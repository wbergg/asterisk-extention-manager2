-- Widen sccp_button.kind to match the chan_sccp2 grammar.
--
-- The CHECK constraint in 0001 omitted `addon_module` and `unused`, but
-- BUTTON_KINDS in src/model/sccp/options.ts has always listed both, and both
-- are accepted by config/parsing/button.rs. A real 7965G in the field is
-- configured with four `button = unused` entries, so the database was rejecting
-- inventory the PBX itself is running — the schema was wrong, not the parser.
--
-- `unused` and `empty` are not synonyms: `empty` renders an empty button
-- position, `unused` leaves the position unconfigured entirely. Collapsing them
-- would change what the phone displays.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. sccp_button
-- is a leaf — nothing references it — so only its own FK to sccp_device has to
-- be reinstated.

CREATE TABLE sccp_button_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  INTEGER NOT NULL REFERENCES sccp_device(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('line','speed_dial','blf','blf_speed_dial',
                                           'feature','service','addon','addon_module',
                                           'empty','unused')),
  args_json  TEXT NOT NULL DEFAULT '[]',
  UNIQUE (device_id, position)
);

INSERT INTO sccp_button_new (id, device_id, position, kind, args_json)
  SELECT id, device_id, position, kind, args_json FROM sccp_button;

DROP TABLE sccp_button;

ALTER TABLE sccp_button_new RENAME TO sccp_button;
