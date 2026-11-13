// pruneTokenUsage (db/audit.ts) groups raw token_usage rows into daily and monthly rollups by the LOCAL day / month of the
// row, and prunes the two rollup tables against the LOCAL day / month of "now minus the retention". The day and month come
// from epochLocalDate / epochLocalMonth, so they must be the same on SQLite and on PostgreSQL (this file runs on both:
// useTestDb). The clock is faked (Date only) so the retention cut-offs sit exactly on a local day / month edge, where a UTC
// day or month would give another answer. Retentions are the defaults: 30 days raw, 365 days daily, 1095 days monthly.
//
// Privacy: neutral fixtures only (agent-a, t-b).
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { dbx } from '../db.js'
import { pruneTokenUsage } from '../db/audit.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const ORIGINAL_TZ = process.env.TZ
beforeAll(() => { process.env.TZ = 'Europe/Budapest' })
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

const utc = (iso: string): number => Date.parse(iso) / 1000

beforeEach(async () => {
  await dbx.run('DELETE FROM token_usage')
  await dbx.run('DELETE FROM token_usage_daily')
  await dbx.run('DELETE FROM token_usage_monthly')
  await dbx.run(`INSERT INTO tenants (id, display_name, created_at) VALUES ('t-b', 'B', 0) ON CONFLICT DO NOTHING`)
})
afterEach(() => { vi.useRealTimers() })

/** Pin Date.now() only (timers stay real, the PG driver needs them). */
function clockAt(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(iso))
}

async function raw(iso: string, session: string, tokens: number, tenant = 'default'): Promise<void> {
  await dbx.run(
    `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, tenant_id) VALUES ('agent-a', ?, ?, ?, ?)`,
    session, utc(iso), tokens, tenant,
  )
}

describe('the rollups group by the LOCAL day and month of the row', () => {
  it('splits rows at local midnight (not UTC midnight), keeps tenants apart, counts rows and distinct sessions', async () => {
    clockAt('2026-11-13T12:00:00Z')   // every row below is older than the 30 day raw window, newer than the 365 day daily one
    // Budapest: UTC+1 in winter, UTC+2 in summer
    await raw('2025-12-31T22:30:00Z', 's1', 1)     // 23:30 on 31 December: day 2025-12-31, month 2025-12
    await raw('2025-12-31T23:30:00Z', 's1', 2)     // 00:30 on 1 January:   day 2026-01-01, month 2026-01
    await raw('2026-03-31T21:30:00Z', 's2', 4)     // 23:30 on 31 March (CEST): day 2026-03-31, month 2026-03
    await raw('2026-03-31T21:45:00Z', 's2', 16)    // same day, same session
    await raw('2026-03-31T21:55:00Z', 's9', 64)    // same day, another session
    await raw('2026-03-31T21:50:00Z', 's2', 32, 't-b')   // same day, another tenant: its own group
    await raw('2026-03-31T22:30:00Z', 's3', 8)     // 00:30 on 1 April (CEST): day 2026-04-01, month 2026-04
    await raw('2026-03-30T12:00:00Z', 's2', 128)   // another day of the same month: a month-wide group would swallow it

    const result = await pruneTokenUsage()
    expect(result).toEqual({ rawDeleted: 8, dailyUpserted: 6, monthlyUpserted: 5 })

    const daily = await dbx.all<{ day: string; tenant_id: string; input_tokens: number; row_count: number }>(
      'SELECT day, tenant_id, input_tokens, row_count FROM token_usage_daily ORDER BY day, tenant_id')
    expect(daily).toEqual([
      { day: '2025-12-31', tenant_id: 'default', input_tokens: 1, row_count: 1 },
      { day: '2026-01-01', tenant_id: 'default', input_tokens: 2, row_count: 1 },
      { day: '2026-03-30', tenant_id: 'default', input_tokens: 128, row_count: 1 },
      { day: '2026-03-31', tenant_id: 'default', input_tokens: 84, row_count: 3 },
      { day: '2026-03-31', tenant_id: 't-b', input_tokens: 32, row_count: 1 },
      { day: '2026-04-01', tenant_id: 'default', input_tokens: 8, row_count: 1 },
    ])
    const monthlyRows = await dbx.all<{ month: string; tenant_id: string; input_tokens: number; row_count: number; session_count: number }>(
      'SELECT month, tenant_id, input_tokens, row_count, session_count FROM token_usage_monthly ORDER BY month, tenant_id')
    expect(monthlyRows).toEqual([
      { month: '2025-12', tenant_id: 'default', input_tokens: 1, row_count: 1, session_count: 1 },
      { month: '2026-01', tenant_id: 'default', input_tokens: 2, row_count: 1, session_count: 1 },
      { month: '2026-03', tenant_id: 'default', input_tokens: 212, row_count: 4, session_count: 2 },
      { month: '2026-03', tenant_id: 't-b', input_tokens: 32, row_count: 1, session_count: 1 },
      { month: '2026-04', tenant_id: 'default', input_tokens: 8, row_count: 1, session_count: 1 },
    ])
  })
})

describe('the rollup tables are pruned against the LOCAL day / month of "now minus the retention"', () => {
  async function seedDays(days: string[]): Promise<void> {
    for (const d of days) await dbx.run(`INSERT INTO token_usage_daily (day, agent, model, tenant_id) VALUES (?, 'agent-a', 'm', 'default')`, d)
  }
  async function seedMonths(months: string[]): Promise<void> {
    for (const m of months) await dbx.run(`INSERT INTO token_usage_monthly (month, agent, model, tenant_id) VALUES (?, 'agent-a', 'm', 'default')`, m)
  }
  const days = async (): Promise<string[]> => (await dbx.all<{ day: string }>('SELECT day FROM token_usage_daily ORDER BY day')).map((r) => r.day)
  const months = async (): Promise<string[]> => (await dbx.all<{ month: string }>('SELECT month FROM token_usage_monthly ORDER BY month')).map((r) => r.month)

  it('daily: the cut-off 2025-11-13T23:30Z is 00:30 on 14 November in Budapest, so the 13th goes and the 14th stays', async () => {
    const now = '2026-11-13T23:30:00Z'
    expect(Date.parse(now) / 1000 - 365 * 86400).toBe(utc('2025-11-13T23:30:00Z'))   // guards the date arithmetic of this cell
    clockAt(now)
    await seedDays(['2025-11-12', '2025-11-13', '2025-11-14', '2025-11-15'])
    await pruneTokenUsage()
    expect(await days()).toEqual(['2025-11-14', '2025-11-15'])
  })

  it('daily: the cut-off 2025-11-13T22:30Z is 23:30 on the 13th in Budapest, so the 13th stays (the edge from the other side)', async () => {
    const now = '2026-11-13T22:30:00Z'
    expect(Date.parse(now) / 1000 - 365 * 86400).toBe(utc('2025-11-13T22:30:00Z'))
    clockAt(now)
    await seedDays(['2025-11-12', '2025-11-13', '2025-11-14'])
    await pruneTokenUsage()
    expect(await days()).toEqual(['2025-11-13', '2025-11-14'])
  })

  it('monthly: the cut-off 2023-12-31T22:30Z is 23:30 on 31 December in Budapest, so December stays (the edge from the other side)', async () => {
    const now = '2026-12-30T22:30:00Z'
    expect(Date.parse(now) / 1000 - 1095 * 86400).toBe(utc('2023-12-31T22:30:00Z'))
    clockAt(now)
    await seedMonths(['2023-11', '2023-12', '2024-01'])
    await pruneTokenUsage()
    expect(await months()).toEqual(['2023-12', '2024-01'])
  })

  it('daily: a cut-off that is the same day in UTC and locally still splits at that day', async () => {
    const now = '2026-11-13T12:00:00Z'
    clockAt(now)   // cut-off 2025-11-13T12:00Z: day 2025-11-13 in both
    await seedDays(['2025-11-12', '2025-11-13', '2025-11-14'])
    await pruneTokenUsage()
    expect(await days()).toEqual(['2025-11-13', '2025-11-14'])
  })

  it('monthly: the cut-off 2023-12-31T23:30Z is 00:30 on 1 January 2024 in Budapest, so December goes and January stays', async () => {
    const now = '2026-12-30T23:30:00Z'
    expect(Date.parse(now) / 1000 - 1095 * 86400).toBe(utc('2023-12-31T23:30:00Z'))   // guards the date arithmetic of this cell
    clockAt(now)
    await seedMonths(['2023-11', '2023-12', '2024-01', '2024-02'])
    await pruneTokenUsage()
    expect(await months()).toEqual(['2024-01', '2024-02'])
  })

  it('monthly: a cut-off in the middle of a month splits at that month', async () => {
    const now = '2026-11-13T12:00:00Z'
    clockAt(now)   // cut-off 2023-11-14T12:00Z
    await seedMonths(['2023-10', '2023-11', '2023-12'])
    await pruneTokenUsage()
    expect(await months()).toEqual(['2023-11', '2023-12'])
  })
})
