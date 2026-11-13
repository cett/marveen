// pruneTokenUsage writes two rollups (daily, monthly), deletes the raw rows and prunes the two aggregator tables. "The
// rollups are written, THEN the raw rows are deleted" only holds when the five statements share one connection, and a
// failure of a later one must take the rollups back instead of leaving them half done. On SQLite a call on the
// facade inside the transaction body lands in the same transaction anyway (one connection), so the behaviour alone
// cannot tell a statement on the transaction handle from one on the facade. On PostgreSQL the facade call would be
// another connection and another transaction. This test therefore watches the facade itself: while a transaction
// scope is open, NOTHING may reach it. Plus the atomicity and the rollup-before-delete order that rest on it.
//
// Privacy: neutral fixtures only (agent-a).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ambientInTx, testDbMode, useTestDb } from './helpers/with-test-db.js'
import { dbx, getDb, pruneTokenUsage } from '../db.js'
import { currentTxScope } from '../db/tx-lock.js'

useTestDb()

const DAY = 86400
// Noon UTC, 60 days ago: outside the 30 day raw window, inside the 365 day daily and 3 year monthly windows, and clear of
// any midnight boundary of the local day the rollup groups by.
const OLD_TS = () => Math.floor(Date.now() / 86400000) * 86400 + 43200 - 60 * DAY

interface FacadeCall { op: string; inTx: boolean; sql: string }
let facadeCalls: FacadeCall[] = []

/** Record every call that reaches the facade (dbx.run / get / all / exec) and whether a transaction scope was open. */
function watchFacade(): void {
  facadeCalls = []
  for (const op of ['run', 'get', 'all', 'exec'] as const) {
    const real = dbx[op] as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, op).mockImplementation(((...a: unknown[]) => {
      facadeCalls.push({ op, inTx: currentTxScope() !== undefined, sql: String(a[0]).slice(0, 70) })
      return real.apply(dbx, a)
    }) as never)
  }
}
const insideTx = () => facadeCalls.filter((c) => c.inTx)

async function count(table: string): Promise<number> {
  return ((await dbx.get(`SELECT COUNT(*) AS n FROM ${table}`)) as { n: number }).n
}
function seedOldRows(): void {
  const insert = getDb().prepare(
    `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES ('agent-a', ?, ?, ?, ?, 0, 0)`,
  )
  insert.run('sess-a', OLD_TS(), 100, 50)
  insert.run('sess-b', OLD_TS() + 3600, 200, 75) // same day, one hour later
}

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { vi.restoreAllMocks() })

describe('the harness', () => {
  it('sees a facade call made while a transaction is open (so zero below is not an empty claim)', async () => {
    watchFacade()
    await ambientInTx(() => dbx.tx(async () => { await dbx.run('SELECT 1') }))
    // the spy reads SQLite's transaction scope, which PostgreSQL does not have: there the refusal above is the observation
    if (testDbMode() !== 'pg') expect(insideTx().map((c) => c.op)).toEqual(['run'])
  })
})

describe('pruneTokenUsage: every statement runs on the transaction handle', () => {
  it('one transaction, no call reaches the facade while it is open, and the prune still aggregates and deletes', async () => {
    seedOldRows()
    watchFacade()
    const txSpy = vi.spyOn(dbx, 'tx')
    const result = await pruneTokenUsage()
    expect(txSpy).toHaveBeenCalledTimes(1)
    expect(insideTx(), JSON.stringify(insideTx())).toHaveLength(0)
    expect(result).toEqual({ rawDeleted: 2, dailyUpserted: 1, monthlyUpserted: 1 })
    expect(await count('token_usage')).toBe(0)
  })

  it('the rollups are written BEFORE the raw rows are deleted: the aggregate carries both rows', async () => {
    seedOldRows()
    await pruneTokenUsage()
    const daily = await dbx.all("SELECT input_tokens, output_tokens, row_count FROM token_usage_daily WHERE agent = 'agent-a'")
    expect(daily).toEqual([{ input_tokens: 300, output_tokens: 125, row_count: 2 }])
    const monthly = await dbx.all("SELECT input_tokens, session_count, row_count FROM token_usage_monthly WHERE agent = 'agent-a'")
    expect(monthly).toEqual([{ input_tokens: 300, session_count: 2, row_count: 2 }])
  })

  it('is idempotent: a second run over the same state changes no total', async () => {
    seedOldRows()
    await pruneTokenUsage()
    const again = await pruneTokenUsage()
    expect(again.rawDeleted).toBe(0)
    expect(await dbx.all("SELECT input_tokens FROM token_usage_daily WHERE agent = 'agent-a'")).toEqual([{ input_tokens: 300 }])
  })
})

describe('pruneTokenUsage: a later failure takes the rollups back', () => {
  it('when the raw delete fails, neither rollup is left behind and the raw rows stay', async () => {
    seedOldRows()
    await dbx.exec(`CREATE TRIGGER no_raw_delete BEFORE DELETE ON token_usage BEGIN SELECT RAISE(ABORT, 'raw delete refused'); END`)
    await expect(pruneTokenUsage()).rejects.toThrow('raw delete refused')
    expect(await count('token_usage')).toBe(2)
    expect(await count('token_usage_daily')).toBe(0)
    expect(await count('token_usage_monthly')).toBe(0)
  })

  it('when an aggregator retention delete fails, the rollups AND the raw delete roll back', async () => {
    seedOldRows()
    // A daily row far past its 365 day window: step 4 deletes it, and the trigger refuses.
    await dbx.run(`INSERT INTO token_usage_daily (day, agent, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, row_count, tenant_id)
       VALUES ('2000-01-01', 'agent-z', '', 1, 1, 0, 0, 0, 1, 'default')`)
    await dbx.exec(`CREATE TRIGGER no_daily_delete BEFORE DELETE ON token_usage_daily BEGIN SELECT RAISE(ABORT, 'daily delete refused'); END`)
    await expect(pruneTokenUsage()).rejects.toThrow('daily delete refused')
    expect(await count('token_usage')).toBe(2)
    expect(await count('token_usage_daily')).toBe(1) // only the seeded old row: no rollup of agent-a survived
    expect(await count('token_usage_monthly')).toBe(0)
  })
})
