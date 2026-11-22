-- PostgreSQL full-text index of artifacts (phase 3, c4). The SQLite side is the external-content FTS5 table artifacts_fts
-- (title, meta, body) with three sync triggers; here one generated column does the same, so no trigger is kept in step.
--
-- title is weight A, meta (a JSON text: its keys and values are words) weight B, body weight C. The body is indexed only for
-- the textual kinds (html, markdown, json, text), as the SQLite trigger does; a binary artifact is found by title and meta.
-- content is bytea: fts_bytes_text reads it as UTF-8 (an invalid sequence gives '', the title and meta still index).
-- The text goes through fts_norm (capped at 300000 characters: a pinned divergence, see the artifact cells).
-- The parts are separated by the lexeme '~' (at its own position): a tsvector concatenation renumbers the right operand,
-- so a phrase cannot run from the end of one part into the next (SQLite's FTS5 phrase stays inside one column, the same
-- result). fts_norm never emits '~', so the separator is not a word of the text.
ALTER TABLE artifacts ADD COLUMN fts tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('public.marveen_fts', public.fts_norm(title)), 'A') ||
  $$'~':1$$::tsvector ||
  setweight(to_tsvector('public.marveen_fts', public.fts_norm(meta)), 'B') ||
  $$'~':1$$::tsvector ||
  setweight(to_tsvector('public.marveen_fts', public.fts_norm(
    CASE WHEN kind IN ('html', 'markdown', 'json', 'text') THEN public.fts_bytes_text(content) ELSE '' END
  )), 'C')
) STORED;

CREATE INDEX artifacts_fts_gin ON artifacts USING gin (fts);
