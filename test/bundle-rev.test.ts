import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../migrations/0001_initial.sql?raw";
import { encryptSecret } from "../src/lib/crypto.js";
import { renderBundle } from "../src/render/bundle.js";
import { defaultSettings } from "../src/render/settings.js";
import type { Env } from "../src/types.js";

const DB = (env as unknown as Env).DB;

/**
 * `file_rev` is the only signal the PBX has that its files are out of date: the
 * DO reads AEM_FILE_REV back out of the dialplan and compares. So the invariant
 * is "the revision bumps if and only if the rendered bundle changed", and the
 * secrets are part of the rendered bundle — websocket_client.conf and ari.conf
 * embed them verbatim.
 *
 * They were originally left out of file_input_hash, so rotating a secret
 * produced different files under the same revision and the PBX would sit on
 * dead credentials reporting itself current. These pin both halves.
 */

// Self-generated rather than taken from the environment, so the test does not
// depend on whatever happens to be in .dev.vars.
const b64key = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const KEY = b64key();
const TEST_ENV = { SECRET_KEY: KEY, BUNDLE_KEY: b64key() } as unknown as Env;

async function applySchema(): Promise<void> {
  const stripped = schema
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

async function seed(ws = "ws-original", ari = "ari-original"): Promise<void> {
  await DB.prepare(
    `INSERT INTO pbx (id, name, prefix, ws_secret_enc, ari_secret_enc, sccp_enabled, settings_json)
     VALUES ('site42', 'Site 42', 'aem-', ?, ?, 0, ?)`,
  )
    .bind(
      await encryptSecret(KEY, ws),
      await encryptSecret(KEY, ari),
      JSON.stringify(defaultSettings("site42", "cp.example.net")),
    )
    .run();
}

const render = () => renderBundle(DB, TEST_ENV, "site42", "cp.example.net");

const storedRev = async (): Promise<number> =>
  (
    await DB.prepare("SELECT file_rev FROM pbx WHERE id = 'site42'").first<{
      file_rev: number;
    }>()
  )?.file_rev ?? -1;

describe("bundle revision", () => {
  beforeEach(async () => {
    await dropAll();
    await applySchema();
    await seed();
  });

  it("does not bump when nothing changed", async () => {
    const first = await render();
    const second = await render();
    expect(second.fileRev).toBe(first.fileRev);
    expect(await storedRev()).toBe(first.fileRev);
  });

  it("bumps when a secret is rotated", async () => {
    const before = await render();
    expect(before.files.find((f) => f.path === "websocket_client.conf")?.content).toContain(
      "password = ws-original",
    );

    await DB.prepare("UPDATE pbx SET ws_secret_enc = ? WHERE id = 'site42'")
      .bind(await encryptSecret(KEY, "ws-rotated"))
      .run();

    const after = await render();
    expect(after.fileRev).toBe(before.fileRev + 1);
    expect(after.files.find((f) => f.path === "websocket_client.conf")?.content).toContain(
      "password = ws-rotated",
    );
  });

  it("bumps when the ari secret is rotated", async () => {
    const before = await render();
    await DB.prepare("UPDATE pbx SET ari_secret_enc = ? WHERE id = 'site42'")
      .bind(await encryptSecret(KEY, "ari-rotated"))
      .run();

    const after = await render();
    expect(after.fileRev).toBe(before.fileRev + 1);
    expect(after.files.find((f) => f.path === "ari.conf")?.content).toContain(
      "password = ari-rotated",
    );
  });

  // AES-GCM uses a fresh IV per call, so the ciphertext differs every time even
  // for identical plaintext. Hashing the stored blob rather than the decrypted
  // value would bump the revision on every render and mark a converged PBX
  // permanently stale.
  it("does not bump when a secret is re-encrypted to the same value", async () => {
    const before = await render();
    const reEncrypted = await encryptSecret(KEY, "ws-original");
    await DB.prepare("UPDATE pbx SET ws_secret_enc = ? WHERE id = 'site42'")
      .bind(reEncrypted)
      .run();

    const after = await render();
    expect(after.fileRev).toBe(before.fileRev);
  });

  it("still bumps for ordinary config changes", async () => {
    const before = await render();
    await DB.prepare("UPDATE pbx SET sccp_enabled = 1 WHERE id = 'site42'").run();
    const after = await render();
    expect(after.fileRev).toBe(before.fileRev + 1);
  });

  // `prefix` is vestigial: it reaches no object id and no rendered file, so a
  // change to it is something the PBX cannot observe. Bumping would mark a
  // converged site stale and demand a re-apply that changes nothing.
  it("does not bump for the vestigial prefix column", async () => {
    const before = await render();
    await DB.prepare("UPDATE pbx SET prefix = 'aem-atp' WHERE id = 'site42'").run();
    const after = await render();
    expect(after.fileRev).toBe(before.fileRev);
  });
});
