-- Migration 0084: the second phase of using up an approval, the effect itself.
-- Only ADD COLUMN statements, one per column (see 0080): SQLite has no ADD COLUMN IF NOT EXISTS, so the
-- runner applies such a migration one statement at a time and skips a "duplicate column name". There is
-- deliberately no ALTER TABLE ... RENAME and no table rebuild (the vec_* trigger crash-loop of 0076 / 0078).
--
-- An email approval is used up in two steps that two different callers take:
--   consumed_at   the send gate RESERVES the approval when it lets a mail call through (migration 0080)
--   used_at       the official sender SEALS the effect: it adopts the gate's reservation (or, with no gate in
--                 front of it, reserves and seals in one step) right before the mail leaves
--   used_ref      the sender's own reference of that use; the same ref again inside the replay window is a
--                 retry of a lost answer, any other caller finds the approval already used
-- NULL = not sealed. A reservation nobody seals (the mail went out by another tool) stays a reservation.

ALTER TABLE approvals ADD COLUMN used_at INTEGER;
ALTER TABLE approvals ADD COLUMN used_ref TEXT;
