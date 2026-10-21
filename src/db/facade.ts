// The async db facade (`dbx`) of the PostgreSQL preparation (Phase 1).
//
// Every method returns a Promise, so the callers are written once for the SQLite backend of today and the
// PostgreSQL backend of Phase 2. A module that moves onto the facade uses `dbx`, never the raw `db` handle.
//
// Rules of the surface:
//  - parameters are positional `?` values (any number of arguments) OR one object for `@name` placeholders;
//    both go to better-sqlite3 unchanged,
//  - the raw handle and prepared statement objects never leave this file,
//  - a better-sqlite3 error propagates unchanged (same Error, same `code`) as a rejection,
//  - the backend handle is resolved on EVERY call (`db` is a live binding): `initDatabase()` hands out a new
//    handle on each call, tests included, and a cached reference would keep talking to the closed one,
//  - one FIFO lock per connection (tx-lock.ts): `dbx.tx()` holds it from BEGIN to COMMIT/ROLLBACK, a statement
//    outside a transaction waits while one is open, a statement inside the transaction body does not.
//    A transaction body holds the lock: only db calls in it, no LLM / HTTP / file I/O / sleep,
//  - the body is synchronous better-sqlite3 wrapped in a Promise. The statement is prepared per call, as the
//    callers do today; a statement cache waits for a measurement.

import { db } from './connection.js'
import { logger } from '../logger.js'
import { captureOrigin, currentTxScope, lockFor, newTxScope, txStore, txWarnMs, type TxScope } from './tx-lock.js'

export interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

/** The statement operations a connection and a transaction have in common. */
export interface SqlOps {
  get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined>
  all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]>
  run(sql: string, ...params: unknown[]): Promise<RunResult>
  exec(sql: string): Promise<void>
}

export interface TxOptions {
  /** `deferred` is the default (BEGIN); `immediate` takes the write lock at the start (BEGIN IMMEDIATE). */
  mode?: 'deferred' | 'immediate'
}

/** The handle a transaction body receives: the same operations, and `tx` again for a nested (savepoint) scope. */
export interface Tx extends SqlOps {
  tx<T>(fn: (tx: Tx) => Promise<T>, opts?: TxOptions): Promise<T>
}

export interface Dbx extends SqlOps {
  tx<T>(fn: (tx: Tx) => Promise<T>, opts?: TxOptions): Promise<T>
}

// A synchronous throw (bad SQL, constraint) becomes a rejection, not an exception at the call site.
function settle<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn())
  } catch (err) {
    return Promise.reject(err)
  }
}

/** The SQLite statement operations, resolved against the current handle at call time. */
export const sqliteOps: SqlOps = {
  get<T = unknown>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    return settle(() => db.prepare(sql).get(...params) as T | undefined)
  },
  all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]> {
    return settle(() => db.prepare(sql).all(...params) as T[])
  },
  run(sql: string, ...params: unknown[]): Promise<RunResult> {
    // better-sqlite3 returns a fresh plain object { changes, lastInsertRowid } per call.
    return settle(() => db.prepare(sql).run(...params))
  },
  exec(sql: string): Promise<void> {
    return settle(() => { db.exec(sql) })
  },
}

// ---- Statements outside a transaction ------------------------------------------------------------------

// A statement waits while a transaction is open on the connection and keeps its place in the queue. A body
// running INSIDE a transaction (the transaction scope travels with it) goes straight through. With no
// transaction open the statement runs at once: it is synchronous, so nothing can interleave.
function guarded<T>(op: () => Promise<T>): Promise<T> {
  if (currentTxScope()) return op()
  const lock = lockFor(db)
  if (!lock.busy) return op()
  return lock.acquire().then((release) => op().finally(release))
}

const lockedOps: SqlOps = {
  get: <T = unknown>(sql: string, ...params: unknown[]) => guarded(() => sqliteOps.get<T>(sql, ...params)),
  all: <T = unknown>(sql: string, ...params: unknown[]) => guarded(() => sqliteOps.all<T>(sql, ...params)),
  run: (sql: string, ...params: unknown[]) => guarded(() => sqliteOps.run(sql, ...params)),
  exec: (sql: string) => guarded(() => sqliteOps.exec(sql)),
}

// ---- Transactions ---------------------------------------------------------------------------------------

// The handle a body receives. It refuses to work once its transaction has ended, so a stray reference kept
// past the commit cannot write outside the lock.
function makeTx(scope: TxScope): Tx {
  const live = <T>(op: () => Promise<T>): Promise<T> =>
    scope.active ? op() : Promise.reject(new Error('dbx: the transaction has already finished'))
  return {
    get: <T = unknown>(sql: string, ...params: unknown[]) => live(() => sqliteOps.get<T>(sql, ...params)),
    all: <T = unknown>(sql: string, ...params: unknown[]) => live(() => sqliteOps.all<T>(sql, ...params)),
    run: (sql: string, ...params: unknown[]) => live(() => sqliteOps.run(sql, ...params)),
    exec: (sql: string) => live(() => sqliteOps.exec(sql)),
    tx: <T>(fn: (tx: Tx) => Promise<T>) => live(() => runNested(scope, fn)),
  }
}

// Open a transaction: take the connection lock, BEGIN, run the body with the scope attached, COMMIT, or
// ROLLBACK when the body throws or rejects. The lock is always given back (finally).
async function runTx<T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions): Promise<T> {
  const parent = currentTxScope()
  if (parent) return runNested(parent, fn)

  const handle = db
  const origin = captureOrigin()
  const release = await lockFor(handle).acquire()
  let warn: NodeJS.Timeout | undefined
  try {
    const warnMs = txWarnMs()
    if (warnMs > 0) {
      warn = setTimeout(() => {
        logger.warn({ origin, warnMs }, 'db: a transaction has been open longer than DB_TX_WARN_MS (keep only db calls in a transaction body)')
      }, warnMs)
      warn.unref?.()
    }
    handle.exec(opts.mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN')
    const scope = newTxScope()
    let result: T
    try {
      result = await txStore.run(scope, () => fn(makeTx(scope)))
    } catch (err) {
      scope.active = false
      rollback(handle)
      throw err
    }
    scope.active = false
    try {
      handle.exec('COMMIT')
    } catch (err) {
      rollback(handle)
      throw err
    }
    return result
  } finally {
    if (warn) clearTimeout(warn)
    release()
  }
}

function rollback(handle: typeof db): void {
  try {
    if (handle.inTransaction) handle.exec('ROLLBACK')
  } catch (err) {
    logger.warn({ err }, 'db: ROLLBACK failed')
  }
}

// A transaction inside a transaction is a SAVEPOINT: an error in the inner body undoes only the inner part,
// which is what better-sqlite3's nested `db.transaction` does today. Savepoints opened side by side under one
// scope run one after the other.
async function runNested<T>(parent: TxScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const release = await parent.children.acquire()
  try {
    if (!parent.active) throw new Error('dbx: the transaction has already finished')
    const name = `dbx_sp_${++parent.counter.n}`
    db.exec(`SAVEPOINT ${name}`)
    const scope = newTxScope(parent.counter)
    let result: T
    try {
      result = await txStore.run(scope, () => fn(makeTx(scope)))
    } catch (err) {
      scope.active = false
      try {
        db.exec(`ROLLBACK TO ${name}`)
        db.exec(`RELEASE ${name}`)
      } catch (rbErr) {
        logger.warn({ err: rbErr }, 'db: ROLLBACK TO SAVEPOINT failed')
      }
      throw err
    }
    scope.active = false
    db.exec(`RELEASE ${name}`)
    return result
  } finally {
    release()
  }
}

export const dbx: Dbx = {
  ...lockedOps,
  tx: <T>(fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}) => runTx(fn, opts),
}
