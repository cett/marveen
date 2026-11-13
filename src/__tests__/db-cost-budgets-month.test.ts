// getMonthlyTokenSpend (db/cost-budgets.ts) counts the raw token_usage rows of the CURRENT LOCAL MONTH. The month comes from
// epochLocalMonth, so it must be the same on SQLite and on PostgreSQL (this file runs on both: useTestDb). The edge that
// tells a UTC month from a local one: 2026-10-31T23:30:00Z is already November in Europe/Budapest.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { dbx } from '../db.js'
import { getMonthlyTokenSpend } from '../db/cost-budgets.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const ORIGINAL_TZ = process.env.TZ
beforeAll(() => { process.env.TZ = 'Europe/Budapest' })
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

const utc = (iso: string): number => Date.parse(iso) / 1000

// The total is a NUMBER on both engines (SUM() of bigint is numeric on PostgreSQL, a string in the driver, unless the statement casts).
const spend = (filter: Parameters<typeof getMonthlyTokenSpend>[0], now: number): Promise<number> => getMonthlyTokenSpend(filter, now)

async function usage(ts: number, tokens: number, agent = 'agent-a', tenant = 'default'): Promise<void> {
  await dbx.run(
    `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, tenant_id) VALUES (?, 's', ?, ?, 0, ?)`,
    agent, ts, tokens, tenant,
  )
}

// A rolled-up month row (token_usage_monthly): the month key is the 'YYYY-MM' string the rollup wrote.
async function monthly(month: string, tokens: number, agent = 'agent-a', tenant = 'default'): Promise<void> {
  await dbx.run(
    `INSERT INTO token_usage_monthly (month, agent, model, input_tokens, tenant_id) VALUES (?, ?, 'm', ?, ?)`,
    month, agent, tokens, tenant,
  )
}

beforeEach(async () => {
  await dbx.run('DELETE FROM token_usage')
  await dbx.run('DELETE FROM token_usage_monthly')
  await dbx.run(`INSERT INTO tenants (id, display_name, created_at) VALUES ('t-b', 'B', 0) ON CONFLICT DO NOTHING`)
})

describe('the month of a token_usage row is its LOCAL month', () => {
  const NOW = utc('2026-11-20T10:00:00Z')

  it('counts a row that is October in UTC but November in Budapest, and not one that is October in both', async () => {
    await usage(utc('2026-10-31T23:30:00Z'), 100)   // November 00:30 in Budapest: counted
    await usage(utc('2026-10-31T21:30:00Z'), 7)     // October 22:30 in Budapest: not counted
    await usage(utc('2026-11-15T12:00:00Z'), 10)    // counted
    await usage(utc('2026-12-01T00:30:00Z'), 5)     // December 01:30 in Budapest: not counted
    // all three query shapes (no filter, a tenant, an agent) carry their own copy of the month expression
    expect(await spend({}, NOW)).toBe(110)
    expect(await spend({ tenant: 'default' }, NOW)).toBe(110)
    expect(await spend({ agent: 'agent-a' }, NOW)).toBe(110)
  })

  it('keeps the agent and tenant filters', async () => {
    await usage(utc('2026-11-02T08:00:00Z'), 10, 'agent-a', 'default')
    await usage(utc('2026-11-02T09:00:00Z'), 20, 'agent-b', 'default')
    await usage(utc('2026-11-02T10:00:00Z'), 40, 'agent-a', 't-b')
    expect(await spend({}, NOW)).toBe(70)
    expect(await spend({ agent: 'agent-a' }, NOW)).toBe(50)
    expect(await spend({ tenant: 't-b' }, NOW)).toBe(40)
    expect(await spend({ tenant: 'default' }, NOW)).toBe(30)
  })

  // "now" is itself a local-month decision, made once per query shape and once per source (raw rows, rolled-up months).
  // So the edge is asserted for every shape and BOTH sources: a raw row and a monthly row of each month, so a "now"
  // shifted in any one clause (or in the JS month key the tenant shape uses for the monthly table) changes a total.
  it('"now" at the month edge decides the month the same way in every query shape and both sources', async () => {
    await usage(utc('2026-11-01T10:00:00Z'), 9)                      // raw, November
    await usage(utc('2026-10-31T10:00:00Z'), 3)                      // raw, October
    await monthly('2026-11', 20)                                     // rolled up, November
    await monthly('2026-10', 5)                                      // rolled up, October
    await monthly('2026-11', 400, 'agent-b', 't-b')
    await monthly('2026-10', 70, 'agent-b', 't-b')
    const EDGE_NOV = utc('2026-10-31T23:30:00Z')   // 00:30 on 1 November in Budapest
    const EDGE_OCT = utc('2026-10-31T21:30:00Z')   // 22:30 on 31 October in Budapest
    // November: 9 + 20 (agent-a, default), 400 (agent-b, t-b)
    expect(await spend({}, EDGE_NOV)).toBe(429)
    expect(await spend({ tenant: 'default' }, EDGE_NOV)).toBe(29)
    expect(await spend({ tenant: 't-b' }, EDGE_NOV)).toBe(400)
    expect(await spend({ agent: 'agent-a' }, EDGE_NOV)).toBe(29)
    expect(await spend({ agent: 'agent-b' }, EDGE_NOV)).toBe(400)
    // October: 3 + 5 (agent-a, default), 70 (agent-b, t-b)
    expect(await spend({}, EDGE_OCT)).toBe(78)
    expect(await spend({ tenant: 'default' }, EDGE_OCT)).toBe(8)
    expect(await spend({ tenant: 't-b' }, EDGE_OCT)).toBe(70)
    expect(await spend({ agent: 'agent-a' }, EDGE_OCT)).toBe(8)
    expect(await spend({ agent: 'agent-b' }, EDGE_OCT)).toBe(70)
  })
})

describe('the total is a number, whatever the engine and the query shape', () => {
  const NOW = utc('2026-11-20T10:00:00Z')

  it('typeof number with rows, with no rows, and for the no-filter, tenant and agent shapes', async () => {
    for (const filter of [{}, { tenant: 'default' }, { agent: 'agent-a' }]) {
      const empty = await spend(filter, NOW)
      expect(typeof empty, JSON.stringify(filter) + ' on no rows').toBe('number')
      expect(empty).toBe(0)
    }
    await usage(utc('2026-11-02T08:00:00Z'), 10)
    for (const filter of [{}, { tenant: 'default' }, { agent: 'agent-a' }]) {
      const v = await spend(filter, NOW)
      expect(typeof v, JSON.stringify(filter) + ' with a row').toBe('number')
      expect(v + 1).toBe(11)    // an addition, as the callers do: a string total would concatenate to '101'
    }
  })
})

