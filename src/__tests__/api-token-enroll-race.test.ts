// Enrolling the dashboard token under a race (db/api-tokens.ts enrollDashboardApiToken). During a restart two dashboard
// processes can enrol at once: the old one is still alive while the new one boots. An enrolment is two statements, the
// insert and the sweep of the other active `dashboard` rows. On PostgreSQL they do not serialise on their own, so the
// per-name lock of the rotation paths (key `dashboard`) is taken first: a second enrolment waits for the first one's sweep
// and then revokes the row the first one inserted, so the second token is the one left active. The cell fixes that
// order (the park point is after the first insert and before the first sweep). Without the lock the second enrolment
// runs to its commit while the first is parked, and then the first sweep revokes the second's committed row: the FIRST
// token is the one left active, not both. Both tokens stay active only when both sweeps run before either commit; that
// interleave (a park after each insert) is not in this cell. SQLite keeps the one-row invariant with its write lock, so
// the same cell is green there.
//
// Privacy: neutral fixtures only (hash-first, hash-second).
import { describe, it, expect, vi } from 'vitest'
import { dbx, enrollDashboardApiToken } from '../db.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, type Interleave } from './helpers/interleave.js'

useTestDb()

const NOW = 1_800_000_000

/**
 * Parks the first enrolment at its sweep (the UPDATE that revokes the other dashboard rows): after its insert, with its own
 * row inserted and not yet committed. The point is held by the test (`il.hold('first-enrol')`).
 */
function parkFirstSweep(il: Interleave): { mockRestore(): void } {
  const real = dbx.tx.bind(dbx) as (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>
  let parked = false
  return vi.spyOn(dbx, 'tx').mockImplementation(((fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
    real((tx) => {
      const target = tx as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      const wrapped = new Proxy(target, {
        get(obj, key) {
          if (key === 'get' || key === 'run' || key === 'all') {
            return async (sql: string, ...params: unknown[]) => {
              if (!parked && /^UPDATE api_tokens SET revoked_at = \?\s+WHERE name = 'dashboard'/.test(sql)) {
                parked = true
                await il.pass('first-enrol')
              }
              return Reflect.apply(obj[key], obj, [sql, ...params])
            }
          }
          const value = Reflect.get(obj, key, obj)
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(obj) : value
        },
      })
      return fn(wrapped)
    }, opts)) as never)
}

/** On PostgreSQL: returns when the second enrolment has finished or is waiting on a lock (never a sleep). */
async function untilSecondFinishesOrBlocks(second: Promise<unknown>): Promise<void> {
  if (testDbMode() !== 'pg') return
  let finished = false
  void second.then(() => { finished = true }, () => { finished = true })
  const deadline = Date.now() + 10_000
  for (;;) {
    if (finished) return
    const row = await dbx.get<{ c: number | string }>(
      "SELECT COUNT(*) AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    )
    if (Number(row?.c ?? 0) >= 1) return
    if (Date.now() > deadline) throw new Error('neither enrolment finished nor blocked within 10 s')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const activeDashboardHashes = async (): Promise<string[]> =>
  (await dbx.all<{ token_hash: string }>("SELECT token_hash FROM api_tokens WHERE name = 'dashboard' AND revoked_at IS NULL ORDER BY token_hash"))
    .map((r) => r.token_hash)

describe('dashboard token enrolment under a race: exactly one active dashboard token', () => {
  it('two overlapping enrolments: the second waits for the first one\'s sweep, and only the second token stays active', async () => {
    const il = interleave()
    il.hold('first-enrol')
    const spy = parkFirstSweep(il)
    try {
      const first = enrollDashboardApiToken('hash-first', NOW)
      await il.reached('first-enrol')
      const second = enrollDashboardApiToken('hash-second', NOW + 1)
      await untilSecondFinishesOrBlocks(second)
      il.open('first-enrol')
      expect(await first).toBe(1)
      expect(await second).toBe(1)
    } finally {
      il.open('first-enrol')
      spy.mockRestore()
    }
    expect(await activeDashboardHashes()).toEqual(['hash-second'])
  })
})
