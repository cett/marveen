// The keyed advisory lock (db/dialect.ts advisoryLockKeyed): on PostgreSQL the statement text is constant and the key is a bound
// parameter (prefix plus id); on SQLite there is no statement. A prefix that is not on the list is refused on both dialects.
// What the server does with the key (the same key waits, another key does not) is pinned in src/__tests__/pg/dialect-keyed-lock.pg.test.ts.
import { describe, expect, it } from 'vitest'
import { advisoryKeyOf, advisoryLockKeyed } from '../db/dialect.js'

describe('advisoryKeyOf', () => {
  it('gives different ids to different compositions, whatever the separator inside a value', () => {
    expect(advisoryKeyOf('a:b', 'c')).not.toBe(advisoryKeyOf('a', 'b:c'))
    expect(advisoryKeyOf('a', 'b')).not.toBe(advisoryKeyOf('a', 'b', ''))
    expect(advisoryKeyOf('a', 'b')).toBe(advisoryKeyOf('a', 'b'))
  })
})

describe('advisoryLockKeyed', () => {
  it('is one constant statement with the prefix plus the id bound, on PostgreSQL, and nothing on SQLite', () => {
    expect(advisoryLockKeyed('bgtask:', 'agent-a', 'pg')).toEqual({ sql: 'SELECT pg_advisory_xact_lock(hashtext(?))', params: ['bgtask:agent-a'] })
    expect(advisoryLockKeyed('bgtask:', 'agent-a', 'sqlite')).toBeNull()
  })

  it('never puts the id into the statement text, whatever the id holds', () => {
    for (const id of ["x') OR 1 = 1 --", 'agent-a', '']) {
      expect(advisoryLockKeyed('approval:', id, 'pg')?.sql).toBe('SELECT pg_advisory_xact_lock(hashtext(?))')
    }
  })

  it('refuses a prefix that is not on the list, on both dialects', () => {
    for (const bad of ['unknown:', 'bgtask', '']) {
      expect(() => advisoryLockKeyed(bad as never, 'agent-a', 'pg'), JSON.stringify(bad)).toThrow(/not a known prefix/)
      expect(() => advisoryLockKeyed(bad as never, 'agent-a', 'sqlite'), JSON.stringify(bad)).toThrow(/not a known prefix/)
    }
  })
})
