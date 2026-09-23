-- Migration 0051: system_config key/value store.
--
-- Backs runtime-configurable system settings that today only live in JSON
-- side-cars or hardcoded defaults, as part of the wider zero-install work.
-- This migration is schema-only -- no seed data, no reads/writes wired up
-- yet; a later step migrates existing JSON-sourced values in and a settings
-- registry reads them app-side.
--
-- source distinguishes a value an operator/admin set directly in this table
-- ('db') from one that was carried over from a pre-existing JSON config file
-- during the S4 one-time migration ('migrated_from_json'), for support/audit
-- visibility into where a setting's current value originated.
--
-- No SQL CHECK on value's shape: type validation belongs to the application
-- (SETTINGS_REGISTRY, per-key typed), which knows what each key means; a CHECK
-- constraint here cannot express that and would just be redundant/out of sync.
CREATE TABLE IF NOT EXISTS system_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  source     TEXT NOT NULL DEFAULT 'db'
);
