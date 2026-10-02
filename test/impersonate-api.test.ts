import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../migrations/0001_initial.sql?raw";
import app from "../src/index.js";
import type { Env } from "../src/types.js";

/**
 * Impersonation through the real request path.
 *
 * The unit tests cover who may impersonate whom; these cover the thing the
 * feature exists to answer — that the *API*, not just the GUI, treats the
 * request as the target. An admin checking "can this user create an extension"
 * has to be shown the user's 403, the user's range and the user's own rows, or
 * the answer is worthless.
 */

const DB = (env as unknown as Env).DB;

/** Authentication is bypassed and pinned to `as`, standing in for Access. */
function worker(as: string): Env {
  return {
    ...(env as unknown as Env),
    DEV_AUTH_BYPASS: "1",
    DEV_ADMIN_EMAIL: as,
  };
}

async function call(
  path: string,
  opts: {
    as: string;
    viewAs?: string;
    method?: string;
    body?: unknown;
  },
): Promise<{ status: number; body: any }> {
  const res = await app.fetch(
    new Request(`https://aem.example.se${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(opts.viewAs ? { "X-Impersonate": opts.viewAs } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    }),
    worker(opts.as),
  );
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body; assert on the text */
  }
  return { status: res.status, body };
}

async function applySchema(): Promise<void> {
  const stripped = schema
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  for (const s of stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    await DB.prepare(s).run();
  }
}

async function dropAll(): Promise<void> {
  const tables = await DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%'",
  ).all<{ name: string }>();
  for (const t of tables.results ?? []) {
    await DB.prepare(`DROP TABLE IF EXISTS "${t.name}"`).run();
  }
}

const ADMIN = "admin@example.se";
const SALES = "sales@example.se";

beforeEach(async () => {
  await dropAll();
  await applySchema();

  await DB.prepare(
    `INSERT INTO pbx (id, name, prefix, ws_secret_enc, ari_secret_enc, sccp_enabled)
     VALUES ('site1', 'Site 1', 'aem-', 'x', 'y', 0)`,
  ).run();

  await DB.prepare(
    `INSERT INTO app_user (email, role, display_name, min_ext, max_ext, call_log_access)
     VALUES ('admin@example.se', 'admin', 'Admin', NULL, NULL, 1),
            ('sales@example.se', 'user', 'Sales', 2000, 2099, 0)`,
  ).run();

  await DB.prepare(
    `INSERT INTO blocked_extension (pbx_id, number, reason)
     VALUES ('site1', '2000', 'reserved for the hunt group')`,
  ).run();

  // One row each, so the ownership filter has something to hide.
  await DB.prepare(
    `INSERT INTO extension (pbx_id, number, display_name, tech, owner_email)
     VALUES ('site1', '2050', 'Sales desk', 'pjsip', 'sales@example.se'),
            ('site1', '3000', 'Reception',  'pjsip', 'admin@example.se')`,
  ).run();
});

const actors = async (): Promise<string[]> =>
  (
    await DB.prepare("SELECT actor FROM audit_log ORDER BY id").all<{
      actor: string;
    }>()
  ).results?.map((r) => r.actor) ?? [];

describe("viewing as another user, through the API", () => {
  it("reports the target's identity and names the admin behind it", async () => {
    const r = await call("/api/me", { as: ADMIN, viewAs: SALES });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      email: SALES,
      role: "user",
      minExt: 2000,
      maxExt: 2099,
      impersonatedBy: ADMIN,
    });
  });

  // The whole point: the admin gate is evaluated against the impersonated
  // identity, so an admin genuinely loses their own privileges while viewing.
  it("locks the admin out of admin endpoints while viewing as a user", async () => {
    const r = await call("/api/admin/users", { as: ADMIN, viewAs: SALES });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "admin role required" });
  });

  it("keeps admin endpoints open when not viewing as anyone", async () => {
    const r = await call("/api/admin/users", { as: ADMIN });
    expect(r.status).toBe(200);
  });

  it("applies the target's ownership filter to /extensions", async () => {
    const mine = await call("/api/extensions", { as: ADMIN });
    expect(mine.body).toHaveLength(2); // an admin sees the whole site

    const theirs = await call("/api/extensions", { as: ADMIN, viewAs: SALES });
    expect(theirs.body).toHaveLength(1);
    expect(theirs.body[0]).toMatchObject({ number: "2050" });
  });

  it("lets the impersonated user create inside their own range", async () => {
    const r = await call("/api/extensions", {
      as: ADMIN,
      viewAs: SALES,
      method: "POST",
      body: { pbx_id: "site1", number: "2001", display_name: "New phone" },
    });
    expect(r.status).toBe(201);

    // Owned by the user who "created" it, not by the admin driving the session.
    const row = await DB.prepare(
      "SELECT owner_email FROM extension WHERE pbx_id = 'site1' AND number = '2001'",
    ).first<{ owner_email: string }>();
    expect(row?.owner_email).toBe(SALES);
  });

  it("enforces the target's range, not the admin's freedom", async () => {
    const r = await call("/api/extensions", {
      as: ADMIN,
      viewAs: SALES,
      method: "POST",
      body: { pbx_id: "site1", number: "1500" },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/between 2000 and 2099/);

    // The same call as themselves is allowed — admins bypass the range.
    const asAdmin = await call("/api/extensions", {
      as: ADMIN,
      method: "POST",
      body: { pbx_id: "site1", number: "1500" },
    });
    expect(asAdmin.status).toBe(201);
  });

  it("still refuses a blocked number inside the range", async () => {
    const r = await call("/api/extensions", {
      as: ADMIN,
      viewAs: SALES,
      method: "POST",
      body: { pbx_id: "site1", number: "2000" },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/blocked/);
  });

  it("shows what an unprovisioned sign-in cannot do", async () => {
    const me = await call("/api/me", {
      as: ADMIN,
      viewAs: "newcomer@example.se",
    });
    expect(me.body).toMatchObject({ role: "user", minExt: null });

    const r = await call("/api/extensions", {
      as: ADMIN,
      viewAs: "newcomer@example.se",
      method: "POST",
      body: { pbx_id: "site1", number: "2001" },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/no delegated extension range/);
  });

  it("refuses to let a user's own extension be touched by another user's view", async () => {
    const r = await call("/api/extensions/site1/3000", {
      as: ADMIN,
      viewAs: SALES,
      method: "DELETE",
    });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "not yours" });
  });

  it("attributes the audit entry to both parties", async () => {
    await call("/api/extensions", {
      as: ADMIN,
      viewAs: SALES,
      method: "POST",
      body: { pbx_id: "site1", number: "2001" },
    });
    expect(await actors()).toEqual([`${ADMIN} (as ${SALES})`]);
  });

  it("attributes ordinary actions to the actor alone", async () => {
    await call("/api/extensions", {
      as: ADMIN,
      method: "POST",
      body: { pbx_id: "site1", number: "2001" },
    });
    expect(await actors()).toEqual([ADMIN]);
  });

  // No privilege escalation: the header is a request for someone else's
  // privileges, never a grant of them.
  it("refuses a non-admin who sends the header themselves", async () => {
    const r = await call("/api/me", { as: SALES, viewAs: ADMIN });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/only an admin/);

    const admin = await call("/api/admin/users", { as: SALES, viewAs: ADMIN });
    expect(admin.status).toBe(403);
  });

  it("will not let an admin delete the account they signed in with", async () => {
    await DB.prepare(
      `INSERT INTO app_user (email, role) VALUES ('other@example.se', 'admin')`,
    ).run();

    const r = await call(`/api/admin/users/${encodeURIComponent(ADMIN)}`, {
      as: ADMIN,
      viewAs: "other@example.se",
      method: "DELETE",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/signed in with/);

    const still = await DB.prepare(
      "SELECT email FROM app_user WHERE email = ?",
    )
      .bind(ADMIN)
      .first();
    expect(still).not.toBeNull();
  });
});
