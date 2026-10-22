-- Per-file fingerprints of every rendered bundle revision.
--
-- The PBX reports exactly one number back — AEM_FILE_REV from extensions.conf —
-- so "the bundle is stale" could never say *what* is stale. Recording a hash of
-- each file per revision lets the status compare the revision the PBX has
-- against the one AEM wants and name the files whose content actually differs.
--
-- The hash is taken with the revision stamp normalized away, otherwise every
-- file would differ between any two revisions.
CREATE TABLE bundle_file_hash (
  pbx_id       TEXT NOT NULL REFERENCES pbx(id) ON DELETE CASCADE,
  file_rev     INTEGER NOT NULL,
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (pbx_id, file_rev, path)
);
