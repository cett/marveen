-- Migration 0072: re-import the HTML-derived import rows after stripMarkup learned to decode entities.
--
-- stripMarkup used to replace every HTML character reference with a space, so an accent written as an
-- entity (&ouml;, &#337;, &#x151;) was stored as a gap ("jegyzo kv" instead of the word). The fix cannot
-- repair the stored text (the original character is gone), and the dedup hash is taken over the RAW
-- source, which did not change, so a normal crawl would report hash_match and leave the garbled text.
-- This marks the affected rows so the next crawl re-reads the source and takes the update path (new text,
-- shadow memory updated, stale embedding dropped by the crawler):
--   * local sources: every row whose file is a markup type that stripMarkup handles;
--   * Confluence sources: every row, and last_run_at is cleared so the next crawl is a full sync (an
--     incremental one would list only pages edited since the last run).
-- The marker is not a sha256, so it can never equal a real hash. Rows of other source types are not
-- touched, and with no matching row both statements are no-ops; the migration runner applies it once.
UPDATE import_memories
   SET content_hash = 'resync-0072'
 WHERE source_id IN (SELECT id FROM import_sources WHERE type = 'confluence')
    OR (source_id IN (SELECT id FROM import_sources WHERE type = 'local')
        AND (file_name LIKE '%.html' OR file_name LIKE '%.htm' OR file_name LIKE '%.xml' OR file_name LIKE '%.svg'));

UPDATE import_sources
   SET last_run_at = NULL
 WHERE type = 'confluence';
