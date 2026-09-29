-- Migration 0060: agent_state table (#985 group 4/8, part 1).
--
-- Backs per-agent RUNTIME state (as opposed to agent_settings' operator
-- CONFIG, migration 0058) -- the first consumer is
-- context-restart-gate-store.ts's run-state half (readGateRunState /
-- writeGateRunState, previously store/context-restart-gate-state.json),
-- which tracks each agent's continuous-blocking streak for the
-- context-restart-gate watchdog. One row per (agent_id, state_key);
-- state_value is JSON text, same shape as agent_settings for the same
-- reason (unrelated, independently-evolving per-consumer shapes).
--
-- No HTTP route currently reads or writes this state (only
-- context-restart-gate-runner.ts, an in-process TS module, calls
-- readGateRunState/writeGateRunState) -- same as the config half migrated
-- in group 3, there is no RBAC question here, just a storage swap.
CREATE TABLE IF NOT EXISTS agent_state (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT    NOT NULL,
  state_key   TEXT    NOT NULL,
  state_value TEXT    NOT NULL,
  tenant_id   TEXT    NOT NULL DEFAULT 'default',
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(agent_id, state_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_state_tenant ON agent_state(tenant_id);
