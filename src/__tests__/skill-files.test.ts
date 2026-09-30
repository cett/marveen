import { describe, it, expect } from 'vitest'
import { normalizeSkillRelPath, sanitizeSkillFileMode } from '../skill-files.js'

describe('normalizeSkillRelPath', () => {
  it('accepts plain relative posix paths', () => {
    for (const ok of ['a.txt', 'scripts/run.sh', 'references/deep/er/x.md', '.hidden', 'a b/c d.txt', 'ékezet/fájl.md']) {
      expect(normalizeSkillRelPath(ok), ok).toBe(ok)
    }
  })

  it('rejects traversal, absolute, empty/dot segments, backslash, control chars, overlong and the skill\'s own SKILL.md', () => {
    const bad = ['', '/abs', '../x', 'a/../b', 'a/./b', 'a//b', 'a/', '.', '..', 'a\\b', 'a\u0000b', 'a\nb', 'SKILL.md', 'x'.repeat(201)]
    for (const b of bad) expect(normalizeSkillRelPath(b), JSON.stringify(b)).toBeNull()
    expect(normalizeSkillRelPath(undefined as unknown as string)).toBeNull()
  })

  it('a nested SKILL.md is an ordinary companion file', () => {
    expect(normalizeSkillRelPath('examples/SKILL.md')).toBe('examples/SKILL.md')
  })
})

describe('sanitizeSkillFileMode', () => {
  it('keeps only "executable or not"', () => {
    expect(sanitizeSkillFileMode(0o755)).toBe(0o755)
    expect(sanitizeSkillFileMode(0o100755)).toBe(0o755)   // full st_mode with the file-type bits
    expect(sanitizeSkillFileMode(0o700)).toBe(0o755)      // owner-exec alone counts as executable
  })

  it('treats any exec bit as executable and everything else (incl. junk) as 0644', () => {
    expect(sanitizeSkillFileMode(0o001)).toBe(0o755)
    expect(sanitizeSkillFileMode(0o644)).toBe(0o644)
    expect(sanitizeSkillFileMode(0o600)).toBe(0o644)
    expect(sanitizeSkillFileMode(undefined)).toBe(0o644)
    expect(sanitizeSkillFileMode(null)).toBe(0o644)
    expect(sanitizeSkillFileMode(Number.NaN)).toBe(0o644)
  })
})
