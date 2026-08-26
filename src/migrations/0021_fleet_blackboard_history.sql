-- fleet_blackboard_history: append-only audit trail of every blackboard state change.
-- The current-state table (fleet_blackboard) uses upsert, so active->done transitions
-- are overwritten in place and cannot be reconstructed retroactively. This table records
-- every INSERT and UPDATE to fleet_blackboard via triggers, enabling compliance audit
-- and retrospective fleet-activity analysis.
--
-- SCHEMA ONLY -- no INSERT/UPDATE, no vec0 dependency.

CREATE TABLE IF NOT EXISTS fleet_blackboard_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT    NOT NULL,
  task_ref   TEXT,
  status     TEXT    NOT NULL
               CHECK (status IN ('active', 'done', 'blocked')),
  summary    TEXT    NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_fbh_agent      ON fleet_blackboard_history(agent_id);
CREATE INDEX IF NOT EXISTS idx_fbh_created    ON fleet_blackboard_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fbh_status     ON fleet_blackboard_history(status);

-- Capture every new blackboard row (first upsert for an agent creates a real INSERT
-- that fires this trigger; subsequent upserts become UPDATE via ON CONFLICT DO UPDATE).
CREATE TRIGGER IF NOT EXISTS trg_fbh_insert
AFTER INSERT ON fleet_blackboard
BEGIN
  INSERT INTO fleet_blackboard_history (agent_id, task_ref, status, summary, created_at)
  VALUES (NEW.agent_id, NEW.task_ref, NEW.status, NEW.summary, unixepoch());
END;

-- Capture every in-place update (subsequent upserts + PATCH calls).
CREATE TRIGGER IF NOT EXISTS trg_fbh_update
AFTER UPDATE ON fleet_blackboard
BEGIN
  INSERT INTO fleet_blackboard_history (agent_id, task_ref, status, summary, created_at)
  VALUES (NEW.agent_id, NEW.task_ref, NEW.status, NEW.summary, unixepoch());
END;
