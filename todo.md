# TODO

Work that is required for this to be usable, ordered roughly by what blocks what.
Speculative work lives in [ideas.md](ideas.md); fixed defects in [bugs.md](bugs.md).

---

## Blocking — cannot deploy without these

- [ ] **Create the D1 database and set its id.** `wrangler.jsonc` still has
      `"database_id": "REPLACE_WITH_D1_DATABASE_ID"`. Run
      `npx wrangler d1 create aem` and paste the id in.
- [ ] **Set production secrets.** `wrangler secret put SECRET_KEY` and
      `wrangler secret put BUNDLE_KEY`, both 32 random bytes base64
      (`openssl rand -base64 32`). Losing `SECRET_KEY` means losing every SIP
      credential in the estate — back it up somewhere that is not this repo.
- [ ] **Configure Cloudflare Access** and set `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`
      in `wrangler.jsonc`. Confirm `DEV_AUTH_BYPASS` is `"0"` in the deployed
      environment — it is the one thing standing between the API and the open
      internet.
- [ ] **Verify against a real Asterisk 23.5.0.** Everything so far is verified
      against `tools/mock-asterisk.mjs`, which implements the protocol as
      documented, not as the binary actually behaves. See the checklist below.

## Verification against real hardware

The mock covers the control-plane logic. These need the real thing:

- [ ] Asterisk actually dials out and authenticates with the rendered
      `websocket_client.conf` (`connection_type = persistent`, Basic on the upgrade).
- [ ] `GET /endpoints/PJSIP` **lists astdb-backed endpoints**. This is the single
      most load-bearing unverified assumption: PJSIP stray detection depends on
      it entirely. If astdb-backed endpoints do not appear there, PJSIP needs the
      same mirror-based ownership SCCP uses.
- [ ] Pushed `endpoint`/`auth`/`aor` take effect without a `module reload` (they
      are fetched on demand, so they should).
- [ ] A softphone registers against a pushed endpoint and can place a call.
- [ ] A 7900-series SCCP set registers against a pushed device+line.
- [ ] `restart asterisk` → socket reconnects unaided, sweep runs, **zero** ops
      applied and no phone disconnects.
- [ ] Delete an aor at the CLI → the hourly alarm sweep detects and repairs it.
- [ ] Create `aem-9999` by hand → reconcile deletes it and leaves `trunk-telia`
      untouched.
- [ ] Place answered / unanswered / busy calls → `call_leg` rows carry a correct
      `disposition` and non-zero `billsec`. This is the check that proves
      `endbeforehexten = yes` took effect; without it an answered call reports
      `NO ANSWER`.
- [ ] Stop the Worker → registrations, calls and SCCP sessions are entirely
      unaffected.
- [ ] Confirm an identical re-PUT of an SCCP device really is a no-op and does
      not drop the session (`config/reload.rs:345-380` says the diff is
      value-based; worth proving).

## Missing API surface

The schema and renderers support these, but nothing can create or edit them
except direct SQL. Each needs CRUD endpoints:

- [ ] `sccp_device` + `sccp_button` — **the most conspicuous gap.** SCCP devices
      are fully modelled, expanded, validated and reconciled, but there is no way
      to create one through the API.
- [ ] `pjsip_static` — trunks, transports, identifies (rendered into `pjsip.conf`)
- [ ] `sccp_static` — softkey profiles and `(!)` templates. A device referencing
      a missing softkey profile is a hard reload failure, and the validator
      already cross-checks against this table, so it needs a way to be populated.
- [ ] `ring_group` + `ring_group_member`
- [ ] `queue` + `queue_member`
- [ ] `ivr` + `ivr_entry`
- [ ] `time_condition`
- [ ] `moh_class`
- [ ] `PATCH /admin/pbx/:id` — edit `settings_json` (bind addresses, codecs,
      channelvars, dialplan includes). Currently only settable at creation.
- [ ] `DELETE` for `pbx`, `profile`, `app_user`.
- [ ] Rotate a PBX's `ws_secret` / `ari_secret`.

## Carried over from the reference, not yet built

- [x] **Admin impersonation.** Built as an admin-only `X-Impersonate` header,
      honoured per-request in the API middleware and re-resolved against
      `app_user`, rather than v1's minted token (`auth_handler.go:134-159`). The
      admin gate, the delegated range and the ownership filter all see the
      impersonated identity; the audit log records `admin (as target)`. Service
      tokens are excluded. GUI entry points: the sidebar footer and each Users
      row.
- [x] **Password policy for operator-supplied secrets.** `validateSecret()` in
      `src/lib/crypto.ts` — 8-128 chars, at least one uppercase letter and one
      digit, no whitespace or control characters — applied to a caller-supplied
      `secret` on both `POST /extensions` and `PUT /extensions/:pbx/:number`.
      The floor is deliberately low: freetext exists to adopt handsets already
      registered with somebody else's password, and a higher floor would make
      adoption impossible. Raise it if a deployment would rather reprovision.
- [ ] **`/logo.bmp`** with explicit `Content-Type: image/bmp` and
      `Content-Length` — Cisco sets require both.

## Frontend

- [ ] **The SPA does not exist.** `public/index.html` is a placeholder. Views
      needed: login/identity, self-service extensions, directory, call log, and
      admin views for fleet status, profiles, users and blocked ranges.
- [ ] The fleet status view is the one with no equivalent in v1 and the most
      value: per-PBX `state`, ack cursor vs desired, `AEM_FILE_REV` drift,
      quarantined objects with their failure reason, and a resync button.

## Operational gaps

- [ ] **`op_log` is never pruned.** It grows without bound. The DO already
      handles a pruned prefix by falling back to a full sweep
      (`cursor_gap`), so pruning is safe — but nothing does it. Needs a
      retention policy and a scheduled job.
- [ ] **`call_leg` is never pruned either.** Same problem, larger table.
- [ ] **No alerting.** A PBX sitting `degraded` or `blocked` is visible only if
      somebody looks. Worth a scheduled check that surfaces it.
- [ ] **Bundle delivery is manual.** `GET /api/pbx/{id}/config-bundle` returns
      signed JSON; nothing consumes it. Needs an Ansible role, a CI job, or the
      git-push approach in ideas.md.
- [ ] **`BUNDLE_KEY` signs the bundle but nothing verifies it.** Either write a
      verifier into whatever applies the bundle, or drop the signature rather
      than implying a guarantee that is not checked.
- [ ] Run `wrangler types` and commit `worker-configuration.d.ts` rather than
      hand-maintaining `Env` in `src/types.ts`.

## Testing gaps

- [ ] **No test covers the Durable Object directly.** The reconciler is exercised
      end-to-end through `tools/mock-asterisk.mjs` by hand. Bugs 1–4 in
      `bugs.md` were all in the DO and none would have been caught by the
      current suite. This is the biggest testing hole.
- [ ] Regression tests specifically for: SCCP stray deletion (bug 1), sweep on
      every reconnect (bug 2), backoff reset on connect (bug 3), quarantine
      release (bug 4).
- [ ] **Replay `sccp-rs/asterisk-module/ci/sorcery/rest-over-websocket.requests.jsonl`**
      against the envelope encoder to confirm framing matches what the module's
      own CI expects. Planned but not done.
- [ ] No test for `src/lib/access.ts` — the Access JWT verification path is
      entirely untested, including the algorithm pinning.
- [ ] No test for `src/do/calllog.ts` beyond `extensionFromChannelName`.

## Upstream

- [ ] Send [docs/UPSTREAM-SCCP-RS.md](docs/UPSTREAM-SCCP-RS.md) to the sccp-rs
      maintainer. Nothing here blocks on it — the Worker validates client-side —
      but §1 and §4 close a real observability hole that client-side validation
      cannot: deletes have no veto path, and failures caused by state we cannot
      see stay invisible.
