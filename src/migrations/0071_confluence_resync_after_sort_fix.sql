-- Migration 0071: one full re-sync for every existing Confluence import source.
--
-- Until the incremental listing was fixed (sort=-modified-date), an incremental Confluence crawl
-- listed the oldest page first, cut off at once and imported nothing, yet every crawl still moved
-- last_run_at forward. Pages edited before the fix therefore sit older than last_run_at and the
-- fixed incremental run would never see them. A NULL last_run_at makes the next crawl a full sync
-- (and makes the source due immediately); the content-hash check leaves unchanged pages untouched.
-- No Confluence source means no row matches and the statement is a no-op; the migration runner
-- applies it once.
UPDATE import_sources
   SET last_run_at = NULL
 WHERE type = 'confluence';
