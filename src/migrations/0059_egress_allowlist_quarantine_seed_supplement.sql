-- Migration 0059: egress_allowlist seed supplement -- 7 RSS-feed hosts
-- added to store/egress-allowlist.json (and the runtime quarantine-reader.md
-- doc) after migration 0056's seed was authored, so the daily digest's new
-- sources would not break before this branch merges.
-- 0056's baked seed is a point-in-time snapshot (199 domains) and does NOT
-- get re-read after the migration has already run on an install -- these 7
-- would otherwise silently disappear from the DB-backed allowlist once this
-- branch (#985) ships, even though the JSON side-car still has them (the
-- side-car is dashboard-fallback-only post-migration, see 0056's own
-- comment). A supplement migration (not an edit to 0056 itself) is the
-- correct fix: editing an already-applied migration's SQL does not
-- retroactively re-run it on installs where it already applied, including
-- this one.
INSERT OR IGNORE INTO egress_allowlist (value, type, added_by, added_at, tenant_id)
VALUES
  ('www.hwsw.hu', 'domain', 'seed_migration', unixepoch(), 'default'),
  ('ite.hu', 'domain', 'seed_migration', unixepoch(), 'default'),
  ('www.marketingszoveg.com', 'domain', 'seed_migration', unixepoch(), 'default'),
  ('logout.hu', 'domain', 'seed_migration', unixepoch(), 'default'),
  ('aphexplays.blog.hu', 'domain', 'seed_migration', unixepoch(), 'default'),
  ('devsolution.hu', 'domain', 'seed_migration', unixepoch(), 'default'),
  ('hzoltan.com', 'domain', 'seed_migration', unixepoch(), 'default');
