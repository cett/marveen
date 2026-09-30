-- Migration 0063: skill_files, the companion files of a skill (scripts/,
-- references/, ...) next to its SKILL.md, so the skills table is the complete
-- source of truth and the on-disk skill directories are only a generated cache.
--
-- One row per (skill, relative path). rel_path is posix, relative, without
-- '..' or empty segments and is never 'SKILL.md' (that is skills.content);
-- src/skill-files.ts normalizes it before every write. content is the raw
-- bytes (BLOB), mode the sanitized permission bits (0644, or 0755 when the
-- file is executable) so a restored script keeps its exec bit.
--
-- No tenant_id column of its own: a row belongs to whoever owns skills.id, and
-- every reader goes through the skill row (same shape as skill_tenant_access).
-- The FK cascades on delete, but SQLite FK enforcement is off by default, so
-- deleteSkill() and the tenant purge remove the rows explicitly as well.
CREATE TABLE IF NOT EXISTS skill_files (
  skill_id   TEXT    NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  rel_path   TEXT    NOT NULL,
  content    BLOB    NOT NULL,
  mode       INTEGER NOT NULL DEFAULT 420,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (skill_id, rel_path)
);
