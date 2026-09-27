import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Per-test STORE_DIR isolation, same rationale as db-system-config.test.ts:
// STORE_DIR is a module-level const resolved once at import time, so each
// test needs its own fresh module instance (vi.resetModules() + re-import)
// rather than just a different directory on disk.
let dbMod: typeof import('../db.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'db-autonomy-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

function configPath(): string {
  return join(storeDir, 'autonomy-config.json')
}

describe('autonomy_categories read/write helpers', () => {
  it('returns undefined for a key that was never set', () => {
    expect(dbMod.getAutonomyCategory('nope')).toBeUndefined()
  })

  it('listAutonomyCategories returns an empty array when the table is empty', () => {
    expect(dbMod.listAutonomyCategories()).toEqual([])
  })

  it('upsertAutonomyCategory inserts a new row', () => {
    dbMod.upsertAutonomyCategory({
      key: 'deploy_retry', label: 'Deploy retry', level: 2, locked: 0, max_level: 3,
      timeout_minutes: null, updated_by: 'db',
    })
    const row = dbMod.getAutonomyCategory('deploy_retry')
    expect(row?.label).toBe('Deploy retry')
    expect(row?.level).toBe(2)
    expect(row?.locked).toBe(0)
    expect(row?.updated_at).toBeGreaterThan(0)
  })

  it('upsertAutonomyCategory upserts: a second call updates the row in place, no duplicate', () => {
    dbMod.upsertAutonomyCategory({ key: 'x', label: 'X', level: 1, locked: 0, max_level: 3, timeout_minutes: null, updated_by: 'db' })
    dbMod.upsertAutonomyCategory({ key: 'x', label: 'X updated', level: 2, locked: 0, max_level: 3, timeout_minutes: 30, updated_by: 'db' })
    expect(dbMod.listAutonomyCategories().filter(r => r.key === 'x')).toHaveLength(1)
    const row = dbMod.getAutonomyCategory('x')!
    expect(row.label).toBe('X updated')
    expect(row.level).toBe(2)
    expect(row.timeout_minutes).toBe(30)
  })

  it('setAutonomyCategoryLevel updates level and updated_by, leaves other fields untouched', () => {
    dbMod.upsertAutonomyCategory({ key: 'y', label: 'Y', level: 1, locked: 0, max_level: 3, timeout_minutes: null, updated_by: 'system' })
    dbMod.setAutonomyCategoryLevel('y', 3, 'dashboard')
    const row = dbMod.getAutonomyCategory('y')!
    expect(row.level).toBe(3)
    expect(row.updated_by).toBe('dashboard')
    expect(row.label).toBe('Y')
  })

  it('listAutonomyCategories returns rows ordered by key', () => {
    dbMod.upsertAutonomyCategory({ key: 'b_key', label: 'B', level: 1, locked: 0, max_level: 3, timeout_minutes: null, updated_by: 'db' })
    dbMod.upsertAutonomyCategory({ key: 'a_key', label: 'A', level: 1, locked: 0, max_level: 3, timeout_minutes: null, updated_by: 'db' })
    expect(dbMod.listAutonomyCategories().map(r => r.key)).toEqual(['a_key', 'b_key'])
  })
})

describe('seedAutonomyCategoriesFromJson', () => {
  it('returns 0 and seeds nothing when autonomy-config.json does not exist', () => {
    expect(dbMod.seedAutonomyCategoriesFromJson()).toBe(0)
    expect(dbMod.listAutonomyCategories()).toHaveLength(0)
  })

  it('copies every JSON category into autonomy_categories with updated_by=migrated_from_json', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(configPath(), JSON.stringify({
      version: 1,
      updated_at: 0,
      categories: [
        { key: 'email_send', label: 'Email küldés', level: 2, locked: false, maxLevel: 2 },
        { key: 'payment', label: 'Vásárlás', level: 1, locked: true, maxLevel: 1 },
      ],
    }))

    const seeded = dbMod.seedAutonomyCategoriesFromJson()

    expect(seeded).toBe(2)
    const email = dbMod.getAutonomyCategory('email_send')!
    expect(email.label).toBe('Email küldés')
    expect(email.level).toBe(2)
    expect(email.locked).toBe(0)
    expect(email.max_level).toBe(2)
    expect(email.updated_by).toBe('migrated_from_json')
    const payment = dbMod.getAutonomyCategory('payment')!
    expect(payment.locked).toBe(1)
  })

  it('carries timeout_minutes through when present in the JSON (decision A)', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(configPath(), JSON.stringify({
      categories: [{ key: 'email_send', label: 'Email', level: 2, locked: false, maxLevel: 2, timeout_minutes: 45 }],
    }))
    dbMod.seedAutonomyCategoriesFromJson()
    expect(dbMod.getAutonomyCategory('email_send')?.timeout_minutes).toBe(45)
  })

  it('is idempotent: does not reseed (or overwrite operator edits) once the table has rows', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(configPath(), JSON.stringify({
      categories: [{ key: 'email_send', label: 'Email', level: 1, locked: false, maxLevel: 2 }],
    }))
    dbMod.seedAutonomyCategoriesFromJson()

    // Simulate an operator having since changed the level via the dashboard.
    dbMod.setAutonomyCategoryLevel('email_send', 2, 'dashboard')

    const secondRunCount = dbMod.seedAutonomyCategoriesFromJson()

    expect(secondRunCount).toBe(0)
    const row = dbMod.getAutonomyCategory('email_send')!
    expect(row.level).toBe(2)
    expect(row.updated_by).toBe('dashboard')
  })

  it('skips malformed JSON without throwing', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(configPath(), '{not valid json')
    expect(dbMod.seedAutonomyCategoriesFromJson()).toBe(0)
    expect(dbMod.listAutonomyCategories()).toHaveLength(0)
  })

  it('skips a JSON file with no categories array', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(configPath(), JSON.stringify({ version: 1 }))
    expect(dbMod.seedAutonomyCategoriesFromJson()).toBe(0)
  })
})
