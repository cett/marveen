import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseSkillSqlRegen } from '../config.js'

// The SQL->file skill regen used to be opt-in (only the literal '1' enabled it),
// so a fresh install never wrote skills back to the SKILL.md files Claude Code
// reads. It is now ON unless explicitly switched off.

describe('parseSkillSqlRegen', () => {
  it('is ON when the variable is unset or empty (the default)', () => {
    expect(parseSkillSqlRegen(undefined)).toBe(true)
    expect(parseSkillSqlRegen('')).toBe(true)
    expect(parseSkillSqlRegen('   ')).toBe(true)
  })

  it('stays ON for an explicit 1 and for any unrecognised value', () => {
    expect(parseSkillSqlRegen('1')).toBe(true)
    expect(parseSkillSqlRegen('true')).toBe(true)
    expect(parseSkillSqlRegen('yes')).toBe(true)
    expect(parseSkillSqlRegen('garbage')).toBe(true)
  })

  it('is OFF only for an explicit 0 (also false/off/no, case and whitespace tolerant)', () => {
    expect(parseSkillSqlRegen('0')).toBe(false)
    expect(parseSkillSqlRegen(' 0 ')).toBe(false)
    expect(parseSkillSqlRegen('false')).toBe(false)
    expect(parseSkillSqlRegen('OFF')).toBe(false)
    expect(parseSkillSqlRegen('No')).toBe(false)
  })
})

describe('SKILL_SQL_REGEN export', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  it('is false when process.env sets SKILL_SQL_REGEN=0 (process.env beats .env)', async () => {
    vi.stubEnv('SKILL_SQL_REGEN', '0')
    vi.resetModules()
    const cfg = await import('../config.js')
    expect(cfg.SKILL_SQL_REGEN).toBe(false)
  })

  it('is true when process.env sets SKILL_SQL_REGEN=1', async () => {
    vi.stubEnv('SKILL_SQL_REGEN', '1')
    vi.resetModules()
    const cfg = await import('../config.js')
    expect(cfg.SKILL_SQL_REGEN).toBe(true)
  })

  it('is true when the variable is blank in process.env (blank never disables)', async () => {
    vi.stubEnv('SKILL_SQL_REGEN', '')
    vi.resetModules()
    const cfg = await import('../config.js')
    expect(cfg.SKILL_SQL_REGEN).toBe(true)
  })
})
