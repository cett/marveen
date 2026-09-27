import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Per-test STORE_DIR isolation, same rationale as db-autonomy.test.ts:
// STORE_DIR is a module-level const resolved once at import time, so each
// test needs its own fresh module instance (vi.resetModules() + re-import)
// rather than just a different directory on disk.
let dbMod: typeof import('../db.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'db-model-profile-map-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

describe('model_profile_map read/write helpers', () => {
  it('returns undefined for a profile id that was never set', () => {
    expect(dbMod.getModelProfileMapEntry('nope')).toBeUndefined()
  })

  it('listModelProfileMap starts pre-seeded with the 4 default profiles (migration 0054)', () => {
    expect(dbMod.listModelProfileMap()).toHaveLength(4)
  })

  it('upsertModelProfileMapEntry inserts a new row', () => {
    dbMod.upsertModelProfileMapEntry({
      profile_id: 'build_strong', model_id: 'claude-sonnet-5', updated_by: 'db',
    })
    const row = dbMod.getModelProfileMapEntry('build_strong')
    expect(row?.model_id).toBe('claude-sonnet-5')
    expect(row?.updated_at).toBeGreaterThan(0)
  })

  it('upsertModelProfileMapEntry upserts: a second call updates the row in place, no duplicate', () => {
    dbMod.upsertModelProfileMapEntry({ profile_id: 'routine_lowcost', model_id: 'model-a', updated_by: 'db' })
    dbMod.upsertModelProfileMapEntry({ profile_id: 'routine_lowcost', model_id: 'model-b', updated_by: 'db' })
    expect(dbMod.listModelProfileMap().filter(r => r.profile_id === 'routine_lowcost')).toHaveLength(1)
    expect(dbMod.getModelProfileMapEntry('routine_lowcost')?.model_id).toBe('model-b')
  })

  it('setModelProfileMapEntry updates model_id and updated_by', () => {
    dbMod.setModelProfileMapEntry('analysis_efficient', 'new-model', 'dashboard')
    const row = dbMod.getModelProfileMapEntry('analysis_efficient')!
    expect(row.model_id).toBe('new-model')
    expect(row.updated_by).toBe('dashboard')
  })

  it('listModelProfileMap returns rows ordered by profile_id', () => {
    const keys = dbMod.listModelProfileMap().map(r => r.profile_id)
    expect(keys).toEqual([...keys].sort())
  })
})

// Migration 0054 hardcodes the 4 default profiles directly in SQL (no
// app-side JSON-file seed exists for this table -- unlike autonomy_categories,
// there was never a JSON-seed transitional step to retire).
describe('migration 0054: hardcoded default profile seed', () => {
  it('seeds exactly 4 profiles on a fresh database', () => {
    expect(dbMod.listModelProfileMap()).toHaveLength(4)
  })

  it('seeds the expected profile ids with the expected model ids', () => {
    expect(dbMod.getModelProfileMapEntry('premium_reasoning')?.model_id).toBe('claude-opus-5')
    expect(dbMod.getModelProfileMapEntry('build_strong')?.model_id).toBe('claude-sonnet-5')
    expect(dbMod.getModelProfileMapEntry('analysis_efficient')?.model_id).toBe('deepseek-v4-pro')
    expect(dbMod.getModelProfileMapEntry('routine_lowcost')?.model_id).toBe('deepseek-v4-pro')
    expect(dbMod.getModelProfileMapEntry('build_strong')?.updated_by).toBe('seed_migration')
  })

  it('the seed SQL itself is a no-op for keys that already exist (INSERT OR IGNORE guard)', async () => {
    // applyMigrations() only re-execs a migration file whose version exceeds
    // schema_version's recorded max (see db-migrations.ts) -- it will never
    // naturally re-run 0054 against this same connection. To verify the
    // guard inside 0054's own SQL (not just that the outer bookkeeping skips
    // it), exec the migration file's SQL directly a second time and confirm
    // it does not touch a row whose profile id already exists.
    dbMod.setModelProfileMapEntry('build_strong', 'operator-edited-model', 'dashboard')
    const before = dbMod.listModelProfileMap()

    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join: joinPath } = await import('node:path')
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const sql = readFileSync(joinPath(__dirname, '../migrations/0054_model_profile_map.sql'), 'utf-8')
    const { db } = await import('../db/connection.js')
    db.exec(sql)

    expect(dbMod.listModelProfileMap()).toEqual(before)
    expect(dbMod.getModelProfileMapEntry('build_strong')?.model_id).toBe('operator-edited-model')
    expect(dbMod.getModelProfileMapEntry('build_strong')?.updated_by).toBe('dashboard')
  })
})
