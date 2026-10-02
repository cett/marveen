import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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

describe('autonomy_categories read/write helpers', () => {
  it('returns undefined for a key that was never set', () => {
    expect(dbMod.getAutonomyCategory('nope')).toBeUndefined()
  })

  it('listAutonomyCategories starts pre-seeded with the 15 default categories (migration 0053)', () => {
    expect(dbMod.listAutonomyCategories()).toHaveLength(15)
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

  it('setAutonomyCategoryTimeout sets and clears timeout_minutes, leaves level and label untouched', () => {
    dbMod.upsertAutonomyCategory({ key: 'tm', label: 'TM', level: 2, locked: 0, max_level: 3, timeout_minutes: 60, updated_by: 'system' })
    dbMod.setAutonomyCategoryTimeout('tm', 240, 'dashboard')
    expect(dbMod.getAutonomyCategory('tm')).toMatchObject({ timeout_minutes: 240, level: 2, label: 'TM', updated_by: 'dashboard' })
    dbMod.setAutonomyCategoryTimeout('tm', null, 'dashboard')
    expect(dbMod.getAutonomyCategory('tm')!.timeout_minutes).toBeNull()
  })

  it('listAutonomyCategories returns rows ordered by key', () => {
    dbMod.upsertAutonomyCategory({ key: 'zz_key', label: 'ZZ', level: 1, locked: 0, max_level: 3, timeout_minutes: null, updated_by: 'db' })
    dbMod.upsertAutonomyCategory({ key: 'aa_key', label: 'AA', level: 1, locked: 0, max_level: 3, timeout_minutes: null, updated_by: 'db' })
    const keys = dbMod.listAutonomyCategories().map(r => r.key)
    expect(keys[0]).toBe('aa_key')
    expect(keys[keys.length - 1]).toBe('zz_key')
    expect(keys).toEqual([...keys].sort())
  })
})

// Migration 0053 hardcodes the 15 default categories directly in SQL (the
// app-side JSON-file seed this test file used to cover was retired along
// with store/autonomy-config.json itself). initDatabase() in beforeEach
// already runs the full migration chain against a fresh :memory: DB, so by
// the time each test starts, 0053 has already had its one shot at seeding.
describe('migration 0053: hardcoded default category seed', () => {
  it('seeds exactly 15 categories on a fresh database', () => {
    expect(dbMod.listAutonomyCategories()).toHaveLength(15)
  })

  it('seeds known categories with the expected level/locked/max_level', () => {
    const email = dbMod.getAutonomyCategory('email_send')!
    expect(email.label).toBe('Email küldés / válasz')
    expect(email.level).toBe(2)
    expect(email.locked).toBe(0)
    expect(email.max_level).toBe(2)
    expect(email.updated_by).toBe('seed_migration')

    const payment = dbMod.getAutonomyCategory('payment')!
    expect(payment.level).toBe(1)
    expect(payment.locked).toBe(1)
    expect(payment.max_level).toBe(1)
  })

  it('the seed SQL itself is a no-op for keys that already exist (INSERT OR IGNORE guard)', async () => {
    // applyMigrations() only re-execs a migration file whose version exceeds
    // schema_version's recorded max (see db-migrations.ts) -- it will never
    // naturally re-run 0053 against this same connection. To verify the
    // guard inside 0053's own SQL (not just that the outer bookkeeping skips
    // it), exec the migration file's SQL directly a second time and confirm
    // it does not touch a table whose keys already exist.
    dbMod.setAutonomyCategoryLevel('email_send', 1, 'dashboard')
    const before = dbMod.listAutonomyCategories()

    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join: joinPath } = await import('node:path')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const sql = readFileSync(joinPath(__dirname, '../migrations/0053_autonomy_categories_seed.sql'), 'utf-8')
    const { db } = await import('../db/connection.js')
    db.exec(sql)

    expect(dbMod.listAutonomyCategories()).toEqual(before)
    expect(dbMod.getAutonomyCategory('email_send')?.level).toBe(1)
    expect(dbMod.getAutonomyCategory('email_send')?.updated_by).toBe('dashboard')
  })
})
