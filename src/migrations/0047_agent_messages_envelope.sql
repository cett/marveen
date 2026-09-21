-- Migration 0047: agent_messages handoff envelope.
--
-- Free-form JSON text, no fixed schema enforced yet -- the config-loss bug
-- class this closes (Microsoft Agent Framework #8329: handoff-time
-- agent-cloning silently forgot to copy config fields) only needs a place to
-- put the data today; a stricter shape is a later sprint's problem. Nullable,
-- no backward-compat break -- every existing caller that never heard of this
-- field keeps working exactly as before.
ALTER TABLE agent_messages ADD COLUMN envelope TEXT;
