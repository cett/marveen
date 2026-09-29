-- Migration 0058: agent_settings table.
--
-- Backs three per-agent operational config side-cars: store/context-guard.json,
-- store/auto-restart.json, and (config half only -- the run-state half
-- (context-restart-gate-state.json) is group 4/8) store/context-restart-gate.json.
-- Part of the wider config/state -> SQLite migration (#985, plan #984, group 3/8).
--
-- One row per (agent_id, setting_key), value stored as JSON text -- the three
-- configs have unrelated, independently-evolving shapes (see
-- normalizeContextGuardConfig / normalizeAutoRestartConfig / normalizeGateConfig),
-- so a single JSON blob column avoids a wide sparse table or three
-- near-identical tables for what is, per row, a single small object.
--
-- tenant_id mirrors 0056's egress_allowlist column, but the RBAC rationale is
-- the OPPOSITE of group 1's: egress_allowlist is enforced by a hook OUTSIDE
-- this process that unions every tenant's rows into one fleet-wide policy, so
-- a tenant-scoped write there would be a privilege escalation (admin-only,
-- full stop). These three settings are read and enforced entirely INSIDE this
-- backend process, per agent_id, by in-process watchdogs (context-guard-runner,
-- auto-restart, context-restart-gate-runner) -- no external process unions rows
-- across tenants. tenant_id here exists so a non-admin caller can be scoped to
-- the agents their own tenant owns, same shape as schedules/costops-budgets,
-- not so writes can be locked to admin-only by default (see #985 plan doc,
-- group 3, RBAC section; route-level enforcement lands in a later commit).
--
-- Existing per-install values are NOT baked into this migration (unlike
-- 0056's domain seed) -- these are per-install operational toggles (e.g. which
-- agent has auto-restart on a daily schedule), not a shared baseline a fresh
-- fork would want to inherit. A boot-time importer carries over each JSON
-- file's content once, same rationale and pattern as group 2's
-- migrateScheduleStateFromFiles().
CREATE TABLE IF NOT EXISTS agent_settings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      TEXT    NOT NULL,
  setting_key   TEXT    NOT NULL CHECK(setting_key IN ('context_guard', 'auto_restart', 'context_restart_gate')),
  setting_value TEXT    NOT NULL,
  tenant_id     TEXT    NOT NULL DEFAULT 'default',
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(agent_id, setting_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_settings_tenant ON agent_settings(tenant_id);
