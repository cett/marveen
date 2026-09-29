-- Migration 0057: schedules.last_run_at / last_run_result columns, plus a
-- baseline system_config row for the scheduler's tick-liveness stamp.
--
-- Replaces store/schedule-last-run.json (per-schedule last-fired timestamp,
-- keyed by schedule id == schedules.id) and store/schedule-tick-state.json
-- (single lastTickMs) with DB-backed state. Part of the wider config/state ->
-- SQLite migration (#985, plan #984, group 2/8).
--
-- Schema-only, same shape as 0051's system_config table: unlike group 1's
-- egress-allowlist (slowly-changing admin config, safe to bake "current"
-- values into the migration's seed), these values are runtime state that
-- changes on every 15s tick -- baking "current" timestamps in here would
-- already be stale by the time this migration ships to an install. The
-- one-time import from the JSON side-cars runs at boot instead, from
-- migrateScheduleStateFromFiles() (src/db/tasks.ts), called by
-- db/index.ts's initDatabase() the same way migrateConfigOverridesToSystemConfig()
-- backfills system_config from config-overrides.json.
ALTER TABLE schedules ADD COLUMN last_run_at INTEGER;
ALTER TABLE schedules ADD COLUMN last_run_result TEXT;

INSERT OR IGNORE INTO system_config (key, value, updated_at, source)
VALUES ('schedule_last_tick_ms', '0', unixepoch(), 'db');
