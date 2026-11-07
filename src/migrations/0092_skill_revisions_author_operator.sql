-- Migration 0092: skill_revisions.author_kind learns 'operator'.
--
-- A skill write made with the operator's own named admin token (the CLI-issued token whose name the server
-- reserves) was recorded as author_kind 'agent', author_id 'operator': the id is true, the kind is not. The trail
-- now says 'operator'. Only NEW writes get it: the existing rows are copied as they are (a row written as
-- 'agent' / 'operator' before this migration stays 'agent' / 'operator'), the trail is history and is not rewritten.
--
-- SQLite cannot widen a CHECK, so the table is rebuilt: copy the rows to a scratch table, drop the table, create
-- it again, copy the rows back (ids kept, in id order), drop the scratch table, recreate the index. NO
-- `ALTER TABLE ... RENAME`: a rename re-parses every trigger in the database, and the vec_* triggers of a live
-- install reference the sqlite-vec `vec0` module, which is not loaded yet while migrations run (migration 0076
-- found this on a copy of the live database). skill_revisions has no trigger of its own, no vec0 table and no
-- foreign key in either direction (migration 0091 deliberately has none), so the DROP cascades nowhere. The
-- migration runs in one transaction, so a failure leaves the old table untouched. skill_revisions is
-- AUTOINCREMENT, so its sqlite_sequence value is carried over: the id of a purged row is never handed out again.
-- UNIQUE(skill_id, seq) is part of the new table definition and the copy keeps every seq as it was.

CREATE TABLE skill_revisions_old AS SELECT * FROM skill_revisions;
CREATE TABLE skill_revisions_seq AS SELECT seq FROM sqlite_sequence WHERE name = 'skill_revisions';
DROP TABLE skill_revisions;
CREATE TABLE skill_revisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id      TEXT    NOT NULL,
  tenant_id     TEXT    NOT NULL,
  seq           INTEGER NOT NULL,
  action        TEXT    NOT NULL CHECK (action IN ('baseline', 'create', 'modify', 'seed', 'delete', 'file_put', 'file_delete', 'file_seed',
                                                   'activate', 'revoke', 'reject', 'expire')),
  content_sha256 TEXT,
  prev_sha256   TEXT,
  files_sha256  TEXT,
  has_scripts   INTEGER NOT NULL DEFAULT 0,
  content       TEXT,
  author_kind   TEXT    NOT NULL CHECK (author_kind IN ('human', 'agent', 'import', 'system', 'auto', 'operator')),
  author_id     TEXT,
  source_ref    TEXT,
  reason        TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (skill_id, seq)
);
INSERT INTO skill_revisions (id, skill_id, tenant_id, seq, action, content_sha256, prev_sha256, files_sha256, has_scripts,
                             content, author_kind, author_id, source_ref, reason, created_at)
SELECT id, skill_id, tenant_id, seq, action, content_sha256, prev_sha256, files_sha256, has_scripts,
       content, author_kind, author_id, source_ref, reason, created_at
  FROM skill_revisions_old
 ORDER BY id;
INSERT INTO sqlite_sequence (name, seq)
SELECT 'skill_revisions', seq FROM skill_revisions_seq
 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'skill_revisions');
UPDATE sqlite_sequence
   SET seq = MAX(seq, (SELECT seq FROM skill_revisions_seq))
 WHERE name = 'skill_revisions' AND EXISTS (SELECT 1 FROM skill_revisions_seq);
DROP TABLE skill_revisions_old;
DROP TABLE skill_revisions_seq;

CREATE INDEX idx_skill_revisions_tenant_created ON skill_revisions(tenant_id, created_at);
