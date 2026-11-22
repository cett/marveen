-- PostgreSQL full-text index of workspace_docs (phase 3, c5). The SQLite side is the external-content FTS5 table
-- workspace_docs_fts (title, content) with three sync triggers; here one generated column does the same.
--
-- title is weight A, content weight B. A binary document has no text: its content is blanked (the same invariant as the
-- SQLite trigger), so a binary doc is found by its title only. The two parts are separated by the lexeme '~' at its own
-- position: a phrase cannot run from the end of the title into the start of the content (see the artifact index, 0005).
-- The text goes through fts_norm (capped at 300000 characters: a pinned divergence, see the workspace cells).
ALTER TABLE workspace_docs ADD COLUMN fts tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('public.marveen_fts', public.fts_norm(title)), 'A') ||
  $$'~':1$$::tsvector ||
  setweight(to_tsvector('public.marveen_fts', public.fts_norm(
    CASE WHEN content_type = 'binary' THEN '' ELSE coalesce(content, '') END
  )), 'B')
) STORED;

CREATE INDEX workspace_docs_fts_gin ON workspace_docs USING gin (fts);
