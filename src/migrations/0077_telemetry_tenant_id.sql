-- Migration 0077: tenant_id on the telemetry and journal tables (Phase 0 of the PostgreSQL move).
--
-- Twelve tables recorded what happened without saying for which tenant: agent_audit_log,
-- hook_audit_log, otel_spans, daily_logs, task_runs, background_tasks, store_file_audit,
-- skill_usage, token_usage_daily, token_usage_monthly, cost_line_items and labels. conversation_log
-- got its column in 0075; token_usage and the other tenant tables already had one.
--
-- New rows are stamped by the writer (src/db/write-tenant.ts, scripts/hooks/context-watchdog.py).
-- The column is NULLABLE on the journal tables: NULL means "the tenant could not be resolved" (a
-- shared agent with no fresh tenant context), which is NOT the same as 'default'. Two tables are
-- the exception because the tenant is part of what they are:
--   labels             NOT NULL DEFAULT 'default': a label name is a tenant's own vocabulary.
--   token_usage_daily  tenant_id joins the primary key (day, agent, model, tenant_id): a rollup
--   token_usage_monthly row of a shared agent used to add the tenants' tokens together. The rollup
--                       reads tenant_id from token_usage, so the split is exact from now on.
--
-- Backfill (Q3b), from one agent -> tenant map: the rows of an agent served by two or more tenants
-- are '_multi_' (the old rows carry no way to tell the tenants apart), the rows of an agent served
-- by exactly one tenant belong to that tenant (an agent that only serves a non-default tenant must
-- not leave its history in 'default'), and the rows of an agent served by none are 'default'.
-- "Served" is counted the way getServedTenantIds does: the tenant it coordinates
-- (tenants.main_agent_id, not disabled) plus its enabled tenant_agent_availability rows, each
-- tenant once. The same map fills the two rollup tables, so a tenant budget sees its old months.
-- Overrides: task_runs take the tenant of the schedule of the same name; the admin rows of
-- agent_audit_log (agent_id is a dashboard user name) take the user's tenant, which stays NULL for
-- the global admin. A row with no agent (hook_audit_log, store_file_audit) stays NULL.
-- Runs once, with the columns, in the same transaction. No ALTER TABLE ... RENAME (the vec0
-- triggers fail to re-parse at boot); the two rollup tables are rebuilt through a scratch copy.

-- Agents served by at least one tenant: '_multi_' for two or more, else the one tenant. An agent
-- missing here is served by none and falls back to 'default' in the UPDATEs below.
CREATE TEMP TABLE _agent_tenant AS
  SELECT agent_id,
         CASE WHEN COUNT(*) >= 2 THEN '_multi_' ELSE MIN(tenant_id) END AS tenant_id
    FROM (
      SELECT agent_id, tenant_id FROM tenant_agent_availability WHERE enabled = 1
      UNION
      SELECT main_agent_id, id FROM tenants WHERE main_agent_id IS NOT NULL AND disabled_at IS NULL
    )
   GROUP BY agent_id;

ALTER TABLE agent_audit_log   ADD COLUMN tenant_id TEXT;
ALTER TABLE hook_audit_log    ADD COLUMN tenant_id TEXT;
ALTER TABLE otel_spans        ADD COLUMN tenant_id TEXT;
ALTER TABLE daily_logs        ADD COLUMN tenant_id TEXT;
ALTER TABLE task_runs         ADD COLUMN tenant_id TEXT;
ALTER TABLE background_tasks  ADD COLUMN tenant_id TEXT;
ALTER TABLE store_file_audit  ADD COLUMN tenant_id TEXT;
ALTER TABLE skill_usage       ADD COLUMN tenant_id TEXT;
ALTER TABLE cost_line_items   ADD COLUMN tenant_id TEXT;
ALTER TABLE labels            ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';

UPDATE agent_audit_log
   SET tenant_id = CASE
     WHEN entity = 'admin' THEN (SELECT u.tenant_id FROM dashboard_users u WHERE u.username = agent_audit_log.agent_id COLLATE NOCASE)
     ELSE COALESCE((SELECT m.tenant_id FROM _agent_tenant m WHERE m.agent_id = agent_audit_log.agent_id), 'default')
   END;

UPDATE hook_audit_log
   SET tenant_id = COALESCE((SELECT m.tenant_id FROM _agent_tenant m WHERE m.agent_id = hook_audit_log.agent_id), 'default')
 WHERE agent_id IS NOT NULL;

UPDATE otel_spans
   SET tenant_id = COALESCE((SELECT m.tenant_id FROM _agent_tenant m WHERE m.agent_id = otel_spans.agent_id), 'default');

UPDATE daily_logs
   SET tenant_id = COALESCE((SELECT m.tenant_id FROM _agent_tenant m WHERE m.agent_id = daily_logs.agent_id), 'default');

UPDATE task_runs
   SET tenant_id = COALESCE(
     (SELECT s.tenant_id FROM schedules s WHERE s.id = task_runs.name),
     (SELECT m.tenant_id FROM _agent_tenant m WHERE m.agent_id = task_runs.agent),
     'default');

UPDATE background_tasks
   SET tenant_id = COALESCE((SELECT m.tenant_id FROM _agent_tenant m WHERE m.agent_id = background_tasks.agent_id), 'default');

UPDATE store_file_audit
   SET tenant_id = COALESCE((SELECT m.tenant_id FROM _agent_tenant m WHERE m.agent_id = store_file_audit.agent), 'default')
 WHERE agent IS NOT NULL;

UPDATE skill_usage
   SET tenant_id = COALESCE((SELECT m.tenant_id FROM _agent_tenant m WHERE m.agent_id = skill_usage.agent_id), 'default');

-- cost_line_items has no agent: its rows hang off cost_sources (admin-only, no writer today), so
-- there is nothing to derive a tenant from and the column stays NULL until a writer exists.

-- Rollup tables: rebuilt with tenant_id in the primary key. A shared agent's existing rows are
-- '_multi_': the sums already mix its tenants.
CREATE TABLE _token_usage_daily_old AS SELECT * FROM token_usage_daily;
DROP TABLE token_usage_daily;
CREATE TABLE token_usage_daily (
  day                   TEXT    NOT NULL,
  agent                 TEXT    NOT NULL,
  model                 TEXT    NOT NULL DEFAULT '',
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens       INTEGER NOT NULL DEFAULT 0,
  row_count             INTEGER NOT NULL DEFAULT 0,
  tenant_id             TEXT    NOT NULL DEFAULT 'default',
  PRIMARY KEY (day, agent, model, tenant_id)
);
INSERT INTO token_usage_daily
  (day, agent, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, row_count, tenant_id)
  SELECT o.day, o.agent, o.model, o.input_tokens, o.output_tokens, o.cache_read_tokens, o.cache_creation_tokens,
         o.thinking_tokens, o.row_count,
         COALESCE((SELECT m.tenant_id FROM _agent_tenant m WHERE m.agent_id = o.agent), 'default')
    FROM _token_usage_daily_old o;
DROP TABLE _token_usage_daily_old;

CREATE TABLE _token_usage_monthly_old AS SELECT * FROM token_usage_monthly;
DROP TABLE token_usage_monthly;
CREATE TABLE token_usage_monthly (
  month                 TEXT    NOT NULL,
  agent                 TEXT    NOT NULL,
  model                 TEXT    NOT NULL DEFAULT '',
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  thinking_tokens       INTEGER NOT NULL DEFAULT 0,
  session_count         INTEGER NOT NULL DEFAULT 0,
  row_count             INTEGER NOT NULL DEFAULT 0,
  tenant_id             TEXT    NOT NULL DEFAULT 'default',
  PRIMARY KEY (month, agent, model, tenant_id)
);
INSERT INTO token_usage_monthly
  (month, agent, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens,
   session_count, row_count, tenant_id)
  SELECT o.month, o.agent, o.model, o.input_tokens, o.output_tokens, o.cache_read_tokens, o.cache_creation_tokens,
         o.thinking_tokens, o.session_count, o.row_count,
         COALESCE((SELECT m.tenant_id FROM _agent_tenant m WHERE m.agent_id = o.agent), 'default')
    FROM _token_usage_monthly_old o;
DROP TABLE _token_usage_monthly_old;

-- The biggest table leads its tenant index with tenant_id (the row-level security policy filters on it).
CREATE INDEX IF NOT EXISTS idx_otel_spans_tenant ON otel_spans(tenant_id, start_ms);

DROP TABLE _agent_tenant;
