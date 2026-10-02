# Ideas

Things considered and deliberately not built, plus directions worth taking later.
Each records *why* it was set aside, so revisiting is a decision rather than a
rediscovery.

Required work lives in [todo.md](todo.md); fixed defects in [bugs.md](bugs.md).

---

## Deferred features

### Voicemail

Explicitly deferred to v2. Consequence: the rendered dialplan's no-answer target
is per-profile configurable and defaults to `Hangup()` rather than emitting
`Voicemail()`.

Likely the first thing to come back, because all three of the features that
*were* built — ring groups, IVRs, queues — eventually want a voicemail fallback
for the no-answer, timeout and overflow paths. When it lands it needs:
`voicemail.conf` rendering, `endpoint.mailboxes` / SCCP `line.mailbox` for MWI,
and a `VoiceMailMain()` access extension.

### Fax

Out of scope, and not merely unbuilt — **not possible from a Worker**. v1's
implementation needs Ghostscript and ImageMagick, write access to
`/var/spool/asterisk/outgoing`, `chown` to the asterisk user, and tailing
`/var/log/asterisk/full` for completion. If it is wanted it has to live in a
separate on-box service; the control plane could at most hold the job metadata.

---

## Alternatives considered and rejected

### Total-ownership reconciliation

Delete anything on the PBX not in the desired set, rather than only strays inside
an owned namespace. Simpler and guarantees convergence, but a misconfigured DO
binding or an empty D1 result set would wipe a live PBX, and hand-maintained
trunks could not coexist. The namespace model was chosen precisely so
`trunk-telia` is never at risk.

### Snapshot revisions instead of per-object deltas

A monotonic revision naming a full immutable desired-state snapshot. Restart-safe
by construction with no replay log to lose, and rollback is just pointing at an
older revision. Rejected in favour of per-object versions and incremental
deltas — but note the delta model made a **full-resync fallback mandatory**,
which is now load-bearing (`cursor_gap`, sweep-on-connect). If the delta path
ever proves troublesome, snapshots remain the simpler answer.

Rollback is worth revisiting on its own merits: there is currently no way to say
"put this PBX back how it was an hour ago".

### Fully typed columns per PJSIP option

Real columns with types and constraints for every option. Best validation and UI
generation, but `res_pjsip` endpoint alone has 100+ options and every Asterisk
release would mean a migration — exactly the wall v1 hit. Profiles plus
free-form overrides make any option reachable on day one.

### mTLS for PBX authentication

`websocket_client.conf` does support client certificates (`cert_file`,
`priv_key_file`), and Cloudflare can validate them at the edge with the
fingerprint readable from `request.cf.tlsClientAuth`. Stronger than a shared
secret in a config file, and revocation is centralized. Rejected for v1 because
it means running a certificate lifecycle on every PBX, and an expired cert is a
silent total outage for that site. Worth reconsidering if the estate grows or if
the bundle-borne secret becomes uncomfortable.

### Maintenance windows for disruptive SCCP changes

Classify ops as additive (new device/line — disturbs nothing) versus disruptive
(update/delete of an existing device, or any line a live device binds), and queue
the disruptive ones until a per-PBX window. Phones would never drop during
business hours. Rejected because it makes desired and actual state intentionally
divergent for hours, so every status view has to show two states and urgent fixes
need an override path. The chosen mitigation — coalesce, order, and skip no-ops —
means a routine sweep costs nothing; only genuine changes cost a re-registration.

### CDR via `cdr_pgsql` to an external database

Full-fidelity, transactional, survives socket outages, and keeps CDR's own
multi-leg `linkedid` merge instead of re-deriving it cloud-side. Rejected because
it needs a second egress path with its own credentials on every PBX and breaks
the "only an outbound WebSocket" property. The right answer **if the call log
ever needs to be billing-grade** — the current path loses events whenever the
socket is down, and Asterisk does not replay them.

### `func_curl` POST from a hangup handler

The only other native HTTP egress for accounting data, and it reads the finalized
CDR directly. Rejected because it blocks the hangup path in the channel thread
with a 180-second default timeout — a slow control plane becomes a PBX
availability incident.

### Git-push bundle delivery

The Worker commits rendered config to a git repo and existing CD deploys it.
Every change becomes a reviewable diff with full history, and rollback is a
revert. Set aside for the simpler signed-bundle endpoint, but this is the better
answer once more than a couple of sites are in play.

### On-box agent

Would make `[general]`, softkey profiles and everything else cloud-managed end
to end. Rejected because it reintroduces exactly the daemon the outbound-ARI
architecture exists to avoid.

---

## Upstream changes that would simplify this

From [docs/UPSTREAM-SCCP-RS.md](docs/UPSTREAM-SCCP-RS.md), framed by what each
would let us delete:

- **`ast_endpoint_create("SCCP", <device-id>)`** — would make
  `GET /ari/endpoints/SCCP` work, giving SCCP the same discover-then-diff
  treatment PJSIP gets. The DO's mirror-based ownership could then be a fallback
  rather than the only mechanism, and one ownership model would cover both
  technologies. Also makes SCCP devices visible to every other ARI consumer with
  real online/offline state.
- **Semantic validation in the sorcery apply handler** — would let us delete most
  of `src/model/sccp/validate.ts` (~370 lines duplicating chan_sccp2's own rules,
  which will drift from upstream over time).
- **A readable convergence status object** — would replace "200 means persisted,
  not converged" with a real signal, and is the only thing that can cover
  *deletes*, which have no in-band veto point at all.
- **Mutation coalescing before reload** — would remove the write-amplification
  concern entirely and let the reconciler push without weighing each write's cost.

---

## Directions worth exploring

### Dry-run / plan output

`terraform plan` for a PBX: show the operator exactly which ops a reconcile would
apply before it applies them. The diff planner already computes this; it just is
not surfaced. Cheap to add and would make the first push against a production
box far less alarming.

### Config drift history

The hourly sweep detects out-of-band CLI edits but only repairs them. Recording
*what* drifted and when would turn it into an audit trail, and would answer
"who has been editing this box by hand".

### Bulk import from an existing PBX

Read an existing `pjsip.conf` and populate D1 from it, so adopting a site does
not mean retyping every extension. The parsing is the easy half; deciding what
becomes a profile versus an override is the interesting part.

### Per-channel `report_events` instead of global `channelvars`

`ari.conf` `channelvars` fires `ast_func_read2` for every variable on every
channel snapshot, under the channel lock — the sample config warns about the cost
explicitly. Asterisk 22/23 added `report_events: true` on a per-channel variable,
so the call log could attach CDR values only to channels it cares about. Worth
doing if CPS makes the global list expensive.

### Multi-tenancy

The schema partitions on `pbx_id` but has no tenant concept — the chosen shape
was a single organization with a handful of sites. Making this a product for
multiple independent customers means `tenant_id` on every table, tenant-scoped
queries everywhere, and isolation tests on every endpoint. A migration, not a
rewrite, but not a small one.

### `SECRET_KEY` rotation

There is currently no rotation path: changing the key orphans every encrypted
secret in D1. A versioned key scheme (`v1:`/`v2:` prefix on the ciphertext, with
lazy re-encryption on read) would make rotation possible without a flag day.

### Tarball bundle format

The bundle is JSON — one entry per file — chosen to stay diffable in a git-based
pipeline. A `.tar.gz` alternative would be more natural for Ansible's
`unarchive`. Both could be offered off the same renderer.
