# asterisk-extention-manager2

Cloud-managed configuration for Asterisk 23, for both PJSIP and
[chan_sccp2](https://github.com/coral/sccp-rs). Cloudflare is the authoritative
control plane; Asterisk keeps only runtime state and last-known-good config.

Asterisk dials **out** to a Durable Object over WSS and all configuration flows
back over that same socket as ARI REST-over-WebSocket. There is no inbound
management port on the PBX and no on-box agent.

```
Browser ──CF Access──▶ Worker (Hono) ──▶ D1  (canonical desired state)
                          │
                          ├──▶ DO stub (getByName(pbx_id))  — one per PBX
                          │
Asterisk 23.5.0 ══════════╧═══ persistent outbound WSS ═══▶ PbxController
   websocket_client.conf                                      • owns the socket
   ari.conf outbound_websocket                                • serializes reconcile
   sorcery.conf → astdb                                       • per-object versions
                                                              • ack cursor, retry, alarm
```

## How it works

**Extension is the unit.** You create `extension 1001, tech=pjsip, profile=desk`.
The Worker expands that into concrete sorcery objects — PJSIP `auth`+`aor`+
`endpoint`, or SCCP `line`+`device` — and those expansions are what get
versioned and reconciled. The trio can never drift apart because it comes from
one expansion.

**Profiles carry the options.** A profile is a validated attribute bag flattened
into the ARI `fields[]` array at push time, with per-object overrides on top.
Any Asterisk option is reachable without a schema migration.

**Two layers, two delivery mechanisms.** Extensions live in the astdb sorcery
backend and move over ARI. Everything ARI cannot reach — the websocket config
itself, `sorcery.conf`, PJSIP trunks/transports/identifies, the whole SCCP
`[general]` section and its softkey profiles, and the dialplan — is rendered
into a config bundle that the operator applies out-of-band. The rendered
`extensions.conf` stamps `[globals] AEM_FILE_REV`, which the DO reads back over
ARI, so "the operator forgot to apply the bundle" is a detected state rather
than a mystery.

**Ownership is the same for both technologies**: object ids are bare extension
numbers, and the owned set is what this PBX last successfully pushed.

| | PJSIP | SCCP |
|---|---|---|
| Object id | the extension number | the extension number (line), `SEP`+12 hex (device) |
| Owned set | the DO's local mirror | the DO's local mirror |
| Stray discovery | mirror minus desired, cross-checked against `pjsip_static` | mirror minus desired |
| Why not a prefix | PJSIP matches the incoming username against the endpoint *id*, so a prefixed endpoint is unreachable for any phone not reconfigured to send the prefix | `SEP`+12-hex ids cannot carry one, and chan_sccp2 registers no `ast_endpoint`, so ARI cannot enumerate anything either |

An earlier design gave PJSIP objects an `aem-` prefix and treated that as the
ownership boundary. It cannot work: both `identify_by=username` (From header)
and `identify_by=auth_username` (Authorization header) resolve an endpoint by
retrieving it *by id*, not by searching auth objects for a matching `username`.
A handset registering as `1001` only ever finds an endpoint literally named
`1001`, so every migrated phone would have needed reconfiguring. The `prefix`
column survives as a vestigial field that nothing reads.

Because ids are now indistinguishable from hand-written ones, the sweep only
ever deletes objects it previously wrote, and refuses any id present in
`pjsip_static`. The trade is deliberate: an object orphaned by mirror loss (DO
eviction with a storage reset) is no longer reclaimable automatically, which is
the recoverable direction — the alternative failure mode is deleting a trunk.

## Constraints this design works around

These were established from source, not assumed. Several obvious designs do not
work because of them.

- **ARI cannot enumerate sorcery objects.** `/asterisk/config/dynamic/{class}/{type}/{id}`
  is GET/PUT/DELETE by id only.
- **The default flat-file sorcery wizard is read-only.** Every PUT returns 403
  until `sorcery.conf` remaps types to `astdb`. The DO probes for this on
  connect rather than discovering it one failed push at a time.
- **chan_sccp2 acks 200 for writes that did not converge** — see
  [docs/UPSTREAM-SCCP-RS.md](docs/UPSTREAM-SCCP-RS.md). The Worker ports
  chan_sccp2's own validation rules and refuses to push an invalid inventory.
- **chan_sccp2 rejects a `type` attribute**, the opposite of every other sorcery
  class, and only at reload time.
- **Every SCCP write triggers a complete inventory reload**, and any material
  device change disconnects the phone. The reconciler reads before writing and
  skips unchanged objects, so a routine sweep costs no re-registrations.
- **`identify`, `registration` and `transport` are fetched in bulk** at
  load/reload, so per-object ARI pushes would not take effect. They live in the
  file layer.
- **`websocket_client.conf` supports no custom headers**, so Cloudflare Access
  service tokens cannot authenticate the PBX. It uses the site id in the URL
  path plus HTTP Basic on the upgrade.
- **There is no CDR event in ARI** and no HTTP CDR backend ships with Asterisk.
  `ari.conf` `channelvars` entries containing `(` are invoked as dialplan
  functions, so `CDR(billsec)` and friends ride along on channel events. This
  requires `cdr.conf` `endbeforehexten = yes`, which defaults to `no` — without
  it an answered call reports disposition `NO ANSWER`.

## Reconciliation

- **Full sweep on every connect.** The delta cursor assumes the PBX kept what we
  last acked, which AstDB does across an Asterisk restart but not across a
  re-image or a restore from backup.
- **Deltas in steady state**, coalesced to the last op per object, with a
  mandatory full-resync fallback when the op log has been pruned past the cursor.
- **Ordering**: creates ascending by dependency rank (`auth`/`line` → `aor`/`device`
  → `endpoint`), deletes descending.
- **Halt on first failure.** The batch stops, the ack cursor does not advance,
  and the retry re-runs it idempotently. After 5 consecutive failures an object
  is quarantined and skipped so one poisoned object cannot stall the stream.
  A pass that skipped a quarantined object reports `degraded`, never
  `converged` — an object knowingly not applied is not convergence. Release
  them with `POST /api/admin/pbx/{id}/resync` (the "I fixed it, try again"
  button), or one at a time with
  `DELETE /api/admin/pbx/{id}/quarantine/{class}/{type}/{objectId}`.
- **Backoff** 1s → 5m, reset on every new connection — an operator who fixes the
  problem and restarts Asterisk gets an immediate attempt.
- **Hourly drift sweep** via a DO alarm, which also acts as the watchdog that
  restarts a reconcile killed mid-flight by DO eviction.

## Getting started

```bash
npm install

# One-time: copy the config template, create the database and put its id
# (plus your route and Access values) in wrangler.jsonc, which is gitignored
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler d1 create aem
npm run db:migrate:local

# Local dev secrets (throwaway; production uses `wrangler secret put`)
cat > .dev.vars <<EOF
DEV_AUTH_BYPASS=1
DEV_ADMIN_EMAIL=you@example.com
SECRET_KEY=$(openssl rand -base64 32)
BUNDLE_KEY=$(openssl rand -base64 32)
EOF

npm run dev
```

`SECRET_KEY` encrypts extension and PBX secrets at rest in D1 and is only ever
decrypted inside the Durable Object, immediately before a push. Losing it means
losing every SIP credential.

### Provisioning a PBX

```bash
# Seed yourself as an admin
npx wrangler d1 execute aem --local --command \
  "INSERT INTO app_user (email, role, min_ext, max_ext, call_log_access)
   VALUES ('you@example.com','admin',1000,1999,1)"

curl -X POST localhost:8787/api/admin/pbx -H 'Content-Type: application/json' \
  -d '{"id":"site42","name":"Site 42","sccp_enabled":true}'

curl -X POST localhost:8787/api/extensions -H 'Content-Type: application/json' \
  -d '{"pbx_id":"site42","number":"1001","display_name":"Björn Åkesson","tech":"pjsip","profile_id":"desk"}'

# Render the config bundle and apply it on the PBX
curl localhost:8787/api/pbx/site42/config-bundle
```

The bundle is JSON — one entry per file — so it stays diffable in a git-based
deployment pipeline. Every generated file ends with an
`#include "<name>_local.conf"` escape hatch for site-specific config.

### Calling the API from the terminal

Access protects every route, so curl needs a **service token** (Zero Trust →
Access → Service Auth), admitted by a second policy on the application with
action *Service Auth*. Access then forwards a JWT whose principal is the
token's client id in a `common_name` claim — there is no email — so the token
is provisioned as its own `app_user` row under the `svc:` namespace and gets a
role, a delegated range and audit-log entries exactly like a person:

```bash
npx wrangler d1 execute aem --remote --command \
  "INSERT INTO app_user (email, role, display_name)
   VALUES ('svc:<client-id>','admin','CI pipeline')"

export CF_ID="<client id>" CF_SECRET="<client secret>"
curl -H "CF-Access-Client-Id: $CF_ID" -H "CF-Access-Client-Secret: $CF_SECRET" \
     https://aem.example.com/api/me
```

Grant `role=user` with a `min_ext`/`max_ext` range unless the token genuinely
needs `/api/admin/*`. Rotating the token in Zero Trust changes the client id,
so the `app_user` row has to be re-pointed at the new one.

### Viewing the GUI as another user

An admin can load the whole GUI with another user's privileges — the sidebar
footer has **View as…**, and each row on the Users screen has its own button.
It answers "can this user create an extension, and what do they see?" without
borrowing their laptop.

It is an admin-only `X-Impersonate: <email>` header, honoured per-request and
re-resolved against `app_user` server-side, never a token minted for the target:

```bash
curl -H "CF-Access-Client-Id: $CF_ID" -H "CF-Access-Client-Secret: $CF_SECRET" \
     -H "X-Impersonate: sales@example.com" https://aem.example.com/api/me
```

Consequences worth knowing:

- The privileges are genuinely the target's. `/api/admin/*` returns 403 while an
  admin views as a `user`, `/extensions` shows only rows that user owns, and
  creating one is held to *their* delegated range.
- **Changes are real.** Nothing is sandboxed; an extension created this way is
  owned by the impersonated user and pushed to the PBX.
- Both parties are audited: the actor is recorded as
  `admin@example.com (as sales@example.com)`.
- A target with no `app_user` row resolves to the same zero-privilege identity a
  real unprovisioned sign-in gets, which is the fastest way to see what a
  newcomer lands on.
- Service tokens may not impersonate, and a non-admin sending the header gets a
  403 rather than a silently ignored request.

### Testing without a PBX

`tools/mock-asterisk.mjs` is a mock Asterisk 23 that dials out and answers
RESTRequest frames from an in-memory sorcery store, so the whole reconcile loop
can be exercised locally:

```bash
# secret comes from the POST /api/admin/pbx response, or the rendered bundle
node tools/mock-asterisk.mjs ws://127.0.0.1:8787/pbx/site42 site42 <secret> --stray aem-9099
```

Useful flags: `--no-astdb` (simulate an unmapped sorcery wizard),
`--missing-module M`, `--file-rev N` (simulate a stale bundle),
`--fail-on ID` (simulate an object the PBX rejects).

```bash
npm test        # 162 unit + D1 integration tests
npm run typecheck
```

## Scope

Managed: PJSIP and SCCP extensions, profiles, SCCP devices and buttons, PJSIP
trunks/transports/identifies, dialplan, hints, ring groups, queues, IVRs, time
conditions, music-on-hold classes, delegation ranges, blocked-extension
carve-outs, audit log, Cisco XML phonebook, call log.

**Deferred to v2:** voicemail — so the rendered dialplan's no-answer target is
per-profile configurable and defaults to `Hangup()` rather than emitting
`Voicemail()`. Ring groups, IVRs and queues all eventually want a voicemail
fallback, so this is the likely first addition.

**Out of scope:** fax. It needs Ghostscript, write access to
`/var/spool/asterisk/outgoing`, and log scraping — inherently on-box, and would
have to live in a separate local service.

The call log is explicitly **not billing-grade**: ARI events are lost while the
socket is down and Asterisk does not replay them.

## Project notes

- [todo.md](todo.md) — what still has to be built, including the deployment
  prerequisites and the checklist for verifying against real hardware
- [ideas.md](ideas.md) — alternatives considered and rejected, and where to go next
- [bugs.md](bugs.md) — defects found during development and how they were fixed
- [docs/UPSTREAM-SCCP-RS.md](docs/UPSTREAM-SCCP-RS.md) — change request for the
  sccp-rs maintainer
