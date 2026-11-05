-- Migration 0089: lookup by trace on the three audit tables GET /api/audit-log can filter by trace_id.
--
-- Partial indexes: every row written before migration 0088 (and every row written outside a traced context) has a NULL
-- trace_id, and a lookup by `trace_id = ?` never asks for those, so they stay out of the index. The other four journal
-- tables that got the columns in 0088 have no trace lookup yet and no index.

CREATE INDEX IF NOT EXISTS idx_config_change_log_trace ON config_change_log(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_audit_log_trace ON agent_audit_log(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hook_audit_log_trace ON hook_audit_log(trace_id) WHERE trace_id IS NOT NULL;
