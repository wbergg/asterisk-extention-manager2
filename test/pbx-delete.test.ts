import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../migrations/0001_initial.sql?raw";
import type { Env } from "../src/types.js";

const DB = (env as unknown as Env).DB;

/**
 * Deleting a PBX leans entirely on `ON DELETE CASCADE` reaching every table
 * scoped to it — including the ones that hang off a child rather than off `pbx`
 * directly. If D1 ever stopped enforcing foreign keys, the delete would appear
 * to succeed and quietly leave orphaned extensions, op-log entries and call
 * legs behind, which the next PBX to reuse that site id would inherit. That is
 * silent enough to be worth pinning down.
 */

async function applySchema(): Promise<void> {
  const stripped = schema
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const statements = stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const s of statements) await DB.prepare(s).run();
}

async function dropAll(): Promise<void> {
  const tables = await DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%'",
  ).all<{ name: string }>();
  for (const t of tables.results ?? []) {
    await DB.prepare(`DROP TABLE IF EXISTS "${t.name}"`).run();
  }
}

const count = async (table: string, where = "pbx_id = 'doomed'"): Promise<number> =>
  (
    await DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{
      n: number;
    }>()
  )?.n ?? 0;

/** Two sites, identically populated, so the cascade's blast radius is visible. */
async function seed(): Promise<void> {
  for (const id of ["doomed", "keeper"]) {
    await DB.prepare(
      `INSERT INTO pbx (id, name, prefix, ws_secret_enc, ari_secret_enc, sccp_enabled)
       VALUES (?, ?, 'aem-', 'x', 'y', 1)`,
    )
      .bind(id, id)
      .run();

    await DB.prepare(
      `INSERT INTO extension (pbx_id, number, display_name, tech, secret_enc)
       VALUES (?, '1001', 'Someone', 'pjsip', 'enc')`,
    )
      .bind(id)
      .run();

    const dev = await DB.prepare(
      `INSERT INTO sccp_device (pbx_id, sep_id, description)
       VALUES (?, 'SEP001122334455', 'Lobby') RETURNING id`,
    )
      .bind(id)
      .first<{ id: number }>();
    await DB.prepare(
      `INSERT INTO sccp_button (device_id, position, kind, args_json)
       VALUES (?, 1, 'line', '["1001"]')`,
    )
      .bind(dev!.id)
      .run();

    const rg = await DB.prepare(
      `INSERT INTO ring_group (pbx_id, number, name) VALUES (?, '600', 'All') RETURNING id`,
    )
      .bind(id)
      .first<{ id: number }>();
    await DB.prepare(
      `INSERT INTO ring_group_member (ring_group_id, position, extension_number)
       VALUES (?, 1, '1001')`,
    )
      .bind(rg!.id)
      .run();

    await DB.prepare(
      `INSERT INTO op_log (pbx_id, op, config_class, object_type, object_id)
       VALUES (?, 'upsert', 'res_pjsip', 'endpoint', 'aem-1001')`,
    )
      .bind(id)
      .run();
    await DB.prepare(
      `INSERT INTO quarantine (pbx_id, config_class, object_type, object_id, reason)
       VALUES (?, 'res_pjsip', 'endpoint', 'aem-1001', 'boom')`,
    )
      .bind(id)
      .run();
    await DB.prepare(
      `INSERT INTO blocked_extension (pbx_id, number, reason) VALUES (?, '1002', 'reserved')`,
    )
      .bind(id)
      .run();
    await DB.prepare(
      `INSERT INTO call_leg (pbx_id, channel_id, src, dst, started_at)
       VALUES (?, 'c1', '1001', '1002', datetime('now'))`,
    )
      .bind(id)
      .run();
  }
}

describe("deleting a pbx", () => {
  beforeEach(async () => {
    await dropAll();
    await applySchema();
    await seed();
  });

  it("cascades to every table scoped to it", async () => {
    expect(await count("extension")).toBe(1);
    expect(await count("call_leg")).toBe(1);

    await DB.prepare("DELETE FROM pbx WHERE id = 'doomed'").run();

    for (const table of [
      "extension",
      "sccp_device",
      "op_log",
      "quarantine",
      "blocked_extension",
      "ring_group",
      "call_leg",
    ]) {
      expect(await count(table), `${table} should be empty`).toBe(0);
    }
  });

  it("cascades through child tables that hang off a child, not off pbx", async () => {
    await DB.prepare("DELETE FROM pbx WHERE id = 'doomed'").run();

    // sccp_button -> sccp_device -> pbx, and ring_group_member -> ring_group -> pbx.
    // Only the surviving site's rows should remain.
    expect(await count("sccp_button", "1 = 1")).toBe(1);
    expect(await count("ring_group_member", "1 = 1")).toBe(1);
  });

  it("leaves other sites untouched", async () => {
    await DB.prepare("DELETE FROM pbx WHERE id = 'doomed'").run();

    expect(await count("extension", "pbx_id = 'keeper'")).toBe(1);
    expect(await count("call_leg", "pbx_id = 'keeper'")).toBe(1);
    expect(await count("pbx", "id = 'keeper'")).toBe(1);
  });

  it("keeps the audit trail, which is not scoped to a pbx", async () => {
    await DB.prepare(
      "INSERT INTO audit_log (actor, action, detail) VALUES ('a@b.c', 'delete_pbx', 'doomed')",
    ).run();

    await DB.prepare("DELETE FROM pbx WHERE id = 'doomed'").run();

    expect(await count("audit_log", "1 = 1")).toBe(1);
  });
});
