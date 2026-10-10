import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../migrations/0001_initial.sql?raw";
import app from "../src/index.js";
import { compilePbx } from "../src/model/compile.js";
import type { Env } from "../src/types.js";

/**
 * Request-boundary checks that keep a delegated user inside their own lane and
 * keep one bad row from taking a whole PBX down.
 *
 * Non-admin requests go through impersonation, which runs the exact identity a
 * delegated user would have through every route check.
 */

const DB = (env as unknown as Env).DB;

const ADMIN = "admin@example.se";
const USER = "user@example.se";

function worker(): Env {
  return {
    ...(env as unknown as Env),
    DEV_AUTH_BYPASS: "1",
    DEV_ADMIN_EMAIL: ADMIN,
  };
}

async function call(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    asUser?: boolean;
    headers?: Record<string, string>;
    rawBody?: string;
  } = {},
): Promise<{ status: number; body: any }> {
  const res = await app.fetch(
    new Request(`https://aem.example.se${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(opts.asUser ? { "X-Impersonate": USER } : {}),
        ...opts.headers,
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.rawBody !== undefined ? { body: opts.rawBody } : {}),
    }),
    worker(),
  );
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body };
}

async function dropAll(): Promise<void> {
  const tables = await DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%'",
  ).all<{ name: string }>();
  for (const t of tables.results ?? []) {
    await DB.prepare(`DROP TABLE IF EXISTS "${t.name}"`).run();
  }
}

async function runSql(sql: string): Promise<void> {
  const stripped = sql
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

const row = (number: string) =>
  DB.prepare(
    "SELECT context, overrides_json FROM extension WHERE pbx_id = 'site1' AND number = ?",
  )
    .bind(number)
    .first<{ context: string; overrides_json: string }>();

beforeEach(async () => {
  await dropAll();
  await runSql(schema);

  await DB.prepare(
    `INSERT INTO pbx (id, name, prefix, ws_secret_enc, ari_secret_enc, sccp_enabled, settings_json)
     VALUES ('site1', 'Site 1', 'aem-', 'x', 'y', 1, ?)`,
  )
    .bind(JSON.stringify({ dialplan: { context: "aem-internal", includes: [] } }))
    .run();

  await DB.prepare(
    `INSERT INTO app_user (email, role, display_name, min_ext, max_ext, call_log_access)
     VALUES (?, 'admin', 'Admin', NULL, NULL, 1),
            (?, 'user', 'User', 2000, 2099, 0)`,
  )
    .bind(ADMIN, USER)
    .run();
});

describe("dialplan context", () => {
  it("refuses a custom context from a delegated user on create", async () => {
    const res = await call("/api/extensions", {
      method: "POST",
      asUser: true,
      body: { pbx_id: "site1", number: "2001", context: "outbound-intl" },
    });
    expect(res.status).toBe(403);
    expect(await row("2001")).toBeNull();
  });

  it("refuses a custom context from a delegated user on update", async () => {
    await call("/api/extensions", {
      method: "POST",
      asUser: true,
      body: { pbx_id: "site1", number: "2001" },
    });
    const res = await call("/api/extensions/site1/2001", {
      method: "PUT",
      asUser: true,
      body: { context: "outbound-intl" },
    });
    expect(res.status).toBe(403);
    expect((await row("2001"))?.context).toBe("aem-internal");
  });

  it("lets a delegated user resubmit the context already stored", async () => {
    // An admin set it; the user's edit form sends it back unchanged.
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "2001", context: "legacy-ctx" },
    });
    await DB.prepare("UPDATE extension SET owner_email = ? WHERE number = '2001'")
      .bind(USER)
      .run();

    const res = await call("/api/extensions/site1/2001", {
      method: "PUT",
      asUser: true,
      body: { context: "legacy-ctx", display_name: "Desk" },
    });
    expect(res.status).toBe(200);
  });

  it("refuses a context name that could corrupt config, even from an admin", async () => {
    const res = await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1001", context: "x\n[evil]" },
    });
    expect(res.status).toBe(400);
  });
});

describe("overrides", () => {
  beforeEach(async () => {
    await call("/api/extensions", {
      method: "POST",
      asUser: true,
      body: { pbx_id: "site1", number: "2001" },
    });
  });

  it("are admin-only", async () => {
    const res = await call("/api/extensions/site1/2001", {
      method: "PUT",
      asUser: true,
      body: { overrides: { endpoint: { trust_id_inbound: "yes" } } },
    });
    expect(res.status).toBe(403);
    expect((await row("2001"))?.overrides_json).toBe("{}");
  });

  it.each([
    [{ endpoint: { allow: 1 } }],
    [{ endpoint: null }],
    [{ line: { label: "x" } }],
    [{ endpoint: { type: "aor" } }],
    [{ auth: { password: "x" } }],
    [{ endpoint: { "bad key": "x" } }],
    [{ endpoint: { callerid: "a\nb" } }],
  ])("rejects malformed overrides %j", async (overrides) => {
    const res = await call("/api/extensions/site1/2001", {
      method: "PUT",
      body: { overrides },
    });
    expect(res.status).toBe(400);
  });

  it("accepts well-formed overrides from an admin", async () => {
    const res = await call("/api/extensions/site1/2001", {
      method: "PUT",
      body: { overrides: { endpoint: { send_connected_line: "no" } } },
    });
    expect(res.status).toBe(200);
  });

  it("a stored non-string value no longer breaks compilation", async () => {
    // A row written before validation existed.
    await DB.prepare(
      "UPDATE extension SET overrides_json = ? WHERE number = '2001'",
    )
      .bind(JSON.stringify({ endpoint: { allow: 1, x: null } }))
      .run();
    await expect(compilePbx(DB, "site1")).resolves.toBeDefined();
  });
});

describe("SCCP extension edits", () => {
  it("are rolled back when they would invalidate the inventory", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1001", tech: "sccp" },
    });
    const res = await call("/api/extensions/site1/1001", {
      method: "PUT",
      body: { overrides: { line: { not_a_real_option: "x" } } },
    });
    expect(res.status).toBe(400);
    expect((await row("1001"))?.overrides_json).toBe("{}");
  });
});

describe("cross-site writes", () => {
  it("refuses a cross-site Sec-Fetch-Site", async () => {
    const res = await call("/api/admin/pbx/site1/resync", {
      method: "POST",
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("refuses a foreign Origin", async () => {
    const res = await call("/api/extensions", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: { pbx_id: "site1", number: "1001" },
    });
    expect(res.status).toBe(403);
    expect(await row("1001")).toBeNull();
  });

  it("refuses a text/plain body carrying JSON", async () => {
    const res = await call("/api/extensions", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      rawBody: JSON.stringify({ pbx_id: "site1", number: "1001" }),
    });
    expect(res.status).toBe(415);
    expect(await row("1001")).toBeNull();
  });

  it("allows a same-origin request", async () => {
    const res = await call("/api/extensions", {
      method: "POST",
      headers: {
        Origin: "https://aem.example.se",
        "Sec-Fetch-Site": "same-origin",
      },
      body: { pbx_id: "site1", number: "1001" },
    });
    expect(res.status).toBe(201);
  });
});
