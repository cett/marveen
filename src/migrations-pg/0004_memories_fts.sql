-- PostgreSQL full-text index of memories (phase 3, c3). The SQLite side is the FTS5 table memories_fts with three sync
-- triggers; here the index is one generated column, so no trigger has to be kept in step. The cost of that column on
-- the write path is measured (the touch-cost note), not assumed.
--
-- content is weight A, keywords weight B: the chat search matches weight A only (FTS5's content-column filter), the agent
-- search matches both. The text goes through fts_norm (the non-alphanumeric runs become spaces, capped at 300000
-- characters: a pinned divergence) and the marveen_fts configuration (accent fold, no stemming).
--
-- Known cost, measured and not optimized here: an UPDATE that changes no indexed column still writes a new heap tuple
-- and new index entries (the HOT path depends on free space in the page, which the default fillfactor leaves at none).
-- The salience and access-time writes take that path.
ALTER TABLE memories ADD COLUMN fts tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('public.marveen_fts', public.fts_norm(content)), 'A') ||
  setweight(to_tsvector('public.marveen_fts', public.fts_norm(keywords)), 'B')
) STORED;

CREATE INDEX memories_fts_gin ON memories USING gin (fts);
