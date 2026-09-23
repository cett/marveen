import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  OVERRIDES_PATH,
  getEffectiveSettingValue,
  setOverride,
  getOverrides,
  reloadOverridesForTest,
} from '../settings-store.js'
import { initDatabase, getSystemConfig } from '../db.js'

// This worktree's PROJECT_ROOT resolves under this checkout's own store/
// directory (see config.ts: PROJECT_ROOT = join(__dirname, '..')), so
// OVERRIDES_PATH here is isolated from any real fleet install -- safe to
// write/delete.
describe('settings-store', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
    reloadOverridesForTest()
  })

  afterAll(() => {
    if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
    reloadOverridesForTest()
  })

  it('falls back to the registry default when no override and no .env value exist', () => {
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(80)
    expect(getEffectiveSettingValue('KANBAN_WIP_OK_COLOR')).toBe('#6b7280')
  })

  it('throws for a key not in the registry', () => {
    expect(() => getEffectiveSettingValue('NOT_A_REAL_KEY')).toThrow()
  })

  it('persists a valid override and resolves it ahead of the default', () => {
    const result = setOverride('KANBAN_WIP_WARN_PCT', 42)
    expect(result.ok).toBe(true)
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(42)
  })

  it('writes ONLY to system_config -- config-overrides.json is never touched', () => {
    setOverride('KANBAN_WIP_OK_COLOR', '#112233')

    expect(existsSync(OVERRIDES_PATH)).toBe(false)

    const row = getSystemConfig('KANBAN_WIP_OK_COLOR')
    expect(row?.value).toBe('#112233')
    expect(row?.source).toBe('db')
  })

  it('a legacy config-overrides.json value is still readable as a fallback below the DB', () => {
    // Simulate a value that was set before the DB-only write path shipped
    // (no corresponding system_config row).
    mkdirSync(dirname(OVERRIDES_PATH), { recursive: true })
    writeFileSync(OVERRIDES_PATH, JSON.stringify({ KANBAN_WIP_OK_COLOR: '#legacy1' }))
    reloadOverridesForTest()

    expect(getSystemConfig('KANBAN_WIP_OK_COLOR')).toBeUndefined()
    expect(getEffectiveSettingValue('KANBAN_WIP_OK_COLOR')).toBe('#legacy1')
  })

  it('a DB value wins over a legacy config-overrides.json value for the same key', () => {
    mkdirSync(dirname(OVERRIDES_PATH), { recursive: true })
    writeFileSync(OVERRIDES_PATH, JSON.stringify({ KANBAN_WIP_OK_COLOR: '#111111' }))
    reloadOverridesForTest()

    setOverride('KANBAN_WIP_OK_COLOR', '#222222')

    expect(getEffectiveSettingValue('KANBAN_WIP_OK_COLOR')).toBe('#222222')
  })

  it('rejects an invalid value and does not change the effective value', () => {
    setOverride('KANBAN_WIP_WARN_PCT', 50) // baseline valid override
    const result = setOverride('KANBAN_WIP_WARN_PCT', 0) // 0 disallowed (min: 1)
    expect(result.ok).toBe(false)
    // rollback: the earlier valid override must still be in effect, not 0
    // and not silently reset to the registry default either.
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(50)
  })

  it('rejects an unknown key without writing to system_config', () => {
    const result = setOverride('NOT_A_REAL_KEY', 'x')
    expect(result.ok).toBe(false)
    expect(getSystemConfig('NOT_A_REAL_KEY')).toBeUndefined()
  })

  it('setOverride does not write to config-overrides.json even when an unrelated legacy file exists', () => {
    mkdirSync(dirname(OVERRIDES_PATH), { recursive: true })
    writeFileSync(OVERRIDES_PATH, JSON.stringify({ KANBAN_WIP_WARN_PCT: 33 }))
    reloadOverridesForTest()

    setOverride('KANBAN_WIP_OK_COLOR', '#abcdef')

    const onDisk = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'))
    expect(onDisk).toEqual({ KANBAN_WIP_WARN_PCT: 33 })
    expect(getOverrides()).toEqual({ KANBAN_WIP_WARN_PCT: 33 })
  })
})
