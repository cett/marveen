// Companion files of a skill (scripts/, references/, ...): the pure rules shared
// by the DB layer, the API and the on-disk generation. They live in the
// skill_files table (migration 0063); SKILL.md itself is skills.content.

export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024
export const MAX_SKILL_FILES_PER_SKILL = 200
const MAX_REL_PATH_LENGTH = 200

/**
 * Normalize a companion file path: posix, relative, no '.', '..', empty or
 * backslash segments, no NUL/control characters, and never the skill's own
 * SKILL.md at the root. Returns null for anything else.
 */
export function normalizeSkillRelPath(input: string): string | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_REL_PATH_LENGTH) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(input)) return null
  if (input.startsWith('/')) return null
  const parts = input.split('/')
  if (parts.some(p => p === '' || p === '.' || p === '..')) return null
  const rel = parts.join('/')
  if (rel === 'SKILL.md') return null
  return rel
}

/** 0755 when any execute bit is set, else 0644: what the generated file gets. */
export function sanitizeSkillFileMode(mode: number | null | undefined): number {
  if (typeof mode !== 'number' || !Number.isFinite(mode)) return 0o644
  return (mode & 0o111) !== 0 ? 0o755 : 0o644
}
