# Bugs

Defects found during initial development and verification. All entries below are
**fixed** unless marked otherwise. Kept as a record because several were found
by tracing data flow rather than by a failing test, and the same class of
mistake is easy to reintroduce.

Open items live in [todo.md](todo.md); unbuilt ideas in [ideas.md](ideas.md).

---

## 1. SCCP strays were never deleted — the mirror was clobbered before it was read

**Status:** fixed
**Severity:** high — removing an SCCP device from the cloud silently did nothing
**Found by:** tracing the data flow, not by a test

`loadDesired()` wiped and rewrote the Durable Object's `desired` mirror table
with the *new* desired set, and `deleteSccpStrays()` then read that same table
as its record of what was previously on the PBX. The two sets were therefore
always identical and `strays` was always empty.

This mattered more than it looks: ARI cannot enumerate chan_sccp2 objects at
all — the module never calls `ast_endpoint_create` — so the local mirror is the
*only* inventory available for SCCP. D1's desired set is the SCCP owned set, so
deleting a device from the cloud should delete it from the PBX, and it never did.

**Fix:** split loading from mirroring. `loadDesired()` only reads; `saveMirror()`
is called at the end of a successful pass so the mirror always describes
*applied* state. `deleteSccpStrays()` now reads the mirror while it still holds
the previous pass's set. (`src/do/pbx.ts`)

**Verified:** delete an SCCP extension from D1 → resync → `DELETE
chan_sccp2/line/1002` reaches the PBX and the line is gone, with PJSIP objects
untouched.

---

## 2. Full sweep ran only on the first connect, not every reconnect

**Status:** fixed
**Severity:** high — a re-imaged PBX would report `converged` while holding nothing
**Found by:** mock-Asterisk reconnect test (case D/E)

The reconciler gated the full sweep on a `swept_once` flag, so the second and
subsequent connections took the delta path. The delta cursor assumes the PBX
still holds everything we last acked, which AstDB does across an Asterisk
restart — but *not* across a re-image, an AstDB wipe, or a restore from backup.
In those cases the DO would sit reporting `converged` over an empty box forever.

This was also a deviation from the agreed design, which specified a full sweep
on every connect/reconnect.

**Fix:** `fetch()` sets `needs_sweep` on every accepted connection; the
reconciler consumes and clears it. (`src/do/pbx.ts`)

**Verified:** reconnecting against an empty mock re-pushes all four objects in
dependency order.

---

## 3. Backoff from a dead connection suppressed the new connection's reconcile

**Status:** fixed
**Severity:** medium — up to 5 minutes of inaction after an operator fixes the fault
**Found by:** mock-Asterisk precondition test (case B)

After a blocked reconcile, `backoff_until` was set up to 5 minutes ahead. A
*new* WebSocket connection did not reset it, so the reconcile triggered on
connect returned early. The overwhelmingly common reason Asterisk reconnects is
that somebody just fixed the failing thing and restarted it — making them wait
out the old connection's penalty is backwards.

A second bug in the same path: `setState("connecting", null)` cleared
`last_error` on every connect, so the reason a PBX was blocked vanished before
the new attempt had produced its own verdict, leaving the status view blank.

**Fix:** `fetch()` calls `clearFailure()` — a new connection is a new
opportunity — and preserves `last_error` until the new attempt produces a
verdict. `webSocketClose()` likewise preserves a `blocked` state and its reason
rather than resetting to a bare disconnected state. (`src/do/pbx.ts`)

**Verified:** missing-module case now blocks with `required module not loaded:
res_sorcery_astdb.so`, and a subsequent healthy connection converges immediately.

---

## 4. A quarantined object could never be released

**Status:** fixed
**Severity:** medium — object skipped forever, only remedy was direct D1 surgery
**Found by:** an object quarantined by an earlier test silently stayed skipped in a later run

After 5 consecutive failures an object is quarantined and skipped so one poisoned
object cannot stall the whole delta stream. But nothing ever cleared the
quarantine, so an operator who fixed the underlying cause had no way to get the
object retried.

Compounding it, a pass that skipped a quarantined object still reported
`converged`. An object knowingly not applied is not convergence, and the state
that most needs surfacing was the one being hidden.

**Fix:** `POST /api/admin/pbx/{id}/resync` clears the PBX's quarantine before
sweeping — pressing resync *is* the "I fixed it, try again" action. Added
`DELETE /api/admin/pbx/{id}/quarantine/{class}/{type}/{objectId}` for releasing
one object. A pass that skipped quarantined objects now reports `degraded` with
a message naming the remedy. (`src/api/routes.ts`, `src/do/pbx.ts`)

**Verified:** quarantined auth → `degraded` with actionable message → resync
releases 1 → auth pushed → `converged`.

---

## 5. `/directory.xml` was served by the static asset handler, not the Worker

**Status:** fixed
**Severity:** medium — Cisco phones would receive the SPA's HTML instead of the phonebook
**Found by:** route probe during the first boot test

`run_worker_first` listed only `/api/*` and `/pbx/*`. Combined with
`not_found_handling: "single-page-application"`, the asset handler answered
`/directory.xml` with `index.html` and a 200, so the Worker route never ran.
A 7900-series set would have got HTML with an XML content type expectation.

**Fix:** added `/directory.xml` to `run_worker_first`. (`wrangler.jsonc`)

**Verified:** now returns `CiscoIPPhoneDirectory` XML with ASCII folding applied
(`Björn Åkesson` → `Bjorn Akesson`).

---

## 6. The request host leaked into the config-bundle revision hash

**Status:** fixed
**Severity:** medium — every PBX marked stale after fetching a bundle from a different hostname
**Found by:** mock-Asterisk blocked on `config bundle is stale` when nothing had changed

`file_rev` is bumped from a hash of the renderer inputs, and those inputs
included settings derived from the *request* host (the websocket URI is
`wss://<host>/pbx/<id>`). Fetching the bundle from a preview URL, a custom
domain, or a different dev port therefore changed the hash, bumped `file_rev`,
and made every already-converged PBX report a stale bundle.

**Fix:** settings are now persisted to `pbx.settings_json` at PBX creation,
seeded from the request host once. Rendering reads stored settings, so the hash
is stable across hostnames. (`src/api/routes.ts`)

**Verified:** two consecutive bundle fetches return the same `fileRev`.

---

## 7. A NUL byte in `src/index.ts` made it binary to tooling

**Status:** fixed
**Severity:** low — functionally harmless, but broke `grep`, `file`, and diffs
**Found by:** `grep` returning nothing for a route that demonstrably existed

The unknown-PBX placeholder string in the WebSocket auth path was written as
`"\x00unknown-pbx-placeholder"` instead of a plain string. TypeScript and
esbuild parsed the file fine and the Worker ran correctly, but `file(1)`
reported it as `data` and `grep` silently skipped it as binary — which is how it
surfaced.

**Fix:** stripped the NUL, and replaced the fixed placeholder with
`generateSecret(32)`. A fresh random value can never coincide with a real
secret, and its length does not leak through the constant-time comparison's
length check. (`src/index.ts`)

**Verified:** repo-wide NUL scan is clean; `file` reports UTF-8 text.

---

## 8. A rotated secret never reached the PBX

**Status:** fixed
**Severity:** high — the API reported success and the phone kept the old password
**Found by:** tracing the data flow while building secret editing

`PUT /extensions/:pbx/:number` with `rotate_secret` wrote a new `secret_enc` and
called `syncPbx()`, which recompiles desired state and notifies the DO only when
the compile reports a change. But the password reaches the PBX as
`{"attribute":"password","secret_ref":<id>}` — deliberately, so plaintext never
lands in `object_version` — so the auth object's `attrs_json` is byte-identical
before and after a rotation. `compilePbx()` therefore found nothing to do, wrote
no `op_log` row, and returned `changed: false`, so the DO was not even notified.

The new password sat in D1 while the handset went on registering with the old
one, until some unrelated edit to the same auth object happened to carry it
along or the PBX reconnected and ran a full sweep. Nothing in the response
distinguished this from a working rotation.

**Fix:** `touchObject()` in `src/model/compile.ts` appends an `op_log` upsert for
one object without changing its desired attributes, and the route calls it for
the extension's auth object whenever the secret changed, then passes
`mustNotify` to `syncPbx()` so the DO is woken despite the empty diff. The DO
needs nothing new: `applyDeltas()` pushes any object named by an op row and
`resolveAttrs()` re-reads and decrypts `secret_enc` at push time, so the row
alone carries the change. Only PJSIP is touched — chan_sccp2 lines authenticate
by device and have no auth object.

**Verified:** `test/extension-secret.test.ts` asserts an op row appears for
`res_pjsip/auth/aem-2050` on a secret change and does not appear for an edit
that only renames the extension.

---

## 9. The profile picker vanished instead of saying it had nothing to offer

**Status:** fixed
**Severity:** high — the failure mode is an endpoint that registers and then
fails every call
**Found by:** an operator reporting "I cannot set a profile", while preparing a
bulk PJSIP migration

Three defects stacked into one symptom. The profile is what carries an
endpoint's codecs: with none, `compilePbx()` hands the expansion an empty
attribute bag (`src/model/compile.ts`), and the pushed endpoint holds only its
derived fields — no `allow`, no `rewrite_contact`, no `rtp_symmetric`. That
object pushes cleanly, the PBX converges, the phone registers, and every call
fails. The same silent shape as the blank-context defect repaired by migration
0003: success is reported at every layer.

1. **Both selects were wrapped in `v-if="techProfiles.length"`.** An empty list
   removed the entire field — including its "none" option — with nothing said
   about why, so a list that failed to load was indistinguishable from a
   product without the feature. The list was also fetched only for admins, and
   its error was deliberately swallowed as "merely convenience".
2. **The edit dialog keyed its options off the create form's tech.**
   `techProfiles` is computed from `form.value.tech`, but the edit dialog
   filtered on `editing.tech` — so which options appeared while editing
   depended on whatever the create form was last left set to.
3. **"None" could not clear a profile.** The route bound `body.profile_id ??
   null` into `COALESCE(?, profile_id)`, and the GUI sends its none option as
   `null` — read as "field absent", so choosing none silently kept the profile
   it was meant to remove. Precisely the mirror image of the blank-context bug
   repaired by migration 0003, where `''` *was* treated as a value and emptied
   the column.

A fourth hole sat behind them: `/admin/profiles` is admin-gated, so a delegated
user could not see profiles at all and self-service could only ever produce a
codec-less endpoint.

**Fix:** the field always renders, disabled and carrying the reason when no
profile of that tech exists; the edit dialog gets its own `editProfiles`
computed; the update carries an explicit given/absent flag
(`profile_id = CASE WHEN ? = 1 THEN ? ELSE profile_id END`) so blank and absent
are different requests; and `GET /profiles` serves `id, tech, name` to every
role, leaving the attribute bags admin-only. Both write paths now reject a
profile whose tech does not match the extension's — an SCCP profile on a PJSIP
extension contributes no endpoint attributes at all, which is the same
codec-less endpoint by another route.

**Verified:** `test/extension-profile.test.ts` — 14 tests asserting on what
reaches the PBX (`buildDesired`) rather than only on what was stored, including
that a profile-less extension really does push an endpoint with no `allow`
attribute, that the picker's null clears the column while an absent field does
not, and that a delegated user can create a working extension.

---

## 10. `POST /extensions` could not say whether it had generated a password

**Status:** fixed
**Severity:** medium — no wrong password was ever stored; the operator simply
could not tell from the response which had happened
**Found by:** an operator asking whether supplying a password on create really
works, having "sometimes" seen a generated-secret toast

The create route returned `{ pbx_id, number, secret }` with `secret` holding
either the password the caller supplied or one the server had just generated.
The two cases were indistinguishable, so the GUI decided which toast to show by
inspecting *its own form state* (`r.secret && !form.value.secret.trim()`) rather
than by asking the server what it did.

That inference happened to be right — a supplied, valid secret is never
replaced, so the toast only ever fired on a genuinely generated one — but it
made a correct create unverifiable from the outside, which matters most exactly
when it matters most: adopting a fleet of handsets that must keep the passwords
they are already registered with. A scripted importer had no signal at all.

**Fix:** the response now carries `generated: boolean`, and `secret` is returned
only when the server generated one — the same principle `PUT` already applied,
where echoing back a password the caller already holds puts a credential on the
wire and on screen for nothing. The GUI reads `r.generated`, and says plainly
that it kept a supplied password instead of falling through to a bare "Created".

**Verified:** eight tests in `test/extension-secret.test.ts` covering the create
path — that the stored ciphertext decrypts to exactly the supplied password,
that `generated` is false when one was supplied and true when none was, that a
whitespace-only secret counts as none supplied, and that a policy failure
creates no row at all rather than leaving an extension nobody can register
against.

---

## Test-harness defects (not product bugs)

- **Schema splitting broke on a semicolon inside a comment.** The D1 test helper
  split `0001_initial.sql` on `;` after stripping whole-line `--` comments, but
  an *inline* comment containing a semicolon ("site id; also the DO name") cut a
  statement in half. Fixed by stripping inline comments too.
- **An over-broad assertion.** A test asserted the serialized auth attrs did not
  contain the substring `value`, intending to check the password carried no
  plaintext — but every other tuple legitimately has a `value` key. Narrowed to
  assert the shape of the password tuple itself.

## Environment notes

Initial dependency versions were guessed from stale knowledge and all needed
correcting against the registry: `@cloudflare/workers-types` is now v5,
`typescript` v7, `vitest` v4, and `@cloudflare/vitest-pool-workers` has been
**renamed to `@cloudflare/vitest-plugin`** with a different entry point
(`cloudflareTest` plugin rather than `defineWorkersConfig`). Worth checking the
registry rather than assuming when revisiting.
