// Parks the FIRST transaction that reaches a given statement, so a test can start a second transaction while the first one
// is open and has already read its rows. Built on helpers/interleave.ts (no sleep, no Promise.all race).
//
//   const il = interleave()
//   il.hold('first')
//   const spy = parkFirstTxAt(il, 'first', /^UPDATE workspace_docs SET /)
//   const first = patchWorkspaceDoc(id, { title: 'T' })
//   await il.reached('first')                 // the first body stopped right before that statement
//   const second = patchWorkspaceDoc(id, { content: 'C' })
//   await untilSettledOrBlocked(second)       // PG: the second is blocked on the row lock (or has finished = no lock)
//   il.open('first')
//
// PostgreSQL: each dbx.tx has its own connection, so the second transaction really runs while the first is parked and,
// when the first one's first read took the row lock, blocks on it. SQLite: the second dbx.tx queues in the connection lock
// until the first one commits, so there is nothing to wait for there and the order is the same.

import { vi } from 'vitest'
import { dbx } from '../../db.js'
import { testDbMode } from './with-test-db.js'
import type { Interleave } from './interleave.js'

type TxFn = (tx: unknown) => Promise<unknown>

/**
 * Wraps `dbx.tx`: the first transaction body that issues a statement matching `pattern` stops at `il.pass(name)` BEFORE
 * that statement is sent. Later transactions are not parked. Call `.mockRestore()` in a finally.
 */
export function parkFirstTxAt(il: Interleave, name: string, pattern: RegExp): { mockRestore(): void } {
  const real = dbx.tx.bind(dbx) as (fn: TxFn, opts?: unknown) => Promise<unknown>
  let parked = false
  return vi.spyOn(dbx, 'tx').mockImplementation(((fn: TxFn, opts?: unknown) =>
    real((tx) => {
      const target = tx as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
      const wrapped = new Proxy(target, {
        get(obj, key) {
          if (key === 'get' || key === 'run' || key === 'all') {
            return async (sql: string, ...params: unknown[]) => {
              if (!parked && pattern.test(sql)) {
                parked = true
                await il.pass(name)
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

/**
 * Resolves once `second` has finished or is blocked on a row lock (PostgreSQL), so the parked first transaction can go on at
 * a known point. A condition of the database, not a sleep: it polls pg_stat_activity for a lock waiter and stops as soon as
 * `second` settles. It says which: 'blocked' (the second is waiting on the lock of the first: the wanted state), 'settled'
 * (the second ran to its end while the first was open: no lock), or, on SQLite, 'queued' (the second waits in the
 * connection lock; nothing to poll).
 */
export async function untilSettledOrBlocked(second: Promise<unknown>): Promise<'settled' | 'blocked' | 'queued'> {
  if (testDbMode() !== 'pg') return 'queued'
  let settled = false
  void second.then(() => { settled = true }, () => { settled = true })
  const deadline = Date.now() + 10_000
  for (;;) {
    if (settled) return 'settled'
    const row = await dbx.get<{ c: number | string }>(
      "SELECT COUNT(*) AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    )
    if (Number(row?.c ?? 0) >= 1) return 'blocked'
    if (Date.now() > deadline) throw new Error('neither transaction settled nor blocked on a lock within 10 s')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
