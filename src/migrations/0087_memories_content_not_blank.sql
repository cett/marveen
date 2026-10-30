-- Migration 0087: a memory's content can no longer be blank, enforced by the database itself.
--
-- The HTTP routes, updateMemory / updateTenantMemory and the import path all refuse blank content
-- through isBlankContent (src/blank-content.ts). This is the last line for everything that writes
-- the table directly. SQLite cannot add a CHECK to an existing table, so two triggers do it (on
-- PostgreSQL this becomes a CHECK constraint with the Phase 2 schema).
--
-- "Blank" is the same set isBlankContent uses: whitespace plus the invisible characters that
-- String.prototype.trim does not strip. SQLite's trim() only strips what it is told to, so the
-- characters are listed as code points: tab, line feed, vertical tab, form feed, carriage return,
-- space, no-break space, soft hyphen, Ogham space, Mongolian vowel separator, the en/em/thin/hair
-- spaces (8192 to 8202), zero width space / non-joiner / joiner, line and paragraph separator,
-- narrow no-break space, medium mathematical space, word joiner, ideographic space, byte order mark.
-- src/__tests__/memories-content-not-blank.test.ts keeps this list equal to isBlankContent.
--
-- Rows already in the table are not touched (there are none with blank content on the live
-- database); only a new row, or an update of content, is checked.

CREATE TRIGGER IF NOT EXISTS memories_content_not_blank_insert
BEFORE INSERT ON memories
FOR EACH ROW
WHEN trim(NEW.content, char(9,10,11,12,13,32,160,173,5760,6158,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8203,8204,8205,8232,8233,8239,8287,8288,12288,65279)) = ''
BEGIN
  SELECT RAISE(ABORT, 'memories.content must not be blank');
END;

CREATE TRIGGER IF NOT EXISTS memories_content_not_blank_update
BEFORE UPDATE OF content ON memories
FOR EACH ROW
WHEN trim(NEW.content, char(9,10,11,12,13,32,160,173,5760,6158,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8203,8204,8205,8232,8233,8239,8287,8288,12288,65279)) = ''
BEGIN
  SELECT RAISE(ABORT, 'memories.content must not be blank');
END;
