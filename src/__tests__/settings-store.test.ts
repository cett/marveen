import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Per-test STORE_DIR isolation (test-stability follow-up). STORE_DIR is
// a module-level const in config.ts, resolved once (from MARVEEN_STORE_DIR)
// at import time -- a statically imported db.js/settings-store.js would keep
// pointing at whatever STORE_DIR (and whatever `db` connection) they
// resolved on the FIRST import, before any test ran. vi.resetModules() +
// dynamic re-import of BOTH db.js and settings-store.js together (same reset
// generation) is required, not just one of them: settings-store.js's
// getSystemConfig/setSystemConfig calls go through db/system-config.js's
// `db` binding, and that must be the SAME instance db.js's initDatabase()
// just (re)initialized -- a stale settings-store.js would hold a `db`
// binding from a previous, possibly-closed connection.
//
// Before this, this file shared the real worktree store/ directory with
// db-system-config.test.ts and settings-route-db-only-write.test.ts across
// concurrently-running worker processes -- a demonstrated flaky race
// (reproduced on the pre-this-change baseline too: 4 of 5 stress runs
// failed there from this exact cross-file contention).
let dbMod: typeof import('../db.js')
let settingsMod: typeof import('../settings-store.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'settings-store-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  ;[dbMod, settingsMod] = await Promise.all([import('../db.js'), import('../settings-store.js')])
  dbMod.initDatabase(':memory:')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

// S8B retired config-overrides.json entirely -- there is no OVERRIDES_PATH
// export anymore. This local path is only used to prove a legacy file, if one
// happens to still be on disk, is now IGNORED (the intentional behaviour
// change that step introduced).
function legacyOverridesPath(): string {
  return join(storeDir, 'config-overrides.json')
}

describe('settings-store', () => {
  it('falls back to the registry default when no DB and no .env value exist', () => {
    expect(settingsMod.getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(80)
    expect(settingsMod.getEffectiveSettingValue('KANBAN_WIP_OK_COLOR')).toBe('#6b7280')
  })

  it('throws for a key not in the registry', () => {
    expect(() => settingsMod.getEffectiveSettingValue('NOT_A_REAL_KEY')).toThrow()
  })

  it('persists a valid override and resolves it ahead of the default', () => {
    const result = settingsMod.setOverride('KANBAN_WIP_WARN_PCT', 42)
    expect(result.ok).toBe(true)
    expect(settingsMod.getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(42)
  })

  it('writes ONLY to system_config -- config-overrides.json is never touched', () => {
    settingsMod.setOverride('KANBAN_WIP_OK_COLOR', '#112233')

    expect(existsSync(legacyOverridesPath())).toBe(false)

    const row = dbMod.getSystemConfig('KANBAN_WIP_OK_COLOR')
    expect(row?.value).toBe('#112233')
    expect(row?.source).toBe('db')
  })

  // S8B intentional behaviour change: a key that only ever lived in
  // config-overrides.json (never migrated into system_config) no longer
  // resolves to the JSON value -- it now falls straight through to the
  // registry default, because the JSON-cache read layer is gone.
  it('a legacy config-overrides.json value with no matching DB row is NO LONGER read -- falls to the registry default', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(legacyOverridesPath(), JSON.stringify({ KANBAN_WIP_OK_COLOR: '#legacy1' }))

    expect(dbMod.getSystemConfig('KANBAN_WIP_OK_COLOR')).toBeUndefined()
    expect(settingsMod.getEffectiveSettingValue('KANBAN_WIP_OK_COLOR')).toBe('#6b7280')
  })

  it('a DB value resolves correctly even while an unrelated legacy config-overrides.json file exists on disk', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(legacyOverridesPath(), JSON.stringify({ KANBAN_WIP_OK_COLOR: '#111111' }))

    settingsMod.setOverride('KANBAN_WIP_OK_COLOR', '#222222')

    expect(settingsMod.getEffectiveSettingValue('KANBAN_WIP_OK_COLOR')).toBe('#222222')
  })

  it('rejects an invalid value and does not change the effective value', () => {
    settingsMod.setOverride('KANBAN_WIP_WARN_PCT', 50) // baseline valid override
    const result = settingsMod.setOverride('KANBAN_WIP_WARN_PCT', 0) // 0 disallowed (min: 1)
    expect(result.ok).toBe(false)
    // rollback: the earlier valid override must still be in effect, not 0
    // and not silently reset to the registry default either.
    expect(settingsMod.getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(50)
  })

  it('rejects an unknown key without writing to system_config', () => {
    const result = settingsMod.setOverride('NOT_A_REAL_KEY', 'x')
    expect(result.ok).toBe(false)
    expect(dbMod.getSystemConfig('NOT_A_REAL_KEY')).toBeUndefined()
  })

  it('setOverride does not write to config-overrides.json even when an unrelated legacy file exists', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(legacyOverridesPath(), JSON.stringify({ KANBAN_WIP_WARN_PCT: 33 }))

    settingsMod.setOverride('KANBAN_WIP_OK_COLOR', '#abcdef')

    const onDisk = JSON.parse(readFileSync(legacyOverridesPath(), 'utf-8'))
    expect(onDisk).toEqual({ KANBAN_WIP_WARN_PCT: 33 })
  })
})
