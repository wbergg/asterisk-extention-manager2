/**
 * Cloudflare Access identity verification.
 *
 * Access sits in front of the app and handles SSO, MFA, session lifetime and
 * revocation; all this does is verify the signed assertion it forwards and map
 * the resulting email onto a row in `app_user` for authorization. That split
 * is deliberate — v1 rolled its own auth and ended up with 24-hour HS256
 * tokens, no refresh, no revocation, and a keyfunc that never pinned the
 * signing algorithm.
 */

import type { Env } from "../types.js";

export interface Identity {
  /** Email address, or `svc:<client-id>` for a service token. */
  email: string;
  role: "admin" | "user";
  minExt: number | null;
  maxExt: number | null;
  callLogAccess: boolean;
  /**
   * The admin actually signed in, when this identity is being impersonated.
   * Absent on a normal request. Never set from a claim — only by
   * `applyImpersonation`, from an already-verified admin principal.
   */
  impersonatedBy?: string;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access JWKS fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

/**
 * Verify the Cf-Access-Jwt-Assertion header. Returns the verified principal:
 * an email address for a human login, or `svc:<client-id>` for a service token.
 *
 * The algorithm is pinned to RS256 rather than read from the header, so a
 * token claiming `alg: none` cannot talk its way through.
 */
export async function verifyAccessJwt(
  token: string,
  aud: string,
  teamDomain: string,
): Promise<string> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed Access JWT");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  const header = JSON.parse(b64urlToString(headerB64)) as {
    kid?: string;
    alg?: string;
  };
  if (header.alg !== "RS256") {
    throw new Error(`unexpected Access JWT algorithm: ${header.alg}`);
  }

  const keys = await getJwks(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("Access JWT signed by an unknown key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) throw new Error("Access JWT signature verification failed");

  const claims = JSON.parse(b64urlToString(payloadB64)) as {
    aud?: string | string[];
    email?: string;
    common_name?: string;
    exp?: number;
    iss?: string;
  };

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(aud)) throw new Error("Access JWT audience mismatch");
  if (!claims.exp || claims.exp * 1000 < Date.now()) {
    throw new Error("Access JWT expired");
  }
  if (claims.iss !== `https://${teamDomain}`) {
    throw new Error("Access JWT issuer mismatch");
  }
  // A human login carries `email`. A service token carries no email at all —
  // only `common_name`, its client id — and reaches us only if a Service Auth
  // policy on the application admitted it. Both are namespaced into the same
  // `app_user.email` key space, where `svc:` cannot collide with a real
  // address, so a token is provisioned, scoped and audited like any other
  // principal rather than getting a bypass of its own.
  if (claims.email) return claims.email.toLowerCase();
  if (claims.common_name) return `svc:${claims.common_name.toLowerCase()}`;

  throw new Error("Access JWT carries neither an email nor a common_name claim");
}

/**
 * Look up what a principal is allowed to do here.
 *
 * Authentication has already happened by this point; this is purely the
 * authorization half, which is why impersonation can reuse it verbatim to
 * resolve its target.
 */
async function authorize(env: Env, principal: string): Promise<Identity> {
  const row = await env.DB.prepare(
    "SELECT email, role, min_ext, max_ext, call_log_access FROM app_user WHERE email = ?",
  )
    .bind(principal)
    .first<{
      email: string;
      role: "admin" | "user";
      min_ext: number | null;
      max_ext: number | null;
      call_log_access: number;
    }>();

  if (!row) {
    // Authenticated by Access but not provisioned here. Treated as a
    // zero-privilege user so the caller can render a useful "ask an admin"
    // page rather than a bare 403.
    return {
      email: principal,
      role: "user",
      minExt: null,
      maxExt: null,
      callLogAccess: false,
    };
  }

  return {
    email: row.email,
    role: row.role,
    minExt: row.min_ext,
    maxExt: row.max_ext,
    callLogAccess: row.call_log_access === 1,
  };
}

/**
 * Resolve the caller to an Identity, or null if unauthenticated.
 *
 * `DEV_AUTH_BYPASS=1` skips verification entirely for local development. It is
 * gated on an explicit var rather than on the absence of config so that a
 * missing ACCESS_AUD in production fails closed instead of opening the door.
 */
export async function authenticate(
  request: Request,
  env: Env,
): Promise<Identity | null> {
  let principal: string;

  if (env.DEV_AUTH_BYPASS === "1") {
    principal = (env.DEV_ADMIN_EMAIL || "dev@localhost").toLowerCase();
  } else {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return null;
    if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) {
      throw new Error(
        "ACCESS_AUD and ACCESS_TEAM_DOMAIN must be set when DEV_AUTH_BYPASS is off",
      );
    }
    principal = await verifyAccessJwt(
      token,
      env.ACCESS_AUD,
      env.ACCESS_TEAM_DOMAIN,
    );
  }

  return authorize(env, principal);
}

/** Admin-only "view as another user". */
export const IMPERSONATE_HEADER = "X-Impersonate";

/** An email address, or a `svc:<client-id>` service-token principal. */
const TARGET_RE = /^(?:[^\s@]+@[^\s@]+\.[^\s@]+|svc:[a-z0-9][a-z0-9._-]*)$/;

export type Impersonation =
  | { ok: true; identity: Identity }
  | { ok: false; status: 400 | 403; error: string };

/**
 * Swap in another user's authorization for this request, if an admin asked for
 * it via `X-Impersonate`.
 *
 * Deliberately server-side and per-request rather than a token minted for the
 * target (v1's approach) or a frontend costume. A second token is a credential
 * that outlives the question being asked and authenticates as someone who never
 * signed in; a frontend-only mode would show what the GUI *believes* a user may
 * do, which is exactly the belief under test. Re-resolving authorization here
 * means the delegated range, the ownership filter on `/extensions` and the 403
 * on `/admin/*` are the real ones.
 *
 * The target need not be provisioned: an unknown address resolves to the same
 * zero-privilege identity a real unprovisioned sign-in gets, which is the view
 * an admin most often wants to check.
 *
 * `impersonatedBy` carries the real admin through to the audit log, so nothing
 * done here is recorded as the target acting alone.
 */
export async function applyImpersonation(
  request: Request,
  env: Env,
  real: Identity,
): Promise<Impersonation> {
  const raw = request.headers.get(IMPERSONATE_HEADER);
  if (!raw) return { ok: true, identity: real };

  const target = raw.trim().toLowerCase();
  // Viewing as yourself is the normal case, not an error — the frontend leaves
  // the header in place across a reload.
  if (!target || target === real.email.toLowerCase()) {
    return { ok: true, identity: real };
  }

  if (real.role !== "admin") {
    return {
      ok: false,
      status: 403,
      error: "only an admin may view as another user",
    };
  }
  // A service token is a long-lived automation credential; letting one assume
  // any identity in the fleet buys nothing, since impersonation exists to
  // answer a question a human is asking interactively.
  if (real.email.startsWith("svc:")) {
    return {
      ok: false,
      status: 403,
      error: "a service token may not view as another user",
    };
  }
  if (target.length > 254 || !TARGET_RE.test(target)) {
    return {
      ok: false,
      status: 400,
      error: "X-Impersonate must be an email address or a svc: client id",
    };
  }

  const identity = await authorize(env, target);
  return { ok: true, identity: { ...identity, impersonatedBy: real.email } };
}

/**
 * Who to record as the actor.
 *
 * An impersonated action is attributed to both parties. Recording only the
 * target would forge history — it says someone acted who never signed in — and
 * recording only the admin would hide which range and ownership the action ran
 * under.
 */
export function auditActor(id: Identity): string {
  return id.impersonatedBy ? `${id.impersonatedBy} (as ${id.email})` : id.email;
}

/** Is `number` inside the caller's delegated range and not blocked? */
export function inRange(id: Identity, number: string): boolean {
  if (id.role === "admin") return true;
  const n = Number(number);
  if (!Number.isInteger(n)) return false;
  if (id.minExt === null || id.maxExt === null) return false;
  return n >= id.minExt && n <= id.maxExt;
}
