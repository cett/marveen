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
//  - the body is synchronous better-sqlite3 wrapped in a Promise. The statement is prepared per call, as the
//    callers do today; a statement cache waits for a measurement.

import { db } from './connection.js'

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

export const dbx: Dbx = {
  ...sqliteOps,
  // The connection-level lock and the transaction scope come with the next step. Until then a transaction
  // is refused rather than run without the lock (two interleaved callers would share one SQLite transaction).
  tx<T>(_fn: (tx: Tx) => Promise<T>, _opts?: TxOptions): Promise<T> {
    return Promise.reject(new Error('dbx.tx is not available yet: the transaction lock is not installed'))
  },
}
