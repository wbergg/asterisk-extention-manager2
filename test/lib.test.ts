import { describe, expect, it } from "vitest";

import { toAscii, xmlEscape } from "../src/lib/ascii.js";
import {
  decryptSecret,
  encryptSecret,
  generateSecret,
  timingSafeEqual,
} from "../src/lib/crypto.js";
import { extensionFromChannelName } from "../src/do/calllog.js";
import {
  buildRequest,
  configUri,
  describeFailure,
  isRestResponse,
} from "../src/ari/envelope.js";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe("ASCII folding", () => {
  it("folds Nordic characters rather than dropping them", () => {
    expect(toAscii("Björn Åkesson")).toBe("Bjorn Akesson");
    expect(toAscii("Ærø Øst")).toBe("AEro Ost");
  });

  it("folds common European accents", () => {
    expect(toAscii("José Müller-Françoise")).toBe("Jose Muller-Francoise");
    expect(toAscii("Straße")).toBe("Strasse");
  });

  it("drops anything still non-ASCII after the table", () => {
    expect(toAscii("Zoë 日本 ok")).toBe("Zoe  ok");
  });

  it("leaves plain ASCII untouched", () => {
    expect(toAscii("John Doe 1001")).toBe("John Doe 1001");
  });
});

describe("XML escaping", () => {
  it("escapes the five XML entities", () => {
    expect(xmlEscape(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;",
    );
  });
});

describe("secret handling", () => {
  it("round-trips through AES-GCM", async () => {
    const secret = "s3cr3t-p@ssw0rd";
    const blob = await encryptSecret(KEY, secret);
    expect(blob).not.toContain(secret);
    expect(await decryptSecret(KEY, blob)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", async () => {
    const a = await encryptSecret(KEY, "same");
    const b = await encryptSecret(KEY, "same");
    expect(a).not.toBe(b);
    expect(await decryptSecret(KEY, a)).toBe(await decryptSecret(KEY, b));
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(encryptSecret(btoa("short"), "x")).rejects.toThrow(
      /32 bytes/,
    );
  });

  it("fails to decrypt with the wrong key", async () => {
    const blob = await encryptSecret(KEY, "x");
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    await expect(decryptSecret(other, blob)).rejects.toThrow();
  });

  it("generates secrets of the requested length from the full alphabet", () => {
    expect(generateSecret(20)).toHaveLength(20);
    expect(generateSecret(32)).toHaveLength(32);
    expect(generateSecret(20)).toMatch(/^[A-Za-z0-9]{20}$/);
  });

  it("generates unbiased secrets", () => {
    // v1 used `byte % 62`, which over-weights the first four characters of the
    // alphabet by ~1.6%. Rejection sampling should stay close to uniform.
    const counts = new Map<string, number>();
    for (let i = 0; i < 200; i++) {
      for (const ch of generateSecret(64)) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    const values = [...counts.values()];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    // Every character should appear, within a generous band around the mean.
    expect(counts.size).toBe(62);
    expect(Math.min(...values)).toBeGreaterThan(mean * 0.7);
    expect(Math.max(...values)).toBeLessThan(mean * 1.3);
  });

  it("compares in constant time without false positives", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("channel name parsing", () => {
  it("recovers the endpoint from a PJSIP channel name", () => {
    expect(extensionFromChannelName("PJSIP/aem-1001-00000002")).toBe("aem-1001");
  });

  it("recovers the line from an SCCP channel name", () => {
    expect(extensionFromChannelName("SCCP/1001-0000002a")).toBe("1001");
  });

  it("returns null for unparseable input", () => {
    expect(extensionFromChannelName(undefined)).toBeNull();
    expect(extensionFromChannelName("Local")).toBeNull();
  });
});

describe("ARI envelope", () => {
  it("builds a dynamic-config URI with no leading slash", () => {
    // A leading slash yields 405 — the single most common REST-over-WebSocket
    // mistake.
    const uri = configUri("res_pjsip", "aor", "aem-1001");
    expect(uri.startsWith("/")).toBe(false);
    expect(uri).toBe("asterisk/config/dynamic/res_pjsip/aor/aem-1001");
  });

  it("escapes ids that need it", () => {
    expect(configUri("res_pjsip", "endpoint", "a b/c")).toBe(
      "asterisk/config/dynamic/res_pjsip/endpoint/a%20b%2Fc",
    );
  });

  it("uses content_type and message_body, not headers or a JSON body field", () => {
    const req = buildRequest("r1", "PUT", "asterisk/config/dynamic/x/y/z", {
      body: { fields: [{ attribute: "type", value: "aor" }] },
    });
    expect(req.content_type).toBe("application/json");
    expect(req.message_body).toBe(
      '{"fields":[{"attribute":"type","value":"aor"}]}',
    );
    expect(req).not.toHaveProperty("headers");
    expect(req).not.toHaveProperty("body");
  });

  it("omits optional fields when unused", () => {
    const req = buildRequest("r1", "GET", "asterisk/modules");
    expect(req).not.toHaveProperty("query_strings");
    expect(req).not.toHaveProperty("message_body");
    expect(req).not.toHaveProperty("transaction_id");
  });

  it("identifies REST responses versus events", () => {
    expect(isRestResponse({ type: "RESTResponse" })).toBe(true);
    expect(isRestResponse({ type: "ChannelDestroyed" })).toBe(false);
  });

  it("distinguishes a validation rejection from a wizard refusal", () => {
    // 403 almost always means sorcery.conf is not mapping the type to a
    // writable wizard, which is a completely different fix from a bad field.
    expect(
      describeFailure({
        type: "RESTResponse",
        transaction_id: "",
        request_id: "r1",
        status_code: 403,
        reason_phrase: "Forbidden",
        uri: "x",
      }),
    ).toMatch(/sorcery\.conf/);

    expect(
      describeFailure({
        type: "RESTResponse",
        transaction_id: "",
        request_id: "r1",
        status_code: 400,
        reason_phrase: "Bad request",
        uri: "x",
      }),
    ).toMatch(/apply handler veto/);
  });
});
