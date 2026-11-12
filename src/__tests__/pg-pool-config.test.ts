// The pool settings of the PostgreSQL adapter (src/db/pg/pool.ts): defaults, environment, explicit override, and the
// refusal of values that would switch a limit off by a typo. No server.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logger } from '../logger.js'
import { PG_POOL_DEFAULTS, pgPoolConfig } from '../db/pg/pool.js'
import { pgTypes } from '../db/pg/types.js'

afterEach(() => vi.restoreAllMocks())

const URL = 'postgres://u:p@127.0.0.1:5432/db'

describe('pgPoolConfig', () => {
  it('has the documented defaults, the connection string and the checked int8 parser', () => {
    const c = pgPoolConfig(URL, {}, {})
    expect(c).toMatchObject({
      connectionString: URL,
      max: 10,
      statement_timeout: 30000,
      idle_in_transaction_session_timeout: 60000,
      lock_timeout: 10000,
      connectionTimeoutMillis: 10000,
    })
    expect(c.types).toBe(pgTypes)
    expect(PG_POOL_DEFAULTS).toMatchObject({ max: 10, statementTimeoutMs: 30000, idleInTransactionTimeoutMs: 60000, lockTimeoutMs: 10000, connectionTimeoutMs: 10000 })
  })

  it('takes the environment, and an explicit setting wins over it', () => {
    const env = { DB_PG_POOL_MAX: '3', DB_PG_STATEMENT_TIMEOUT_MS: '1500', DB_PG_IDLE_IN_TX_TIMEOUT_MS: '2500', DB_PG_LOCK_TIMEOUT_MS: '500', DB_PG_CONNECT_TIMEOUT_MS: '700' }
    expect(pgPoolConfig(URL, {}, env)).toMatchObject({ max: 3, statement_timeout: 1500, idle_in_transaction_session_timeout: 2500, lock_timeout: 500, connectionTimeoutMillis: 700 })
    expect(pgPoolConfig(URL, { max: 1, statementTimeoutMs: 99, idleInTransactionTimeoutMs: 98, lockTimeoutMs: 97, connectionTimeoutMs: 96 }, env)).toMatchObject({
      max: 1, statement_timeout: 99, idle_in_transaction_session_timeout: 98, lock_timeout: 97, connectionTimeoutMillis: 96,
    })
  })

  it('0 switches a timeout off (the server meaning), but the pool needs at least one connection', () => {
    expect(pgPoolConfig(URL, { statementTimeoutMs: 0, lockTimeoutMs: 0, idleInTransactionTimeoutMs: 0, connectionTimeoutMs: 0 }, {})).toMatchObject({
      statement_timeout: 0, lock_timeout: 0, idle_in_transaction_session_timeout: 0, connectionTimeoutMillis: 0,
    })
    expect(() => pgPoolConfig(URL, { max: 0 }, {})).toThrow(RangeError)
    expect(pgPoolConfig(URL, {}, { DB_PG_POOL_MAX: '0' }).max).toBe(10) // an environment typo falls back, it does not break the start
  })

  it('an invalid environment value is ignored with a warning and the default stays (a typo never turns a limit off)', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    for (const bad of ['abc', '-5', '1.5', '10s', ' ', '1e3']) {
      const c = pgPoolConfig(URL, {}, { DB_PG_STATEMENT_TIMEOUT_MS: bad })
      expect(c.statement_timeout).toBe(30000)
    }
    expect(warn).toHaveBeenCalled()
    expect(pgPoolConfig(URL, {}, { DB_PG_STATEMENT_TIMEOUT_MS: '' }).statement_timeout).toBe(30000) // empty = unset
  })

  it('an invalid explicit value throws', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => pgPoolConfig(URL, { statementTimeoutMs: bad }, {})).toThrow(RangeError)
    }
  })
})
