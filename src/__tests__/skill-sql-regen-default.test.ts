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
  afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('../env.js'); vi.resetModules() })

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

  // The dotenv file reaches config.ts through readEnvFile(); fake it to pin the precedence rule:
  // a set process.env value (even blank) wins, only an unset one falls back to the file.
  async function regenWith(dotEnv: string | undefined, processEnv: string | undefined): Promise<boolean> {
    vi.doMock('../env.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../env.js')>()
      return { ...actual, readEnvFile: () => (dotEnv === undefined ? {} : { SKILL_SQL_REGEN: dotEnv }) }
    })
    vi.stubEnv('SKILL_SQL_REGEN', processEnv)
    vi.resetModules()
    return (await import('../config.js')).SKILL_SQL_REGEN
  }

  it('the dotenv value 0 switches it off when process.env does not set it', async () => {
    expect(await regenWith('0', undefined)).toBe(false)
  })

  it('process.env=1 beats the dotenv value 0', async () => {
    expect(await regenWith('0', '1')).toBe(true)
  })

  it('process.env=0 beats the dotenv value 1', async () => {
    expect(await regenWith('1', '0')).toBe(false)
  })

  it('a blank process.env beats the dotenv value 0 (blank never disables, never falls through)', async () => {
    expect(await regenWith('0', '')).toBe(true)
  })

  it('stays on with neither set', async () => {
    expect(await regenWith(undefined, undefined)).toBe(true)
  })
})
