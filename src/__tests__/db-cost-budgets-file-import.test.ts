// The one-time import of store/costops-config.json's budgets[] into cost_budgets (db/cost-budgets.ts), on both engines.
// migrateCostBudgetsFromFileAsync is the PostgreSQL counterpart of the boot importer: the same rows, the same defaults,
// INSERT ... ON CONFLICT DO NOTHING, so a second run adds nothing and an edit made in the database is never overwritten
// by a re-read of the file. The file is a throwaway one in a temp directory: the store's own file is never touched.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbx } from '../db.js'
import { migrateCostBudgetsFromFileAsync } from '../db/cost-budgets.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'carl-cost-budgets-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const file = (): string => join(dir, 'costops-config.json')
const writeBudgets = (budgets: unknown[]): void => {
  writeFileSync(file(), JSON.stringify({ version: 1, currency: 'HUF', budgets, fixed_costs: [] }))
}
const rowOf = async (id: string): Promise<Record<string, unknown> | undefined> =>
  dbx.get<Record<string, unknown>>('SELECT * FROM cost_budgets WHERE id = ? AND tenant_id = ?', id, 'default')
const countRows = async (): Promise<number> =>
  Number((await dbx.get<{ c: number }>('SELECT COUNT(*) AS c FROM cost_budgets'))!.c)

beforeEach(async () => {
  await dbx.run('DELETE FROM cost_budgets')
})

describe('migrateCostBudgetsFromFileAsync', () => {
  it('imports every well-formed entry, with the defaults for the fields it lacks', async () => {
    writeBudgets([
      { id: 'b-food', name: 'Food', scope: 'agent', scope_ref: 'agent-a', amount: 100000, currency: 'HUF', warning_threshold: 0.5, hard_threshold: 0.9, block_on_hard: true },
      { id: 'b-min', amount: 5 },
    ])
    expect(await migrateCostBudgetsFromFileAsync(file())).toBe(2)
    expect(await rowOf('b-food')).toMatchObject({
      name: 'Food', scope: 'agent', scope_ref: 'agent-a', amount: 100000, currency: 'HUF', block_on_hard: 1, tenant_id: 'default',
    })
    expect(await rowOf('b-min')).toMatchObject({
      name: 'b-min', scope: 'global', scope_ref: null, amount: 5, currency: 'HUF', block_on_hard: 0,
    })
  })

  it('a second run adds nothing, and a row edited in the database keeps its edit (ON CONFLICT DO NOTHING)', async () => {
    writeBudgets([{ id: 'b-food', amount: 100000 }])
    expect(await migrateCostBudgetsFromFileAsync(file())).toBe(1)
    await dbx.run("UPDATE cost_budgets SET amount = 250000 WHERE id = 'b-food'")
    writeBudgets([{ id: 'b-food', amount: 100000 }, { id: 'b-new', amount: 7 }])
    expect(await migrateCostBudgetsFromFileAsync(file())).toBe(1)
    expect(await countRows()).toBe(2)
    expect((await rowOf('b-food'))!.amount).toBe(250000)
  })

  it('skips an entry without an id or with a bad amount, and keeps the rest', async () => {
    writeBudgets([
      { amount: 5 },
      { id: 'x-negative', amount: -1 },
      { id: 'x-text', amount: '7' },
      { id: 'x-ok', amount: 3 },
    ])
    expect(await migrateCostBudgetsFromFileAsync(file())).toBe(1)
    expect(await countRows()).toBe(1)
    expect(await rowOf('x-ok')).toBeDefined()
  })

  it('adds nothing when there is no file, or the file holds no budgets array', async () => {
    expect(await migrateCostBudgetsFromFileAsync(join(dir, 'no-such-file.json'))).toBe(0)
    writeFileSync(file(), JSON.stringify({ version: 1 }))
    expect(await migrateCostBudgetsFromFileAsync(file())).toBe(0)
    expect(await countRows()).toBe(0)
  })
})
