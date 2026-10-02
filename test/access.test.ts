import { beforeAll, describe, expect, it, vi } from "vitest";

import { verifyAccessJwt } from "../src/lib/access.js";

const TEAM = "example.cloudflareaccess.com";
const AUD = "aud-tag-under-test";
const KID = "test-key";

let signingKey: CryptoKey;

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlJson(value: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

/** Mint an Access-shaped JWT. `alg` is the *header* claim, not the real one. */
async function mint(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const h = b64urlJson({ alg: "RS256", kid: KID, typ: "JWT", ...header });
  const p = b64urlJson({
    aud: [AUD],
    iss: `https://${TEAM}`,
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  });
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  signingKey = pair.privateKey;

  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as {
    kty: string;
    n: string;
    e: string;
  };

  // The JWKS is fetched once and cached for an hour, so every test in this
  // file verifies against this one key.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      return Response.json({
        keys: [{ kid: KID, kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" }],
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

describe("Access JWT verification", () => {
  it("returns the lowercased email for a human login", async () => {
    const token = await mint({ email: "Bjorn@Example.SE" });
    await expect(verifyAccessJwt(token, AUD, TEAM)).resolves.toBe(
      "bjorn@example.se",
    );
  });

  // A service token JWT carries no email at all — only common_name, its client
  // id — so an email-only check would 401 every terminal call.
  it("maps a service token's common_name into the svc: namespace", async () => {
    const token = await mint({ common_name: "A1B2C3.access", sub: "" });
    await expect(verifyAccessJwt(token, AUD, TEAM)).resolves.toBe(
      "svc:a1b2c3.access",
    );
  });

  it("rejects a token carrying neither claim", async () => {
    const token = await mint({ sub: "" });
    await expect(verifyAccessJwt(token, AUD, TEAM)).rejects.toThrow(
      /neither an email nor a common_name/,
    );
  });

  it("rejects an audience meant for a different application", async () => {
    const token = await mint({ common_name: "a1b2c3.access", aud: ["other"] });
    await expect(verifyAccessJwt(token, AUD, TEAM)).rejects.toThrow(
      /audience mismatch/,
    );
  });

  it("rejects a token issued by a different team domain", async () => {
    const token = await mint({
      common_name: "a1b2c3.access",
      iss: "https://attacker.cloudflareaccess.com",
    });
    await expect(verifyAccessJwt(token, AUD, TEAM)).rejects.toThrow(
      /issuer mismatch/,
    );
  });

  it("rejects an expired token", async () => {
    const token = await mint({
      common_name: "a1b2c3.access",
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    await expect(verifyAccessJwt(token, AUD, TEAM)).rejects.toThrow(/expired/);
  });

  // The signature is never checked for an unpinned algorithm, so this has to
  // be refused on the header alone.
  it("refuses an unsigned token regardless of its claims", async () => {
    const h = b64urlJson({ alg: "none", kid: KID, typ: "JWT" });
    const p = b64urlJson({
      aud: [AUD],
      iss: `https://${TEAM}`,
      exp: Math.floor(Date.now() / 1000) + 600,
      email: "admin@example.se",
    });
    await expect(verifyAccessJwt(`${h}.${p}.`, AUD, TEAM)).rejects.toThrow(
      /unexpected Access JWT algorithm/,
    );
  });

  it("refuses a token whose payload was swapped after signing", async () => {
    const token = await mint({ common_name: "a1b2c3.access" });
    const [h, , sig] = token.split(".");
    const forged = b64urlJson({
      aud: [AUD],
      iss: `https://${TEAM}`,
      exp: Math.floor(Date.now() / 1000) + 600,
      email: "admin@example.se",
    });
    await expect(
      verifyAccessJwt(`${h}.${forged}.${sig}`, AUD, TEAM),
    ).rejects.toThrow(/signature verification failed/);
  });
});
