// The pool settings of the PostgreSQL adapter: the limits that keep one stuck statement or one forgotten transaction
// from taking the whole service with it. They are plain connection parameters (the server enforces them), and every one
// has a default, an environment variable and an explicit override, in that order of weight (override first).
//
//   setting                     env                              default   what it stops
//   statement_timeout           DB_PG_STATEMENT_TIMEOUT_MS       30000     one statement running for ever
//   idle_in_transaction_...     DB_PG_IDLE_IN_TX_TIMEOUT_MS      60000     a transaction opened and then forgotten (holds locks, bloats)
//   lock_timeout                DB_PG_LOCK_TIMEOUT_MS            10000     a statement waiting for a row lock for ever
//   connection timeout (pool)   DB_PG_CONNECT_TIMEOUT_MS         10000     waiting for a free connection when all are busy
//   max (pool size)             DB_PG_POOL_MAX                   10
//
// 0 switches a timeout off (the PostgreSQL meaning). A value that is not a whole number of milliseconds is ignored with a
// warning and the default is used, so a typo cannot turn a limit off by accident.
import type pg from 'pg'
import { logger } from '../../logger.js'
import { pgTypes } from './types.js'

export interface PgPoolSettings {
  max?: number
  statementTimeoutMs?: number
  idleInTransactionTimeoutMs?: number
  lockTimeoutMs?: number
  connectionTimeoutMs?: number
}

export const PG_POOL_DEFAULTS = {
  max: 10,
  statementTimeoutMs: 30_000,
  idleInTransactionTimeoutMs: 60_000,
  lockTimeoutMs: 10_000,
  connectionTimeoutMs: 10_000,
} as const

const ENV = {
  max: 'DB_PG_POOL_MAX',
  statementTimeoutMs: 'DB_PG_STATEMENT_TIMEOUT_MS',
  idleInTransactionTimeoutMs: 'DB_PG_IDLE_IN_TX_TIMEOUT_MS',
  lockTimeoutMs: 'DB_PG_LOCK_TIMEOUT_MS',
  connectionTimeoutMs: 'DB_PG_CONNECT_TIMEOUT_MS',
} as const

function wholeNumber(value: unknown, min: number): number | undefined {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) return undefined
    value = Number(value)
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : undefined
}

function resolve(key: keyof PgPoolSettings, override: number | undefined, env: NodeJS.ProcessEnv): number {
  const min = key === 'max' ? 1 : 0
  if (override !== undefined) {
    const n = wholeNumber(override, min)
    if (n === undefined) throw new RangeError(`${key} must be a whole number >= ${min} (got ${override})`)
    return n
  }
  const raw = env[ENV[key]]
  if (raw !== undefined && raw !== '') {
    const n = wholeNumber(raw, min)
    if (n !== undefined) return n
    logger.warn({ env: ENV[key], value: raw, using: PG_POOL_DEFAULTS[key] }, 'db: ignoring an invalid PostgreSQL pool setting')
  }
  return PG_POOL_DEFAULTS[key]
}

/** The `pg.PoolConfig` for a connection string with the limits above; hand it to `new pg.Pool(...)`. */
export function pgPoolConfig(connectionString: string, settings: PgPoolSettings = {}, env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  return {
    connectionString,
    types: pgTypes,
    max: resolve('max', settings.max, env),
    statement_timeout: resolve('statementTimeoutMs', settings.statementTimeoutMs, env),
    idle_in_transaction_session_timeout: resolve('idleInTransactionTimeoutMs', settings.idleInTransactionTimeoutMs, env),
    lock_timeout: resolve('lockTimeoutMs', settings.lockTimeoutMs, env),
    connectionTimeoutMillis: resolve('connectionTimeoutMs', settings.connectionTimeoutMs, env),
  }
}
