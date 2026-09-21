-- Migration 0045: agent_messages refused/no_session markers.
--
-- The status CHECK constraint (pending/delivered/done/failed) is left
-- untouched -- SQLite cannot ALTER a CHECK inline, and widening it means
-- rebuilding the table. Instead, two nullable columns capture the extra
-- semantics without a status rename:
--   refused_reason: set alongside status='failed' when the executor
--   explicitly declined the task (PUT .../messages/:id status="refused"),
--   distinguishing a refusal from a delivery/execution error.
--   no_session_at: set on a still-pending row the first time the router
--   finds the target tmux session absent, so a caller can tell "never
--   attempted" apart from "target unreachable" without waiting for the
--   1h abandon window.
ALTER TABLE agent_messages ADD COLUMN refused_reason TEXT;
ALTER TABLE agent_messages ADD COLUMN no_session_at INTEGER;
