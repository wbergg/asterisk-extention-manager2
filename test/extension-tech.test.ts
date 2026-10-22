import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../migrations/0001_initial.sql?raw";
import app from "../src/index.js";
import type { Env } from "../src/types.js";

/**
 * Migrating a number between PJSIP and SCCP in place through PUT: the number
 * keeps its row, and the desired set swaps one technology's objects for the
 * other's.
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

const ext = (number: string) =>
  DB.prepare(
    "SELECT tech, profile_id, overrides_json, secret_enc FROM extension WHERE pbx_id = 'site1' AND number = ?",
  )
    .bind(number)
    .first<{ tech: string; profile_id: string | null; overrides_json: string; secret_enc: string | null }>();

const objects = async (number: string) =>
  (
    await DB.prepare(
      "SELECT config_class || '/' || object_type AS o FROM object_version WHERE pbx_id = 'site1' AND object_id = ? ORDER BY o",
    )
      .bind(number)
      .all<{ o: string }>()
  ).results?.map((r) => r.o) ?? [];

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

  await DB.prepare(
    `INSERT INTO profile (id, tech, name, attrs_json) VALUES ('pj', 'pjsip', 'PJSIP', '{}')`,
  ).run();
});

describe("changing an extension's technology", () => {
  it("migrates a PJSIP number to SCCP and resets profile and overrides", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1006", profile_id: "pj" },
    });
    await call("/api/extensions/site1/1006", {
      method: "PUT",
      body: { overrides: { endpoint: { send_pai: "yes" } } },
    });
    expect(await objects("1006")).toEqual(["res_pjsip/aor", "res_pjsip/auth", "res_pjsip/endpoint"]);

    const res = await call("/api/extensions/site1/1006", {
      method: "PUT",
      body: { tech: "sccp" },
    });
    expect(res.status).toBe(200);

    const row = await ext("1006");
    expect(row?.tech).toBe("sccp");
    expect(row?.profile_id).toBeNull();
    expect(row?.overrides_json).toBe("{}");
    expect(await objects("1006")).toEqual(["chan_sccp2/line"]);
  });

  it("validates overrides against the new technology", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1006" },
    });
    const res = await call("/api/extensions/site1/1006", {
      method: "PUT",
      body: { tech: "sccp", overrides: { endpoint: { send_pai: "yes" } } },
    });
    expect(res.status).toBe(400);
    expect((await ext("1006"))?.tech).toBe("pjsip");
  });

  it("refuses a profile of the old technology", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1006" },
    });
    const res = await call("/api/extensions/site1/1006", {
      method: "PUT",
      body: { tech: "sccp", profile_id: "pj" },
    });
    expect(res.status).toBe(400);
    expect((await ext("1006"))?.tech).toBe("pjsip");
  });

  it("generates a secret when an SCCP number without one becomes PJSIP", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1006", tech: "sccp" },
    });
    await DB.prepare("UPDATE extension SET secret_enc = NULL WHERE number = '1006'").run();

    const res = await call("/api/extensions/site1/1006", {
      method: "PUT",
      body: { tech: "pjsip" },
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.secret).toBe("string");
    expect((await ext("1006"))?.secret_enc).not.toBeNull();
    expect(await objects("1006")).toEqual(["res_pjsip/aor", "res_pjsip/auth", "res_pjsip/endpoint"]);
  });

  it("refuses to take a line away from a device that still uses it", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1006", tech: "sccp" },
    });
    const dev = await call("/api/admin/sccp/devices", {
      method: "POST",
      body: {
        pbx_id: "site1",
        sep_id: "SEP001B2AC731B8",
        buttons: [{ position: 1, kind: "line", args: ["1006"] }],
      },
    });
    expect(dev.status).toBe(201);

    const res = await call("/api/extensions/site1/1006", {
      method: "PUT",
      body: { tech: "pjsip" },
    });
    expect(res.status).toBe(400);
    expect((await ext("1006"))?.tech).toBe("sccp");
  });

  it("is admin-only", async () => {
    await call("/api/extensions", {
      method: "POST",
      asUser: true,
      body: { pbx_id: "site1", number: "2001" },
    });
    const res = await call("/api/extensions/site1/2001", {
      method: "PUT",
      asUser: true,
      body: { tech: "sccp" },
    });
    expect(res.status).toBe(403);
    expect((await ext("2001"))?.tech).toBe("pjsip");
  });
});

describe("SCCP button check", () => {
  it("passes a line button for an SCCP line and fails one still on PJSIP", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1006", tech: "sccp" },
    });
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1007" },
    });

    const ok = await call("/api/admin/sccp/buttons/check", {
      method: "POST",
      body: { pbx_id: "site1", kind: "line", args: ["1006", "label=1006", "ring=normal"] },
    });
    expect(ok.body).toEqual({ ok: true });

    const pjsip = await call("/api/admin/sccp/buttons/check", {
      method: "POST",
      body: { pbx_id: "site1", kind: "line", args: ["1007"] },
    });
    expect(pjsip.body.ok).toBe(false);
    expect(pjsip.body.error).toMatch(/not an SCCP extension/);
  });

  it("is admin-only", async () => {
    const res = await call("/api/admin/sccp/buttons/check", {
      method: "POST",
      asUser: true,
      body: { pbx_id: "site1", kind: "empty", args: [] },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a malformed button on device save", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1006", tech: "sccp" },
    });
    const res = await call("/api/admin/sccp/devices", {
      method: "POST",
      body: {
        pbx_id: "site1",
        sep_id: "SEP001B2AC731B8",
        buttons: [{ position: 1, kind: "line", args: ["1006", "lable=1006"] }],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown line option/);
  });
});
