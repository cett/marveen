-- Migration 0054: model_profile_map table, with defaults baked in.
--
-- Backs the deployment-local profile-id -> concrete-model-id mapping that
-- used to live in an optional store/model-profile-map.json side-car, as part
-- of the wider zero-install work (mirrors the autonomy_categories migration).
--
-- Schema AND seed in one migration (unlike autonomy's 0052/0053 split): there
-- is no pre-existing JSON-seed transitional state to preserve here, so this
-- goes straight to the final baked-seed form. The seed values are the same
-- ones config-examples/model-profile-map.example.json documented (Phase 1
-- intent: abstraction, not re-tiering -- the first map answers exactly what
-- the fleet already runs).
--
-- Guard: INSERT OR IGNORE per profile_id -- a key that already exists (e.g. a
-- prior run of this migration on a --force-reapply) is left untouched, so an
-- operator's model_id edit via the dashboard is never overwritten.
--
-- updated_by is an audit-trail addition the JSON side-car never had
-- ('seed_migration', 'dashboard', or 'agent:<id>').
CREATE TABLE IF NOT EXISTS model_profile_map (
  profile_id TEXT    PRIMARY KEY
             CHECK (profile_id IN (
               'premium_reasoning', 'build_strong',
               'analysis_efficient', 'routine_lowcost'
             )),
  model_id   TEXT    NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_by TEXT    NOT NULL DEFAULT 'system'
);

INSERT OR IGNORE INTO model_profile_map (profile_id, model_id, updated_at, updated_by)
VALUES
  ('premium_reasoning',  'claude-opus-5',    unixepoch(), 'seed_migration'),
  ('build_strong',       'claude-sonnet-5',  unixepoch(), 'seed_migration'),
  ('analysis_efficient', 'deepseek-v4-pro',  unixepoch(), 'seed_migration'),
  ('routine_lowcost',    'deepseek-v4-pro',  unixepoch(), 'seed_migration');
