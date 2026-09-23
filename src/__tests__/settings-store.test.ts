import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getEffectiveSettingValue, setOverride } from '../settings-store.js'
import { initDatabase, getSystemConfig } from '../db.js'
import { STORE_DIR } from '../config.js'

// S8B retired config-overrides.json entirely -- there is no OVERRIDES_PATH
// export anymore. This local path is only used to prove a legacy file, if one
// happens to still be on disk, is now IGNORED (the intentional behaviour
// change this step introduces).
const LEGACY_OVERRIDES_PATH = join(STORE_DIR, 'config-overrides.json')

describe('settings-store', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    if (existsSync(LEGACY_OVERRIDES_PATH)) rmSync(LEGACY_OVERRIDES_PATH)
  })

  it('falls back to the registry default when no DB and no .env value exist', () => {
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

    expect(existsSync(LEGACY_OVERRIDES_PATH)).toBe(false)

    const row = getSystemConfig('KANBAN_WIP_OK_COLOR')
    expect(row?.value).toBe('#112233')
    expect(row?.source).toBe('db')
  })

  // S8B intentional behaviour change: a key that only ever lived in
  // config-overrides.json (never migrated into system_config) no longer
  // resolves to the JSON value -- it now falls straight through to the
  // registry default, because the JSON-cache read layer is gone.
  it('a legacy config-overrides.json value with no matching DB row is NO LONGER read -- falls to the registry default', () => {
    mkdirSync(dirname(LEGACY_OVERRIDES_PATH), { recursive: true })
    writeFileSync(LEGACY_OVERRIDES_PATH, JSON.stringify({ KANBAN_WIP_OK_COLOR: '#legacy1' }))

    expect(getSystemConfig('KANBAN_WIP_OK_COLOR')).toBeUndefined()
    expect(getEffectiveSettingValue('KANBAN_WIP_OK_COLOR')).toBe('#6b7280')
  })

  it('a DB value resolves correctly even while an unrelated legacy config-overrides.json file exists on disk', () => {
    mkdirSync(dirname(LEGACY_OVERRIDES_PATH), { recursive: true })
    writeFileSync(LEGACY_OVERRIDES_PATH, JSON.stringify({ KANBAN_WIP_OK_COLOR: '#111111' }))

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
    mkdirSync(dirname(LEGACY_OVERRIDES_PATH), { recursive: true })
    writeFileSync(LEGACY_OVERRIDES_PATH, JSON.stringify({ KANBAN_WIP_WARN_PCT: 33 }))

    setOverride('KANBAN_WIP_OK_COLOR', '#abcdef')

    const onDisk = JSON.parse(readFileSync(LEGACY_OVERRIDES_PATH, 'utf-8'))
    expect(onDisk).toEqual({ KANBAN_WIP_WARN_PCT: 33 })
  })
})
