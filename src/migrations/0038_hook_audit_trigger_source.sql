-- Migration 0038: trigger_source column on hook_audit_log.
--
-- Two independent context-protection layers write into this table (see
-- migration 0037 + src/watchdog-validation.ts): the context-watchdog
-- PostToolUse hook (verdict='handoff', catches long ACTIVE sessions) and
-- context-compact-monitor.sh (hook_type='PreCompact', verdict='allow',
-- scheduled polling that catches the idle-but-full case the watchdog
-- structurally cannot see, since it only runs on an active tool call).
-- Telling them apart today means inferring it from the hook_type+verdict
-- combination -- this column names the producer directly so a coverage
-- audit is a single query instead of a manual reconstruction.

ALTER TABLE hook_audit_log ADD COLUMN trigger_source TEXT;
-- 'watchdog' | 'compact-monitor' | NULL (rows from other producers, e.g.
-- the PreToolUse/PostToolUse tool-call gate, leave this unset)

CREATE INDEX IF NOT EXISTS idx_hook_audit_trigger_source ON hook_audit_log(trigger_source, ts DESC);
