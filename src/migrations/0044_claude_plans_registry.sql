-- Claude Plans registry (#886): DB mirror of store/claude-plans.json, plus a
-- new per-agent active-plan binding with a real lifecycle (the JSON side-car
-- store/claude-plans-state.json has none -- a dead agent's "active" entry
-- stays forever). foreign_keys enforcement is off for this connection, as
-- elsewhere in this schema (see 0041_confluence_source_type.sql) -- the
-- REFERENCES clause below documents the relationship; cascade delete on plan
-- removal is done explicitly in application code (deleteClaudePlanRow), not
-- relied on at the DB layer.

CREATE TABLE IF NOT EXISTS claude_plans_registry (
  id                TEXT    PRIMARY KEY,
  label             TEXT    NOT NULL,
  config_dir        TEXT    NOT NULL,
  plan_type         TEXT    NOT NULL CHECK (plan_type IN ('personal', 'team')),
  channels_allowed  INTEGER NOT NULL DEFAULT 0,
  expected_org_type TEXT,
  expected_email    TEXT,
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS agent_active_plans (
  agent_id       TEXT    PRIMARY KEY,
  plan_id        TEXT    NOT NULL REFERENCES claude_plans_registry(id),
  activated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  last_heartbeat INTEGER NOT NULL DEFAULT (unixepoch()),
  source         TEXT    NOT NULL CHECK (source IN ('manual', 'rotation', 'handoff-recovery'))
);

CREATE INDEX IF NOT EXISTS idx_aap_plan_id       ON agent_active_plans(plan_id);
CREATE INDEX IF NOT EXISTS idx_aap_last_heartbeat ON agent_active_plans(last_heartbeat);
