/**
 * Secret handling.
 *
 * SIP digest auth needs the plaintext password to reach `auth.password`, so it
 * has to be recoverable — but it is stored as AES-GCM ciphertext in D1 and
 * decrypted only inside the Durable Object, immediately before the push. The
 * API reveals a secret once at creation and never again.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const raw = b64decode(base64Key);
  if (raw.length !== 32) {
    throw new Error(
      `SECRET_KEY must decode to 32 bytes, got ${raw.length}. ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Returns base64(iv ‖ ciphertext). */
export async function encryptSecret(
  base64Key: string,
  plaintext: string,
): Promise<string> {
  const key = await importAesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64encode(out);
}

export async function decryptSecret(
  base64Key: string,
  blob: string,
): Promise<string> {
  const key = await importAesKey(base64Key);

  // Without this, a wrong SECRET_KEY or a hand-edited row surfaces as a bare
  // "atob() called with invalid base64-encoded data" from somewhere deep in a
  // config push, which says nothing about what to actually fix.
  let raw: Uint8Array;
  try {
    raw = b64decode(blob);
  } catch {
    throw new Error(
      "stored secret is not valid base64 — the row was not written by this system",
    );
  }
  if (raw.length <= 12) {
    throw new Error("stored secret is too short to contain an AES-GCM nonce");
  }

  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.subarray(0, 12) },
      key,
      raw.subarray(12),
    );
    return dec.decode(pt);
  } catch {
    throw new Error(
      "could not decrypt stored secret — SECRET_KEY does not match the key it was encrypted with",
    );
  }
}

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Generate a SIP secret.
 *
 * Uses rejection sampling rather than `byte % 62`. v1's generator
 * (models/extension.go:22-32) used the modulo form, which skews the first 8
 * characters of the alphabet measurably.
 */
export function generateSecret(length = 20): string {
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  let out = "";
  const buf = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= max) continue; // reject, don't fold
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Policy for an operator-supplied secret.
 *
 * Deliberately lenient about length: the reason freetext is accepted at all is
 * to adopt handsets that are already registered with a password somebody else
 * chose, and a floor higher than the shortest real-world SIP secret would make
 * adoption impossible — which pushes operators towards reprovisioning a whole
 * fleet, or towards keeping v1 around. Generated secrets are 20 chars and are
 * what the GUI offers first; this is the escape hatch, not the default.
 *
 * Whitespace and control characters are refused because they survive the JSON
 * push to ARI but not the phone-side config that has to carry the same value —
 * the two ends then disagree and the handset never registers.
 */
export const MIN_SECRET_LENGTH = 8;
export const MAX_SECRET_LENGTH = 128;

/** Returns a human-readable problem, or null when the secret is acceptable. */
export function validateSecret(secret: string): string | null {
  if (secret.length < MIN_SECRET_LENGTH) {
    return `secret must be at least ${MIN_SECRET_LENGTH} characters`;
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    return `secret must be at most ${MAX_SECRET_LENGTH} characters`;
  }
  if (!/[A-Z]/.test(secret)) {
    return "secret must contain an uppercase letter";
  }
  if (!/[0-9]/.test(secret)) {
    return "secret must contain a digit";
  }
  if (/[\s\u0000-\u001f\u007f]/.test(secret)) {
    return "secret must not contain whitespace or control characters";
  }
  return null;
}

const PBKDF2_ITERATIONS = 210_000;

export async function hashPassword(
  password: string,
  saltB64?: string,
): Promise<{ hash: string; salt: string }> {
  const salt = saltB64 ? b64decode(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return { hash: b64encode(new Uint8Array(bits)), salt: b64encode(salt) };
}

export async function verifyPassword(
  password: string,
  expectedHash: string,
  salt: string,
): Promise<boolean> {
  const { hash } = await hashPassword(password, salt);
  return timingSafeEqual(hash, expectedHash);
}

/** Constant-time string compare, to keep secret verification non-leaky. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256 over a rendered config bundle, hex encoded. */
export async function signBundle(
  base64Key: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    b64decode(base64Key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
