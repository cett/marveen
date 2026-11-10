-- Migration 0093: skills.status, the lifecycle state of a skill (quarantine, step 2).
--
-- 'live'            the skill is in use: it reaches the agents (generated files, agent skill lists, fleet export).
-- 'pending_review'  reserved for the quarantine path (a later step): written but not yet approved. Nothing sets it yet.
-- 'disabled'        revoked: POST /api/skills/sql/:id/revoke moves a live skill here; it no longer reaches an agent.
-- 'expired'         reserved for the retention job (a later step): a pending skill nobody reviewed. Nothing sets it yet.
--
-- Every existing row, and every row a writer inserts without naming a status, is 'live': this migration changes no
-- behavior by itself. The CHECK keeps a typo from becoming a fifth state.
--
-- ADD COLUMN, not a table rebuild: SQLite accepts a NOT NULL column with a constant DEFAULT and a CHECK on ADD COLUMN,
-- the skills table has foreign keys pointing AT it (skill_tenant_access, skill_files) that a DROP would cascade
-- through, and no `ALTER TABLE ... RENAME` is involved (a rename re-parses every trigger of a live install, and its
-- vec0 triggers need a module that is not loaded while migrations run: see migration 0076).
--
-- skill_revisions.action already accepts 'revoke' (migration 0092 widened it with 'activate', 'reject' and 'expire'),
-- so that table is not touched here. No index: the table holds a few dozen rows.

ALTER TABLE skills ADD COLUMN status TEXT NOT NULL DEFAULT 'live'
  CHECK (status IN ('live', 'pending_review', 'disabled', 'expired'));
