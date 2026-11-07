-- Migration 0091: skill_revisions, the trail of every write to a skill (SKILL.md and companion files).
--
-- Until now a skill write overwrote the row in place and a delete removed it: after a change nobody could tell who
-- changed what, when, or what the text was before. This table is the first step of the skill quarantine work: it
-- records the change only. Nothing reads it to decide anything yet, and no write path behaves differently.
--
-- Deliberately NO foreign key to skills and NO ON DELETE CASCADE: the trail has to outlive the skill it describes
-- (a deleted skill is exactly the case where the history matters). skill_id is therefore a plain text reference.
-- Rows leave only through the tenant purge (tenant_id is the purge key), never through a skill delete.
--
-- The CHECK lists already allow the values the later quarantine steps will write: the actions activate, revoke, reject
-- and expire, and the author kind auto. Nothing writes them yet (the writer and the TypeScript types know only the
-- values above); they are reserved here because widening a CHECK later means rebuilding the table, and SQLite cannot
-- do that without a rename (see the vec0 trigger note in the migration rules).
--
-- seq is per skill, starts at 1 and is unique with the skill id (UNIQUE(skill_id, seq)); the writer takes MAX(seq)+1
-- inside the same transaction as the skill write. Hashes are SHA-256 hex computed by the application (SQLite has no
-- sha256 function, so a migration cannot backfill them: the existing skills get their baseline row from
-- backfillSkillBaselines() at boot). content is the SKILL.md text for the content-bearing actions and NULL for the
-- companion file actions; files_sha256 is the hash of the sorted (path, mode, content hash) list of the companion
-- files and is NULL when the skill has none. has_scripts is 1 when any companion file lives under scripts/ or is
-- executable. author_kind says who wrote it, author_id names them when there is a name to give.
CREATE TABLE IF NOT EXISTS skill_revisions (
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
  author_kind   TEXT    NOT NULL CHECK (author_kind IN ('human', 'agent', 'import', 'system', 'auto')),
  author_id     TEXT,
  source_ref    TEXT,
  reason        TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (skill_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_skill_revisions_tenant_created ON skill_revisions(tenant_id, created_at);
