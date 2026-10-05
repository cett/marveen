-- Migration 0069: homoglyph_findings, a journal of Cyrillic look-alike letters in kanban text.
--
-- Generated Hungarian text occasionally carries Cyrillic look-alike letters: they read fine, but every
-- later grep / LIKE / FTS query misses them. Agents write kanban rows with sqlite3 directly, so an
-- API-level check never sees those writes. These two AFTER INSERT triggers journal (never block, never
-- modify) rows whose text carries one of the measured look-alike letters; GET /api/homoglyphs surfaces
-- the journal. The letter set mirrors TRIGGER_CHARS in src/homoglyph.ts (a test keeps them identical).
--
--   src_table   kanban_cards | kanban_comments
--   src_id      the row id (text)
--   sample      the first 120 characters of the text, so the finding is locatable
--   found_at    unix seconds (UTC)
--   resolved_at set when someone READ the word and fixed it or classified it as legitimate content
CREATE TABLE IF NOT EXISTS homoglyph_findings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  src_table   TEXT NOT NULL,
  src_id      TEXT NOT NULL,
  sample      TEXT NOT NULL,
  found_at    INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TRIGGER IF NOT EXISTS homoglyph_kanban_comments_ai AFTER INSERT ON kanban_comments
WHEN NEW.content LIKE '%а%' OR NEW.content LIKE '%б%' OR NEW.content LIKE '%е%' OR NEW.content LIKE '%и%' OR NEW.content LIKE '%ј%' OR NEW.content LIKE '%к%' OR NEW.content LIKE '%л%' OR NEW.content LIKE '%м%' OR NEW.content LIKE '%н%' OR NEW.content LIKE '%о%' OR NEW.content LIKE '%п%' OR NEW.content LIKE '%р%' OR NEW.content LIKE '%с%' OR NEW.content LIKE '%т%' OR NEW.content LIKE '%у%' OR NEW.content LIKE '%х%'
BEGIN
  INSERT INTO homoglyph_findings (src_table, src_id, sample, found_at)
  VALUES ('kanban_comments', NEW.id, substr(NEW.content, 1, 120), unixepoch());
END;

CREATE TRIGGER IF NOT EXISTS homoglyph_kanban_cards_ai AFTER INSERT ON kanban_cards
WHEN NEW.title LIKE '%а%' OR NEW.title LIKE '%б%' OR NEW.title LIKE '%е%' OR NEW.title LIKE '%и%' OR NEW.title LIKE '%ј%' OR NEW.title LIKE '%к%' OR NEW.title LIKE '%л%' OR NEW.title LIKE '%м%' OR NEW.title LIKE '%н%' OR NEW.title LIKE '%о%' OR NEW.title LIKE '%п%' OR NEW.title LIKE '%р%' OR NEW.title LIKE '%с%' OR NEW.title LIKE '%т%' OR NEW.title LIKE '%у%' OR NEW.title LIKE '%х%'
BEGIN
  INSERT INTO homoglyph_findings (src_table, src_id, sample, found_at)
  VALUES ('kanban_cards', NEW.id, substr(NEW.title, 1, 120), unixepoch());
END;
