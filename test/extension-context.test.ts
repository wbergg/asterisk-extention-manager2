import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../migrations/0001_initial.sql?raw";
import repairBlankContext from "../migrations/0003_repair_blank_context.sql?raw";
import app from "../src/index.js";
import { buildDesired } from "../src/model/compile.js";
import { isSecretTuple, type Env } from "../src/types.js";

/**
 * A blank dialplan context must never reach the PBX as an empty value.
 *
 * Stored empty it survives the update's `COALESCE` — SQL treats '' as a value,
 * not as absent — and `tuples()` then reads the empty string as an attribute
 * *removal*, so the pushed endpoint carries no `context` at all and inherits
 * Asterisk's own, confusingly also called `default`. Every layer reports
 * success: the object pushes, the PBX converges, the phone registers, and calls
 * from it land nowhere near the generated dialplan.
 *
 * These go through the real request path because the bug lived in the boundary
 * between the route's SQL and the expansion, which no unit test of either half
 * could see.
 */

const DB = (env as unknown as Env).DB;

const ADMIN = "admin@example.se";

function worker(): Env {
  return {
    ...(env as unknown as Env),
    DEV_AUTH_BYPASS: "1",
    DEV_ADMIN_EMAIL: ADMIN,
  };
}

async function call(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const res = await app.fetch(
    new Request(`https://aem.example.se${path}`, {
      method: opts.method ?? "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    }),
    worker(),
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

async function dropAll(): Promise<void> {
  const tables = await DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%'",
  ).all<{ name: string }>();
  for (const t of tables.results ?? []) {
    await DB.prepare(`DROP TABLE IF EXISTS "${t.name}"`).run();
  }
}

const contextOf = async (number: string): Promise<string | null> =>
  (
    await DB.prepare(
      "SELECT context FROM extension WHERE pbx_id = 'site1' AND number = ?",
    )
      .bind(number)
      .first<{ context: string }>()
  )?.context ?? null;

/** The context actually pushed for an extension's endpoint, if any. */
async function pushedContext(number: string): Promise<string | undefined> {
  const objects = await buildDesired(DB, "site1");
  const endpoint = objects.find(
    (o) => o.objectType === "endpoint" && o.objectId === number,
  );
  const tuple = endpoint?.attrs.find((a) => a.attribute === "context");
  return tuple && !isSecretTuple(tuple) ? tuple.value : undefined;
}

beforeEach(async () => {
  await dropAll();
  await runSql(schema);

  await DB.prepare(
    `INSERT INTO pbx (id, name, prefix, ws_secret_enc, ari_secret_enc, sccp_enabled, settings_json)
     VALUES ('site1', 'Site 1', 'aem-', 'x', 'y', 0, ?)`,
  )
    .bind(JSON.stringify({ dialplan: { context: "aem-internal", includes: [] } }))
    .run();

  await DB.prepare(
    `INSERT INTO app_user (email, role, display_name, min_ext, max_ext, call_log_access)
     VALUES (?, 'admin', 'Admin', NULL, NULL, 1)`,
  )
    .bind(ADMIN)
    .run();
});

describe("blank dialplan context", () => {
  it("resolves to the managed context on create", async () => {
    const res = await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1001", context: "" },
    });
    expect(res.status).toBe(201);
    expect(await contextOf("1001")).toBe("aem-internal");
  });

  it("resolves to the managed context when cleared on update", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1001", context: "custom-ctx" },
    });
    expect(await contextOf("1001")).toBe("custom-ctx");

    // The GUI always sends the field, so a cleared box arrives as "".
    const res = await call("/api/extensions/site1/1001", {
      method: "PUT",
      body: { context: "" },
    });
    expect(res.status).toBe(200);
    expect(await contextOf("1001")).toBe("aem-internal");
  });

  it("leaves the context alone when the field is absent", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1001", context: "custom-ctx" },
    });

    await call("/api/extensions/site1/1001", {
      method: "PUT",
      body: { display_name: "Renamed" },
    });
    expect(await contextOf("1001")).toBe("custom-ctx");
  });

  it("follows a renamed managed context rather than a hardcoded default", async () => {
    await DB.prepare("UPDATE pbx SET settings_json = ? WHERE id = 'site1'")
      .bind(JSON.stringify({ dialplan: { context: "site1-dial", includes: [] } }))
      .run();

    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1001", context: "  " },
    });
    expect(await contextOf("1001")).toBe("site1-dial");
  });

  it("always pushes a context attribute, never an empty one", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1001", context: "" },
    });
    // The regression: an empty value is dropped by `tuples()`, so the absence
    // of the attribute is the bug, not merely a wrong value.
    expect(await pushedContext("1001")).toBe("aem-internal");
  });
});

describe("migration 0003", () => {
  it("repairs rows already stored blank, honouring the PBX's context", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1001" },
    });
    // Reproduce the pre-fix state directly; the routes no longer allow it.
    await DB.prepare(
      "UPDATE extension SET context = '' WHERE pbx_id = 'site1' AND number = '1001'",
    ).run();
    expect(await pushedContext("1001")).toBeUndefined();

    await runSql(repairBlankContext);

    expect(await contextOf("1001")).toBe("aem-internal");
    expect(await pushedContext("1001")).toBe("aem-internal");
  });

  it("falls back to the shipped default when settings carry no context", async () => {
    await DB.prepare("UPDATE pbx SET settings_json = '' WHERE id = 'site1'").run();
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1002" },
    });
    await DB.prepare(
      "UPDATE extension SET context = '' WHERE pbx_id = 'site1' AND number = '1002'",
    ).run();

    // json_valid guards the extract: a malformed blob must fall through rather
    // than abort the migration.
    await runSql(repairBlankContext);

    expect(await contextOf("1002")).toBe("aem-internal");
  });
});
