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

// SUM() of bigint columns is numeric in PostgreSQL, which node-pg hands back as a STRING ('110'); SQLite gives a number.
// The value is what this file is about, so it is compared as a number (the type difference is a finding of its own).
const spend = async (filter: Parameters<typeof getMonthlyTokenSpend>[0], now: number): Promise<number> =>
  Number(await getMonthlyTokenSpend(filter, now))

async function usage(ts: number, tokens: number, agent = 'agent-a', tenant = 'default'): Promise<void> {
  await dbx.run(
    `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, tenant_id) VALUES (?, 's', ?, ?, 0, ?)`,
    agent, ts, tokens, tenant,
  )
}

beforeEach(async () => {
  await dbx.run('DELETE FROM token_usage')
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

  it('"now" at the month edge decides the month the same way: 2026-10-31T23:30Z is November', async () => {
    await usage(utc('2026-11-01T10:00:00Z'), 9)
    await usage(utc('2026-10-31T10:00:00Z'), 3)
    expect(await spend({}, utc('2026-10-31T23:30:00Z'))).toBe(9)
    expect(await spend({}, utc('2026-10-31T21:30:00Z'))).toBe(3)
  })
})
