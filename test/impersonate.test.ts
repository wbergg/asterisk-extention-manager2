import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import schema from "../migrations/0001_initial.sql?raw";
import {
  applyImpersonation,
  auditActor,
  IMPERSONATE_HEADER,
  type Identity,
} from "../src/lib/access.js";
import type { Env } from "../src/types.js";

/**
 * Impersonation is an authorization swap, so the interesting cases are all the
 * ones where it must *not* happen: a non-admin asking for it, a service token
 * asking for it, and a target that is not a principal at all. The privilege it
 * hands out is the target's, never the admin's, which is what makes the
 * `/admin/*` 403 a real answer rather than a rendered guess.
 */

const DB = (env as unknown as Env).DB;
const WORKER = env as unknown as Env;

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

const ADMIN: Identity = {
  email: "admin@example.se",
  role: "admin",
  minExt: null,
  maxExt: null,
  callLogAccess: true,
};

const USER: Identity = {
  email: "user@example.se",
  role: "user",
  minExt: 1000,
  maxExt: 1099,
  callLogAccess: false,
};

/** A request carrying only the impersonation header. */
const asking = (target?: string): Request =>
  new Request(
    "https://aem.example.se/api/me",
    target === undefined ? {} : { headers: { [IMPERSONATE_HEADER]: target } },
  );

beforeAll(async () => {
  await dropAll();
  await applySchema();
});

beforeEach(async () => {
  await DB.prepare("DELETE FROM app_user").run();
  await DB.prepare(
    `INSERT INTO app_user (email, role, display_name, min_ext, max_ext, call_log_access)
     VALUES ('admin@example.se', 'admin', 'Admin', NULL, NULL, 1),
            ('sales@example.se', 'user', 'Sales', 2000, 2099, 1),
            ('other@example.se', 'admin', 'Other admin', NULL, NULL, 0)`,
  ).run();
});

describe("applyImpersonation", () => {
  it("passes the real identity through when no header is present", async () => {
    const r = await applyImpersonation(asking(), WORKER, ADMIN);
    expect(r).toEqual({ ok: true, identity: ADMIN });
  });

  it("resolves the target's own privileges, not the admin's", async () => {
    const r = await applyImpersonation(
      asking("sales@example.se"),
      WORKER,
      ADMIN,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity).toEqual({
      email: "sales@example.se",
      role: "user",
      minExt: 2000,
      maxExt: 2099,
      callLogAccess: true,
      impersonatedBy: "admin@example.se",
    });
  });

  // The view an admin most often wants: what someone Access lets in but who has
  // no row here actually sees.
  it("resolves an unprovisioned address to a zero-privilege user", async () => {
    const r = await applyImpersonation(
      asking("newcomer@example.se"),
      WORKER,
      ADMIN,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity).toEqual({
      email: "newcomer@example.se",
      role: "user",
      minExt: null,
      maxExt: null,
      callLogAccess: false,
      impersonatedBy: "admin@example.se",
    });
  });

  it("keeps admin privileges when the target is another admin", async () => {
    const r = await applyImpersonation(
      asking("other@example.se"),
      WORKER,
      ADMIN,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity.role).toBe("admin");
    expect(r.identity.impersonatedBy).toBe("admin@example.se");
  });

  it("refuses a non-admin asking to view as someone else", async () => {
    const r = await applyImpersonation(
      asking("sales@example.se"),
      WORKER,
      USER,
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  // A long-lived automation credential that can assume any identity in the
  // fleet is a bigger blast radius than the feature is worth.
  it("refuses a service token even when it is provisioned as admin", async () => {
    const r = await applyImpersonation(asking("sales@example.se"), WORKER, {
      ...ADMIN,
      email: "svc:a1b2c3.access",
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a target that is not a principal", async () => {
    for (const bogus of ["not-an-email", "a@b", "<script>", "a".repeat(300)]) {
      const r = await applyImpersonation(asking(bogus), WORKER, ADMIN);
      expect(r, bogus).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("treats viewing as yourself as not impersonating", async () => {
    const r = await applyImpersonation(
      asking("ADMIN@example.se"),
      WORKER,
      ADMIN,
    );
    expect(r).toEqual({ ok: true, identity: ADMIN });
  });

  it("is case-insensitive about the target", async () => {
    const r = await applyImpersonation(
      asking("  Sales@Example.SE  "),
      WORKER,
      ADMIN,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity.email).toBe("sales@example.se");
    expect(r.identity.minExt).toBe(2000);
  });

  // Nothing here is a second credential: the swap lasts exactly one request,
  // and a non-admin who replays the header gets nowhere.
  it("does not let the impersonated identity impersonate onwards", async () => {
    const first = await applyImpersonation(
      asking("sales@example.se"),
      WORKER,
      ADMIN,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await applyImpersonation(
      asking("other@example.se"),
      WORKER,
      first.identity,
    );
    expect(second).toMatchObject({ ok: false, status: 403 });
  });
});

describe("auditActor", () => {
  it("records the plain principal when not impersonating", () => {
    expect(auditActor(ADMIN)).toBe("admin@example.se");
  });

  // Attributing the action to the target alone would forge history; to the
  // admin alone would hide which range and ownership it ran under.
  it("records both parties when impersonating", () => {
    expect(
      auditActor({ ...USER, impersonatedBy: "admin@example.se" }),
    ).toBe("admin@example.se (as user@example.se)");
  });
});
