import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../migrations/0001_initial.sql?raw";
import app from "../src/index.js";
import { buildDesired } from "../src/model/compile.js";
import { isSecretTuple, type Env } from "../src/types.js";

/**
 * The profile is what carries an endpoint's codecs. Without one the expansion
 * gets an empty attribute bag and pushes an endpoint holding nothing but its
 * derived fields — no `allow`, no `rewrite_contact`, no `rtp_symmetric`. That
 * object pushes cleanly, the PBX converges and the phone registers; every call
 * then fails. It is the same silent shape as the blank-context bug in
 * migration 0003, which is why these assert on what reaches the PBX rather
 * than only on what the route stored.
 *
 * Three defects are covered here:
 *
 *  - `PUT` bound `body.profile_id ?? null` into `COALESCE(?, profile_id)`, so
 *    the picker's "none" (sent as null) was read as "field absent" and quietly
 *    kept the profile it was meant to remove.
 *  - Neither write path checked that the profile's tech matched the
 *    extension's, and an SCCP profile on a PJSIP extension contributes no
 *    endpoint attributes at all — a codec-less endpoint by another route.
 *  - The picker's list came from `/admin/profiles`, so a delegated user could
 *    not see profiles and self-service could only ever produce a broken phone.
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
  opts: { method?: string; body?: unknown; viewAs?: string } = {},
): Promise<{ status: number; body: any }> {
  const res = await app.fetch(
    new Request(`https://aem.example.se${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(opts.viewAs ? { "X-Impersonate": opts.viewAs } : {}),
      },
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

const profileOf = async (number: string): Promise<string | null> =>
  (
    await DB.prepare(
      "SELECT profile_id FROM extension WHERE pbx_id = 'site1' AND number = ?",
    )
      .bind(number)
      .first<{ profile_id: string | null }>()
  )?.profile_id ?? null;

/** The codec list actually pushed for an extension's endpoint, if any. */
async function pushedCodecs(number: string): Promise<string | undefined> {
  const objects = await buildDesired(DB, "site1");
  const endpoint = objects.find(
    (o) => o.objectType === "endpoint" && o.objectId === number,
  );
  const tuple = endpoint?.attrs.find((a) => a.attribute === "allow");
  return tuple && !isSecretTuple(tuple) ? tuple.value : undefined;
}

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
     VALUES (?, 'admin', 'Admin', NULL, NULL, 1)`,
  )
    .bind(ADMIN)
    .run();

  await DB.prepare(
    `INSERT INTO app_user (email, role, display_name, min_ext, max_ext, call_log_access)
     VALUES (?, 'user', 'User', 1000, 1999, 0)`,
  )
    .bind(USER)
    .run();

  await DB.prepare(
    `INSERT INTO profile (id, tech, name, attrs_json) VALUES
       ('desk', 'pjsip', 'Desk phone', ?),
       ('sccp-desk', 'sccp', 'SCCP desk', ?)`,
  )
    .bind(
      JSON.stringify({ endpoint: { allow: "ulaw,alaw,g722" }, aor: {}, auth: {} }),
      JSON.stringify({ device: {}, line: {} }),
    )
    .run();
});

describe("choosing a profile", () => {
  it("stores and pushes the profile chosen on create", async () => {
    const res = await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1001", profile_id: "desk" },
    });
    expect(res.status).toBe(201);
    expect(await profileOf("1001")).toBe("desk");
    expect(await pushedCodecs("1001")).toBe("ulaw,alaw,g722");
  });

  it("pushes an endpoint with no codecs when no profile is chosen", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1002" },
    });
    // Not an assertion that this is *desired* — it is the hazard the picker
    // exists to avoid, and it registers happily before failing every call.
    expect(await profileOf("1002")).toBeNull();
    expect(await pushedCodecs("1002")).toBeUndefined();
  });

  it("attaches a profile to an extension that had none", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1003" },
    });

    const res = await call("/api/extensions/site1/1003", {
      method: "PUT",
      body: { profile_id: "desk" },
    });
    expect(res.status).toBe(200);
    expect(await profileOf("1003")).toBe("desk");
    expect(await pushedCodecs("1003")).toBe("ulaw,alaw,g722");
  });

  it("clears the profile when the picker's none is sent", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1004", profile_id: "desk" },
    });

    // The regression: the GUI sends the "none" option as null, which COALESCE
    // read as "leave it alone".
    const res = await call("/api/extensions/site1/1004", {
      method: "PUT",
      body: { profile_id: null },
    });
    expect(res.status).toBe(200);
    expect(await profileOf("1004")).toBeNull();
  });

  it("treats a blank profile the same as none", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1005", profile_id: "desk" },
    });
    await call("/api/extensions/site1/1005", {
      method: "PUT",
      body: { profile_id: "  " },
    });
    expect(await profileOf("1005")).toBeNull();
  });

  it("leaves the profile alone when the field is absent", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1006", profile_id: "desk" },
    });
    await call("/api/extensions/site1/1006", {
      method: "PUT",
      body: { display_name: "Renamed" },
    });
    expect(await profileOf("1006")).toBe("desk");
  });

  it("ignores a blank profile on create rather than storing one", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1007", profile_id: "" },
    });
    expect(await profileOf("1007")).toBeNull();
  });
});

describe("profile validation", () => {
  it("refuses a profile belonging to the other tech on create", async () => {
    const res = await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1008", profile_id: "sccp-desk" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sccp profile/);
    expect(await profileOf("1008")).toBeNull();
  });

  it("refuses a profile belonging to the other tech on update", async () => {
    await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1009", profile_id: "desk" },
    });
    const res = await call("/api/extensions/site1/1009", {
      method: "PUT",
      body: { profile_id: "sccp-desk" },
    });
    expect(res.status).toBe(400);
    expect(await profileOf("1009")).toBe("desk");
  });

  it("refuses an unknown profile", async () => {
    const res = await call("/api/extensions", {
      method: "POST",
      body: { pbx_id: "site1", number: "1010", profile_id: "nope" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown profile/);
  });

  it("accepts an sccp profile on an sccp extension", async () => {
    const res = await call("/api/extensions", {
      method: "POST",
      body: {
        pbx_id: "site1",
        number: "1011",
        tech: "sccp",
        profile_id: "sccp-desk",
      },
    });
    expect(res.status).toBe(201);
    expect(await profileOf("1011")).toBe("sccp-desk");
  });
});

describe("the picker's profile list", () => {
  it("is readable by a delegated user, who could not see /admin/profiles", async () => {
    const admin = await call("/api/admin/profiles", { viewAs: USER });
    expect(admin.status).toBe(403);

    const res = await call("/api/profiles", { viewAs: USER });
    expect(res.status).toBe(200);
    expect(res.body.map((p: { id: string }) => p.id).sort()).toEqual([
      "desk",
      "sccp-desk",
    ]);
  });

  it("withholds the attribute bags, which stay admin-only", async () => {
    const res = await call("/api/profiles");
    expect(res.status).toBe(200);
    expect(res.body[0]).not.toHaveProperty("attrs_json");
    expect(Object.keys(res.body[0]).sort()).toEqual(["id", "name", "tech"]);
  });

  it("lets a delegated user create a working extension", async () => {
    const res = await call("/api/extensions", {
      method: "POST",
      viewAs: USER,
      body: { pbx_id: "site1", number: "1012", profile_id: "desk" },
    });
    expect(res.status).toBe(201);
    expect(await pushedCodecs("1012")).toBe("ulaw,alaw,g722");
  });
});
