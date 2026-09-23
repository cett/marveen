import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Per-test STORE_DIR isolation (test-stability follow-up). This file's
// tests write directly to <STORE_DIR>/config-overrides.json, and STORE_DIR is
// a module-level const in config.ts resolved once (from MARVEEN_STORE_DIR)
// at import time -- so giving each test its own directory means giving each
// test its own fresh MODULE INSTANCE of db.js/config.js (vi.resetModules() +
// a dynamic re-import), not just a different directory on disk. A statically
// imported db.js would keep pointing at whatever STORE_DIR it resolved on
// the FIRST import, before any test ran.
//
// Before this, this file shared the real worktree store/ directory with
// settings-store.test.ts and settings-route-db-only-write.test.ts across
// concurrently-running worker processes -- a demonstrated flaky race
// (reproduced on the pre-this-change baseline too: 4 of 5 stress runs
// failed there from this exact cross-file contention).
let dbMod: typeof import('../db.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'db-system-config-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

function overridesPath(): string {
  return join(storeDir, 'config-overrides.json')
}

describe('system_config read/write helpers', () => {
  it('returns undefined for a key that was never set', () => {
    expect(dbMod.getSystemConfig('NOPE')).toBeUndefined()
  })

  it('setSystemConfig inserts a row with the default source', () => {
    dbMod.setSystemConfig('OLLAMA_URL', 'http://box:11434')
    const row = dbMod.getSystemConfig('OLLAMA_URL')
    expect(row?.value).toBe('http://box:11434')
    expect(row?.source).toBe('db')
    expect(row?.updated_at).toBeGreaterThan(0)
  })

  it('setSystemConfig upserts: a second call updates value/updated_at in place', () => {
    dbMod.setSystemConfig('OLLAMA_URL', 'http://first:11434')
    const first = dbMod.getSystemConfig('OLLAMA_URL')!
    dbMod.setSystemConfig('OLLAMA_URL', 'http://second:11434')
    const second = dbMod.getSystemConfig('OLLAMA_URL')!
    expect(second.value).toBe('http://second:11434')
    expect(dbMod.listSystemConfig().filter(r => r.key === 'OLLAMA_URL')).toHaveLength(1)
    expect(second.updated_at).toBeGreaterThanOrEqual(first.updated_at)
  })

  it('setSystemConfig accepts an explicit source', () => {
    dbMod.setSystemConfig('DASHBOARD_PUBLIC_URL', 'https://box.example', 'migrated_from_json')
    expect(dbMod.getSystemConfig('DASHBOARD_PUBLIC_URL')?.source).toBe('migrated_from_json')
  })

  it('listSystemConfig returns all rows ordered by key', () => {
    dbMod.setSystemConfig('B_KEY', '2')
    dbMod.setSystemConfig('A_KEY', '1')
    expect(dbMod.listSystemConfig().map(r => r.key)).toEqual(['A_KEY', 'B_KEY'])
  })
})

describe('migrateConfigOverridesToSystemConfig', () => {
  it('returns 0 and writes nothing when config-overrides.json does not exist', () => {
    expect(dbMod.migrateConfigOverridesToSystemConfig()).toBe(0)
    expect(dbMod.listSystemConfig()).toHaveLength(0)
  })

  it('copies every JSON key into system_config with source=migrated_from_json', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(overridesPath(), JSON.stringify({ OLLAMA_URL: 'http://box:11434', KANBAN_WIP_WARN_PCT: 90 }))

    const migrated = dbMod.migrateConfigOverridesToSystemConfig()

    expect(migrated).toBe(2)
    expect(dbMod.getSystemConfig('OLLAMA_URL')?.value).toBe('http://box:11434')
    expect(dbMod.getSystemConfig('OLLAMA_URL')?.source).toBe('migrated_from_json')
    // Numeric JSON values are stringified -- system_config.value is TEXT.
    expect(dbMod.getSystemConfig('KANBAN_WIP_WARN_PCT')?.value).toBe('90')
  })

  it('is idempotent: a second run does not duplicate or overwrite an existing row', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(overridesPath(), JSON.stringify({ OLLAMA_URL: 'http://box:11434' }))
    dbMod.migrateConfigOverridesToSystemConfig()

    // Simulate an operator having since edited the value directly in the DB.
    dbMod.setSystemConfig('OLLAMA_URL', 'http://operator-set:11434', 'db')

    const secondRunCount = dbMod.migrateConfigOverridesToSystemConfig()

    expect(secondRunCount).toBe(0)
    const row = dbMod.getSystemConfig('OLLAMA_URL')!
    expect(row.value).toBe('http://operator-set:11434')
    expect(row.source).toBe('db')
    expect(dbMod.listSystemConfig().filter(r => r.key === 'OLLAMA_URL')).toHaveLength(1)
  })

  it('skips malformed JSON without throwing', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(overridesPath(), '{not valid json')
    expect(dbMod.migrateConfigOverridesToSystemConfig()).toBe(0)
    expect(dbMod.listSystemConfig()).toHaveLength(0)
  })

  it('skips a JSON file that is not a plain object', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(overridesPath(), JSON.stringify(['a', 'b']))
    expect(dbMod.migrateConfigOverridesToSystemConfig()).toBe(0)
  })
})

// retireConfigOverridesFile() itself is covered in a separate, fully-mocked
// file (retire-config-overrides.test.ts): it performs a real rename, and a
// mocked node:fs there sidesteps needing a real directory at all.
