import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../migrations/0001_initial.sql?raw";
import { compilePbx } from "../src/model/compile.js";
import type { Env } from "../src/types.js";

const DB = (env as unknown as Env).DB;

/**
 * Apply the D1 schema. Split manually rather than using db.exec(), which is
 * fussy about comments and multi-line statements.
 */
async function applySchema(): Promise<void> {
  // Strip inline comments as well as whole-line ones: a prose comment
  // containing a semicolon would otherwise split a statement in half.
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

async function seedPbx(): Promise<void> {
  await DB.prepare(
    `INSERT INTO pbx (id, name, prefix, ws_secret_enc, ari_secret_enc, sccp_enabled)
     VALUES ('site42', 'Site 42', 'aem-', 'x', 'y', 1)`,
  ).run();
  await DB.prepare(
    `INSERT INTO profile (id, tech, name, attrs_json)
     VALUES ('desk', 'pjsip', 'Desk phone',
             '{"endpoint":{"allow":"g722,alaw","direct_media":"no"}}')`,
  ).run();
}

async function addExtension(
  number: string,
  tech: "pjsip" | "sccp" = "pjsip",
): Promise<void> {
  await DB.prepare(
    `INSERT INTO extension (pbx_id, number, display_name, tech, profile_id, secret_enc)
     VALUES ('site42', ?, ?, ?, ?, 'enc')`,
  )
    .bind(number, `User ${number}`, tech, tech === "pjsip" ? "desk" : null)
    .run();
}

const opCount = async (): Promise<number> =>
  (
    await DB.prepare("SELECT COUNT(*) AS n FROM op_log").first<{ n: number }>()
  )?.n ?? 0;

const objects = async () =>
  (
    await DB.prepare(
      "SELECT config_class, object_type, object_id, version, dep_rank FROM object_version ORDER BY dep_rank, object_type",
    ).all<{
      config_class: string;
      object_type: string;
      object_id: string;
      version: number;
      dep_rank: number;
    }>()
  ).results ?? [];

beforeEach(async () => {
  await dropAll();
  await applySchema();
  await seedPbx();
});

describe("compilePbx", () => {
  it("expands one PJSIP extension into three ordered objects", async () => {
    await addExtension("1001");
    const result = await compilePbx(DB, "site42");

    expect(result.created).toBe(3);
    expect(result.changed).toBe(true);

    const objs = await objects();
    expect(objs.map((o) => o.object_type)).toEqual(["auth", "aor", "endpoint"]);
    expect(objs.every((o) => o.object_id === "1001")).toBe(true);
    expect(await opCount()).toBe(3);
  });

  it("is idempotent: recompiling unchanged input emits no ops", async () => {
    await addExtension("1001");
    await compilePbx(DB, "site42");
    const before = await opCount();

    const second = await compilePbx(DB, "site42");

    expect(second.changed).toBe(false);
    expect(second.created + second.updated + second.deleted).toBe(0);
    expect(await opCount()).toBe(before);
  });

  it("bumps only the objects that actually changed", async () => {
    await addExtension("1001");
    await compilePbx(DB, "site42");

    await DB.prepare(
      "UPDATE extension SET display_name = 'Renamed' WHERE number = '1001'",
    ).run();
    const result = await compilePbx(DB, "site42");

    // Only the endpoint carries callerid, so auth and aor must not churn.
    expect(result.updated).toBe(1);
    const objs = await objects();
    const byType = Object.fromEntries(objs.map((o) => [o.object_type, o]));
    expect(byType["endpoint"]!.version).toBe(2);
    expect(byType["auth"]!.version).toBe(1);
    expect(byType["aor"]!.version).toBe(1);
  });

  it("emits delete ops and removes rows when an extension goes away", async () => {
    await addExtension("1001");
    await compilePbx(DB, "site42");

    await DB.prepare("DELETE FROM extension WHERE number = '1001'").run();
    const result = await compilePbx(DB, "site42");

    expect(result.deleted).toBe(3);
    expect(await objects()).toEqual([]);

    const deletes = await DB.prepare(
      "SELECT object_type FROM op_log WHERE op = 'delete' ORDER BY seq",
    ).all<{ object_type: string }>();
    expect(deletes.results?.length).toBe(3);
  });

  it("clears quarantine when an object is removed", async () => {
    await addExtension("1001");
    await compilePbx(DB, "site42");
    await DB.prepare(
      `INSERT INTO quarantine (pbx_id, config_class, object_type, object_id, attempts)
       VALUES ('site42', 'res_pjsip', 'endpoint', '1001', 5)`,
    ).run();

    await DB.prepare("DELETE FROM extension WHERE number = '1001'").run();
    await compilePbx(DB, "site42");

    const q = await DB.prepare("SELECT COUNT(*) AS n FROM quarantine").first<{
      n: number;
    }>();
    // A stale quarantine row would otherwise suppress a future object reusing
    // the same id.
    expect(q?.n).toBe(0);
  });

  it("expands an SCCP extension to a single unprefixed line", async () => {
    await addExtension("2001", "sccp");
    await compilePbx(DB, "site42");

    const objs = await objects();
    expect(objs).toHaveLength(1);
    expect(objs[0]!.config_class).toBe("chan_sccp2");
    expect(objs[0]!.object_type).toBe("line");
    expect(objs[0]!.object_id).toBe("2001");
  });

  it("ranks an SCCP line below its device", async () => {
    await addExtension("2001", "sccp");
    await DB.prepare(
      `INSERT INTO sccp_device (pbx_id, sep_id, description, softkey_profile)
       VALUES ('site42', 'SEP001122334455', 'Reception', 'default')`,
    ).run();
    const dev = await DB.prepare(
      "SELECT id FROM sccp_device WHERE sep_id = 'SEP001122334455'",
    ).first<{ id: number }>();
    await DB.prepare(
      `INSERT INTO sccp_button (device_id, position, kind, args_json)
       VALUES (?, 1, 'line', '["2001"]')`,
    )
      .bind(dev!.id)
      .run();

    await compilePbx(DB, "site42");

    const objs = await objects();
    const line = objs.find((o) => o.object_type === "line")!;
    const device = objs.find((o) => o.object_type === "device")!;
    expect(line.dep_rank).toBeLessThan(device.dep_rank);
  });

  it("propagates a profile change to every extension using it", async () => {
    await addExtension("1001");
    await addExtension("1002");
    await compilePbx(DB, "site42");

    await DB.prepare(
      `UPDATE profile SET attrs_json = '{"endpoint":{"allow":"opus"}}' WHERE id = 'desk'`,
    ).run();
    const result = await compilePbx(DB, "site42");

    expect(result.updated).toBe(2); // both endpoints, nothing else
  });

  it("emits nothing for a directory-only extension", async () => {
    await DB.prepare(
      `INSERT INTO extension (pbx_id, number, display_name, tech, directory_only)
       VALUES ('site42', '1500', 'Front Desk', 'pjsip', 1)`,
    ).run();
    const result = await compilePbx(DB, "site42");

    expect(result.created).toBe(0);
    expect(await objects()).toEqual([]);
  });
});
