import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../migrations/0001_initial.sql?raw";
import fileHashes from "../migrations/0004_bundle_file_hash.sql?raw";
import { encryptSecret } from "../src/lib/crypto.js";
import { describeStale, renderBundle, staleFiles } from "../src/render/bundle.js";
import { defaultSettings } from "../src/render/settings.js";
import type { Env } from "../src/types.js";

const DB = (env as unknown as Env).DB;

/**
 * The stale status names the files whose content differs between the revision
 * the PBX applied and the one AEM wants, rather than only the two numbers.
 */

const b64key = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const KEY = b64key();
const TEST_ENV = { SECRET_KEY: KEY, BUNDLE_KEY: b64key() } as unknown as Env;

async function runSql(sql: string): Promise<void> {
  const stripped = sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  for (const s of stripped
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)) {
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

const render = () => renderBundle(DB, TEST_ENV, "site42", "cp.example.net");

beforeEach(async () => {
  await dropAll();
  await runSql(schema);
  await runSql(fileHashes);
  await DB.prepare(
    `INSERT INTO pbx (id, name, prefix, ws_secret_enc, ari_secret_enc, sccp_enabled, settings_json)
     VALUES ('site42', 'Site 42', 'aem-', ?, ?, 0, ?)`,
  )
    .bind(
      await encryptSecret(KEY, "ws"),
      await encryptSecret(KEY, "ari"),
      JSON.stringify(defaultSettings("site42", "cp.example.net")),
    )
    .run();
});

describe("stale files", () => {
  it("names only the file whose content changed", async () => {
    const before = await render();
    await DB.prepare(
      `INSERT INTO extension (pbx_id, number, display_name, tech, context)
       VALUES ('site42', '1006', 'Desk', 'pjsip', 'aem-internal')`,
    ).run();
    const after = await render();
    expect(after.fileRev).toBe(before.fileRev + 1);

    const stale = await staleFiles(DB, "site42", before.fileRev, after.fileRev);
    expect(stale).toEqual({ changed: ["extensions.conf"], removed: [] });
    expect(describeStale(stale)).toBe("Changed: extensions.conf.");
  });

  it("reports a file that is no longer generated", async () => {
    await DB.prepare("UPDATE pbx SET sccp_enabled = 1 WHERE id = 'site42'").run();
    const before = await render();
    await DB.prepare("UPDATE pbx SET sccp_enabled = 0 WHERE id = 'site42'").run();
    const after = await render();

    const stale = await staleFiles(DB, "site42", before.fileRev, after.fileRev);
    expect(stale?.removed).toEqual(["sccp.conf"]);
    // sorcery.conf loses its [chan_sccp2] block too.
    expect(stale?.changed).toEqual(["sorcery.conf"]);
  });

  it("falls back to 'install every file' for an unrecorded revision", async () => {
    const after = await render();
    const stale = await staleFiles(DB, "site42", after.fileRev - 1, after.fileRev);
    expect(stale).toBeNull();
    expect(describeStale(stale)).toMatch(/install every file/);
  });
});
