-- Migration 0094: the review state of a skill revision (quarantine, step 3).
--
-- A change that has to be reviewed before it goes live (an archive import, a change that adds or edits a script or
-- widens what a skill may do) is recorded as a revision of its own with status 'pending'. The live skill row is NOT
-- touched by it: the proposed SKILL.md sits in skill_revisions.content and the proposed companion files in
-- skill_revision_files, until a person decides.
--
-- status          'activated' (the row describes a state that is, or was, live: every row that exists today and every
--                 row a writer inserts without a status), 'pending' (waiting for a decision), 'rejected', 'expired'.
-- touches_privilege 1 when the change carries something that decides what the skill may do (a script, an executable
--                 file, allowed-tools, hooks, the description that makes a model pick the skill).
-- submitted_by    who proposed it (an actor id, never a secret), decided_by who decided (a dashboard user),
-- decided_at      unix seconds of the decision, decision_ref the approval the decision stands on.
--
-- ADD COLUMN only: skill_revisions was rebuilt once (0092) and a rename re-parses every trigger of a live install,
-- whose vec0 triggers need a module that is not loaded while migrations run (see 0076). The CHECK on status and the
-- constant defaults are accepted by ADD COLUMN, so every existing row reads 'activated' and nothing changes by itself.
--
-- skill_revision_files holds the companion files a pending revision proposes (the bytes the trail never copies for a
-- live write). It has no foreign key (the trail has none either, and it must outlive a skill delete); the retention
-- step removes the bytes of a decided revision, the hashes stay on the revision row.
ALTER TABLE skill_revisions ADD COLUMN status TEXT NOT NULL DEFAULT 'activated'
  CHECK (status IN ('activated', 'pending', 'rejected', 'expired'));
ALTER TABLE skill_revisions ADD COLUMN touches_privilege INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skill_revisions ADD COLUMN submitted_by TEXT;
ALTER TABLE skill_revisions ADD COLUMN decided_by TEXT;
ALTER TABLE skill_revisions ADD COLUMN decided_at INTEGER;
ALTER TABLE skill_revisions ADD COLUMN decision_ref TEXT;

CREATE TABLE IF NOT EXISTS skill_revision_files (
  revision_id INTEGER NOT NULL,
  rel_path    TEXT    NOT NULL,
  mode        INTEGER NOT NULL DEFAULT 420,
  content     BLOB    NOT NULL,
  PRIMARY KEY (revision_id, rel_path)
);

CREATE INDEX IF NOT EXISTS idx_skill_revisions_pending ON skill_revisions(status, skill_id);
