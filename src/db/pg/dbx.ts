// The PostgreSQL implementation of the db facade (`Dbx`, see ../facade.ts): `createPgDbx(pool)`.
//
// Nothing in the production start-up imports this yet (the dashboard stays on SQLite until the backend switch), it is
// reachable through the tests and `createPgDbx` only. The differences to the SQLite facade, each with a cell:
//
//  - CONNECTIONS. The pool is the concurrency: there is no global transaction lock, two transactions run side by side
//    on two connections (READ COMMITTED), and a conflicting UPDATE waits for the row. `mode: 'immediate'` means
//    nothing here and is ignored.
//  - EVERY statement is in a transaction, because the tenant context is set with `set_config(name, value, true)`
//    (= SET LOCAL), which lives exactly as long as the transaction and cannot be left behind on a pooled connection.
//    A statement outside `dbx.tx` is therefore BEGIN / set context / statement / COMMIT: four round trips on one
//    connection, a transaction body pays the BEGIN, the context and the COMMIT once. A hot path that runs several
//    statements opens `dbx.tx` once.
//  - THE CONTEXT. The four settings app.tenant_id, app.role, app.agent_id, app.job are set in ONE statement
//    (one round trip) from `currentDbContext()` at the moment the transaction opens, once, at its start (a body that
//    enters another `runAs` keeps the context the transaction started with). No context is the empty string for all four,
//    never a default tenant: a policy that compares with them finds nothing (fail closed). Never put set_config in the
//    same statement as the work (a CTE): PostgreSQL does not promise the order in which a policy and the CTE are evaluated.
//  - RELEASE. A connection goes back to the pool only after COMMIT or ROLLBACK. When the ROLLBACK itself fails the
//    connection is destroyed, not returned. A connection returned inside an open transaction would hand the next
//    borrower the previous tenant.
//  - NESTING. `tx.tx(...)` is a SAVEPOINT: a failing inner body (a unique violation) is undone alone and the outer
//    transaction goes on. Without it the next statement would fail with 25P02 (aborted transaction).
//  - STRICT. Inside a transaction body the handle must be used. The OUTER `dbx.*` (it would run on another connection,
//    outside the transaction, and not see its rows) throws `dbx: use the tx handle inside a transaction body`, unless
//    the transaction was opened with `{ ambient: true }`: then the outer calls are allowed and run OUTSIDE the
//    transaction on connections of their own (with a pool of one connection that waits for itself: size the pool).
//  - ROWS. int8 comes back as a checked number (types.ts). `run().changes` is the driver's rowCount; an
//    `ON CONFLICT DO NOTHING` that skipped the row is 0. `lastInsertRowid` is always 0: use `RETURNING id`.
//  - A body that swallowed a failing statement and returned normally has an aborted transaction, and COMMIT then
//    rolls back WITHOUT an error. The adapter looks at the command tag and fails the transaction instead of reporting
//    a success that did not happen.
//
// Not covered here: a statement that PostgreSQL refuses inside a transaction (VACUUM, CREATE INDEX CONCURRENTLY,
// CREATE DATABASE) cannot go through this facade.

import { AsyncLocalStorage } from 'node:async_hooks'
import type pg from 'pg'
import { logger } from '../../logger.js'
import { currentDbContext, noteDbCall, type DbContext } from '../context.js'
import type { RunResult, SqlOps, Tx, TxOptions } from '../facade.js'
import { AsyncLock, txWarnMs } from '../tx-lock.js'
import { translatePlaceholders } from './translate.js'
import { pgTypes } from './types.js'

/** The settings a statement's policy can read with `current_setting('app.tenant_id', true)` and its siblings. */
export const PG_CONTEXT_SETTINGS = ['app.tenant_id', 'app.role', 'app.agent_id', 'app.job'] as const

/** One statement, one round trip, four settings, transaction-local (the `true`). */
export const PG_SET_CONTEXT_SQL =
  "SELECT set_config('app.tenant_id', $1, true), set_config('app.role', $2, true), set_config('app.agent_id', $3, true), set_config('app.job', $4, true)"

/** The values of the four settings for a context; no context is four empty strings (never a default tenant). */
export function pgContextValues(ctx: DbContext | undefined): [string, string, string, string] {
  if (!ctx) return ['', '', '', '']
  return [ctx.tenantId ?? '', ctx.role, ctx.agentId ?? '', ctx.role === 'system' ? (ctx.name ?? '') : '']
}

export interface PgTxOptions extends TxOptions {
  /**
   * The body may call the outer `dbx.*` (the fleet import does, about 26 calls). Those calls run on connections of their own,
   * outside this transaction. Without it the outer call throws, because it would be a silent second connection.
   */
  ambient?: boolean
}

export interface PgDbx extends SqlOps {
  tx<T>(fn: (tx: Tx) => Promise<T>, opts?: PgTxOptions): Promise<T>
}

/** What the adapter needs of a connection and of a pool (a pg.Pool fits; the control-flow tests use a fake). */
export interface PgClientLike {
  query(config: pg.QueryConfig): Promise<pg.QueryResult>
  release(destroy?: boolean | Error): void
  on?(event: 'error', listener: (err: Error) => void): unknown
  removeListener?(event: 'error', listener: (err: Error) => void): unknown
}
export interface PgPoolLike {
  connect(): Promise<PgClientLike>
  on?(event: 'error', listener: (err: Error) => void): unknown
}

export interface PgDbxOptions {
  /** Log a transaction open longer than this many ms (default DB_TX_WARN_MS, 2000; 0 = off). */
  txWarnMs?: number
}

export const STRICT_OUTSIDE_CALL_MESSAGE = 'dbx: use the tx handle inside a transaction body'
const FINISHED_MESSAGE = 'dbx: the transaction has already finished'

// One open transaction (or savepoint) body. `owner` ties it to the Dbx that opened it, so a call on ANOTHER
// pool's Dbx inside a body is not mistaken for an outer call.
interface PgScope {
  readonly owner: object
  readonly client: PgClientLike
  active: boolean
  readonly ambient: boolean
  /** Savepoints opened side by side under one scope run one after the other. */
  readonly children: AsyncLock
  /** Savepoint counter shared by the whole tree, so names never collide. */
  readonly counter: { n: number }
}

const scopes = new AsyncLocalStorage<PgScope>()

// A statement text with its parameters, translated. The row types go with every query, so the result does not depend
// on how the caller configured the pool.
function prepare(sql: string, params: unknown[]): pg.QueryConfig {
  const t = translatePlaceholders(sql, params)
  return { text: t.text, values: t.values, types: pgTypes }
}

// What each operation makes of the driver's answer.
const asRow = <T>(res: pg.QueryResult): T | undefined => res.rows[0] as T | undefined
const asRows = <T>(res: pg.QueryResult): T[] => res.rows as T[]
// The facade's RunResult has this property and the sqlite-dialect baseline counts it (1 -> 2 with this line). On PostgreSQL
// it is a constant 0 that nothing reads: the generated key comes back with RETURNING.
const asRunResult = (res: pg.QueryResult): RunResult => ({ changes: res.rowCount ?? 0, lastInsertRowid: 0 })
const asNothing = (): void => undefined
const execQuery = (sql: string) => (): pg.QueryConfig => ({ text: sql, types: pgTypes })

// `build` runs inside the async function, so a mistake in the parameters is a rejection, never a throw at the call site.
async function queryOn<T>(client: PgClientLike, build: () => pg.QueryConfig, shape: (res: pg.QueryResult) => T): Promise<T> {
  return shape(await client.query(build()))
}

/** ROLLBACK that cannot throw: true when it worked, false when the connection is not to be given back. */
async function rollbackQuietly(client: PgClientLike): Promise<boolean> {
  try {
    await client.query({ text: 'ROLLBACK' })
    return true
  } catch (err) {
    logger.warn({ err }, 'db: ROLLBACK failed, the connection is discarded')
    return false
  }
}

// The pool listens for errors of IDLE clients only; a client that is checked out has no listener, and a connection
// that drops while no query is running (the server killed it, idle_in_transaction_session_timeout) would be an unhandled
// 'error' event that ends the process. The listener lives as long as the checkout; an error marks the connection as unusable.
function guardClient(client: PgClientLike): { failed: () => boolean; stop: () => void } {
  let failed = false
  const onError = (err: Error): void => {
    failed = true
    logger.warn({ err }, 'db: error on a PostgreSQL connection in use, the connection is discarded')
  }
  client.on?.('error', onError)
  return { failed: () => failed, stop: () => { client.removeListener?.('error', onError) } }
}

function frameOf(stack: string | undefined): string {
  return ((stack ?? '').split('\n')[1] ?? 'unknown').trim()
}

export function createPgDbx(pool: PgPoolLike, opts: PgDbxOptions = {}): PgDbx {
  const self = {}
  // an idle client that errors (the server restarted) is an event on the pool; without a listener it would end the process
  pool.on?.('error', (err: Error) => { logger.error({ err }, 'db: error on an idle PostgreSQL client') })

  const insideTx = (): PgScope | undefined => {
    const s = scopes.getStore()
    return s && s.owner === self && s.active ? s : undefined
  }

  /** BEGIN, the context, the statement, COMMIT on a connection of its own; the connection is given back only after the transaction ended. */
  async function lone<T>(build: () => pg.QueryConfig, shape: (res: pg.QueryResult) => T): Promise<T> {
    const client = await pool.connect()
    const guard = guardClient(client)
    let discard = false
    try {
      await client.query({ text: 'BEGIN' })
      await client.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues(currentDbContext()) })
      const result = await queryOn(client, build, shape)
      await commit(client)
      return result
    } catch (err) {
      discard = !(await rollbackQuietly(client))
      throw err
    } finally {
      guard.stop()
      client.release(discard || guard.failed())
    }
  }

  // A statement on the outer Dbx. Checked before a connection is taken: the strict rule, and the translation of the text.
  const outer = <T>(build: () => pg.QueryConfig, shape: (res: pg.QueryResult) => T): Promise<T> => {
    noteDbCall()
    const s = insideTx()
    if (s && !s.ambient) return Promise.reject(new Error(STRICT_OUTSIDE_CALL_MESSAGE))
    let ready: pg.QueryConfig
    try {
      ready = build()
    } catch (err) {
      return Promise.reject(err)
    }
    return lone(() => ready, shape)
  }

  function newScope(client: PgClientLike, ambient: boolean, counter: { n: number } = { n: 0 }): PgScope {
    return { owner: self, client, active: true, ambient, children: new AsyncLock(), counter }
  }

  // The handle a body receives. It refuses to work once its transaction has ended.
  function makeTx(scope: PgScope): Tx {
    const live = <T>(op: () => Promise<T>): Promise<T> => {
      noteDbCall()
      return scope.active ? op() : Promise.reject(new Error(FINISHED_MESSAGE))
    }
    return {
      get: <T = unknown>(sql: string, ...params: unknown[]) => live(() => queryOn(scope.client, () => prepare(sql, params), asRow<T>)),
      all: <T = unknown>(sql: string, ...params: unknown[]) => live(() => queryOn(scope.client, () => prepare(sql, params), asRows<T>)),
      run: (sql: string, ...params: unknown[]) => live(() => queryOn(scope.client, () => prepare(sql, params), asRunResult)),
      exec: (sql: string) => live(() => queryOn(scope.client, execQuery(sql), asNothing)),
      tx: <T>(fn: (tx: Tx) => Promise<T>) => live(() => runNested(scope, fn)),
    }
  }

  // A transaction inside a transaction is a SAVEPOINT: an error in the inner body undoes only the inner part.
  async function runNested<T>(parent: PgScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const release = await parent.children.acquire()
    try {
      if (!parent.active) throw new Error(FINISHED_MESSAGE)
      const name = `dbx_sp_${++parent.counter.n}`
      await parent.client.query({ text: `SAVEPOINT ${name}` })
      const scope = newScope(parent.client, parent.ambient, parent.counter)
      let result: T
      try {
        result = await scopes.run(scope, () => fn(makeTx(scope)))
      } catch (err) {
        scope.active = false
        try {
          await parent.client.query({ text: `ROLLBACK TO SAVEPOINT ${name}` })
          await parent.client.query({ text: `RELEASE SAVEPOINT ${name}` })
        } catch (rbErr) {
          logger.warn({ err: rbErr }, 'db: ROLLBACK TO SAVEPOINT failed')
        }
        throw err
      }
      scope.active = false
      await parent.client.query({ text: `RELEASE SAVEPOINT ${name}` })
      return result
    } finally {
      release()
    }
  }

  async function runTx<T>(fn: (tx: Tx) => Promise<T>, txOpts: PgTxOptions, entry: (...args: never[]) => unknown): Promise<T> {
    noteDbCall()
    const s = insideTx()
    if (s && !s.ambient) throw new Error(STRICT_OUTSIDE_CALL_MESSAGE)

    const warnMs = opts.txWarnMs ?? txWarnMs()
    let origin: (() => string) | undefined
    if (warnMs > 0) {
      const holder: { stack?: string } = {}
      Error.captureStackTrace(holder, entry) // the frames above the entry are dropped: the first one left is the caller
      origin = () => frameOf(holder.stack)
    }

    const client = await pool.connect()
    const guard = guardClient(client)
    let discard = false
    let warn: NodeJS.Timeout | undefined
    let scope: PgScope | undefined
    try {
      if (origin) {
        const where = origin
        warn = setTimeout(() => {
          logger.warn({ origin: where(), warnMs }, 'db: a transaction has been open longer than DB_TX_WARN_MS (keep only db calls in a transaction body)')
        }, warnMs)
        warn.unref?.()
      }
      await client.query({ text: 'BEGIN' })
      await client.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues(currentDbContext()) })
      const mine = newScope(client, txOpts.ambient === true)
      scope = mine
      const result = await scopes.run(mine, () => fn(makeTx(mine)))
      mine.active = false
      await commit(client)
      return result
    } catch (err) {
      if (scope) scope.active = false
      discard = !(await rollbackQuietly(client))
      throw err
    } finally {
      if (warn) clearTimeout(warn)
      guard.stop()
      client.release(discard || guard.failed())
    }
  }

  function txEntry<T>(fn: (tx: Tx) => Promise<T>, txOpts: PgTxOptions = {}): Promise<T> {
    return runTx(fn, txOpts, txEntry)
  }

  return {
    get: <T = unknown>(sql: string, ...params: unknown[]) => outer(() => prepare(sql, params), asRow<T>),
    all: <T = unknown>(sql: string, ...params: unknown[]) => outer(() => prepare(sql, params), asRows<T>),
    run: (sql: string, ...params: unknown[]) => outer(() => prepare(sql, params), asRunResult),
    exec: (sql: string) => outer(execQuery(sql), asNothing),
    tx: txEntry,
  }
}

// COMMIT of a transaction that a swallowed error left aborted does not fail: the server answers with the command tag
// ROLLBACK. Reporting that as a success would lose the writes without a trace.
async function commit(client: PgClientLike): Promise<void> {
  const res = await client.query({ text: 'COMMIT' })
  if (res.command === 'ROLLBACK') {
    throw new Error('dbx: the transaction was aborted by an earlier failed statement and nothing was committed')
  }
}
