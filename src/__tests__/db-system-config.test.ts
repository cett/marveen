import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initDatabase,
  getSystemConfig,
  setSystemConfig,
  listSystemConfig,
  migrateConfigOverridesToSystemConfig,
} from '../db.js'
import { STORE_DIR } from '../config.js'

// This worktree's PROJECT_ROOT (and therefore STORE_DIR) resolves under this
// checkout's own store/ directory -- safe to write/delete config-overrides.json
// here (same isolation settings-store.test.ts relies on for OVERRIDES_PATH).
const OVERRIDES_PATH = join(STORE_DIR, 'config-overrides.json')

beforeEach(() => {
  initDatabase(':memory:')
  if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
})

afterEach(() => {
  if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
})

describe('system_config read/write helpers', () => {
  it('returns undefined for a key that was never set', () => {
    expect(getSystemConfig('NOPE')).toBeUndefined()
  })

  it('setSystemConfig inserts a row with the default source', () => {
    setSystemConfig('OLLAMA_URL', 'http://box:11434')
    const row = getSystemConfig('OLLAMA_URL')
    expect(row?.value).toBe('http://box:11434')
    expect(row?.source).toBe('db')
    expect(row?.updated_at).toBeGreaterThan(0)
  })

  it('setSystemConfig upserts: a second call updates value/updated_at in place', () => {
    setSystemConfig('OLLAMA_URL', 'http://first:11434')
    const first = getSystemConfig('OLLAMA_URL')!
    setSystemConfig('OLLAMA_URL', 'http://second:11434')
    const second = getSystemConfig('OLLAMA_URL')!
    expect(second.value).toBe('http://second:11434')
    expect(listSystemConfig().filter(r => r.key === 'OLLAMA_URL')).toHaveLength(1)
    expect(second.updated_at).toBeGreaterThanOrEqual(first.updated_at)
  })

  it('setSystemConfig accepts an explicit source', () => {
    setSystemConfig('DASHBOARD_PUBLIC_URL', 'https://box.example', 'migrated_from_json')
    expect(getSystemConfig('DASHBOARD_PUBLIC_URL')?.source).toBe('migrated_from_json')
  })

  it('listSystemConfig returns all rows ordered by key', () => {
    setSystemConfig('B_KEY', '2')
    setSystemConfig('A_KEY', '1')
    expect(listSystemConfig().map(r => r.key)).toEqual(['A_KEY', 'B_KEY'])
  })
})

describe('migrateConfigOverridesToSystemConfig', () => {
  it('returns 0 and writes nothing when config-overrides.json does not exist', () => {
    expect(migrateConfigOverridesToSystemConfig()).toBe(0)
    expect(listSystemConfig()).toHaveLength(0)
  })

  it('copies every JSON key into system_config with source=migrated_from_json', () => {
    mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(OVERRIDES_PATH, JSON.stringify({ OLLAMA_URL: 'http://box:11434', KANBAN_WIP_WARN_PCT: 90 }))

    const migrated = migrateConfigOverridesToSystemConfig()

    expect(migrated).toBe(2)
    expect(getSystemConfig('OLLAMA_URL')?.value).toBe('http://box:11434')
    expect(getSystemConfig('OLLAMA_URL')?.source).toBe('migrated_from_json')
    // Numeric JSON values are stringified -- system_config.value is TEXT.
    expect(getSystemConfig('KANBAN_WIP_WARN_PCT')?.value).toBe('90')
  })

  it('is idempotent: a second run does not duplicate or overwrite an existing row', () => {
    mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(OVERRIDES_PATH, JSON.stringify({ OLLAMA_URL: 'http://box:11434' }))
    migrateConfigOverridesToSystemConfig()

    // Simulate an operator having since edited the value directly in the DB.
    setSystemConfig('OLLAMA_URL', 'http://operator-set:11434', 'db')

    const secondRunCount = migrateConfigOverridesToSystemConfig()

    expect(secondRunCount).toBe(0)
    const row = getSystemConfig('OLLAMA_URL')!
    expect(row.value).toBe('http://operator-set:11434')
    expect(row.source).toBe('db')
    expect(listSystemConfig().filter(r => r.key === 'OLLAMA_URL')).toHaveLength(1)
  })

  it('skips malformed JSON without throwing', () => {
    mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(OVERRIDES_PATH, '{not valid json')
    expect(migrateConfigOverridesToSystemConfig()).toBe(0)
    expect(listSystemConfig()).toHaveLength(0)
  })

  it('skips a JSON file that is not a plain object', () => {
    mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(OVERRIDES_PATH, JSON.stringify(['a', 'b']))
    expect(migrateConfigOverridesToSystemConfig()).toBe(0)
  })
})

// retireConfigOverridesFile() itself is covered in a separate, fully-mocked
// file (retire-config-overrides.test.ts): it performs a real rename against
// STORE_DIR, and this file's STORE_DIR is the real, shared worktree store/
// directory that several OTHER test files also read/write the exact same
// config-overrides.json path from concurrently-running worker processes. A
// mocked node:fs eliminates that cross-file race entirely.
