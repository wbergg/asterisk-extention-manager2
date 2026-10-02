import { Hono } from "hono";

import { api } from "./api/routes.js";
import { decryptSecret, generateSecret, timingSafeEqual } from "./lib/crypto.js";
import { renderDirectoryXml } from "./api/directory.js";
import type { Env } from "./types.js";

export { PbxController } from "./do/pbx.js";

const app = new Hono<{ Bindings: Env }>();

/**
 * The Asterisk outbound WebSocket endpoint.
 *
 * Asterisk dials out to wss://<host>/pbx/<site-id> and presents HTTP Basic
 * credentials on the upgrade. That is the whole authentication surface
 * available to us: websocket_client.conf supports only username/password, TLS
 * server verification and client certificates — there is no custom-header
 * option, which is why Cloudflare Access service tokens cannot be used here.
 */
app.get("/pbx/:id", async (c) => {
  const pbxId = c.req.param("id");

  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("expected a websocket upgrade", 426);
  }

  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Basic ")) {
    return c.text("unauthorized", 401, {
      "WWW-Authenticate": 'Basic realm="aem"',
    });
  }

  let username: string;
  let password: string;
  try {
    const decoded = atob(auth.slice(6));
    const sep = decoded.indexOf(":");
    if (sep < 0) throw new Error("malformed");
    username = decoded.slice(0, sep);
    password = decoded.slice(sep + 1);
  } catch {
    return c.text("malformed credentials", 400);
  }

  const pbx = await c.env.DB.prepare(
    "SELECT id, ws_secret_enc FROM pbx WHERE id = ?",
  )
    .bind(pbxId)
    .first<{ id: string; ws_secret_enc: string }>();

  // Compare against a value even when the PBX is unknown, so a bad site id and
  // a bad password take the same path and cannot be told apart. A fresh random
  // value rather than a fixed placeholder: it can never coincide with a real
  // secret, and its length does not leak through the length check.
  const expected = pbx
    ? await decryptSecret(c.env.SECRET_KEY, pbx.ws_secret_enc)
    : generateSecret(32);

  if (!pbx || username !== pbxId || !timingSafeEqual(password, expected)) {
    console.warn(`pbx auth rejected for "${pbxId}"`);
    return c.text("unauthorized", 401);
  }

  const stub = c.env.PBX.getByName(pbxId);
  // The DO does not know its own name, so pass it explicitly.
  const url = new URL(c.req.url);
  url.searchParams.set("pbx_id", pbxId);

  return stub.fetch(new Request(url, c.req.raw));
});

/**
 * Cisco XML phonebook.
 *
 * Served unauthenticated because 7900-series sets cannot present credentials
 * or do TLS, and they fetch this directly. It exposes names and extension
 * numbers only — no credentials — which is the same exposure as the printed
 * directory on the wall. Scoped per PBX so one site's phones cannot enumerate
 * another's.
 */
app.get("/directory.xml", async (c) => {
  const pbxId = c.req.query("pbx");
  if (!pbxId) return c.text("missing ?pbx=<site-id>", 400);
  return renderDirectoryXml(c.env.DB, pbxId, new URL(c.req.url));
});

app.route("/api", api);

// Everything else is the SPA.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
