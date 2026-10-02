-- Cloud-managed Asterisk configuration: canonical desired state.
--
-- Two layers live here:
--   1. The product model an operator edits (pbx, profile, extension, sccp_*,
--      ring_group, ivr, queue, trunk, ...).
--   2. The expanded sorcery objects that model compiles down to
--      (object_version), plus the delta stream the Durable Object consumes
--      (op_log).
--
-- Only layer 2 is reconciled onto a PBX over ARI. Everything that cannot be
-- reached via ARI dynamic configuration is rendered into a config bundle
-- instead; those rows are marked "file-rendered" below.

-- ---------------------------------------------------------------------------
-- Fleet
-- ---------------------------------------------------------------------------

CREATE TABLE pbx (
  id                TEXT PRIMARY KEY,          -- site id; also the DO name and URL path segment
  name              TEXT NOT NULL,
  prefix            TEXT NOT NULL DEFAULT 'aem-',  -- PJSIP ownership namespace

  -- Both are AES-GCM ciphertext rather than hashes: the rendered config bundle
  -- has to reproduce them verbatim for websocket_client.conf and ari.conf, so
  -- they must be recoverable. Verification decrypts and compares in constant
  -- time. Decryption happens in the Worker/DO only.
  ws_secret_enc     TEXT NOT NULL,             -- Basic password Asterisk presents on the upgrade
  ari_secret_enc    TEXT NOT NULL,             -- password for the local ARI user in ari.conf

  sccp_enabled      INTEGER NOT NULL DEFAULT 0,

  -- Desired revision of the rendered config bundle. Stamped into
  -- extensions.conf as [globals] AEM_FILE_REV and read back over ARI.
  file_rev          INTEGER NOT NULL DEFAULT 0,
  -- Hash of everything that feeds the renderers. file_rev is bumped only when
  -- this changes, so re-rendering is idempotent and an unchanged bundle never
  -- makes a converged PBX look stale.
  file_input_hash   TEXT NOT NULL DEFAULT '',
  -- Last AEM_FILE_REV the DO actually observed on the box. NULL = never seen.
  observed_file_rev INTEGER,

  -- Reconciliation status, written by the DO.
  state             TEXT NOT NULL DEFAULT 'never_connected'
                      CHECK (state IN ('never_connected','connecting','blocked',
                                       'syncing','converged','degraded')),
  last_error        TEXT,
  last_seen_at      TEXT,
  acked_seq         INTEGER NOT NULL DEFAULT 0, -- op_log cursor confirmed applied

  -- Free-form inputs to the file renderers (bind addresses, TLS, codecs,
  -- SCCP [general], etc). Shape is owned by the renderer, not by SQL.
  settings_json     TEXT NOT NULL DEFAULT '{}',

  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Profiles: a validated attribute bag, flattened into ARI fields[] at push
-- time. Replaces v1's out-of-repo pjsip.conf templates.
-- ---------------------------------------------------------------------------

CREATE TABLE profile (
  id          TEXT PRIMARY KEY,
  tech        TEXT NOT NULL CHECK (tech IN ('pjsip','sccp')),
  name        TEXT NOT NULL,
  -- For pjsip: {"endpoint": {...}, "aor": {...}, "auth": {...}}
  -- For sccp:  {"device": {...}, "line": {...}}
  attrs_json  TEXT NOT NULL DEFAULT '{}',
  -- Dialplan behaviour on no-answer. Voicemail is deferred to v2, so this
  -- defaults to Hangup() rather than emitting Voicemail().
  no_answer_target TEXT NOT NULL DEFAULT 'Hangup()',
  ring_timeout     INTEGER NOT NULL DEFAULT 20,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tech, name)
);

-- ---------------------------------------------------------------------------
-- Extensions. For pjsip this expands to auth+aor+endpoint sharing one id.
-- For sccp this is the *line*; devices are separate and bind lines via buttons.
-- ---------------------------------------------------------------------------

CREATE TABLE extension (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pbx_id         TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  number         TEXT NOT NULL,
  display_name   TEXT NOT NULL DEFAULT '',
  tech           TEXT NOT NULL CHECK (tech IN ('pjsip','sccp')),
  profile_id     TEXT REFERENCES profile(id),
  overrides_json TEXT NOT NULL DEFAULT '{}',
  context        TEXT NOT NULL DEFAULT 'aem-internal',
  -- AES-GCM ciphertext; decrypted only inside the DO at push time.
  secret_enc     TEXT,
  -- Phonebook-only entry: no endpoint, no auth, no aor, no dialplan.
  directory_only INTEGER NOT NULL DEFAULT 0,
  owner_email    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (pbx_id, number)
);

CREATE INDEX idx_extension_pbx ON extension(pbx_id);
CREATE INDEX idx_extension_owner ON extension(owner_email);

-- SCCP devices. id must be SEP + 12 hex (chan_sccp2 config/parsing/device.rs:10-11)
-- and cannot carry the ownership prefix, which is why SCCP ownership is
-- "D1's desired set is the owned set".
CREATE TABLE sccp_device (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pbx_id         TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  sep_id         TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  profile_id     TEXT REFERENCES profile(id),
  softkey_profile TEXT NOT NULL DEFAULT 'default',
  overrides_json TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (pbx_id, sep_id)
);

-- Repeatable button.NNNN entries. position is the NNNN index.
CREATE TABLE sccp_button (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  INTEGER NOT NULL REFERENCES sccp_device(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('line','speed_dial','blf','blf_speed_dial',
                                           'feature','service','addon','empty')),
  args_json  TEXT NOT NULL DEFAULT '[]',
  UNIQUE (device_id, position)
);

-- ---------------------------------------------------------------------------
-- Expanded desired state + the delta stream. This is what gets reconciled.
-- ---------------------------------------------------------------------------

CREATE TABLE object_version (
  pbx_id        TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  config_class  TEXT NOT NULL,   -- res_pjsip | chan_sccp2 | res_pjsip_endpoint_identifier_ip
  object_type   TEXT NOT NULL,   -- endpoint | aor | auth | device | line
  object_id     TEXT NOT NULL,   -- aem-1001 | SEP001122334455 | 1001
  version       INTEGER NOT NULL DEFAULT 1,
  -- Flattened ConfigTuple list, ready for ARI: [{"attribute":..,"value":..}, ...]
  -- Secrets are stored as {"attribute":"password","secret_ref":<extension.id>}
  -- and resolved inside the DO so plaintext never lands here.
  attrs_json    TEXT NOT NULL,
  -- Ordering rank within a batch: lower applies first on create, last on delete.
  dep_rank      INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pbx_id, config_class, object_type, object_id)
);

CREATE INDEX idx_object_version_pbx ON object_version(pbx_id, dep_rank);

-- The ack cursor stream. Records *which* object changed, not its contents:
-- the DO reads current attrs from object_version at apply time, so repeated
-- edits to one object coalesce for free and every apply is idempotent.
CREATE TABLE op_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  pbx_id       TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  op           TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  config_class TEXT NOT NULL,
  object_type  TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_op_log_pbx_seq ON op_log(pbx_id, seq);

-- Objects that failed to apply N times in a row. Surfaced in the UI; skipped
-- by the reconciler so one poisoned object cannot stall the whole stream
-- forever.
CREATE TABLE quarantine (
  pbx_id       TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  config_class TEXT NOT NULL,
  object_type  TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  status_code  INTEGER,
  reason       TEXT,
  first_failed_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_failed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pbx_id, config_class, object_type, object_id)
);

-- ---------------------------------------------------------------------------
-- File-rendered config (unreachable via ARI dynamic configuration)
-- ---------------------------------------------------------------------------

-- PJSIP trunks/transports/identifies. identify+registration+transport are
-- retrieved in bulk at load/reload, so per-object ARI pushes would not take
-- effect; they belong in the file layer.
CREATE TABLE pjsip_static (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pbx_id       TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  object_type  TEXT NOT NULL CHECK (object_type IN ('transport','endpoint','auth','aor',
                                                    'identify','registration','acl')),
  object_id    TEXT NOT NULL,
  attrs_json   TEXT NOT NULL DEFAULT '{}',
  sort_order   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (pbx_id, object_type, object_id)
);

-- SCCP softkey profiles and (!) templates. A device referencing a missing
-- softkey profile is a hard reload failure (config/parsing/device.rs:38-44),
-- so the validator cross-checks sccp_device.softkey_profile against this table.
CREATE TABLE sccp_static (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pbx_id       TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  section_type TEXT NOT NULL CHECK (section_type IN ('softkey_profile','template')),
  name         TEXT NOT NULL,
  attrs_json   TEXT NOT NULL DEFAULT '{}',
  UNIQUE (pbx_id, section_type, name)
);

CREATE TABLE ring_group (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pbx_id      TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  number      TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  strategy    TEXT NOT NULL DEFAULT 'ringall' CHECK (strategy IN ('ringall','hunt','memoryhunt')),
  ring_time   INTEGER NOT NULL DEFAULT 20,
  no_answer_target TEXT NOT NULL DEFAULT 'Hangup()',
  UNIQUE (pbx_id, number)
);

CREATE TABLE ring_group_member (
  ring_group_id INTEGER NOT NULL REFERENCES ring_group(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  extension_number TEXT NOT NULL,
  PRIMARY KEY (ring_group_id, position)
);

CREATE TABLE moh_class (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pbx_id     TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'files',
  directory  TEXT NOT NULL DEFAULT '',
  sort_mode  TEXT NOT NULL DEFAULT 'random',
  UNIQUE (pbx_id, name)
);

CREATE TABLE queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pbx_id      TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  number      TEXT NOT NULL,
  name        TEXT NOT NULL,
  strategy    TEXT NOT NULL DEFAULT 'ringall',
  timeout     INTEGER NOT NULL DEFAULT 15,
  musicclass  TEXT NOT NULL DEFAULT 'default',
  attrs_json  TEXT NOT NULL DEFAULT '{}',
  UNIQUE (pbx_id, number)
);

CREATE TABLE queue_member (
  queue_id         INTEGER NOT NULL REFERENCES queue(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  extension_number TEXT NOT NULL,
  penalty          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (queue_id, position)
);

CREATE TABLE ivr (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pbx_id      TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  number      TEXT NOT NULL,
  name        TEXT NOT NULL,
  greeting    TEXT NOT NULL DEFAULT '',
  timeout     INTEGER NOT NULL DEFAULT 10,
  invalid_target TEXT NOT NULL DEFAULT 'Hangup()',
  timeout_target TEXT NOT NULL DEFAULT 'Hangup()',
  UNIQUE (pbx_id, number)
);

CREATE TABLE ivr_entry (
  ivr_id  INTEGER NOT NULL REFERENCES ivr(id) ON DELETE CASCADE,
  digit   TEXT NOT NULL,
  target  TEXT NOT NULL,
  PRIMARY KEY (ivr_id, digit)
);

-- Business-hours / time-condition routing.
CREATE TABLE time_condition (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pbx_id        TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  number        TEXT NOT NULL,
  name          TEXT NOT NULL,
  -- GoToIfTime spec: <times>,<weekdays>,<mdays>,<months>
  time_spec     TEXT NOT NULL,
  match_target  TEXT NOT NULL,
  nomatch_target TEXT NOT NULL,
  UNIQUE (pbx_id, number)
);

-- ---------------------------------------------------------------------------
-- People, guardrails, audit
-- ---------------------------------------------------------------------------

-- Identity comes from the Cloudflare Access JWT; this table is authorization
-- only. No passwords, no sessions, no token minting.
CREATE TABLE app_user (
  email           TEXT PRIMARY KEY,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  display_name    TEXT NOT NULL DEFAULT '',
  min_ext         INTEGER,
  max_ext         INTEGER,
  call_log_access INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Admin-maintained carve-outs inside a user's delegated range.
CREATE TABLE blocked_extension (
  pbx_id     TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  number     TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pbx_id, number)
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_created ON audit_log(created_at);

-- ---------------------------------------------------------------------------
-- Call log, reconstructed from the ARI event stream (there is no CDR event in
-- ARI; CDR values arrive as channelvars). Explicitly not billing-grade:
-- events are lost while the socket is down and Asterisk does not replay.
-- ---------------------------------------------------------------------------

CREATE TABLE call_leg (
  pbx_id      TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL,
  linkedid    TEXT,
  channel_name TEXT,
  src         TEXT,
  dst         TEXT,
  dcontext    TEXT,
  started_at  TEXT,
  answered_at TEXT,
  ended_at    TEXT,
  disposition TEXT,
  billsec     INTEGER,
  duration    INTEGER,
  cause       INTEGER,
  cause_txt   TEXT,
  PRIMARY KEY (pbx_id, channel_id)
);

CREATE INDEX idx_call_leg_started ON call_leg(pbx_id, started_at DESC);
CREATE INDEX idx_call_leg_linked ON call_leg(pbx_id, linkedid);
CREATE INDEX idx_call_leg_src ON call_leg(pbx_id, src);
CREATE INDEX idx_call_leg_dst ON call_leg(pbx_id, dst);
