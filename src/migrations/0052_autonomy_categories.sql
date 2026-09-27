-- Migration 0052: autonomy_categories table.
--
-- Backs the per-category autonomy level (1=notify-only, 2=propose+approve,
-- 3=autonomous+report) that today lives in the store/autonomy-config.json
-- side-car, as part of the wider zero-install work (see migration 0051 for
-- the same pattern applied to system_config). Schema-only -- no seed data
-- here; a one-time app-side seed copies the existing JSON file's categories
-- in on first boot after this migration (see seedAutonomyCategoriesFromJson
-- in src/db/autonomy.ts), the same shape as migrateConfigOverridesToSystemConfig.
--
-- timeout_minutes is nullable: NULL means no approval-timeout limit for that
-- category (unchanged behavior from the JSON's optional field).
--
-- updated_by is an audit-trail addition the JSON side-car never had
-- ('dashboard', 'system', or 'agent:<id>').
CREATE TABLE IF NOT EXISTS autonomy_categories (
  key             TEXT    PRIMARY KEY,
  label           TEXT    NOT NULL,
  level           INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
  locked          INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
  max_level       INTEGER NOT NULL DEFAULT 3 CHECK (max_level BETWEEN 1 AND 3),
  timeout_minutes INTEGER,
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by      TEXT    NOT NULL DEFAULT 'system'
);
