import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import initial from "../migrations/0001_initial.sql?raw";
import buttonKinds from "../migrations/0002_sccp_button_kinds.sql?raw";
import type { Env } from "../src/types.js";

const DB = (env as unknown as Env).DB;

/**
 * Migrations run once, against a live database, and a broken one is discovered
 * in production or not at all. 0002 rebuilds sccp_button to widen a CHECK
 * constraint, which in SQLite means create/copy/drop/rename — so what needs
 * proving is that existing rows survive the copy, the foreign key still
 * cascades afterwards, and the constraint ends up both wider and still closed.
 */

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

const apply = async (sql: string) => {
  for (const s of statements(sql)) await DB.prepare(s).run();
};

async function dropAll(): Promise<void> {
  const tables = await DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%'",
  ).all<{ name: string }>();
  for (const t of tables.results ?? []) {
    await DB.prepare(`DROP TABLE IF EXISTS "${t.name}"`).run();
  }
}

/** A device with one pre-existing button, as a live database would have. */
async function seed(): Promise<number> {
  await DB.prepare(
    `INSERT INTO pbx (id, name, prefix, ws_secret_enc, ari_secret_enc, sccp_enabled)
     VALUES ('atp', 'atp', 'aem-atp', 'x', 'y', 1)`,
  ).run();
  const dev = await DB.prepare(
    `INSERT INTO sccp_device (pbx_id, sep_id, description)
     VALUES ('atp', 'SEP001B2AC731B8', '7961G') RETURNING id`,
  ).first<{ id: number }>();
  await DB.prepare(
    `INSERT INTO sccp_button (device_id, position, kind, args_json)
     VALUES (?, 1, 'line', '["1006","label=1006"]')`,
  )
    .bind(dev!.id)
    .run();
  return dev!.id;
}

describe("migration 0002 — sccp_button kinds", () => {
  let deviceId: number;

  beforeEach(async () => {
    await dropAll();
    await apply(initial);
    deviceId = await seed();
  });

  it("rejects `unused` before the migration", async () => {
    await expect(
      DB.prepare(
        "INSERT INTO sccp_button (device_id, position, kind) VALUES (?, 2, 'unused')",
      )
        .bind(deviceId)
        .run(),
    ).rejects.toThrow();
  });

  it("accepts `unused` and `addon_module` after it", async () => {
    await apply(buttonKinds);

    for (const [pos, kind] of [
      [2, "unused"],
      [3, "addon_module"],
    ] as const) {
      await DB.prepare(
        "INSERT INTO sccp_button (device_id, position, kind) VALUES (?, ?, ?)",
      )
        .bind(deviceId, pos, kind)
        .run();
    }

    const n = await DB.prepare(
      "SELECT COUNT(*) AS n FROM sccp_button WHERE device_id = ?",
    )
      .bind(deviceId)
      .first<{ n: number }>();
    expect(n?.n).toBe(3);
  });

  it("preserves existing rows through the table rebuild", async () => {
    await apply(buttonKinds);

    const row = await DB.prepare(
      "SELECT device_id, position, kind, args_json FROM sccp_button WHERE position = 1",
    ).first<{
      device_id: number;
      position: number;
      kind: string;
      args_json: string;
    }>();
    expect(row).toMatchObject({
      device_id: deviceId,
      position: 1,
      kind: "line",
      args_json: '["1006","label=1006"]',
    });
  });

  it("keeps the constraint closed — a bogus kind is still refused", async () => {
    await apply(buttonKinds);
    await expect(
      DB.prepare(
        "INSERT INTO sccp_button (device_id, position, kind) VALUES (?, 9, 'nonsense')",
      )
        .bind(deviceId)
        .run(),
    ).rejects.toThrow();
  });

  // The rebuild drops and recreates the table, so the FK to sccp_device has to
  // be reinstated by the new definition or buttons would outlive their device.
  it("keeps the cascade from sccp_device intact", async () => {
    await apply(buttonKinds);
    await DB.prepare("DELETE FROM sccp_device WHERE id = ?").bind(deviceId).run();

    const n = await DB.prepare("SELECT COUNT(*) AS n FROM sccp_button").first<{
      n: number;
    }>();
    expect(n?.n).toBe(0);
  });

  it("keeps the unique constraint on (device_id, position)", async () => {
    await apply(buttonKinds);
    await expect(
      DB.prepare(
        "INSERT INTO sccp_button (device_id, position, kind) VALUES (?, 1, 'empty')",
      )
        .bind(deviceId)
        .run(),
    ).rejects.toThrow();
  });
});
