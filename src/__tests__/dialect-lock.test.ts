// The row lock and the advisory lock fragments (db/dialect.ts): the text on each dialect. On SQLite both are the empty
// string, so no FOR UPDATE and no pg_advisory text can reach a SQLite statement. What the PostgreSQL text does on a real
// server (a second transaction waits for the first) is pinned in src/__tests__/pg/dialect-lock.pg.test.ts.
import { describe, expect, it } from 'vitest'
import { advisoryLockSql, forUpdate } from '../db/dialect.js'

describe('forUpdate', () => {
  it('is the row lock clause on PostgreSQL and nothing on SQLite', () => {
    expect(forUpdate('pg')).toBe('FOR UPDATE')
    expect(forUpdate('sqlite')).toBe('')
  })
})

describe('advisoryLockSql', () => {
  it('is one lock statement on the key on PostgreSQL and nothing on SQLite', () => {
    expect(advisoryLockSql('lock-key-a', 'pg')).toBe("SELECT pg_advisory_xact_lock(hashtext('lock-key-a'))")
    expect(advisoryLockSql('lock-key-a', 'sqlite')).toBe('')
  })

  it('refuses a key that is not a plain key, on both dialects (the key goes into SQL text)', () => {
    for (const bad of ["a'b", 'Upper', 'a b', '', 'a;drop', 'a\nb']) {
      expect(() => advisoryLockSql(bad, 'pg'), JSON.stringify(bad)).toThrow(/not a plain key/)
      expect(() => advisoryLockSql(bad, 'sqlite'), JSON.stringify(bad)).toThrow(/not a plain key/)
    }
  })
})
