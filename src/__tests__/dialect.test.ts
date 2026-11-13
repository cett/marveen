import { describe, expect, it } from 'vitest'
import { checkZoneName, eqNoCase, epochLocalDate, epochLocalMonth, localTimeZone, orderBytes, orderNoCase } from '../db/dialect.js'
import { dbxDialect } from '../db/facade.js'

// The shape of every fragment on both dialects, without a server. The differential cells (same inputs on SQLite and on
// PostgreSQL, same output) are in src/__tests__/pg/dialect.pg.test.ts.

describe('the default dialect is SQLite', () => {
  it('builds the SQLite spelling when no backend was switched', () => {
    expect(dbxDialect()).toBe('sqlite')
    expect(epochLocalMonth('ts')).toBe("strftime('%Y-%m', ts, 'unixepoch', 'localtime')")
    expect(eqNoCase('a', '?')).toBe('a = ? COLLATE NOCASE')
  })
})

describe('SQLite spellings', () => {
  it('maps each fragment to the construct it replaces', () => {
    expect(epochLocalDate('ts', 'sqlite')).toBe("date(ts, 'unixepoch', 'localtime')")
    expect(epochLocalMonth('@nowSec', 'sqlite')).toBe("strftime('%Y-%m', @nowSec, 'unixepoch', 'localtime')")
    expect(eqNoCase('username', '?', 'sqlite')).toBe('username = ? COLLATE NOCASE')
    expect(orderNoCase('username', 'sqlite')).toBe('username COLLATE NOCASE')
    expect(orderBytes('username', 'sqlite')).toBe('username')
  })
})

describe('PostgreSQL spellings', () => {
  const fold = (x: string): string => `translate(${x}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`

  it('names the process zone explicitly and never uses the session zone', () => {
    const zone = localTimeZone()
    expect(epochLocalDate('ts', 'pg')).toBe(`to_char(to_timestamp((ts)::double precision) AT TIME ZONE '${zone}', 'YYYY-MM-DD')`)
    expect(epochLocalMonth('ts', 'pg')).toBe(`to_char(to_timestamp((ts)::double precision) AT TIME ZONE '${zone}', 'YYYY-MM')`)
  })

  it('folds ASCII only (translate), never lower(), and orders by bytes', () => {
    expect(eqNoCase('a', 'b', 'pg')).toBe(`${fold('a')} = ${fold('b')}`)
    expect(eqNoCase('a', 'b', 'pg')).not.toMatch(/lower\(/i)
    expect(orderNoCase('c', 'pg')).toBe(`${fold('c')} COLLATE "C"`)
    expect(orderBytes('c', 'pg')).toBe('c COLLATE "C"')
  })
})

describe('the zone name that goes into SQL text', () => {
  it('accepts plain IANA names', () => {
    for (const z of ['UTC', 'Europe/Budapest', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5', 'America/Port-au-Prince']) {
      expect(checkZoneName(z)).toBe(z)
    }
  })

  it('refuses everything that could leave the quotes or is not a name', () => {
    const bad = ["x'; DROP TABLE t; --", "a'b", 'a b', 'a..b/c', '', '/Europe', 'Europe/', 'a//b', 'a"b', 'a;b', 'Europe/Budapest\n', 'x'.repeat(65), 'é/é']
    for (const z of bad) expect(() => checkZoneName(z), JSON.stringify(z)).toThrow(/not a plain IANA zone name/)
    for (const z of [null, undefined, 5, {}]) expect(() => checkZoneName(z)).toThrow(/not a plain IANA zone name/)
  })

  it('the process zone passes the same check', () => {
    expect(() => localTimeZone()).not.toThrow()
  })
})
