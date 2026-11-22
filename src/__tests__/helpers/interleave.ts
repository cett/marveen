// Deterministic interleaving of two transactions: no sleep, no Promise.all race. A transaction body calls
// `await il.pass('name')` at the point where another transaction has to run. The test holds that point before it
// starts the body (`hold`), waits until the body has stopped there (`reached`), starts the other transaction, waits
// until that one is blocked (`waitBlockedOnLock`), and then lets the body go on (`open`).
//
// PostgreSQL: each `dbx.tx` has its own connection, so the second transaction really blocks on the first one's row
// lock and `waitBlockedOnLock` sees it in pg_stat_activity. SQLite: one connection, and the second `dbx.tx` waits in the
// connection lock until the first one commits; the order that results is the one the test expects, so there is
// nothing to wait for there.
//
// A point that is never reached is an error after `REACH_TIMEOUT_MS`, not a hang.

import { testDbMode } from './with-test-db.js'

const REACH_TIMEOUT_MS = 10_000
const BLOCK_TIMEOUT_MS = 10_000
const POLL_MS = 5

export interface Interleave {
  /** Inside a transaction body: stops here while the test holds `name`; returns at once when it is not held. */
  pass(name: string): Promise<void>
  /** Test: the next body that reaches `name` stops there until `open(name)`. */
  hold(name: string): void
  /** Test: resolves when a body is stopped at `name`. Rejects after REACH_TIMEOUT_MS. */
  reached(name: string): Promise<void>
  /** Test: lets the body stopped at `name` go on. */
  open(name: string): void
}

interface Point {
  held: boolean
  stopped?: () => void
  release?: () => void
}

export function interleave(): Interleave {
  const points = new Map<string, Point>()
  const point = (name: string): Point => {
    let p = points.get(name)
    if (!p) {
      p = { held: false }
      points.set(name, p)
    }
    return p
  }
  return {
    async pass(name) {
      const p = point(name)
      if (!p.held) return
      await new Promise<void>((resolve) => {
        p.release = resolve
        p.stopped?.()
      })
    },
    hold(name) {
      point(name).held = true
    },
    reached(name) {
      const p = point(name)
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`interleave: no body reached "${name}" within ${REACH_TIMEOUT_MS} ms`)), REACH_TIMEOUT_MS)
        timer.unref?.()
        const stopped = (): void => {
          clearTimeout(timer)
          resolve()
        }
        if (p.release) stopped()
        else p.stopped = stopped
      })
    },
    open(name) {
      const p = point(name)
      p.held = false
      const release = p.release
      p.release = undefined
      p.stopped = undefined
      release?.()
    },
  }
}

/**
 * PostgreSQL: waits until `count` backends of this database wait on a lock (a transaction blocked by another one).
 * SQLite: returns at once, the second transaction is queued in the connection lock (see the header).
 * `dbx` is only used on PostgreSQL, outside any transaction body.
 */
export async function waitBlockedOnLock(
  dbx: { get: <T = unknown>(sql: string, ...params: unknown[]) => Promise<T | undefined> },
  count = 1,
  engine: 'sqlite' | 'pg' = testDbMode(),
): Promise<void> {
  if (engine !== 'pg') return
  const deadline = Date.now() + BLOCK_TIMEOUT_MS
  for (;;) {
    const row = await dbx.get<{ c: number | string }>(
      "SELECT COUNT(*) AS c FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
    )
    if (Number(row?.c ?? 0) >= count) return
    if (Date.now() > deadline) throw new Error(`interleave: no backend waited on a lock within ${BLOCK_TIMEOUT_MS} ms`)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
