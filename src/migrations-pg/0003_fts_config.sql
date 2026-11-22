-- PostgreSQL full-text configuration for the search that SQLite does with FTS5 (phase 3, c1). PG-only: there is no SQLite
-- twin, the SQLite FTS5 tables stay as they are. No table is created here; the indexes come with the tables that use them.
--
-- Parity target: FTS5 with the default unicode61 tokenizer (remove_diacritics on): tokens are runs of letters and digits,
-- case folded, accents removed, no stemming, no stop words. The configuration below is 'simple' (no stemming, no stop words)
-- with unaccent in front of it, so the accent fold matches. Hungarian stemming is a later, separately measured option.

CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TEXT SEARCH CONFIGURATION public.marveen_fts (COPY = pg_catalog.simple);

ALTER TEXT SEARCH CONFIGURATION public.marveen_fts
  ALTER MAPPING FOR asciiword, word, numword, asciihword, hword, numhword, hword_asciipart, hword_part, hword_numpart
  WITH unaccent, simple;

-- Turns every run of non-alphanumeric characters into one space before the parser sees the text, so that
-- "serper.dev", "rank-check", "a_b", URLs and e-mail addresses split into words the way unicode61 splits them (the
-- default parser keeps "serper.dev" and "x.hu/p?q=1" as single tokens). Capped at 300000 characters: the text beyond
-- that is not searchable on PostgreSQL (SQLite indexes all of it; this is a pinned divergence, see the cells).
-- [^[:alnum:]] follows the database locale: the preflight warns when the locale is C or POSIX.
CREATE FUNCTION public.fts_norm(t text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT regexp_replace(left(coalesce(t, ''), 300000), '[^[:alnum:]]+', ' ', 'g') $$;

-- artifacts.content is bytea; SQLite's CAST(blob AS TEXT) never fails, so a body that is not valid UTF-8 must not fail
-- the INSERT. convert_from is STABLE, not IMMUTABLE, so it cannot sit in a generated column by itself. The IMMUTABLE label
-- here is a deliberate declaration: the result depends only on the bytes and the server encoding, which the preflight
-- requires to be UTF8. An invalid byte sequence gives '' (the body is not indexed, the title and meta still are).
CREATE FUNCTION public.fts_bytes_text(b bytea) RETURNS text
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  AS $$
BEGIN
  IF b IS NULL THEN
    RETURN '';
  END IF;
  RETURN convert_from(b, 'UTF8');
EXCEPTION WHEN character_not_in_repertoire OR untranslatable_character THEN
  -- only the invalid-byte-sequence errors (SQLSTATE 22021, 22P05) are the body's case; anything else (out of memory,
  -- cancelled statement) must still fail the statement
  RETURN '';
END
$$;
