-- Migration 0067: give the approval timeout something to act on.
--
-- Every autonomy_categories row was seeded with timeout_minutes = NULL (0053), and NULL meant "no
-- limit", so the timeout sweeper (expireTimedOutApprovals) never found a pending approval to expire:
-- a forgotten level-2 request stayed approvable for days with stale context. Categories that can
-- raise an approval (max_level >= 2) get 60 minutes, matching the timeout_seconds: 3600 the agent
-- template has always sent. The locked categories (max_level 1) never raise an approval and keep NULL.
-- A value an operator already set is left alone, so the migration is idempotent and a re-run is a no-op.
UPDATE autonomy_categories
   SET timeout_minutes = 60
 WHERE timeout_minutes IS NULL AND max_level >= 2;

-- A request that is still pending without a deadline (an import or a fork that ran before this) gets
-- one derived from when it was asked, so the next sweep tick expires it instead of leaving it open.
UPDATE approvals
   SET timeout_at = requested_at + 3600
 WHERE status = 'pending' AND timeout_at IS NULL;
