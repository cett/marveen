-- Migration 0088: the audit and journal tables carry the trace they were written in.
--
-- trace_id / span_id name the request (or inter-agent message) whose work wrote the row, so an event and the
-- otel_spans trace of that work can be tied together by a stored fact instead of a guess on the timestamp. The value is
-- the same string otel_spans.trace_id holds (a server id, `w3c-<hex>` for a traceparent that came with credentials, an
-- agent session id); the OTLP mapping is the one the spans already use.
--
-- Both columns are nullable and there is no backfill: a row written before this migration, or outside any traced
-- request (a timer, a boot task), keeps NULL. No index here: a lookup by trace gets its index in its own migration,
-- together with the query that needs it.
--
-- ONLY plain ADD COLUMN statements, on purpose: the migration runner tolerates the duplicate-column error of a half-applied
-- run for a migration that is nothing but ADD COLUMN (db-migrations.ts isPureAddColumnMigration). Do not add anything
-- else to this file.

ALTER TABLE agent_audit_log ADD COLUMN trace_id TEXT;
ALTER TABLE agent_audit_log ADD COLUMN span_id TEXT;
ALTER TABLE hook_audit_log ADD COLUMN trace_id TEXT;
ALTER TABLE hook_audit_log ADD COLUMN span_id TEXT;
ALTER TABLE approval_events ADD COLUMN trace_id TEXT;
ALTER TABLE approval_events ADD COLUMN span_id TEXT;
ALTER TABLE rbac_shadow_log ADD COLUMN trace_id TEXT;
ALTER TABLE rbac_shadow_log ADD COLUMN span_id TEXT;
ALTER TABLE config_change_log ADD COLUMN trace_id TEXT;
ALTER TABLE config_change_log ADD COLUMN span_id TEXT;
ALTER TABLE fleet_blackboard_history ADD COLUMN trace_id TEXT;
ALTER TABLE fleet_blackboard_history ADD COLUMN span_id TEXT;
ALTER TABLE kanban_card_events ADD COLUMN trace_id TEXT;
ALTER TABLE kanban_card_events ADD COLUMN span_id TEXT;
