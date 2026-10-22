import { Hono } from "hono";

import {
  applyImpersonation,
  auditActor,
  authenticate,
  inRange,
  type Identity,
} from "../lib/access.js";
import {
  encryptSecret,
  generateSecret,
  validateSecret,
} from "../lib/crypto.js";
import { buildDesired, compilePbx, touchObject } from "../model/compile.js";
import { buttonProblem } from "../model/sccp/button.js";
import { BUTTON_KINDS, DEVICE_ID_RE } from "../model/sccp/options.js";
import { validateSccpInventory } from "../model/sccp/validate.js";
import { renderBundle } from "../render/bundle.js";
import {
  defaultSettings,
  parseSettings,
  type PbxSettings,
} from "../render/settings.js";
import { toAscii } from "../lib/ascii.js";
import type { Env } from "../types.js";

type Vars = { identity: Identity };

export const api = new Hono<{ Bindings: Env; Variables: Vars }>();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Refuse cross-site writes.
 *
 * Browser auth is the Access cookie, which the browser attaches to any request
 * to this origin — including a `<form enctype="text/plain">` POST from another
 * site whose body happens to be valid JSON, or a body-less `no-cors` fetch to
 * `/resync`. Neither triggers a preflight, and `c.req.json()` does not care
 * about Content-Type. So every unsafe method must prove it came from this
 * origin: `Sec-Fetch-Site` where the browser sends it, `Origin` otherwise.
 * Non-browser clients (service tokens, curl) send neither and are unaffected.
 */
api.use("*", async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }
  const site = c.req.header("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") {
    return c.json({ error: "cross-site request refused" }, 403);
  }
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: "cross-site request refused" }, 403);
  }
  // A body this API reads is always JSON. Refusing the form encodings closes
  // the simple-request path even for a browser that sends neither header.
  const type = c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (
    type === "text/plain" ||
    type === "application/x-www-form-urlencoded" ||
    type === "multipart/form-data"
  ) {
    return c.json({ error: "request body must be application/json" }, 415);
  }
  await next();
});

api.use("*", async (c, next) => {
  let real: Identity | null;
  try {
    real = await authenticate(c.req.raw, c.env);
  } catch (e) {
    console.error("auth failed", e);
    return c.json({ error: "authentication failed" }, 401);
  }
  if (!real) return c.json({ error: "unauthenticated" }, 401);

  // Everything downstream — including the admin gate below — sees the
  // impersonated identity, which is the point: an admin viewing as a user must
  // hit the same 403s and the same range checks that user would.
  const view = await applyImpersonation(c.req.raw, c.env, real);
  if (!view.ok) return c.json({ error: view.error }, view.status);

  c.set("identity", view.identity);
  await next();
});

api.use("/admin/*", async (c, next) => {
  if (c.get("identity").role !== "admin") {
    return c.json({ error: "admin role required" }, 403);
  }
  await next();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function audit(
  env: Env,
  actor: Identity,
  action: string,
  detail: string,
): Promise<void> {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (actor, action, detail) VALUES (?, ?, ?)",
    )
      .bind(auditActor(actor), action, detail)
      .run();
  } catch (e) {
    // Auditing must never fail a request, matching v1's deliberate choice.
    console.error("audit write failed", e);
  }
}

/**
 * Recompile desired state and wake the Durable Object.
 *
 * Notifying is best-effort: if the PBX is offline the DO simply has nothing to
 * do, and its next connect triggers a full sweep anyway.
 *
 * `mustNotify` covers the one case where the compile legitimately finds nothing
 * — a secret change, whose op_log row is written directly by `touchObject`
 * rather than falling out of the diff.
 */
async function syncPbx(
  env: Env,
  pbxId: string,
  mustNotify = false,
): Promise<void> {
  const result = await compilePbx(env.DB, pbxId);
  if (!result.changed && !mustNotify) return;
  try {
    await env.PBX.getByName(pbxId).notifyChange();
  } catch (e) {
    console.error(`notify ${pbxId} failed`, e);
  }
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const ATTR_KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Validate an `overrides` body before it is stored.
 *
 * Shape matters as much as content: `expand` calls `.replace` on every value,
 * so a single number or null in one extension's overrides used to throw inside
 * `compilePbx` and stop every later write to that PBX. Keys are restricted to
 * the object types this tech expands to, and to attribute names that cannot
 * carry a newline or section header. `type` belongs to the expansion (and
 * chan_sccp2 rejects it outright); `password` would duplicate the secret_ref
 * the DO appends.
 */
function badOverrides(
  ov: unknown,
  objectTypes: readonly string[],
): string | null {
  if (typeof ov !== "object" || ov === null || Array.isArray(ov)) {
    return "overrides must be an object";
  }
  for (const [objType, attrs] of Object.entries(ov)) {
    if (!objectTypes.includes(objType)) {
      return `overrides: unknown object "${objType}" (expected ${objectTypes.join(", ")})`;
    }
    if (typeof attrs !== "object" || attrs === null || Array.isArray(attrs)) {
      return `overrides.${objType} must be an object`;
    }
    for (const [key, value] of Object.entries(attrs)) {
      if (!ATTR_KEY_RE.test(key)) {
        return `overrides.${objType}: invalid attribute name "${key}"`;
      }
      if (key === "type" || key === "password") {
        return `overrides.${objType}.${key} is managed by the expansion`;
      }
      if (typeof value !== "string") {
        return `overrides.${objType}.${key} must be a string`;
      }
      if (value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) {
        return `overrides.${objType}.${key} is too long or contains control characters`;
      }
    }
  }
  return null;
}

function overrideTypesFor(tech: "pjsip" | "sccp"): readonly string[] {
  return tech === "pjsip" ? ["auth", "aor", "endpoint"] : ["line"];
}

/** Is this number blocked, or outside the caller's delegated range? */
async function checkExtensionAllowed(
  env: Env,
  id: Identity,
  pbxId: string,
  number: string,
): Promise<string | null> {
  if (!/^\d{2,10}$/.test(number)) {
    return "extension must be 2-10 digits";
  }
  if (!inRange(id, number)) {
    return id.minExt === null
      ? "you have no delegated extension range; ask an administrator"
      : `extension must be between ${id.minExt} and ${id.maxExt}`;
  }
  // Admins bypass the range but not the blocked list, so a reserved number
  // stays reserved even for them.
  const blocked = await env.DB.prepare(
    "SELECT reason FROM blocked_extension WHERE pbx_id = ? AND number = ?",
  )
    .bind(pbxId, number)
    .first<{ reason: string }>();
  if (blocked) {
    return `extension ${number} is blocked${blocked.reason ? `: ${blocked.reason}` : ""}`;
  }
  return null;
}

/** What a request asked to happen to an extension's SIP secret. */
type SecretIntent =
  | { kind: "keep" }
  | { kind: "generate" }
  | { kind: "supplied"; secret: string }
  | { kind: "invalid"; error: string };

/**
 * Read a secret change out of a request body.
 *
 * `rotate_secret` generates one; a non-empty `secret` sets that exact value.
 * They are mutually exclusive rather than one winning silently: a caller that
 * sends both has a bug, and guessing which they meant would either discard a
 * password they hold or leave a phone unable to register.
 *
 * A directory-only extension has no SIP presence at all, so any secret change
 * against one is a mistake worth reporting instead of dropping on the floor.
 */
function readSecretIntent(
  body: { secret?: string; rotate_secret?: boolean },
  directoryOnly: boolean,
): SecretIntent {
  const supplied = typeof body.secret === "string" ? body.secret.trim() : "";
  const rotate = body.rotate_secret === true;

  if (!supplied && !rotate) return { kind: "keep" };
  if (supplied && rotate) {
    return {
      kind: "invalid",
      error: "send either secret or rotate_secret, not both",
    };
  }
  if (directoryOnly) {
    return {
      kind: "invalid",
      error: "a directory-only extension has no SIP secret",
    };
  }
  if (rotate) return { kind: "generate" };

  const problem = validateSecret(supplied);
  return problem
    ? { kind: "invalid", error: problem }
    : { kind: "supplied", secret: supplied };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

api.get("/me", (c) => c.json(c.get("identity")));

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------

api.get("/extensions", async (c) => {
  const id = c.get("identity");
  const pbxId = c.req.query("pbx");

  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (pbxId) {
    conditions.push("pbx_id = ?");
    binds.push(pbxId);
  }
  if (id.role !== "admin") {
    conditions.push("owner_email = ?");
    binds.push(id.email);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const res = await c.env.DB.prepare(
    `SELECT id, pbx_id, number, display_name, tech, profile_id, context,
            directory_only, owner_email, created_at,
            CASE WHEN secret_enc IS NULL THEN 0 ELSE 1 END AS secret_set
       FROM extension ${where} ORDER BY pbx_id, number`,
  )
    .bind(...binds)
    .all();

  // Note the absence of the secret itself: it is revealed once at creation
  // and never returned again.
  return c.json(res.results ?? []);
});

/**
 * Resolve a caller-supplied context to one that will actually route.
 *
 * Blank means "use the managed context", never an empty value. Stored empty it
 * survives the update's `COALESCE` — SQL treats `''` as a value, not as absent —
 * and `tuples()` then reads the empty string as a removal and drops the
 * attribute altogether, so the endpoint inherits Asterisk's own context, which
 * is confusingly also called `default`. Calls from the phone land nowhere near
 * the dialplan this app generates, and nothing reports it: the object pushes
 * cleanly, the PBX converges, and the extension is simply unreachable.
 *
 * Resolved against the PBX's own `dialplan.context` rather than a literal, so
 * renaming the managed context does not leave older extensions behind.
 *
 * Only admins may choose anything else. The context decides what a phone can
 * dial, so a delegated user pointing their own extension at a trunk context is
 * toll fraud. A non-admin may still resubmit the value already stored
 * (`current`), because the edit form sends the context back on every save.
 */
async function resolveContext(
  env: Env,
  id: Identity,
  pbxId: string,
  supplied: unknown,
  host: string,
  current: string | null = null,
): Promise<{ ok: true; context: string } | { ok: false; error: string }> {
  if (supplied != null && typeof supplied !== "string") {
    return { ok: false, error: "context must be a string" };
  }
  const row = await env.DB.prepare("SELECT settings_json FROM pbx WHERE id = ?")
    .bind(pbxId)
    .first<{ settings_json: string }>();
  const managed = parseSettings(row?.settings_json ?? "", pbxId, host).dialplan
    .context;

  const trimmed = supplied?.trim();
  if (!trimmed) return { ok: true, context: managed };
  if (!NAME_RE.test(trimmed)) {
    return { ok: false, error: "context must be letters, digits, _ or -" };
  }
  if (id.role !== "admin" && trimmed !== managed && trimmed !== current) {
    return {
      ok: false,
      error: `only administrators can set a context other than ${managed}`,
    };
  }
  return { ok: true, context: trimmed };
}

/**
 * Reject a profile that cannot apply to this extension.
 *
 * A tech mismatch is worth a 400 rather than a shrug. The expansion reads
 * `attrs.endpoint`/`aor`/`auth` for PJSIP and `attrs.device`/`line` for SCCP,
 * so an SCCP profile on a PJSIP extension contributes *nothing* — the endpoint
 * is pushed carrying only its derived fields, with no `allow` codec list, and
 * an endpoint with no codecs cannot complete a call. That is the same silent
 * failure as having no profile at all: the object pushes, the PBX converges,
 * the phone registers, and every call fails.
 */
async function checkProfile(
  env: Env,
  profileId: string | null,
  tech: "pjsip" | "sccp",
): Promise<string | null> {
  if (!profileId) return null;
  const row = await env.DB.prepare("SELECT tech FROM profile WHERE id = ?")
    .bind(profileId)
    .first<{ tech: "pjsip" | "sccp" }>();
  if (!row) return `unknown profile: ${profileId}`;
  if (row.tech !== tech) {
    return `profile ${profileId} is a ${row.tech} profile; this extension is ${tech}`;
  }
  return null;
}

api.post("/extensions", async (c) => {
  const id = c.get("identity");
  const body = await c.req.json<{
    pbx_id?: string;
    number?: string;
    display_name?: string;
    tech?: "pjsip" | "sccp";
    profile_id?: string | null;
    context?: string;
    directory_only?: boolean;
    secret?: string;
  }>();

  if (
    typeof body.pbx_id !== "string" ||
    typeof body.number !== "string" ||
    (body.display_name !== undefined && typeof body.display_name !== "string") ||
    (body.profile_id != null && typeof body.profile_id !== "string") ||
    (body.tech !== undefined && body.tech !== "pjsip" && body.tech !== "sccp")
  ) {
    return c.json({ error: "malformed request body" }, 400);
  }
  const pbxId = body.pbx_id;
  const number = body.number.trim();
  if (!pbxId || !number) {
    return c.json({ error: "pbx_id and number are required" }, 400);
  }

  const problem = await checkExtensionAllowed(c.env, id, pbxId, number);
  if (problem) return c.json({ error: problem }, 403);

  const ctx = await resolveContext(
    c.env,
    id,
    pbxId,
    body.context,
    new URL(c.req.url).host,
  );
  if (!ctx.ok) return c.json({ error: ctx.error }, id.role === "admin" ? 400 : 403);

  const tech = body.tech ?? "pjsip";
  const directoryOnly = body.directory_only === true;

  const profileId = body.profile_id?.trim() || null;
  const profileProblem = await checkProfile(c.env, profileId, tech);
  if (profileProblem) return c.json({ error: profileProblem }, 400);

  // A blank secret on create means "generate one" — the same field, left empty,
  // that the edit form treats as "leave it alone".
  const intent = readSecretIntent(body, directoryOnly);
  if (intent.kind === "invalid") return c.json({ error: intent.error }, 400);

  const secret =
    intent.kind === "supplied"
      ? intent.secret
      : directoryOnly
        ? null
        : generateSecret();
  const secretEnc = secret
    ? await encryptSecret(c.env.SECRET_KEY, secret)
    : null;

  try {
    await c.env.DB.prepare(
      `INSERT INTO extension (pbx_id, number, display_name, tech, profile_id,
                              context, directory_only, secret_enc, owner_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        pbxId,
        number,
        body.display_name ?? "",
        tech,
        profileId,
        ctx.context,
        directoryOnly ? 1 : 0,
        secretEnc,
        id.email,
      )
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint/i.test(msg)) {
      return c.json({ error: `extension ${number} already exists` }, 409);
    }
    throw e;
  }

  if (tech === "sccp") {
    const invalid = await validateSccpForPbx(c.env, pbxId);
    if (invalid) {
      // One bad line fails chan_sccp2's whole inventory reload, so it must not
      // be left behind for the reconciler to trip over.
      await c.env.DB.prepare(
        "DELETE FROM extension WHERE pbx_id = ? AND number = ?",
      )
        .bind(pbxId, number)
        .run();
      return c.json({ error: `SCCP inventory would be invalid: ${invalid}` }, 400);
    }
  }

  await audit(c.env, id, "create_extension", `${pbxId}/${number}`);
  await syncPbx(c.env, pbxId);

  // Revealed only when generated here, exactly as `PUT` does. Echoing a
  // supplied secret back put a credential the caller already holds onto the
  // wire and onto the screen for nothing — and, because both cases looked
  // identical in the response, it left the GUI deciding whether to show a
  // "here is your new password" toast by inspecting its own form state. A
  // caller adopting an existing handset needs to know the difference for
  // certain: `generated: false` is the confirmation that the password it sent
  // is the password now stored.
  const generated = intent.kind !== "supplied" && secret !== null;
  return c.json(
    { pbx_id: pbxId, number, secret: generated ? secret : null, generated },
    201,
  );
});

api.put("/extensions/:pbx/:number", async (c) => {
  const id = c.get("identity");
  const pbxId = c.req.param("pbx");
  const number = c.req.param("number");

  const existing = await c.env.DB.prepare(
    `SELECT owner_email, directory_only, tech, display_name, profile_id,
            context, overrides_json, secret_enc
       FROM extension WHERE pbx_id = ? AND number = ?`,
  )
    .bind(pbxId, number)
    .first<{
      owner_email: string | null;
      directory_only: number;
      tech: "pjsip" | "sccp";
      display_name: string;
      profile_id: string | null;
      context: string;
      overrides_json: string;
      secret_enc: string | null;
    }>();
  if (!existing) return c.json({ error: "not found" }, 404);
  if (id.role !== "admin" && existing.owner_email !== id.email) {
    return c.json({ error: "not yours" }, 403);
  }

  const body = await c.req.json<{
    display_name?: string;
    profile_id?: string | null;
    context?: string;
    overrides?: Record<string, unknown>;
    rotate_secret?: boolean;
    secret?: string;
    tech?: "pjsip" | "sccp";
  }>();

  if (
    (body.display_name != null && typeof body.display_name !== "string") ||
    (body.profile_id != null && typeof body.profile_id !== "string") ||
    (body.tech !== undefined && body.tech !== "pjsip" && body.tech !== "sccp")
  ) {
    return c.json({ error: "malformed request body" }, 400);
  }

  // Changing technology migrates a number between PJSIP and SCCP in place,
  // keeping its number, owner, context and secret. Admin-only: SCCP lines are
  // only reachable through devices, which are an administrator's inventory.
  const tech = body.tech ?? existing.tech;
  const techChanged = tech !== existing.tech;
  if (techChanged && id.role !== "admin") {
    return c.json({ error: "only administrators can change the technology" }, 403);
  }

  // Overrides reach any attribute on the pushed objects — caller-ID trust,
  // channel variables, a static contact that sends the extension's calls
  // off-box — so they are an administrator's tool, not a delegated user's.
  if (body.overrides !== undefined) {
    if (id.role !== "admin") {
      return c.json({ error: "only administrators can set overrides" }, 403);
    }
    const bad = badOverrides(body.overrides, overrideTypesFor(tech));
    if (bad) return c.json({ error: bad }, 400);
  }

  let context: string | null = null;
  if (body.context !== undefined) {
    const ctx = await resolveContext(
      c.env,
      id,
      pbxId,
      body.context,
      new URL(c.req.url).host,
      existing.context,
    );
    if (!ctx.ok) {
      return c.json({ error: ctx.error }, id.role === "admin" ? 400 : 403);
    }
    context = ctx.context;
  }

  const intent = readSecretIntent(body, existing.directory_only === 1);
  if (intent.kind === "invalid") return c.json({ error: intent.error }, 400);

  // Absent means "leave it alone"; present-but-blank means "no profile at all".
  // COALESCE cannot draw that distinction — SQL spells both as NULL — so the
  // update carries an explicit flag instead.
  //
  // `context` had the mirror image of this bug (migration 0003): there '' was
  // treated as a value and silently emptied the column. Here it went the other
  // way — the GUI sends its "none" option as null, COALESCE read that as
  // absent, and choosing none quietly kept the profile it was meant to remove.
  //
  // A technology change always rewrites the profile: the old one belongs to the
  // other technology and could not be used, so absent means "none" there.
  const profileGiven = body.profile_id !== undefined || techChanged;
  const profileId = profileGiven ? body.profile_id?.trim() || null : null;
  if (profileGiven) {
    const problem = await checkProfile(c.env, profileId, tech);
    if (problem) return c.json({ error: problem }, 400);
  }
  // Likewise the overrides: they are keyed by the old technology's object
  // types, which the new expansion would reject.
  const overridesJson = body.overrides
    ? JSON.stringify(body.overrides)
    : techChanged
      ? "{}"
      : null;

  // Revealed only when generated here. A supplied secret is one the caller
  // already holds, so returning it would put a credential back on the wire
  // (and on screen) for nothing.
  let newSecret: string | null = null;
  let secretEnc: string | null = null;
  //
  // A number becoming PJSIP with no stored secret would push an auth object
  // with no password, so one is generated exactly as on create.
  const needsSecret =
    techChanged &&
    tech === "pjsip" &&
    existing.directory_only !== 1 &&
    existing.secret_enc === null &&
    intent.kind === "keep";
  if (intent.kind === "generate" || needsSecret) {
    newSecret = generateSecret();
    secretEnc = await encryptSecret(c.env.SECRET_KEY, newSecret);
  } else if (intent.kind === "supplied") {
    secretEnc = await encryptSecret(c.env.SECRET_KEY, intent.secret);
  }

  await c.env.DB.prepare(
    `UPDATE extension SET
       tech           = ?,
       display_name   = COALESCE(?, display_name),
       profile_id     = CASE WHEN ? = 1 THEN ? ELSE profile_id END,
       context        = COALESCE(?, context),
       overrides_json = COALESCE(?, overrides_json),
       secret_enc     = COALESCE(?, secret_enc)
     WHERE pbx_id = ? AND number = ?`,
  )
    .bind(
      tech,
      body.display_name ?? null,
      profileGiven ? 1 : 0,
      profileId,
      // Absent means "leave it alone"; present-but-blank means "back to the
      // managed context". Passing '' straight through is what silently
      // misrouted the endpoint — see resolveContext.
      context,
      overridesJson,
      secretEnc,
      pbxId,
      number,
    )
    .run();

  // Leaving SCCP is validated too: a device whose line button still names this
  // number would otherwise reference a line that no longer exists.
  if (existing.tech === "sccp" || tech === "sccp") {
    const invalid = await validateSccpForPbx(c.env, pbxId);
    if (invalid) {
      await c.env.DB.prepare(
        `UPDATE extension SET tech = ?, display_name = ?, profile_id = ?, context = ?,
                overrides_json = ?, secret_enc = ?
          WHERE pbx_id = ? AND number = ?`,
      )
        .bind(
          existing.tech,
          existing.display_name,
          existing.profile_id,
          existing.context,
          existing.overrides_json,
          existing.secret_enc,
          pbxId,
          number,
        )
        .run();
      return c.json({ error: `SCCP inventory would be invalid: ${invalid}` }, 400);
    }
  }

  await audit(
    c.env,
    id,
    "update_extension",
    `${pbxId}/${number}${techChanged ? ` (tech ${existing.tech}→${tech})` : ""}`,
  );
  // A credential change gets its own action rather than hiding inside a generic
  // update, so the audit view can be read for "who changed a password".
  if (intent.kind !== "keep") {
    await audit(
      c.env,
      id,
      intent.kind === "generate"
        ? "rotate_extension_secret"
        : "set_extension_secret",
      `${pbxId}/${number}`,
    );
  }

  // Only PJSIP carries the secret into pushed config: chan_sccp2 lines
  // authenticate by device, so an SCCP secret is stored but has no auth object
  // to re-push. The auth object's sorcery id is the bare extension number.
  // After a technology change the auth object is new anyway, so it needs no
  // separate touch.
  const pushSecret = intent.kind !== "keep" && tech === "pjsip" && !techChanged;
  if (pushSecret) {
    await touchObject(c.env.DB, pbxId, "res_pjsip", "auth", number);
  }
  await syncPbx(c.env, pbxId, pushSecret);

  return c.json({ ok: true, ...(newSecret ? { secret: newSecret } : {}) });
});

api.delete("/extensions/:pbx/:number", async (c) => {
  const id = c.get("identity");
  const pbxId = c.req.param("pbx");
  const number = c.req.param("number");

  const existing = await c.env.DB.prepare(
    "SELECT owner_email FROM extension WHERE pbx_id = ? AND number = ?",
  )
    .bind(pbxId, number)
    .first<{ owner_email: string | null }>();
  if (!existing) return c.json({ error: "not found" }, 404);
  if (id.role !== "admin" && existing.owner_email !== id.email) {
    return c.json({ error: "not yours" }, 403);
  }

  await c.env.DB.prepare(
    "DELETE FROM extension WHERE pbx_id = ? AND number = ?",
  )
    .bind(pbxId, number)
    .run();

  await audit(c.env, id, "delete_extension", `${pbxId}/${number}`);
  await syncPbx(c.env, pbxId);

  return c.json({ ok: true });
});

/**
 * The profile picker's list, readable by anyone who may create an extension.
 *
 * `/admin/profiles` is admin-gated and returns the full attribute bags, so a
 * delegated user had no way to see profiles at all — and an extension created
 * without one expands to an endpoint with no codecs, which registers fine and
 * then fails every call. Self-service could not produce a working phone.
 *
 * Only what the picker needs: the attribute bags stay admin-only, since they
 * are where a site's NAT and codec policy is legible.
 */
api.get("/profiles", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT id, tech, name FROM profile ORDER BY tech, name",
  ).all();
  return c.json(res.results ?? []);
});

// ---------------------------------------------------------------------------
// Directory (in-app, distinct from the Cisco XML endpoint)
// ---------------------------------------------------------------------------

api.get("/directory", async (c) => {
  const pbxId = c.req.query("pbx");
  const res = await c.env.DB.prepare(
    `SELECT pbx_id, number, display_name FROM extension
      ${pbxId ? "WHERE pbx_id = ?" : ""} ORDER BY number`,
  )
    .bind(...(pbxId ? [pbxId] : []))
    .all<{ pbx_id: string; number: string; display_name: string }>();

  return c.json(
    (res.results ?? []).map((r) => ({
      ...r,
      display_name_ascii: toAscii(r.display_name),
    })),
  );
});

// ---------------------------------------------------------------------------
// Call log
// ---------------------------------------------------------------------------

api.get("/cdr", async (c) => {
  const id = c.get("identity");
  if (!id.callLogAccess && id.role !== "admin") {
    return c.json({ error: "call log access not granted" }, 403);
  }

  const pbxId = c.req.query("pbx");
  const limit = Math.min(500, Number(c.req.query("limit") ?? "100") || 100);
  const offset = Math.max(0, Number(c.req.query("offset") ?? "0") || 0);

  const res = await c.env.DB.prepare(
    `SELECT * FROM call_leg ${pbxId ? "WHERE pbx_id = ?" : ""}
      ORDER BY started_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...(pbxId ? [pbxId, limit, offset] : [limit, offset]))
    .all();

  return c.json(res.results ?? []);
});

// ---------------------------------------------------------------------------
// Fleet status
// ---------------------------------------------------------------------------

/**
 * Fleet list.
 *
 * `state` is the verdict of the last reconcile, not connectivity — a PBX that
 * converged and then went offline still reads `converged`. `seconds_since_seen`
 * is what distinguishes "converged and healthy" from "converged three weeks ago
 * and unreachable since", so both are returned together.
 */
api.get("/pbx", async (c) => {
  const res = await c.env.DB.prepare(
    `SELECT id, name, prefix, sccp_enabled, file_rev, observed_file_rev,
            state, last_error, last_seen_at, acked_seq,
            CAST(strftime('%s','now') AS INTEGER)
              - CAST(strftime('%s', last_seen_at) AS INTEGER) AS seconds_since_seen
       FROM pbx ORDER BY id`,
  ).all();
  return c.json(res.results ?? []);
});

api.get("/pbx/:id/status", async (c) => {
  const pbxId = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT id FROM pbx WHERE id = ?")
    .bind(pbxId)
    .first();
  if (!row) return c.json({ error: "not found" }, 404);

  // Ask the DO directly rather than reading the mirrored row: the DO knows
  // whether the socket is actually up right now.
  const live = await c.env.PBX.getByName(pbxId).getStatus();

  const head = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(seq), 0) AS head FROM op_log WHERE pbx_id = ?",
  )
    .bind(pbxId)
    .first<{ head: number }>();

  const quarantined = await c.env.DB.prepare(
    `SELECT config_class, object_type, object_id, attempts, status_code, reason
       FROM quarantine WHERE pbx_id = ? ORDER BY last_failed_at DESC`,
  )
    .bind(pbxId)
    .all();

  return c.json({
    ...live,
    desiredSeq: head?.head ?? 0,
    behind: (head?.head ?? 0) - live.ackedSeq,
    quarantined: quarantined.results ?? [],
  });
});

api.get("/pbx/:id/config-bundle", async (c) => {
  const id = c.get("identity");
  if (id.role !== "admin") return c.json({ error: "admin role required" }, 403);

  const pbxId = c.req.param("id");
  const bundle = await renderBundle(
    c.env.DB,
    c.env,
    pbxId,
    new URL(c.req.url).host,
  );

  await audit(c.env, id, "download_config_bundle", `${pbxId} rev ${bundle.fileRev}`);

  // Plain JSON rather than a tarball: it stays diffable in a git-based
  // deployment pipeline, and the files are small.
  return c.json(bundle);
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

api.post("/admin/pbx", async (c) => {
  const id = c.get("identity");
  const body = await c.req.json<{
    id?: string;
    name?: string;
    prefix?: string;
    sccp_enabled?: boolean;
  }>();

  const pbxId = body.id?.trim();
  if (!pbxId || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(pbxId)) {
    return c.json(
      { error: "id must be lowercase alphanumeric with dashes, 2-63 chars" },
      400,
    );
  }

  const wsSecret = generateSecret(32);
  const ariSecret = generateSecret(32);

  // Persist the settings now, seeded from the request host. They must be
  // stored rather than re-derived at render time: the websocket URI feeds the
  // file-revision hash, so deriving it from whatever host the bundle happened
  // to be fetched from would bump the revision spuriously and mark a converged
  // PBX stale.
  const settings = defaultSettings(pbxId, new URL(c.req.url).host);

  try {
    await c.env.DB.prepare(
      `INSERT INTO pbx (id, name, prefix, sccp_enabled, ws_secret_enc, ari_secret_enc, settings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        pbxId,
        body.name ?? pbxId,
        body.prefix ?? "aem-",
        body.sccp_enabled ? 1 : 0,
        await encryptSecret(c.env.SECRET_KEY, wsSecret),
        await encryptSecret(c.env.SECRET_KEY, ariSecret),
        JSON.stringify(settings),
      )
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint/i.test(msg)) {
      return c.json({ error: `pbx ${pbxId} already exists` }, 409);
    }
    throw e;
  }

  await audit(c.env, id, "create_pbx", pbxId);

  return c.json(
    {
      id: pbxId,
      // Both also appear in the rendered bundle, which is where the operator
      // will actually consume them.
      ws_secret: wsSecret,
      ari_secret: ariSecret,
    },
    201,
  );
});

/**
 * Edit a PBX in place. `id` is immutable — it is the Durable Object name and a
 * URL path segment, so renaming it would orphan the DO holding the reconcile
 * cursor.
 *
 * `prefix` is vestigial. It used to be both the PJSIP object-id prefix and the
 * ownership boundary, until it turned out PJSIP identifies an endpoint by
 * matching the incoming username against the endpoint id, which made prefixed
 * ids unreachable for any phone not reconfigured to send the prefix. Ids are now
 * bare extension numbers and ownership lives in the DO's mirror
 * (`deletePjsipStrays`). The column is retained so stored rows and the existing
 * API shape keep working; nothing reads it. Editing it has no effect.
 */
api.put("/admin/pbx/:id", async (c) => {
  const id = c.get("identity");
  const pbxId = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    prefix?: string;
    sccp_enabled?: boolean;
    rotate_secrets?: boolean;
  }>();

  const existing = await c.env.DB.prepare(
    "SELECT id, name, prefix, sccp_enabled FROM pbx WHERE id = ?",
  )
    .bind(pbxId)
    .first<{
      id: string;
      name: string;
      prefix: string;
      sccp_enabled: number;
    }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  const name = body.name?.trim();
  if (name !== undefined && !name) {
    return c.json({ error: "name must not be empty" }, 400);
  }

  // Still shape-checked so a stored value stays sane, but no longer guarded
  // against change: it does not reach any object id, rendered file or sweep, so
  // there is nothing left for a change to abandon.
  const prefix = body.prefix?.trim();
  if (prefix !== undefined && prefix !== existing.prefix) {
    if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(prefix)) {
      return c.json(
        { error: "prefix must be lowercase alphanumeric with dashes, 1-16 chars" },
        400,
      );
    }
  }

  // Both at once: they travel in the same bundle and are applied in the same
  // maintenance window, so rotating one alone buys nothing but a second outage.
  let wsSecret: string | null = null;
  let ariSecret: string | null = null;
  let wsEnc: string | null = null;
  let ariEnc: string | null = null;
  if (body.rotate_secrets) {
    wsSecret = generateSecret(32);
    ariSecret = generateSecret(32);
    wsEnc = await encryptSecret(c.env.SECRET_KEY, wsSecret);
    ariEnc = await encryptSecret(c.env.SECRET_KEY, ariSecret);
  }

  await c.env.DB.prepare(
    `UPDATE pbx SET
       name           = COALESCE(?, name),
       prefix         = COALESCE(?, prefix),
       sccp_enabled   = COALESCE(?, sccp_enabled),
       ws_secret_enc  = COALESCE(?, ws_secret_enc),
       ari_secret_enc = COALESCE(?, ari_secret_enc)
     WHERE id = ?`,
  )
    .bind(
      name ?? null,
      prefix ?? null,
      body.sccp_enabled === undefined ? null : body.sccp_enabled ? 1 : 0,
      wsEnc,
      ariEnc,
      pbxId,
    )
    .run();

  const changes: string[] = [];
  if (name !== undefined && name !== existing.name) changes.push(`name=${name}`);
  if (prefix !== undefined && prefix !== existing.prefix) {
    changes.push(`prefix=${existing.prefix}→${prefix}`);
  }
  if (
    body.sccp_enabled !== undefined &&
    Number(body.sccp_enabled) !== existing.sccp_enabled
  ) {
    changes.push(`sccp=${body.sccp_enabled ? "on" : "off"}`);
  }
  if (body.rotate_secrets) changes.push("secrets rotated");

  await audit(
    c.env,
    id,
    body.rotate_secrets ? "rotate_pbx_secrets" : "update_pbx",
    `${pbxId}${changes.length ? ` (${changes.join(", ")})` : ""}`,
  );
  // prefix, sccp_enabled and the secrets all feed the bundle hash; the
  // file_rev bump itself happens lazily on the next render.
  await syncPbx(c.env, pbxId);

  return c.json({
    ok: true,
    ...(wsSecret && ariSecret
      ? { ws_secret: wsSecret, ari_secret: ariSecret }
      : {}),
  });
});

/**
 * Per-site renderer inputs — the contents of `settings_json`.
 *
 * Everything here lands in the config bundle rather than in ARI, so a bad value
 * is not caught by the reconciler: it ships to the box and breaks something at
 * load. The validation below covers the fields whose failure modes are worst —
 * the websocket URI (the PBX stops connecting entirely and the only symptom is
 * a log line), and the identifiers that name config sections.
 */
api.get("/admin/pbx/:id/settings", async (c) => {
  const pbxId = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT settings_json FROM pbx WHERE id = ?",
  )
    .bind(pbxId)
    .first<{ settings_json: string }>();
  if (!row) return c.json({ error: "not found" }, 404);

  // Merged with defaults so the caller always gets a complete object to edit,
  // whatever partial blob happens to be stored.
  return c.json(
    parseSettings(row.settings_json, pbxId, new URL(c.req.url).host),
  );
});


function badSettings(s: PbxSettings): string | null {
  let uri: URL;
  try {
    uri = new URL(s.ws.uri);
  } catch {
    return "ws.uri must be an absolute URL";
  }
  if (uri.protocol !== "wss:" && uri.protocol !== "ws:") {
    return "ws.uri must be a ws:// or wss:// URL";
  }
  // tls_enabled must agree with the scheme: wss with TLS off does not fall back
  // to plaintext, it simply fails to connect.
  if (uri.protocol === "wss:" && !s.ws.tls_enabled) {
    return "ws.tls_enabled must be on for a wss:// URI";
  }
  if (uri.protocol === "ws:" && s.ws.tls_enabled) {
    return "ws.tls_enabled must be off for a ws:// URI";
  }
  if (!s.ws.username.trim()) return "ws.username is required";

  if (!NAME_RE.test(s.ari.user)) return "ari.user must be alphanumeric";
  if (!NAME_RE.test(s.ari.app)) return "ari.app must be alphanumeric";
  if (!NAME_RE.test(s.dialplan.context)) {
    return "dialplan.context must be alphanumeric, dashes or underscores";
  }
  for (const inc of s.dialplan.includes) {
    if (!NAME_RE.test(inc)) return `dialplan include "${inc}" is not a valid context name`;
  }

  for (const [k, v] of [
    ["connection_timeout", s.ws.connection_timeout],
    ["reconnect_interval", s.ws.reconnect_interval],
    ["reconnect_attempts", s.ws.reconnect_attempts],
    ["pingpong_interval", s.ws.pingpong_interval],
    ["pingpong_probes", s.ws.pingpong_probes],
  ] as const) {
    if (!Number.isInteger(v) || v < 0) return `ws.${k} must be a non-negative integer`;
  }

  if (!s.asterisk_config_dir.startsWith("/")) {
    return "asterisk_config_dir must be an absolute path";
  }
  return null;
}

api.put("/admin/pbx/:id/settings", async (c) => {
  const id = c.get("identity");
  const pbxId = c.req.param("id");

  const existing = await c.env.DB.prepare(
    "SELECT settings_json FROM pbx WHERE id = ?",
  )
    .bind(pbxId)
    .first<{ settings_json: string }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  // Re-parsed rather than trusted: the client sends a whole settings object,
  // and this fills any field it omitted from the defaults instead of writing
  // an undefined into the stored blob.
  const merged = parseSettings(
    JSON.stringify(await c.req.json()),
    pbxId,
    new URL(c.req.url).host,
  );

  const problem = badSettings(merged);
  if (problem) return c.json({ error: problem }, 400);

  await c.env.DB.prepare("UPDATE pbx SET settings_json = ? WHERE id = ?")
    .bind(JSON.stringify(merged), pbxId)
    .run();

  const before = parseSettings(
    existing.settings_json,
    pbxId,
    new URL(c.req.url).host,
  );
  const changed = (
    ["ws", "ari", "dialplan", "sccp_general", "pjsip_global"] as const
  ).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(merged[k]));

  await audit(
    c.env,
    id,
    "update_pbx_settings",
    `${pbxId}${changed.length ? ` (${changed.join(", ")})` : ""}`,
  );
  // Settings feed the bundle hash, so file_rev bumps on the next render and the
  // PBX correctly reports itself stale until the bundle is re-applied.
  await syncPbx(c.env, pbxId);

  return c.json({ ok: true });
});

/**
 * Delete a PBX and everything scoped to it.
 *
 * Two stores have to be cleared, and only one of them cascades. D1 drops the
 * extensions, devices, op log, quarantine, blocked list and call legs via
 * `ON DELETE CASCADE`; the Durable Object holding the reconcile cursor does not
 * go anywhere on its own and must be wiped explicitly, or a future PBX reusing
 * this site id would inherit it. `decommission` runs first, while the row still
 * exists, because an optional purge of the live box resolves the owned set from
 * the DO's mirror and cross-checks it against this PBX's `pjsip_static` rows.
 *
 * `?purge=1` additionally removes the owned config from the PBX over ARI. It is
 * off by default: dropping the manager's record of a site should not, on its
 * own, take that site's phones down.
 */
api.delete("/admin/pbx/:id", async (c) => {
  const id = c.get("identity");
  const pbxId = c.req.param("id");
  const purge = c.req.query("purge") === "1";

  const existing = await c.env.DB.prepare("SELECT id FROM pbx WHERE id = ?")
    .bind(pbxId)
    .first<{ id: string }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  // Counted before the cascade, purely so the audit entry records what went.
  const counts = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM extension   WHERE pbx_id = ?1) AS extensions,
            (SELECT COUNT(*) FROM sccp_device WHERE pbx_id = ?1) AS devices,
            (SELECT COUNT(*) FROM call_leg    WHERE pbx_id = ?1) AS calls`,
  )
    .bind(pbxId)
    .first<{ extensions: number; devices: number; calls: number }>();

  let result: { purged: boolean; error?: string };
  try {
    result = await c.env.PBX.getByName(pbxId).decommission(purge);
  } catch (e) {
    // The D1 row is deliberately left intact: deleting it while the controller
    // still holds a cursor is the one outcome worse than not deleting at all.
    return c.json(
      {
        error: `could not decommission the controller, nothing was deleted: ${
          e instanceof Error ? e.message : String(e)
        }`,
      },
      502,
    );
  }

  await c.env.DB.prepare("DELETE FROM pbx WHERE id = ?").bind(pbxId).run();

  const detail =
    `${pbxId} (${counts?.extensions ?? 0} extensions, ${counts?.devices ?? 0} devices, ` +
    `${counts?.calls ?? 0} call legs` +
    (purge ? `; purge ${result.purged ? "ok" : `failed: ${result.error}`}` : "") +
    ")";
  await audit(c.env, id, "delete_pbx", detail);

  return c.json({
    ok: true,
    deleted: {
      extensions: counts?.extensions ?? 0,
      devices: counts?.devices ?? 0,
      calls: counts?.calls ?? 0,
    },
    purged: result.purged,
    ...(result.error ? { purgeError: result.error } : {}),
  });
});

/**
 * The drift-repair escape hatch, and the only way to release quarantined
 * objects.
 *
 * A quarantined object is skipped by every subsequent pass, so without this an
 * operator who fixed the underlying problem would have no way to get it
 * retried. Pressing resync is precisely the "I fixed it, try again" action, so
 * it clears the quarantine before sweeping.
 */
api.post("/admin/pbx/:id/resync", async (c) => {
  const id = c.get("identity");
  const pbxId = c.req.param("id");

  const cleared = await c.env.DB.prepare(
    "DELETE FROM quarantine WHERE pbx_id = ?",
  )
    .bind(pbxId)
    .run();

  await compilePbx(c.env.DB, pbxId);
  const result = await c.env.PBX.getByName(pbxId).forceResync();

  await audit(
    c.env,
    id,
    "force_resync",
    `${pbxId} (released ${cleared.meta.changes ?? 0} quarantined)`,
  );
  return c.json(
    { ...result, quarantineReleased: cleared.meta.changes ?? 0 },
    result.ok ? 200 : 502,
  );
});

/** Release a single quarantined object without a full resync. */
api.delete("/admin/pbx/:id/quarantine/:class/:type/:objectId", async (c) => {
  const id = c.get("identity");
  const pbxId = c.req.param("id");
  const res = await c.env.DB.prepare(
    `DELETE FROM quarantine
      WHERE pbx_id = ? AND config_class = ? AND object_type = ? AND object_id = ?`,
  )
    .bind(
      pbxId,
      c.req.param("class"),
      c.req.param("type"),
      c.req.param("objectId"),
    )
    .run();

  if ((res.meta.changes ?? 0) === 0) return c.json({ error: "not found" }, 404);

  // The cursor already moved past this object's op while it was being skipped,
  // so a delta pass would find nothing to retry and report "converged" with
  // the object still unapplied. A fresh upsert op puts it back in the stream.
  await touchObject(
    c.env.DB,
    pbxId,
    c.req.param("class"),
    c.req.param("type"),
    c.req.param("objectId"),
  );

  await audit(
    c.env,
    id,
    "release_quarantine",
    `${pbxId}/${c.req.param("type")}/${c.req.param("objectId")}`,
  );
  try {
    await c.env.PBX.getByName(pbxId).notifyChange();
  } catch (e) {
    console.error(`notify ${pbxId} failed`, e);
  }
  return c.json({ ok: true });
});

api.get("/admin/users", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT email, role, display_name, min_ext, max_ext, call_log_access, created_at FROM app_user ORDER BY email",
  ).all();
  return c.json(res.results ?? []);
});

api.post("/admin/users", async (c) => {
  const id = c.get("identity");
  const body = await c.req.json<{
    email?: string;
    role?: "admin" | "user";
    display_name?: string;
    min_ext?: number;
    max_ext?: number;
    call_log_access?: boolean;
    /** Set when editing: the row's current email, so the email can change. */
    previous_email?: string;
  }>();

  const email = body.email?.trim().toLowerCase();
  if (!email) return c.json({ error: "email is required" }, 400);
  if (
    body.min_ext !== undefined &&
    body.max_ext !== undefined &&
    body.min_ext > body.max_ext
  ) {
    return c.json({ error: "min_ext must not exceed max_ext" }, 400);
  }

  const previous = body.previous_email?.trim().toLowerCase();
  if (previous && previous !== email) {
    // Renaming the principal you are signed in as would strand you: Access
    // keeps asserting the old address, which no longer has a row.
    if (
      previous === id.email.toLowerCase() ||
      previous === id.impersonatedBy?.toLowerCase()
    ) {
      return c.json({ error: "you cannot change the email of your own account" }, 400);
    }
    const [old, clash] = await Promise.all([
      c.env.DB.prepare("SELECT 1 FROM app_user WHERE email = ?").bind(previous).first(),
      c.env.DB.prepare("SELECT 1 FROM app_user WHERE email = ?").bind(email).first(),
    ]);
    if (!old) return c.json({ error: "not found" }, 404);
    if (clash) return c.json({ error: `${email} already exists` }, 409);

    // owner_email is an ACL keyed on the address, so the user's extensions
    // move with them. One batch so a failure leaves neither half applied.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE app_user SET email = ?, role = ?, display_name = ?, min_ext = ?,
           max_ext = ?, call_log_access = ? WHERE email = ?`,
      ).bind(
        email,
        body.role ?? "user",
        body.display_name ?? "",
        body.min_ext ?? null,
        body.max_ext ?? null,
        body.call_log_access ? 1 : 0,
        previous,
      ),
      c.env.DB.prepare("UPDATE extension SET owner_email = ? WHERE owner_email = ?").bind(
        email,
        previous,
      ),
    ]);
    await audit(c.env, id, "rename_user", `${previous} -> ${email}`);
    return c.json({ ok: true });
  }

  await c.env.DB.prepare(
    `INSERT INTO app_user (email, role, display_name, min_ext, max_ext, call_log_access)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       role = excluded.role,
       display_name = excluded.display_name,
       min_ext = excluded.min_ext,
       max_ext = excluded.max_ext,
       call_log_access = excluded.call_log_access`,
  )
    .bind(
      email,
      body.role ?? "user",
      body.display_name ?? "",
      body.min_ext ?? null,
      body.max_ext ?? null,
      body.call_log_access ? 1 : 0,
    )
    .run();

  await audit(c.env, id, "upsert_user", email);
  return c.json({ ok: true });
});

/**
 * Remove a principal's authorization row.
 *
 * Two guardrails, both about not locking the fleet out of its own admin GUI:
 * you cannot delete yourself, and you cannot delete the last admin. Access
 * still authenticates a deleted principal — they simply land as an
 * unprovisioned zero-privilege user (see `authenticate`), which is exactly what
 * "removed" should mean here.
 *
 * Extensions keep their `owner_email`. That column is an ACL, not a foreign
 * key: leaving it means re-provisioning the same address restores their own
 * extensions, and it grants nobody else anything in the meantime.
 */
api.delete("/admin/users/:email", async (c) => {
  const id = c.get("identity");
  const email = decodeURIComponent(c.req.param("email")).trim().toLowerCase();

  if (email === id.email.toLowerCase()) {
    return c.json({ error: "you cannot remove your own account" }, 400);
  }
  // The guardrail covers the real actor too. An admin viewing as another admin
  // could otherwise delete the account they signed in with, which is the exact
  // lockout the rule above exists to prevent.
  if (email === id.impersonatedBy?.toLowerCase()) {
    return c.json(
      { error: "you cannot remove the account you signed in with" },
      400,
    );
  }

  const target = await c.env.DB.prepare(
    "SELECT email, role FROM app_user WHERE email = ?",
  )
    .bind(email)
    .first<{ email: string; role: "admin" | "user" }>();

  if (!target) return c.json({ error: "not found" }, 404);

  if (target.role === "admin") {
    const admins = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM app_user WHERE role = 'admin'",
    ).first<{ n: number }>();
    if ((admins?.n ?? 0) <= 1) {
      return c.json({ error: "cannot remove the last admin" }, 400);
    }
  }

  const owned = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM extension WHERE owner_email = ?",
  )
    .bind(email)
    .first<{ n: number }>();

  await c.env.DB.prepare("DELETE FROM app_user WHERE email = ?")
    .bind(email)
    .run();

  const orphaned = owned?.n ?? 0;
  await audit(
    c.env,
    id,
    "delete_user",
    `${email} (${target.role}${orphaned ? `, ${orphaned} extension(s) left unowned` : ""})`,
  );
  return c.json({ ok: true, orphanedExtensions: orphaned });
});

api.get("/admin/blocked", async (c) => {
  const pbxId = c.req.query("pbx");
  const res = await c.env.DB.prepare(
    `SELECT pbx_id, number, reason, created_at FROM blocked_extension
      ${pbxId ? "WHERE pbx_id = ?" : ""} ORDER BY pbx_id, number`,
  )
    .bind(...(pbxId ? [pbxId] : []))
    .all();
  return c.json(res.results ?? []);
});

api.post("/admin/blocked", async (c) => {
  const id = c.get("identity");
  const body = await c.req.json<{
    pbx_id?: string;
    number?: string;
    reason?: string;
  }>();
  if (!body.pbx_id || !body.number) {
    return c.json({ error: "pbx_id and number are required" }, 400);
  }
  await c.env.DB.prepare(
    `INSERT INTO blocked_extension (pbx_id, number, reason) VALUES (?, ?, ?)
     ON CONFLICT(pbx_id, number) DO UPDATE SET reason = excluded.reason`,
  )
    .bind(body.pbx_id, body.number, body.reason ?? "")
    .run();
  await audit(
    c.env,
    id,
    "block_extension",
    `${body.pbx_id}/${body.number}`,
  );
  return c.json({ ok: true });
});

api.delete("/admin/blocked/:pbx/:number", async (c) => {
  const id = c.get("identity");
  const pbxId = c.req.param("pbx");
  const number = c.req.param("number");
  await c.env.DB.prepare(
    "DELETE FROM blocked_extension WHERE pbx_id = ? AND number = ?",
  )
    .bind(pbxId, number)
    .run();
  await audit(c.env, id, "unblock_extension", `${pbxId}/${number}`);
  return c.json({ ok: true });
});

api.get("/admin/profiles", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT id, tech, name, attrs_json, no_answer_target, ring_timeout FROM profile ORDER BY tech, name",
  ).all();
  return c.json(res.results ?? []);
});

api.post("/admin/profiles", async (c) => {
  const id = c.get("identity");
  const body = await c.req.json<{
    id?: string;
    tech?: "pjsip" | "sccp";
    name?: string;
    attrs?: Record<string, unknown>;
    no_answer_target?: string;
    ring_timeout?: number;
  }>();
  if (!body.id || !body.tech || !body.name) {
    return c.json({ error: "id, tech and name are required" }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO profile (id, tech, name, attrs_json, no_answer_target, ring_timeout)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       attrs_json = excluded.attrs_json,
       no_answer_target = excluded.no_answer_target,
       ring_timeout = excluded.ring_timeout`,
  )
    .bind(
      body.id,
      body.tech,
      body.name,
      JSON.stringify(body.attrs ?? {}),
      body.no_answer_target ?? "Hangup()",
      body.ring_timeout ?? 20,
    )
    .run();

  await audit(c.env, id, "upsert_profile", body.id);

  // A profile change fans out to every extension that references it.
  const pbxes = await c.env.DB.prepare("SELECT id FROM pbx").all<{ id: string }>();
  for (const p of pbxes.results ?? []) await syncPbx(c.env, p.id);

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// SCCP: devices, their buttons, and the static sccp.conf sections
// ---------------------------------------------------------------------------

interface ButtonInput {
  position: number;
  kind: string;
  args: string[];
}

/**
 * Validate what the PBX would be asked to accept, before it is stored.
 *
 * The reconciler already refuses an invalid inventory at push time, but by then
 * the only symptom is a `degraded` PBX and a log line. chan_sccp2 makes this
 * worse than it sounds: every write triggers a full inventory reload, and a
 * single bad object fails the *whole* reload while still acking 200. So the
 * same rules run here, against the whole pbx rather than the one row being
 * written — a device referencing a line that does not exist is only visible
 * when both are in scope.
 */
async function validateSccpForPbx(
  env: Env,
  pbxId: string,
): Promise<string | null> {
  const desired = await buildDesired(env.DB, pbxId);
  const sccp = desired.filter((d) => d.configClass === "chan_sccp2");
  if (sccp.length === 0) return null;

  const profiles = await env.DB.prepare(
    "SELECT name FROM sccp_static WHERE pbx_id = ? AND section_type = 'softkey_profile'",
  )
    .bind(pbxId)
    .all<{ name: string }>();
  const softkeyProfiles = new Set((profiles.results ?? []).map((p) => p.name));
  softkeyProfiles.add("default"); // DEFAULT_SOFT_KEY_PROFILE, config/mod.rs:92

  // secret_ref tuples never appear on SCCP objects, so the raw attrs are
  // already the final ones — no decryption pass needed here.
  const issues = validateSccpInventory(
    sccp.map((d) => ({
      objectType: d.objectType as "device" | "line",
      objectId: d.objectId,
      attrs: d.attrs.map((a) => ({
        attribute: a.attribute,
        value: "value" in a ? String(a.value) : "",
      })),
    })),
    { softkeyProfiles },
  );
  if (issues.length === 0) return null;

  return issues
    .slice(0, 5)
    .map((i) => `${i.objectType}/${i.objectId}: ${i.code} — ${i.message}`)
    .join("; ");
}

function badButtons(buttons: ButtonInput[]): string | null {
  const seen = new Set<number>();
  for (const b of buttons) {
    if (!Number.isInteger(b.position) || b.position < 1 || b.position > 9999) {
      return `button position must be 1-9999, got ${b.position}`;
    }
    if (seen.has(b.position)) return `duplicate button position ${b.position}`;
    seen.add(b.position);
    if (!(b.kind in BUTTON_KINDS)) return `unknown button kind "${b.kind}"`;
    // Syntax only: whether a line button names a real line is a cross-object
    // check, which validateSccpForPbx makes against the whole inventory.
    const problem = buttonProblem(b.kind, b.args);
    if (problem) return `button ${b.position}: ${problem}`;
  }
  return null;
}

/**
 * Check one button as chan_sccp2 would parse it, without saving anything —
 * the device form's per-button "Check". Unlike save, this also resolves a line
 * button against the PBX's SCCP lines, so a missing or still-PJSIP number is
 * caught while the operator is looking at it.
 */
api.post("/admin/sccp/buttons/check", async (c) => {
  const body = await c.req.json<{ pbx_id?: string; kind?: string; args?: unknown }>();
  if (
    typeof body.pbx_id !== "string" ||
    typeof body.kind !== "string" ||
    !Array.isArray(body.args) ||
    !body.args.every((a) => typeof a === "string")
  ) {
    return c.json({ error: "malformed request body" }, 400);
  }

  const res = await c.env.DB.prepare(
    "SELECT number FROM extension WHERE pbx_id = ? AND tech = 'sccp' AND directory_only = 0",
  )
    .bind(body.pbx_id)
    .all<{ number: string }>();
  const lines = new Set((res.results ?? []).map((r) => r.number));

  const problem = buttonProblem(body.kind, body.args as string[], lines);
  return c.json(problem ? { ok: false, error: problem } : { ok: true });
});

async function replaceButtons(
  env: Env,
  deviceId: number,
  buttons: ButtonInput[],
): Promise<void> {
  await env.DB.prepare("DELETE FROM sccp_button WHERE device_id = ?")
    .bind(deviceId)
    .run();
  for (const b of buttons) {
    await env.DB.prepare(
      "INSERT INTO sccp_button (device_id, position, kind, args_json) VALUES (?, ?, ?, ?)",
    )
      .bind(deviceId, b.position, b.kind, JSON.stringify(b.args))
      .run();
  }
}

api.get("/admin/sccp/devices", async (c) => {
  const pbxId = c.req.query("pbx");
  const devices = await c.env.DB.prepare(
    `SELECT id, pbx_id, sep_id, description, profile_id, softkey_profile,
            overrides_json, created_at
       FROM sccp_device ${pbxId ? "WHERE pbx_id = ?" : ""} ORDER BY pbx_id, sep_id`,
  )
    .bind(...(pbxId ? [pbxId] : []))
    .all<{ id: number }>();

  const rows = devices.results ?? [];
  if (rows.length === 0) return c.json([]);

  const buttons = await c.env.DB.prepare(
    `SELECT device_id, position, kind, args_json FROM sccp_button
      WHERE device_id IN (${rows.map(() => "?").join(",")})
      ORDER BY device_id, position`,
  )
    .bind(...rows.map((d) => d.id))
    .all<{ device_id: number; position: number; kind: string; args_json: string }>();

  const byDevice = new Map<number, ButtonInput[]>();
  for (const b of buttons.results ?? []) {
    const list = byDevice.get(b.device_id) ?? [];
    let args: string[] = [];
    try {
      args = JSON.parse(b.args_json) as string[];
    } catch {
      /* a hand-edited row; surface it as argument-less rather than 500 */
    }
    list.push({ position: b.position, kind: b.kind, args });
    byDevice.set(b.device_id, list);
  }

  return c.json(rows.map((d) => ({ ...d, buttons: byDevice.get(d.id) ?? [] })));
});

api.post("/admin/sccp/devices", async (c) => {
  const id = c.get("identity");
  const body = await c.req.json<{
    pbx_id?: string;
    sep_id?: string;
    description?: string;
    profile_id?: string | null;
    softkey_profile?: string;
    overrides?: Record<string, unknown>;
    buttons?: ButtonInput[];
  }>();

  const pbxId = body.pbx_id;
  const sepId = body.sep_id?.trim().toUpperCase();
  if (!pbxId || !sepId) {
    return c.json({ error: "pbx_id and sep_id are required" }, 400);
  }
  // SEP + 12 hex, enforced by chan_sccp2 itself (config/parsing/device.rs:10-11).
  if (!DEVICE_ID_RE.test(sepId)) {
    return c.json({ error: "sep_id must be SEP followed by 12 hex digits" }, 400);
  }
  if (body.overrides !== undefined) {
    const bad = badOverrides(body.overrides, ["device"]);
    if (bad) return c.json({ error: bad }, 400);
  }

  const buttons = body.buttons ?? [];
  const buttonProblem = badButtons(buttons);
  if (buttonProblem) return c.json({ error: buttonProblem }, 400);

  let deviceId: number;
  try {
    const row = await c.env.DB.prepare(
      `INSERT INTO sccp_device (pbx_id, sep_id, description, profile_id,
                                softkey_profile, overrides_json)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(
        pbxId,
        sepId,
        body.description ?? "",
        body.profile_id ?? null,
        body.softkey_profile ?? "default",
        JSON.stringify(body.overrides ?? {}),
      )
      .first<{ id: number }>();
    deviceId = row!.id;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint/i.test(msg)) {
      return c.json({ error: `device ${sepId} already exists on ${pbxId}` }, 409);
    }
    throw e;
  }

  await replaceButtons(c.env, deviceId, buttons);

  const invalid = await validateSccpForPbx(c.env, pbxId);
  if (invalid) {
    // Roll back rather than leave the PBX unable to reload: one bad object
    // fails the entire chan_sccp2 inventory, not just itself.
    await c.env.DB.prepare("DELETE FROM sccp_device WHERE id = ?")
      .bind(deviceId)
      .run();
    return c.json({ error: `SCCP inventory would be invalid: ${invalid}` }, 400);
  }

  await audit(c.env, id, "create_sccp_device", `${pbxId}/${sepId}`);
  await syncPbx(c.env, pbxId);
  return c.json({ id: deviceId, pbx_id: pbxId, sep_id: sepId }, 201);
});

api.put("/admin/sccp/devices/:pbx/:sepId", async (c) => {
  const id = c.get("identity");
  const pbxId = c.req.param("pbx");
  const sepId = c.req.param("sepId").toUpperCase();

  const existing = await c.env.DB.prepare(
    `SELECT id, description, profile_id, softkey_profile, overrides_json
       FROM sccp_device WHERE pbx_id = ? AND sep_id = ?`,
  )
    .bind(pbxId, sepId)
    .first<{
      id: number;
      description: string;
      profile_id: string | null;
      softkey_profile: string;
      overrides_json: string;
    }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  const body = await c.req.json<{
    description?: string;
    profile_id?: string | null;
    softkey_profile?: string;
    overrides?: Record<string, unknown>;
    buttons?: ButtonInput[];
  }>();

  if (body.buttons) {
    const problem = badButtons(body.buttons);
    if (problem) return c.json({ error: problem }, 400);
  }
  if (body.overrides !== undefined) {
    const bad = badOverrides(body.overrides, ["device"]);
    if (bad) return c.json({ error: bad }, 400);
  }

  // Snapshot for rollback: chan_sccp2 reloads the whole inventory on any write,
  // so a rejected edit must leave nothing behind.
  const priorButtons = await c.env.DB.prepare(
    "SELECT position, kind, args_json FROM sccp_button WHERE device_id = ? ORDER BY position",
  )
    .bind(existing.id)
    .all<{ position: number; kind: string; args_json: string }>();

  await c.env.DB.prepare(
    `UPDATE sccp_device SET
       description     = COALESCE(?, description),
       profile_id      = COALESCE(?, profile_id),
       softkey_profile = COALESCE(?, softkey_profile),
       overrides_json  = COALESCE(?, overrides_json)
     WHERE id = ?`,
  )
    .bind(
      body.description ?? null,
      body.profile_id === undefined ? null : body.profile_id,
      body.softkey_profile ?? null,
      body.overrides ? JSON.stringify(body.overrides) : null,
      existing.id,
    )
    .run();

  if (body.buttons) await replaceButtons(c.env, existing.id, body.buttons);

  const invalid = await validateSccpForPbx(c.env, pbxId);
  if (invalid) {
    await c.env.DB.prepare(
      `UPDATE sccp_device SET description = ?, profile_id = ?,
              softkey_profile = ?, overrides_json = ? WHERE id = ?`,
    )
      .bind(
        existing.description,
        existing.profile_id,
        existing.softkey_profile,
        existing.overrides_json,
        existing.id,
      )
      .run();
    if (body.buttons) {
      await replaceButtons(
        c.env,
        existing.id,
        (priorButtons.results ?? []).map((b) => ({
          position: b.position,
          kind: b.kind,
          args: JSON.parse(b.args_json) as string[],
        })),
      );
    }
    return c.json({ error: `SCCP inventory would be invalid: ${invalid}` }, 400);
  }

  await audit(c.env, id, "update_sccp_device", `${pbxId}/${sepId}`);
  await syncPbx(c.env, pbxId);
  return c.json({ ok: true });
});

api.delete("/admin/sccp/devices/:pbx/:sepId", async (c) => {
  const id = c.get("identity");
  const pbxId = c.req.param("pbx");
  const sepId = c.req.param("sepId").toUpperCase();

  // Buttons cascade via sccp_button.device_id.
  const res = await c.env.DB.prepare(
    "DELETE FROM sccp_device WHERE pbx_id = ? AND sep_id = ?",
  )
    .bind(pbxId, sepId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: "not found" }, 404);

  await audit(c.env, id, "delete_sccp_device", `${pbxId}/${sepId}`);
  await syncPbx(c.env, pbxId);
  return c.json({ ok: true });
});

/**
 * Static sccp.conf sections: softkey profiles and (!) templates.
 *
 * File-layer only — chan_sccp2 reads these at load, and a device referencing a
 * softkey_profile that does not exist is a hard reload failure, which is why
 * the device validator cross-checks against this table.
 */
api.get("/admin/sccp/static", async (c) => {
  const pbxId = c.req.query("pbx");
  const res = await c.env.DB.prepare(
    `SELECT id, pbx_id, section_type, name, attrs_json FROM sccp_static
      ${pbxId ? "WHERE pbx_id = ?" : ""} ORDER BY pbx_id, section_type, name`,
  )
    .bind(...(pbxId ? [pbxId] : []))
    .all();
  return c.json(res.results ?? []);
});

api.post("/admin/sccp/static", async (c) => {
  const id = c.get("identity");
  const body = await c.req.json<{
    pbx_id?: string;
    section_type?: "softkey_profile" | "template";
    name?: string;
    attrs?: Record<string, string>;
  }>();

  if (!body.pbx_id || !body.section_type || !body.name?.trim()) {
    return c.json({ error: "pbx_id, section_type and name are required" }, 400);
  }
  if (body.section_type !== "softkey_profile" && body.section_type !== "template") {
    return c.json({ error: "section_type must be softkey_profile or template" }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO sccp_static (pbx_id, section_type, name, attrs_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(pbx_id, section_type, name) DO UPDATE SET
       attrs_json = excluded.attrs_json`,
  )
    .bind(
      body.pbx_id,
      body.section_type,
      body.name.trim(),
      JSON.stringify(body.attrs ?? {}),
    )
    .run();

  await audit(
    c.env,
    id,
    "upsert_sccp_static",
    `${body.pbx_id}/${body.section_type}/${body.name.trim()}`,
  );
  await syncPbx(c.env, body.pbx_id);
  return c.json({ ok: true });
});

api.delete("/admin/sccp/static/:pbx/:type/:name", async (c) => {
  const id = c.get("identity");
  const pbxId = c.req.param("pbx");
  const type = c.req.param("type");
  const name = decodeURIComponent(c.req.param("name"));

  // Refuse to strand a device on a profile that would vanish — that is a hard
  // reload failure on the PBX, and chan_sccp2 acks the write anyway.
  if (type === "softkey_profile") {
    const users = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sccp_device WHERE pbx_id = ? AND softkey_profile = ?",
    )
      .bind(pbxId, name)
      .first<{ n: number }>();
    if ((users?.n ?? 0) > 0) {
      return c.json(
        {
          error: `${users?.n} device(s) still reference softkey profile "${name}"`,
        },
        409,
      );
    }
  }

  const res = await c.env.DB.prepare(
    "DELETE FROM sccp_static WHERE pbx_id = ? AND section_type = ? AND name = ?",
  )
    .bind(pbxId, type, name)
    .run();
  if ((res.meta.changes ?? 0) === 0) return c.json({ error: "not found" }, 404);

  await audit(c.env, id, "delete_sccp_static", `${pbxId}/${type}/${name}`);
  await syncPbx(c.env, pbxId);
  return c.json({ ok: true });
});

api.get("/admin/audit", async (c) => {
  const limit = Math.min(500, Number(c.req.query("limit") ?? "100") || 100);
  const res = await c.env.DB.prepare(
    "SELECT id, actor, action, detail, created_at FROM audit_log ORDER BY id DESC LIMIT ?",
  )
    .bind(limit)
    .all();
  return c.json(res.results ?? []);
});
