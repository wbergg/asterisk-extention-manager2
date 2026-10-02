import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../migrations/0001_initial.sql?raw";
import app from "../src/index.js";
import { decryptSecret, validateSecret } from "../src/lib/crypto.js";
import type { Env } from "../src/types.js";

/**
 * Changing an extension's SIP secret, the two ways an operator can mean it:
 * generate one (and be shown it once), or type in the password the handset is
 * already registered with.
 *
 * The part worth pinning down is propagation. The password reaches the PBX as a
 * `secret_ref` tuple, so `object_version.attrs_json` does not move when the
 * secret behind it changes — the desired-state diff sees nothing, and without a
 * deliberate op_log row the new password would sit in D1 while the phone kept
 * registering on the old one. That failure is completely silent from the API's
 * side: the request returns 200 either way.
 */

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const DB = (env as unknown as Env).DB;

function worker(as: string): Env {
  return {
    ...(env as unknown as Env),
    DEV_AUTH_BYPASS: "1",
    DEV_ADMIN_EMAIL: as,
    SECRET_KEY: KEY,
  };
}

async function call(
  path: string,
  opts: { as: string; method?: string; body?: unknown },
): Promise<{ status: number; body: any }> {
  const res = await app.fetch(
    new Request(`https://aem.example.se${path}`, {
      method: opts.method ?? "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
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

const ADMIN = "admin@example.se";
const SALES = "sales@example.se";
const OTHER = "other@example.se";

/** The plaintext currently stored for an extension. */
async function storedSecret(number: string): Promise<string | null> {
  const row = await DB.prepare(
    "SELECT secret_enc FROM extension WHERE pbx_id = 'site1' AND number = ?",
  )
    .bind(number)
    .first<{ secret_enc: string | null }>();
  return row?.secret_enc ? await decryptSecret(KEY, row.secret_enc) : null;
}

/** op_log rows naming an object, which is what makes the DO re-push it. */
async function opsFor(objectId: string): Promise<number> {
  const row = await DB.prepare(
    `SELECT COUNT(*) AS n FROM op_log
      WHERE pbx_id = 'site1' AND op = 'upsert'
        AND config_class = 'res_pjsip' AND object_type = 'auth' AND object_id = ?`,
  )
    .bind(objectId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

const actions = async (): Promise<string[]> =>
  (
    await DB.prepare("SELECT action FROM audit_log ORDER BY id").all<{
      action: string;
    }>()
  ).results?.map((r) => r.action) ?? [];

beforeEach(async () => {
  await dropAll();
  await applySchema();

  await DB.prepare(
    `INSERT INTO pbx (id, name, prefix, ws_secret_enc, ari_secret_enc, sccp_enabled)
     VALUES ('site1', 'Site 1', 'aem-', 'x', 'y', 1)`,
  ).run();

  await DB.prepare(
    `INSERT INTO app_user (email, role, display_name, min_ext, max_ext, call_log_access)
     VALUES ('admin@example.se', 'admin', 'Admin',  NULL, NULL, 1),
            ('sales@example.se', 'user',  'Sales',  2000, 2099, 0),
            ('other@example.se', 'user',  'Other',  2100, 2199, 0)`,
  ).run();

  // Created through the API so object_version and op_log are populated the way
  // a live install has them — the propagation assertions depend on it.
  await call("/api/extensions", {
    as: SALES,
    method: "POST",
    body: { pbx_id: "site1", number: "2050", display_name: "Sales desk" },
  });
});

describe("creating an extension with a supplied password", () => {
  /**
   * Adoption is the whole migration story: the handset keeps the password it is
   * already registered with, and the pushed auth object must carry exactly
   * that. There is no path where a valid supplied secret is replaced by a
   * generated one — these pin that down, and pin down the signal that says so,
   * because "adopted" and "replaced" reading alike in the response is what made
   * a correct create look like a password change.
   */

  it("stores exactly the password supplied, and says it generated nothing", async () => {
    const r = await call("/api/extensions", {
      as: ADMIN,
      method: "POST",
      body: { pbx_id: "site1", number: "2051", secret: "Existing9pass" },
    });

    expect(r.status).toBe(201);
    expect(r.body.generated).toBe(false);
    // Not echoed: the caller already holds it.
    expect(r.body.secret).toBeNull();
    expect(await storedSecret("2051")).toBe("Existing9pass");
  });

  it("generates and reveals one only when none was supplied", async () => {
    const r = await call("/api/extensions", {
      as: ADMIN,
      method: "POST",
      body: { pbx_id: "site1", number: "2052" },
    });

    expect(r.body.generated).toBe(true);
    expect(r.body.secret).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(await storedSecret("2052")).toBe(r.body.secret);
  });

  it("pushes the supplied password to the PBX, not some other one", async () => {
    await call("/api/extensions", {
      as: ADMIN,
      method: "POST",
      body: { pbx_id: "site1", number: "2053", secret: "Adopted42pw" },
    });

    // The auth object travels as a secret_ref, resolved from secret_enc at push
    // time — so what the PBX receives is whatever this decrypts to.
    expect(await storedSecret("2053")).toBe("Adopted42pw");
    expect(await opsFor("2053")).toBeGreaterThan(0);
  });

  it("trims surrounding whitespace rather than storing it", async () => {
    await call("/api/extensions", {
      as: ADMIN,
      method: "POST",
      body: { pbx_id: "site1", number: "2054", secret: "  Padded7pass  " },
    });
    expect(await storedSecret("2054")).toBe("Padded7pass");
  });

  it("treats a whitespace-only secret as none supplied and generates", async () => {
    const r = await call("/api/extensions", {
      as: ADMIN,
      method: "POST",
      body: { pbx_id: "site1", number: "2055", secret: "   " },
    });
    // Worth stating: this is the one input that looks supplied and is not.
    expect(r.body.generated).toBe(true);
    expect(await storedSecret("2055")).toBe(r.body.secret);
  });

  it("creates nothing at all when the supplied password fails the policy", async () => {
    const r = await call("/api/extensions", {
      as: ADMIN,
      method: "POST",
      body: { pbx_id: "site1", number: "2056", secret: "nodigits" },
    });

    expect(r.status).toBe(400);
    // The row must not exist: a half-created extension would shadow the file
    // definition with an endpoint nobody can register against.
    const row = await DB.prepare(
      "SELECT number FROM extension WHERE pbx_id = 'site1' AND number = '2056'",
    ).first();
    expect(row).toBeNull();
  });

  it("refuses a secret on a directory-only entry rather than generating one", async () => {
    const r = await call("/api/extensions", {
      as: ADMIN,
      method: "POST",
      body: {
        pbx_id: "site1",
        number: "2057",
        directory_only: true,
        secret: "Existing9pass",
      },
    });
    expect(r.status).toBe(400);
  });

  it("reports no generated secret for a directory-only entry", async () => {
    const r = await call("/api/extensions", {
      as: ADMIN,
      method: "POST",
      body: { pbx_id: "site1", number: "2058", directory_only: true },
    });
    expect(r.status).toBe(201);
    expect(r.body.generated).toBe(false);
    expect(r.body.secret).toBeNull();
    expect(await storedSecret("2058")).toBeNull();
  });
});

describe("changing an extension's secret", () => {
  it("generates one on request and reveals it exactly once", async () => {
    const before = await storedSecret("2050");

    const r = await call("/api/extensions/site1/2050", {
      as: SALES,
      method: "PUT",
      body: { rotate_secret: true },
    });

    expect(r.status).toBe(200);
    expect(r.body.secret).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(await storedSecret("2050")).toBe(r.body.secret);
    expect(await storedSecret("2050")).not.toBe(before);

    // Never again: a plain edit afterwards returns no secret at all.
    const again = await call("/api/extensions/site1/2050", {
      as: SALES,
      method: "PUT",
      body: { display_name: "Sales desk 2" },
    });
    expect(again.body).toEqual({ ok: true });
  });

  it("stores a supplied secret without echoing it back", async () => {
    const r = await call("/api/extensions/site1/2050", {
      as: SALES,
      method: "PUT",
      body: { secret: "Adopted99pass" },
    });

    expect(r.status).toBe(200);
    // The caller already holds it; returning it would only put it back on the
    // wire and on screen.
    expect(r.body).toEqual({ ok: true });
    expect(await storedSecret("2050")).toBe("Adopted99pass");
  });

  it("trims a supplied secret rather than storing the whitespace", async () => {
    await call("/api/extensions/site1/2050", {
      as: SALES,
      method: "PUT",
      body: { secret: "  Adopted99pass  " },
    });
    expect(await storedSecret("2050")).toBe("Adopted99pass");
  });

  it("leaves the secret alone when the request does not mention it", async () => {
    const before = await storedSecret("2050");
    const r = await call("/api/extensions/site1/2050", {
      as: SALES,
      method: "PUT",
      body: { display_name: "Renamed", secret: "" },
    });
    expect(r.status).toBe(200);
    expect(await storedSecret("2050")).toBe(before);
  });

  // The silent-failure case this feature would otherwise have.
  it("queues a push of the auth object, which the diff cannot see", async () => {
    const beforeOps = await opsFor("2050");

    await call("/api/extensions/site1/2050", {
      as: SALES,
      method: "PUT",
      body: { secret: "Adopted99pass" },
    });

    expect(await opsFor("2050")).toBe(beforeOps + 1);
  });

  it("queues no push when nothing about the secret changed", async () => {
    const beforeOps = await opsFor("2050");
    await call("/api/extensions/site1/2050", {
      as: SALES,
      method: "PUT",
      body: { display_name: "Renamed" },
    });
    // The display name lands on the endpoint object, not on auth.
    expect(await opsFor("2050")).toBe(beforeOps);
  });

  it("records the credential change under its own audit action", async () => {
    await call("/api/extensions/site1/2050", {
      as: SALES,
      method: "PUT",
      body: { rotate_secret: true },
    });
    await call("/api/extensions/site1/2050", {
      as: SALES,
      method: "PUT",
      body: { secret: "Adopted99pass" },
    });

    expect(await actions()).toEqual([
      "create_extension",
      "update_extension",
      "rotate_extension_secret",
      "update_extension",
      "set_extension_secret",
    ]);
  });
});

describe("who may change a secret", () => {
  it("lets the owning user set their own", async () => {
    const r = await call("/api/extensions/site1/2050", {
      as: SALES,
      method: "PUT",
      body: { secret: "Adopted99pass" },
    });
    expect(r.status).toBe(200);
  });

  it("lets an admin set one on an extension they do not own", async () => {
    const r = await call("/api/extensions/site1/2050", {
      as: ADMIN,
      method: "PUT",
      body: { secret: "Adopted99pass" },
    });
    expect(r.status).toBe(200);
    expect(await storedSecret("2050")).toBe("Adopted99pass");
  });

  it("refuses a user reaching for someone else's extension", async () => {
    const before = await storedSecret("2050");
    const r = await call("/api/extensions/site1/2050", {
      as: OTHER,
      method: "PUT",
      body: { secret: "Adopted99pass" },
    });
    expect(r.status).toBe(403);
    expect(await storedSecret("2050")).toBe(before);
  });
});

describe("rejected secret changes", () => {
  const bad: [string, string, RegExp][] = [
    ["too short", "Ab3", /at least 8/],
    ["no uppercase", "lowercase99", /uppercase/],
    ["no digit", "NoDigitsHere", /digit/],
    ["contains a space", "With Space9", /whitespace/],
  ];

  for (const [why, secret, expected] of bad) {
    it(`refuses one that is ${why}, leaving the stored secret intact`, async () => {
      const before = await storedSecret("2050");
      const r = await call("/api/extensions/site1/2050", {
        as: SALES,
        method: "PUT",
        body: { secret },
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(expected);
      expect(await storedSecret("2050")).toBe(before);
    });
  }

  it("refuses both instructions at once rather than guessing", async () => {
    const r = await call("/api/extensions/site1/2050", {
      as: SALES,
      method: "PUT",
      body: { secret: "Adopted99pass", rotate_secret: true },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not both/);
  });

  it("refuses a secret on a directory-only entry, which has no SIP presence", async () => {
    await call("/api/extensions", {
      as: SALES,
      method: "POST",
      body: {
        pbx_id: "site1",
        number: "2051",
        display_name: "Front desk phonebook",
        directory_only: true,
      },
    });
    expect(await storedSecret("2051")).toBeNull();

    for (const body of [{ secret: "Adopted99pass" }, { rotate_secret: true }]) {
      const r = await call("/api/extensions/site1/2051", {
        as: SALES,
        method: "PUT",
        body,
      });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/directory-only/);
    }
    expect(await storedSecret("2051")).toBeNull();
  });

  it("applies the same policy at creation", async () => {
    const r = await call("/api/extensions", {
      as: SALES,
      method: "POST",
      body: { pbx_id: "site1", number: "2052", secret: "weak" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at least 8/);

    const row = await DB.prepare(
      "SELECT number FROM extension WHERE pbx_id = 'site1' AND number = '2052'",
    ).first();
    expect(row).toBeNull();
  });
});

describe("secret policy", () => {
  it("accepts what the generator produces", () => {
    // Generated secrets must pass the policy applied to supplied ones, or the
    // GUI's own default would be rejected on the next edit.
    expect(validateSecret("Xy7kQ2mB9nR4tL6wS8vZ")).toBeNull();
  });

  it("names the specific problem, so the GUI can show it verbatim", () => {
    expect(validateSecret("Ab3")).toMatch(/at least 8/);
    expect(validateSecret("nouppercase9")).toMatch(/uppercase/);
    expect(validateSecret("NoDigitsAtAll")).toMatch(/digit/);
    expect(validateSecret("Tab\t99Sep")).toMatch(/whitespace/);
    expect(validateSecret("Null\u0000Byte9")).toMatch(/control/);
    expect(validateSecret(`A9${"x".repeat(200)}`)).toMatch(/at most 128/);
  });
});
