import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Per-test STORE_DIR isolation (same pattern as db-system-config.test.ts):
// each test gets its own module instance since STORE_DIR is a module-level
// const in config.ts resolved once, at import time.
let dbMod: typeof import('../db.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'db-cost-budgets-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

function costopsPath(): string {
  return join(storeDir, 'costops-config.json')
}

describe('listCostBudgets / replaceCostBudgets', () => {
  it('returns an empty array when nothing was ever set', () => {
    expect(dbMod.listCostBudgets('default')).toEqual([])
  })

  it('replaceCostBudgets persists a full set, readable via listCostBudgets', () => {
    dbMod.replaceCostBudgets('default', [
      { id: 'a', name: 'A', scope: 'global', amount: 100, currency: 'HUF', warning_threshold: 0.8, hard_threshold: 1.0, block_on_hard: false },
      { id: 'b', name: 'B', scope: 'agent', scope_ref: 'agent-x', amount: 200, currency: 'HUF', warning_threshold: 0.5, hard_threshold: 0.9, block_on_hard: true },
    ])
    const rows = dbMod.listCostBudgets('default')
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.id === 'b')).toMatchObject({ scope: 'agent', scope_ref: 'agent-x', block_on_hard: true })
  })

  it('is a whole-value replace: a budget dropped from the new set disappears, not just left un-upserted', () => {
    dbMod.replaceCostBudgets('default', [
      { id: 'a', amount: 100 },
      { id: 'b', amount: 200 },
    ])
    dbMod.replaceCostBudgets('default', [{ id: 'a', amount: 999 }])
    const rows = dbMod.listCostBudgets('default')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'a', amount: 999 })
  })

  it('scopes reads/writes by tenant_id', () => {
    dbMod.replaceCostBudgets('default', [{ id: 'a', amount: 100 }])
    dbMod.replaceCostBudgets('other-tenant', [{ id: 'a', amount: 500 }])
    expect(dbMod.listCostBudgets('default')[0].amount).toBe(100)
    expect(dbMod.listCostBudgets('other-tenant')[0].amount).toBe(500)
  })
})

describe('migrateCostBudgetsFromFile', () => {
  it('returns 0 and writes nothing when the file does not exist', () => {
    expect(dbMod.migrateCostBudgetsFromFile()).toBe(0)
    expect(dbMod.listCostBudgets('default')).toEqual([])
  })

  it('backfills every budget from an existing file with source tenant=default', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(costopsPath(), JSON.stringify({
      version: 1, currency: 'HUF', fixed_costs: [],
      budgets: [
        { id: 'global-monthly', name: 'Global', scope: 'global', amount: 5_000_000 },
        { id: 'agent-budget', scope: 'agent', scope_ref: 'agent-x', amount: 1000, block_on_hard: true },
      ],
    }))

    const migrated = dbMod.migrateCostBudgetsFromFile()

    expect(migrated).toBe(2)
    const rows = dbMod.listCostBudgets('default')
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.id === 'agent-budget')).toMatchObject({ scope_ref: 'agent-x', block_on_hard: true })
  })

  it('is idempotent: a second run does not overwrite an operator-set row', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(costopsPath(), JSON.stringify({
      version: 1, currency: 'HUF', fixed_costs: [],
      budgets: [{ id: 'global-monthly', amount: 100 }],
    }))
    dbMod.migrateCostBudgetsFromFile()

    dbMod.replaceCostBudgets('default', [{ id: 'global-monthly', amount: 999 }])
    const secondRun = dbMod.migrateCostBudgetsFromFile()

    expect(secondRun).toBe(0)
    expect(dbMod.listCostBudgets('default')[0].amount).toBe(999)
  })

  it('skips a corrupt JSON file without throwing', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(costopsPath(), 'not valid json')
    expect(() => dbMod.migrateCostBudgetsFromFile()).not.toThrow()
    expect(dbMod.migrateCostBudgetsFromFile()).toBe(0)
  })

  it('skips a budgets entry with a missing id or invalid amount, keeps the rest', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(costopsPath(), JSON.stringify({
      version: 1, currency: 'HUF', fixed_costs: [],
      budgets: [
        { amount: 100 },
        { id: 'bad-amount', amount: -5 },
        { id: 'ok', amount: 50 },
      ],
    }))
    expect(dbMod.migrateCostBudgetsFromFile()).toBe(1)
    expect(dbMod.listCostBudgets('default')).toHaveLength(1)
  })

  it('returns 0 when the file has no budgets array (version/currency/fixed_costs only)', () => {
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(costopsPath(), JSON.stringify({ version: 1, currency: 'HUF', fixed_costs: [] }))
    expect(dbMod.migrateCostBudgetsFromFile()).toBe(0)
  })
})
