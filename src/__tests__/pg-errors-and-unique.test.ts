// PostgreSQL error codes (src/db/pg/errors.ts) and the unique-violation matcher that now knows both drivers
// (src/web/unique-violation.ts). The PostgreSQL errors here are the shape the pg driver produces, built by hand: no server.
import { describe, expect, it } from 'vitest'
import { isPgRetryable, isPgUniqueViolation, PG_ERROR, pgErrorCode } from '../db/pg/errors.js'
import { isUniqueViolationOn } from '../web/unique-violation.js'

const pgError = (code: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error('pg error'), { code }, extra)
const sqliteError = (message: string, code = 'SQLITE_CONSTRAINT_UNIQUE'): Error => Object.assign(new Error(message), { code })

describe('pgErrorCode', () => {
  it('returns a SQLSTATE and nothing else', () => {
    for (const code of ['23505', '40001', '40P01', '25P02', '55P03', '57014', '22P02', 'P0001', 'XX000', 'F0000', 'HV000', '0A000']) {
      expect(pgErrorCode(pgError(code))).toBe(code)
    }
  })

  it('a Node system error code is not a SQLSTATE (EPIPE has five characters too)', () => {
    for (const code of ['EPIPE', 'ECONNRESET', 'ETIMEDOUT', 'ENOENT', 'SQLITE_BUSY', '2305', '230505', '23505 ', '23-05', '23505'.toLowerCase().replace('3', 'x')]) {
      expect(pgErrorCode(pgError(code))).toBeUndefined()
    }
  })

  it('no error, no code, a code that is not a string', () => {
    for (const v of [undefined, null, 'x', 42, {}, new Error('plain'), { code: 23505 }, { code: null }]) expect(pgErrorCode(v)).toBeUndefined()
  })

  it('names the codes the callers look for', () => {
    expect(PG_ERROR).toMatchObject({ uniqueViolation: '23505', serializationFailure: '40001', deadlockDetected: '40P01', inFailedSqlTransaction: '25P02' })
  })

  it('retryable is the serialization failure and the deadlock only; unique is 23505 only', () => {
    expect(isPgRetryable(pgError('40001'))).toBe(true)
    expect(isPgRetryable(pgError('40P01'))).toBe(true)
    for (const c of ['23505', '25P02', '55P03', '40002']) expect(isPgRetryable(pgError(c))).toBe(false)
    expect(isPgUniqueViolation(pgError('23505'))).toBe(true)
    expect(isPgUniqueViolation(pgError('23503'))).toBe(false)
    expect(isPgUniqueViolation(new Error('23505'))).toBe(false)
  })
})

describe('isUniqueViolationOn', () => {
  it('SQLite (unchanged): the column named in the message', () => {
    expect(isUniqueViolationOn(sqliteError('UNIQUE constraint failed: dashboard_users.username'), 'dashboard_users.username')).toBe(true)
    expect(isUniqueViolationOn(sqliteError('UNIQUE constraint failed: dashboard_users.email'), 'dashboard_users.username')).toBe(false)
    expect(isUniqueViolationOn(sqliteError('UNIQUE constraint failed: dashboard_users.username', 'SQLITE_CONSTRAINT_PRIMARYKEY'), 'dashboard_users.username')).toBe(false)
  })

  it('PostgreSQL: code 23505, the table and the column from the detail', () => {
    const e = pgError('23505', { table: 'dashboard_users', constraint: 'dashboard_users_username_key', detail: 'Key (username)=(agent-a) already exists.' })
    expect(isUniqueViolationOn(e, 'dashboard_users.username')).toBe(true)
    expect(isUniqueViolationOn(e, 'dashboard_users.email')).toBe(false) // another column
    expect(isUniqueViolationOn(e, 'other_table.username')).toBe(false) // another table
    expect(isUniqueViolationOn(e, 'users.username')).toBe(false) // a table whose name only ends the same way
  })

  it('PostgreSQL: a composite key matches the same list the SQLite message gives, and not a part of it', () => {
    const e = pgError('23505', { table: 'memberships', detail: 'Key (tenant_id, user_id)=(t1, u1) already exists.' })
    expect(isUniqueViolationOn(e, 'memberships.tenant_id, memberships.user_id')).toBe(true)
    expect(isUniqueViolationOn(e, 'memberships.tenant_id')).toBe(false)
    expect(isUniqueViolationOn(e, 'memberships.user_id')).toBe(false)
  })

  it('PostgreSQL: the value in the detail does not matter, even when it looks like the end of the column list', () => {
    const e = pgError('23505', { table: 'dashboard_users', detail: 'Key (username)=(a)=(b) already exists.' })
    expect(isUniqueViolationOn(e, 'dashboard_users.username')).toBe(true)
    const multiline = pgError('23505', { table: 'dashboard_users', detail: 'Key (username)=(a\nb) already exists.' })
    expect(isUniqueViolationOn(multiline, 'dashboard_users.username')).toBe(true)
  })

  it('PostgreSQL: another error class, a missing table or detail, a localized or expression detail are not matched', () => {
    const base = { table: 'dashboard_users', detail: 'Key (username)=(agent-a) already exists.' }
    expect(isUniqueViolationOn(pgError('23503', base), 'dashboard_users.username')).toBe(false) // foreign key
    expect(isUniqueViolationOn(pgError('23505', { detail: base.detail }), 'dashboard_users.username')).toBe(false)
    expect(isUniqueViolationOn(pgError('23505', { table: '', detail: base.detail }), 'dashboard_users.username')).toBe(false)
    expect(isUniqueViolationOn(pgError('23505', { table: base.table }), 'dashboard_users.username')).toBe(false)
    expect(isUniqueViolationOn(pgError('23505', { table: base.table, detail: 42 }), 'dashboard_users.username')).toBe(false)
    expect(isUniqueViolationOn(pgError('23505', { table: base.table, detail: 'Schluessel (username)=(x) existiert bereits.' }), 'dashboard_users.username')).toBe(false)
    expect(isUniqueViolationOn(pgError('23505', { table: base.table, detail: 'Key (lower(username))=(x) already exists.' }), 'dashboard_users.username')).toBe(false)
  })

  it('anything that is not an Error is never a match', () => {
    for (const v of [undefined, null, 'UNIQUE constraint failed: a.b', { code: '23505', table: 'a', detail: 'Key (b)=(c) already exists.' }]) {
      expect(isUniqueViolationOn(v, 'a.b')).toBe(false)
    }
  })
})
