-- Migration 0053: hardcoded default seed for autonomy_categories.
--
-- Retires the app-side JSON-file seed (seedAutonomyCategoriesFromJson in
-- src/db/autonomy.ts, migration 0052) now that store/autonomy-config.json is
-- being removed from the repo entirely -- a fresh install no longer has that
-- file to seed from, so the defaults move into the migration itself.
--
-- Guard: INSERT OR IGNORE per key -- a key that already exists (whether from
-- an upgrading install's earlier JSON-seed run, or from a prior run of this
-- migration on a --force-reapply) is left completely untouched, so an
-- operator's level/locked/max_level edit is never overwritten. This is a
-- per-key guard rather than a single upfront "table is empty" check because
-- a table-level `WHERE NOT EXISTS (SELECT 1 FROM autonomy_categories)` guard
-- would self-invalidate after the first of these sequential INSERTs runs
-- (the subquery re-evaluates against the now-non-empty table for every
-- statement that follows) -- INSERT OR IGNORE has no such ordering hazard.
INSERT OR IGNORE INTO autonomy_categories (key, label, level, locked, max_level, timeout_minutes, updated_at, updated_by)
VALUES
  ('data_delete', 'Fájl / adat törlés', 1, 1, 1, NULL, unixepoch(), 'seed_migration'),
  ('deploy_retry', 'Elbukott deploy/CI újrapróbálkozás', 2, 0, 3, NULL, unixepoch(), 'seed_migration'),
  ('email_send', 'Email küldés / válasz', 2, 0, 2, NULL, unixepoch(), 'seed_migration'),
  ('external_message', 'Külső üzenet küldés', 1, 1, 1, NULL, unixepoch(), 'seed_migration'),
  ('import_sources', 'Import forrás hozzáadása / törlése', 2, 0, 3, NULL, unixepoch(), 'seed_migration'),
  ('import_wipe', 'Import emlékek teljes törlése', 2, 0, 2, NULL, unixepoch(), 'seed_migration'),
  ('kanban_archive_done', '7+ napos done kártya archiválás', 3, 0, 3, NULL, unixepoch(), 'seed_migration'),
  ('kanban_restructure', 'Kanban kártya átstrukturálás / sub-task bontás', 2, 0, 3, NULL, unixepoch(), 'seed_migration'),
  ('kanban_stuck_nudge', 'Beakadt task: assignee nudge (2 kör után eszkalál)', 2, 0, 3, NULL, unixepoch(), 'seed_migration'),
  ('memory_maintenance', 'Memória rendberakás (vektorizálás, teszt-spam cold-ba)', 2, 0, 3, NULL, unixepoch(), 'seed_migration'),
  ('payment', 'Vásárlás / pénzmozgás', 1, 1, 1, NULL, unixepoch(), 'seed_migration'),
  ('permission_change', 'Jogosultság-változtatás / megosztás', 1, 1, 1, NULL, unixepoch(), 'seed_migration'),
  ('publish_content', 'Publikálás (Skool / blog / közösség)', 1, 1, 1, NULL, unixepoch(), 'seed_migration'),
  ('routine_trivial_fix', 'Déli/reggeli rutin triviális javításai', 2, 0, 3, NULL, unixepoch(), 'seed_migration'),
  ('skill_patch', 'Skill-patch alkalmazás', 2, 0, 3, NULL, unixepoch(), 'seed_migration');
