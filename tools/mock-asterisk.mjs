#!/usr/bin/env node
/**
 * A mock Asterisk 23 that speaks ARI REST-over-WebSocket.
 *
 * Dials out to the control plane exactly as `websocket_client.conf` with
 * `connection_type = persistent` would, then answers RESTRequest frames from
 * an in-memory sorcery store. Lets the whole reconcile loop — preconditions,
 * full sweep, diffing, stray deletion, delta application — be exercised
 * without a real PBX.
 *
 * Usage:
 *   node tools/mock-asterisk.mjs ws://127.0.0.1:8787/pbx/site42 site42 <secret> [options]
 *
 * Options:
 *   --file-rev N      value returned for the AEM_FILE_REV global (default 1)
 *   --no-astdb        make config PUT/DELETE return 403, as the read-only
 *                     flat-file wizard does when sorcery.conf is unmapped
 *   --missing-module M  omit M from GET asterisk/modules
 *   --stray ID        pre-seed a PJSIP endpoint that the cloud does not know
 *   --fail-on ID      return 400 for any PUT touching this object id
 *   --quiet
 */

const [, , url, username, password, ...rest] = process.argv;
if (!url || !username || !password) {
  console.error("usage: mock-asterisk.mjs <ws-url> <username> <password> [options]");
  process.exit(2);
}

const opts = {
  fileRev: "1",
  astdb: true,
  missingModules: new Set(),
  strays: [],
  failOn: new Set(),
  quiet: false,
};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--file-rev") opts.fileRev = rest[++i];
  else if (a === "--no-astdb") opts.astdb = false;
  else if (a === "--missing-module") opts.missingModules.add(rest[++i]);
  else if (a === "--stray") opts.strays.push(rest[++i]);
  else if (a === "--fail-on") opts.failOn.add(rest[++i]);
  else if (a === "--quiet") opts.quiet = true;
}

const log = (...a) => opts.quiet || console.log(...a);

/** family -> Map<id, [{attribute, value}]> */
const store = new Map();
const keyOf = (cls, type) => `${cls}/${type}`;
const family = (cls, type) => {
  const k = keyOf(cls, type);
  if (!store.has(k)) store.set(k, new Map());
  return store.get(k);
};

// Pre-seed strays so the reconciler has something to clean up.
for (const id of opts.strays) {
  family("res_pjsip", "endpoint").set(id, [
    { attribute: "type", value: "endpoint" },
    { attribute: "context", value: "leftover" },
  ]);
  family("res_pjsip", "aor").set(id, [{ attribute: "type", value: "aor" }]);
  family("res_pjsip", "auth").set(id, [{ attribute: "type", value: "auth" }]);
}

const MODULES = [
  "res_sorcery_astdb.so",
  "res_sorcery_config.so",
  "res_ari.so",
  "res_ari_asterisk.so",
  "res_websocket_client.so",
  "res_http_websocket.so",
  "res_stasis.so",
  "chan_sccp2.so",
].filter((m) => !opts.missingModules.has(m));

const applied = [];

function handle(req) {
  const uri = decodeURIComponent(req.uri ?? "");
  const method = req.method;

  const ok = (body) => ({
    status_code: 200,
    reason_phrase: "OK",
    content_type: "application/json",
    message_body: JSON.stringify(body),
  });
  const err = (code, phrase, message) => ({
    status_code: code,
    reason_phrase: phrase,
    ...(message
      ? { content_type: "application/json", message_body: JSON.stringify({ message }) }
      : {}),
  });

  // Asterisk answers 405 when the uri carries a leading slash — the single
  // most common REST-over-WebSocket mistake, so the mock enforces it.
  if (req.uri?.startsWith("/")) {
    return err(405, "Method Not Allowed", "uri must not have a leading slash");
  }

  if (uri === "asterisk/modules" && method === "GET") {
    return ok(MODULES.map((name) => ({ name, description: name, use_count: 1, status: "Running" })));
  }

  if (uri === "asterisk/variable" && method === "GET") {
    const v = (req.query_strings ?? []).find((q) => q.name === "variable");
    return ok({ value: v?.value === "AEM_FILE_REV" ? opts.fileRev : "" });
  }

  if (uri === "endpoints/PJSIP" && method === "GET") {
    return ok(
      [...family("res_pjsip", "endpoint").keys()].map((resource) => ({
        technology: "PJSIP",
        resource,
        state: "offline",
        channel_ids: [],
      })),
    );
  }

  const m = uri.match(/^asterisk\/config\/dynamic\/([^/]+)\/([^/]+)\/(.+)$/);
  if (m) {
    const [, cls, type, id] = m;
    const fam = family(cls, type);

    if (method === "GET") {
      const obj = fam.get(id);
      return obj ? ok(obj) : err(404, "Not Found", `${id} not found`);
    }

    if (method === "PUT") {
      if (!opts.astdb) {
        // What the read-only flat-file wizard returns.
        return err(403, "Forbidden", `Cannot create sorcery objects of type '${type}'`);
      }
      if (opts.failOn.has(id)) {
        return err(
          400,
          "Bad request",
          `Creation of object '${id}' failed field value validation`,
        );
      }
      const body = JSON.parse(req.message_body ?? "{}");
      const fields = body.fields ?? [];

      // chan_sccp2 rejects `type`; every other class requires it. The mock
      // enforces both so a regression here is caught.
      if (cls === "chan_sccp2" && fields.some((f) => f.attribute === "type")) {
        return err(400, "Bad request", `Update of object '${id}' failed field value validation`);
      }
      if (cls === "res_pjsip" && !fields.some((f) => f.attribute === "type")) {
        return err(400, "Bad request", `Creation of object '${id}' requires type`);
      }

      // Merge, matching ARI's copy-then-apply semantics.
      const merged = new Map((fam.get(id) ?? []).map((f) => [f.attribute, f.value]));
      for (const f of fields) merged.set(f.attribute, f.value);
      const out = [...merged].map(([attribute, value]) => ({ attribute, value }));
      fam.set(id, out);
      applied.push(`PUT ${cls}/${type}/${id}`);
      log(`  PUT    ${cls}/${type}/${id}  (${fields.length} fields)`);
      return ok(out);
    }

    if (method === "DELETE") {
      if (!fam.has(id)) return err(404, "Not Found", `Object with id '${id}' not found`);
      fam.delete(id);
      applied.push(`DELETE ${cls}/${type}/${id}`);
      log(`  DELETE ${cls}/${type}/${id}`);
      return { status_code: 204, reason_phrase: "No Content" };
    }
  }

  return err(404, "Not Found", `no handler for ${method} ${uri}`);
}

const ws = new WebSocket(url, {
  headers: {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  },
});

ws.addEventListener("open", () => log(`connected to ${url}`));

ws.addEventListener("message", (ev) => {
  let req;
  try {
    req = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (req.type !== "RESTRequest") return;

  const res = handle(req);
  ws.send(
    JSON.stringify({
      type: "RESTResponse",
      transaction_id: req.transaction_id ?? "",
      request_id: req.request_id ?? "",
      uri: req.uri,
      timestamp: new Date().toISOString(),
      asterisk_id: "de:ad:be:ef:00:01",
      application: "aem",
      ...res,
    }),
  );
});

ws.addEventListener("close", (ev) => {
  log(`closed: ${ev.code} ${ev.reason}`);
  dump();
  process.exit(0);
});

ws.addEventListener("error", (e) => {
  console.error("websocket error:", e.message ?? e);
  process.exit(1);
});

function dump() {
  console.log("\n=== operations applied ===");
  for (const op of applied) console.log(" ", op);
  console.log("\n=== resulting sorcery store ===");
  for (const [fam, objs] of store) {
    for (const [id, attrs] of objs) {
      console.log(
        `  ${fam}/${id}: ${attrs.map((a) => `${a.attribute}=${a.value}`).join(" ")}`,
      );
    }
  }
}

const runFor = Number(process.env.MOCK_RUN_MS ?? "12000");
setTimeout(() => {
  dump();
  process.exit(0);
}, runFor);
