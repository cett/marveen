-- FTS5 full-text index for workspace_docs, so GET /api/memories?q= can surface
-- working documents (plans/briefs/reports/notes) alongside memories. Kanban
-- 9156e583.
--
-- workspace_docs has a TEXT primary key (`id`, a UUID) -- but the table is a
-- normal rowid table (not WITHOUT ROWID, `id` is not an INTEGER PRIMARY KEY
-- alias), so it still has the usual hidden `rowid` column. We reference that
-- directly rather than adding a separate id<->rowid mapping table, mirroring
-- artifacts_fts (migration 0010), which already does this for the same
-- TEXT-PK situation.
--
-- content='workspace_docs' (true external content, not contentless
-- content=''): the FTS index stores no duplicate text at all -- only the
-- inverted index -- and it lets snippet()/highlight() look the live row up
-- by rowid at query time (a contentless table cannot support those
-- functions). Sync triggers must still supply the OLD column values
-- explicitly on delete/update-delete: by the time an AFTER DELETE trigger
-- fires the source row is already gone, so FTS5 can't look it up itself for
-- that half of the operation. This is the standard documented idiom for
-- external-content FTS5 tables, not something specific to this migration.
--
-- Every workspace_docs row gets exactly one workspace_docs_fts row
-- (unconditional insert on every INSERT, matching artifacts_fts's pattern),
-- with the indexed `content` blanked to '' for content_type='binary' (its
-- real payload lives in content_blob, not the TEXT `content` column, so
-- there is no searchable text to index) -- title still indexes for binary
-- docs, so they're findable by name even though a content search won't
-- surface them. This invariant (every row is always indexed) is
-- deliberate, not just a simplification: an earlier version of this
-- migration conditionally SKIPPED inserting a row for binary docs, which
-- meant a later DELETE or UPDATE on that row had to issue FTS5's 'delete'
-- command for a rowid that was never actually indexed -- confirmed
-- empirically while writing this migration to corrupt the FTS5 shadow
-- tables ("database disk image is malformed" / SQLITE_CORRUPT_VTAB). Always
-- inserting (with content blanked instead of the row omitted) avoids that
-- whole class of bug: every delete/update is guaranteed to target a rowid
-- that genuinely exists in the index.

CREATE VIRTUAL TABLE IF NOT EXISTS workspace_docs_fts USING fts5(
  title,
  content,
  content='workspace_docs',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS workspace_docs_fts_ai AFTER INSERT ON workspace_docs BEGIN
  INSERT INTO workspace_docs_fts(rowid, title, content)
    VALUES (
      new.rowid, new.title,
      CASE WHEN new.content_type = 'binary' THEN '' ELSE COALESCE(new.content, '') END
    );
END;

CREATE TRIGGER IF NOT EXISTS workspace_docs_fts_ad AFTER DELETE ON workspace_docs BEGIN
  INSERT INTO workspace_docs_fts(workspace_docs_fts, rowid, title, content)
    VALUES (
      'delete', old.rowid, old.title,
      CASE WHEN old.content_type = 'binary' THEN '' ELSE COALESCE(old.content, '') END
    );
END;

CREATE TRIGGER IF NOT EXISTS workspace_docs_fts_au AFTER UPDATE ON workspace_docs BEGIN
  INSERT INTO workspace_docs_fts(workspace_docs_fts, rowid, title, content)
    VALUES (
      'delete', old.rowid, old.title,
      CASE WHEN old.content_type = 'binary' THEN '' ELSE COALESCE(old.content, '') END
    );
  INSERT INTO workspace_docs_fts(rowid, title, content)
    VALUES (
      new.rowid, new.title,
      CASE WHEN new.content_type = 'binary' THEN '' ELSE COALESCE(new.content, '') END
    );
END;

-- One-time backfill for existing rows (this migration only ever runs once
-- per database, tracked in schema_version -- see src/db-migrations.ts -- so
-- no additional idempotency guard is needed here).
INSERT INTO workspace_docs_fts(rowid, title, content)
  SELECT rowid, title, CASE WHEN content_type = 'binary' THEN '' ELSE COALESCE(content, '') END
  FROM workspace_docs;
