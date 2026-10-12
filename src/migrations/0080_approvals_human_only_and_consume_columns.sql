-- Migration 0080: the columns the human-only approval categories and the approval consume step need.
-- Only ADD COLUMN statements, one per column: SQLite has no ADD COLUMN IF NOT EXISTS, so the runner
-- applies a migration made entirely of ADD COLUMN statements one statement at a time and skips a
-- "duplicate column name" (src/db-migrations.ts, isPureAddColumnMigration). There is deliberately no
-- ALTER TABLE ... RENAME and no table rebuild here: a rename re-parses the vec_* triggers on a live
-- database before the vec0 module is loaded and crash-loops the boot (see 0076 / 0078).
--
--   approvals.human_only     snapshot, taken at creation, of whether the category was human-only; a
--                            decision on such a row needs a human dashboard session (APPROVAL_HUMAN_ONLY_ENFORCE)
--   approvals.resolved_via   how the decision arrived: 'dashboard_session' | 'bearer'; NULL for a pending row
--                            and for rows decided before this column existed
--   approvals.content_hash   64 lowercase hex, the hash of the exact action the approval covers; NULL when the
--                            requester gave none (such a row can never be consumed)
--   approvals.consumed_at    epoch seconds, set once by the consume step; NULL = not consumed
--   approvals.consumed_by    who consumed it (the consumer name the caller gave)
--   approvals.consumed_ref   an opaque reference of the consuming action (a message id, for example)
--   autonomy_categories.human_only   1 = a category an agent may never decide for itself; the code carries a floor
--                            of keys that API cannot lower, this column only adds to it

ALTER TABLE approvals ADD COLUMN human_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN resolved_via TEXT;
ALTER TABLE approvals ADD COLUMN content_hash TEXT;
ALTER TABLE approvals ADD COLUMN consumed_at INTEGER;
ALTER TABLE approvals ADD COLUMN consumed_by TEXT;
ALTER TABLE approvals ADD COLUMN consumed_ref TEXT;
ALTER TABLE autonomy_categories ADD COLUMN human_only INTEGER NOT NULL DEFAULT 0;
