// The connection-level async lock and the transaction scope of the db facade (`dbx`).
//
// Why it exists: better-sqlite3 is synchronous, so today a `db.transaction(() => ...)` body cannot be
// interleaved with another caller. A facade transaction body is async (`await` between statements), and the
// one SQLite connection would then run another caller's statement INSIDE the open transaction: a dirty read
// before the commit, a write that the rollback takes away, and a second `BEGIN` that fails. One FIFO lock per
// connection closes that:
//   - `dbx.tx()` takes the lock when it opens and gives it back at COMMIT / ROLLBACK,
//   - every statement outside a transaction waits while one is open (and keeps its place in the queue),
//   - a statement INSIDE the transaction body does not wait: an AsyncLocalStorage (this one, not the tenant
//     context in context.ts) marks the body and everything it awaits.
//
// What it does NOT cover:
//   - another connection: `db-migrations.ts` and `config.ts` open their own short-lived connection and never
//     go through this lock,
//   - another process: the channel coordinator is a separate process and talks to the file through SQLite's
//     own locking (busy timeout), not through this lock.
//
// The lock is keyed by the connection handle (a WeakMap), so `initDatabase()` called again, tests included,
// starts with a fresh, free lock for the fresh handle.

import { AsyncLocalStorage } from 'node:async_hooks'

/** A FIFO mutex. `acquire()` resolves with a release function (idempotent). */
export class AsyncLock {
  private held = false
  private readonly queue: Array<() => void> = []

  /** True while somebody holds the lock (a handed-over lock stays busy). */
  get busy(): boolean {
    return this.held
  }

  acquire(): Promise<() => void> {
    if (!this.held) {
      this.held = true
      return Promise.resolve(this.makeRelease())
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(this.makeRelease()))
    })
  }

  private makeRelease(): () => void {
    let done = false
    return () => {
      if (done) return
      done = true
      const next = this.queue.shift()
      // Hand over without ever marking the lock free: a caller arriving between the release and the next
      // holder's turn must queue behind it, not slip in.
      if (next) next()
      else this.held = false
    }
  }
}

/** One open transaction (or savepoint) body. */
export interface TxScope {
  /** False once the body finished: a late call that still carries the scope is treated as outside any transaction. */
  active: boolean
  /** Serializes the savepoints opened directly under this scope (parallel branches of one body). */
  readonly children: AsyncLock
  /** Savepoint counter shared by the whole tree, so names never collide. */
  readonly counter: { n: number }
  /** The scope this savepoint body was opened under (none for the outermost transaction). */
  readonly parent?: TxScope
}

export const txStore = new AsyncLocalStorage<TxScope>()

/** Thrown when the handle of an enclosing transaction is used inside the body of one of its savepoints (both engines). */
export const PARENT_HANDLE_MESSAGE = 'dbx: use the savepoint handle inside a savepoint body, not the handle of the enclosing transaction'

/**
 * Is `current` (the scope the caller is running in) an OPEN savepoint body somewhere below `scope`? A call on the handle of
 * `scope` made from there is the P31 hazard: its statement would land inside the savepoint (and be undone with it), and a
 * nested `tx` on it would wait for the lock the running savepoint holds, for ever. A call made from `scope`'s own body (a
 * sibling that queues for the lock, a statement of the parent) and a late call after the savepoint ended are not.
 */
export function insideOpenChildOf<S extends { active: boolean; parent?: S }>(scope: S, current: S | undefined): boolean {
  for (let s = current; s && s !== scope; s = s.parent) {
    if (s.parent === scope) return s.active
  }
  return false
}

/** The transaction the caller is running inside, if it is still open. */
export function currentTxScope(): TxScope | undefined {
  const scope = txStore.getStore()
  return scope && scope.active ? scope : undefined
}

export function newTxScope(counter: { n: number } = { n: 0 }, parent?: TxScope): TxScope {
  return { active: true, children: new AsyncLock(), counter, parent }
}

let locks = new WeakMap<object, AsyncLock>()

/** The lock of one connection handle. */
export function lockFor(handle: object): AsyncLock {
  let lock = locks.get(handle)
  if (!lock) {
    lock = new AsyncLock()
    locks.set(handle, lock)
  }
  return lock
}

/** Test hook: forget every lock (a test that left a transaction hanging must not poison the next one). */
export function resetTxLockState(): void {
  locks = new WeakMap<object, AsyncLock>()
  txStore.disable()
}

const DEFAULT_TX_WARN_MS = 2000

/** `DB_TX_WARN_MS` (default 2000): a transaction open longer than this is logged with where it started. 0 turns it off. */
export function txWarnMs(): number {
  const raw = process.env.DB_TX_WARN_MS
  if (raw === undefined || raw === '') return DEFAULT_TX_WARN_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TX_WARN_MS
}

/** The first frame outside the db layer (the facade, the lock, the context carrier and the PostgreSQL adapter) and node internals: the caller. */
export function originOf(stack: string | undefined): string {
  const lines = (stack ?? '').split('\n').slice(1)
  const outside = lines.find((l) => !/db[\\/](facade|tx-lock|context)\.|[\\/]db[\\/]pg[\\/]/.test(l) && !/node:internal/.test(l))
  return (outside ?? lines[0] ?? 'unknown').trim()
}

/** The first stack line outside the facade: where the transaction was opened. */
export function captureOrigin(): string {
  return originOf(new Error().stack)
}

/**
 * Records the call stack now and formats it only when the returned function is called. The frames are captured
 * eagerly (they are gone later); turning them into text, the expensive part, waits for a transaction that is
 * actually slow.
 */
export function captureOriginLater(): () => string {
  const holder: { stack?: string } = {}
  Error.captureStackTrace(holder, captureOriginLater)
  return () => originOf(holder.stack)
}
