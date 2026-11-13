// src/db/dialect.ts against both engines: the SAME inputs on SQLite (better-sqlite3, in memory) and on a real PostgreSQL
// server (MARVEEN_PG_TEST_URL, `npm run test:pg`), the same output, plus an oracle that is neither engine (JS Intl for the
// days, a byte comparison for the order). The shape of the fragments without a server: src/__tests__/dialect.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { checkZoneName, epochLocalDate, epochLocalMonth, eqNoCase, localTimeZone, orderBytes, orderNoCase } from '../../db/dialect.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

let pgdb: PgTestDb
let sq: Database.Database
const ORIGINAL_TZ = process.env.TZ

beforeAll(async () => {
  pgdb = await createPgTestDb()
  sq = new Database(':memory:')
  await pgdb.pool.query('CREATE TABLE ord_t (id bigint PRIMARY KEY, name text)')
  sq.exec('CREATE TABLE ord_t (id INTEGER PRIMARY KEY, name TEXT)')
}, 60000)

afterAll(async () => {
  sq?.close()
  await pgdb?.close()
})

afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})

/** Runs `sql` on both engines and returns the rows of each, as plain arrays of column values. */
async function both(sqliteSql: string, pgSql: string): Promise<{ sqlite: unknown[][]; pg: unknown[][] }> {
  const s = sq.prepare(sqliteSql).raw().all() as unknown[][]
  const p = await pgdb.pool.query({ text: pgSql, rowMode: 'array' })
  return { sqlite: s, pg: p.rows as unknown[][] }
}

const sqlText = (v: string | null): string => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`)

/** Local day/month labels of `epochs` on both engines, in the order given. */
async function labels(epochs: (number | null)[], fn: typeof epochLocalDate): Promise<{ sqlite: unknown[]; pg: unknown[] }> {
  const rows = (d: 'sqlite' | 'pg'): string =>
    epochs.map((e, i) => `SELECT ${i} AS i, ${e === null ? 'NULL' : e} AS v`).join(' UNION ALL ')
  const make = (d: 'sqlite' | 'pg'): string => `SELECT ${fn('v', d)} AS label FROM (${rows(d)}) ORDER BY i`
  const r = await both(make('sqlite'), make('pg'))
  return { sqlite: r.sqlite.map((x) => x[0]), pg: r.pg.map((x) => x[0]) }
}

const utc = (iso: string): number => Date.parse(iso) / 1000

/** The independent oracle: what a person in `zone` would read off the wall clock. */
function oracle(zone: string, epoch: number, part: 'day' | 'month'): string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const day = f.format(new Date(epoch * 1000))
  return part === 'day' ? day : day.slice(0, 7)
}

const EDGES: number[] = [
  utc('2026-03-29T00:59:59Z'), utc('2026-03-29T01:00:00Z'),   // Europe: the clocks go forward at 01:00 UTC
  utc('2026-10-25T00:59:59Z'), utc('2026-10-25T01:00:00Z'),   // Europe: the clocks go back at 01:00 UTC (the 02:xx hour happens twice)
  utc('2026-03-28T22:59:59Z'), utc('2026-03-28T23:00:00Z'),   // Budapest midnight
  utc('2026-03-08T06:59:59Z'), utc('2026-03-08T07:00:00Z'),   // New York: forward
  utc('2026-11-01T05:59:59Z'), utc('2026-11-01T06:00:00Z'),   // New York: back
  utc('2026-10-31T23:30:00Z'),                                // the month edge: October in UTC, November in Budapest
  utc('2026-12-31T23:30:00Z'),                                // the year edge
  utc('2026-06-30T22:30:00Z'),                                // summer: July locally, June in UTC
  utc('1970-01-01T00:00:00Z'), utc('2038-01-19T03:14:08Z'),   // zero and past 2^31
  1774745999.5,                                               // fractional seconds
]

describe.each(['Europe/Budapest', 'America/New_York', 'UTC'])('local day and month, process zone %s', (zone) => {
  it('PostgreSQL gives the same label as SQLite, and both give what the wall clock says', async () => {
    process.env.TZ = zone
    expect(localTimeZone()).toBe(zone)
    const day = await labels([...EDGES, null], epochLocalDate)
    const month = await labels([...EDGES, null], epochLocalMonth)
    expect(day.pg).toEqual(day.sqlite)
    expect(month.pg).toEqual(month.sqlite)
    expect(day.sqlite).toEqual([...EDGES.map((e) => oracle(zone, e, 'day')), null])
    expect(month.sqlite).toEqual([...EDGES.map((e) => oracle(zone, e, 'month')), null])
  })

  it('PostgreSQL knows the zone name the fragment puts in the SQL text', async () => {
    process.env.TZ = zone
    const r = await pgdb.pool.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [checkZoneName(localTimeZone())])
    expect(r.rowCount, `PostgreSQL has no zone ${zone}: the day labels would be wrong, not loud`).toBe(1)
  })
})

describe('a DST day is 23 or 25 hours long, on both engines', () => {
  it('Europe/Budapest: 23 hourly instants on 2026-03-29, 25 on 2026-10-25, 24 on a normal day', async () => {
    process.env.TZ = 'Europe/Budapest'
    const start = utc('2026-03-27T00:00:00Z')
    // one instant per hour to the end of October, generated inside each engine (a compound SELECT has a term limit)
    const make = (d: 'sqlite' | 'pg'): string => `
      WITH RECURSIVE h(i, v) AS (
        SELECT CAST(0 AS BIGINT), CAST(${start} AS BIGINT)
        UNION ALL SELECT i + 1, v + 3600 FROM h WHERE i < ${24 * 215})
      SELECT ${epochLocalDate('v', d)} AS day, count(*) AS n FROM h GROUP BY 1 ORDER BY 1`
    const r = await both(make('sqlite'), make('pg'))
    const toMap = (rows: unknown[][]): Record<string, number> => Object.fromEntries(rows.map((x) => [String(x[0]), Number(x[1])]))
    const sMap = toMap(r.sqlite)
    const pMap = toMap(r.pg)
    expect(pMap).toEqual(sMap)
    for (const m of [sMap, pMap]) {
      expect(m['2026-03-29']).toBe(23)
      expect(m['2026-10-25']).toBe(25)
      expect(m['2026-06-15']).toBe(24)
    }
  })
})

describe('eqNoCase', () => {
  const PAIRS: [string | null, string | null, 0 | 1 | null][] = [
    ['A', 'a', 1], ['a_b', 'A_B', 1], ['', '', 1], ['abc', 'abd', 0],
    ['Ő', 'ő', 0],                  // O-double-acute vs o-double-acute: SQLite NOCASE folds ASCII only
    ['É', 'é', 0],                  // E-acute vs e-acute
    ['straße', 'STRASSE', 0],
    [null, 'a', null], ['a', null, null], [null, null, null], ['', null, null],
  ]

  it('both engines agree with each other and with the table, NULL is unknown on both', async () => {
    const rows = (d: 'sqlite' | 'pg'): string =>
      PAIRS.map(([a, b], i) => `SELECT ${i} AS i, ${sqlText(a)} AS a, ${sqlText(b)} AS b`).join(' UNION ALL ')
    const make = (d: 'sqlite' | 'pg'): string => `SELECT ${eqNoCase('a', 'b', d)} AS r FROM (${rows(d)}) ORDER BY i`
    const r = await both(make('sqlite'), make('pg'))
    const norm = (v: unknown): 0 | 1 | null => (v === null ? null : v === true || v === 1 ? 1 : 0)
    expect(r.sqlite.map((x) => norm(x[0]))).toEqual(PAIRS.map((p) => p[2]))
    expect(r.pg.map((x) => norm(x[0]))).toEqual(PAIRS.map((p) => p[2]))
  })

  it('works against a column and a bound parameter too', async () => {
    await pgdb.pool.query('CREATE TABLE eq_t (id bigint PRIMARY KEY, u text)')
    sq.exec('CREATE TABLE eq_t (id INTEGER PRIMARY KEY, u TEXT)')
    const names = ['Alice', 'alice2', 'Őra', 'Bob']
    for (const [i, n] of names.entries()) {
      await pgdb.pool.query('INSERT INTO eq_t VALUES ($1, $2)', [i, n])
      sq.prepare('INSERT INTO eq_t VALUES (?, ?)').run(i, n)
    }
    const s = sq.prepare(`SELECT id FROM eq_t WHERE ${eqNoCase('u', '?', 'sqlite')} ORDER BY id`).all('ALICE')
    const p = await pgdb.pool.query(`SELECT id FROM eq_t WHERE ${eqNoCase('u', '$1', 'pg')} ORDER BY id`, ['ALICE'])
    expect(s).toEqual([{ id: 0 }])
    expect(p.rows).toEqual([{ id: 0 }])
    const s2 = sq.prepare(`SELECT id FROM eq_t WHERE ${eqNoCase('u', '?', 'sqlite')}`).all('őRA')   // o-double-acute: no match
    const p2 = await pgdb.pool.query(`SELECT id FROM eq_t WHERE ${eqNoCase('u', '$1', 'pg')}`, ['őRA'])
    expect(s2).toEqual([])
    expect(p2.rows).toEqual([])
  })
})

describe('orderNoCase and orderBytes', () => {
  const NAMES = ['a_b', 'a-b', 'Ab', 'ab', 'AB', 'aB', 'Ő', 'ő', '_x', ' sp', 'a1', 'Z', 'é', 'B', 'b', 'ab ', 'a', 'ÿ', '10', '9']

  /** The oracle: bytes of the ASCII-folded name, then the raw bytes (the tie-break), then the id. */
  function expected(): number[] {
    const fold = (s: string): Buffer => Buffer.from(s.replace(/[A-Z]/g, (c) => c.toLowerCase()), 'utf8')
    return NAMES.map((n, id) => ({ n, id }))
      .sort((x, y) => Buffer.compare(fold(x.n), fold(y.n)) || Buffer.compare(Buffer.from(x.n), Buffer.from(y.n)) || x.id - y.id)
      .map((x) => x.id)
  }

  it('the server default collation really differs from byte order on this data (else the cell proves nothing)', async () => {
    await pgdb.pool.query('TRUNCATE ord_t')
    for (const [id, n] of NAMES.entries()) await pgdb.pool.query('INSERT INTO ord_t VALUES ($1, $2)', [id, n])
    const dflt = await pgdb.pool.query('SELECT id FROM ord_t ORDER BY name, id')
    const bytes = await pgdb.pool.query('SELECT id FROM ord_t ORDER BY name COLLATE "C", id')
    expect(dflt.rows.map((r) => Number(r.id)), 'the database collation is C: this cell cannot tell a missing COLLATE "C"').not.toEqual(
      bytes.rows.map((r) => Number(r.id)))
  })

  it('both engines return the same order, and it is the byte order of the folded name with a byte tie-break', async () => {
    await pgdb.pool.query('TRUNCATE ord_t')
    sq.exec('DELETE FROM ord_t')
    for (const [id, n] of NAMES.entries()) {
      await pgdb.pool.query('INSERT INTO ord_t VALUES ($1, $2)', [id, n])
      sq.prepare('INSERT INTO ord_t VALUES (?, ?)').run(id, n)
    }
    const q = (d: 'sqlite' | 'pg'): string =>
      `SELECT id FROM ord_t ORDER BY ${orderNoCase('name', d)}, ${orderBytes('name', d)}, id`
    const r = await both(q('sqlite'), q('pg'))
    const want = expected()
    expect(r.sqlite.map((x) => Number(x[0]))).toEqual(want)
    expect(r.pg.map((x) => Number(x[0]))).toEqual(want)
  })

  it('names that tie after the fold (Ab, ab, AB, aB) come out in byte order of the raw name', async () => {
    const q = (d: 'sqlite' | 'pg'): string =>
      `SELECT name FROM ord_t WHERE ${eqNoCase('name', "'ab'", d)} ORDER BY ${orderNoCase('name', d)}, ${orderBytes('name', d)}, id`
    const r = await both(q('sqlite'), q('pg'))
    expect(r.sqlite.map((x) => x[0])).toEqual(['AB', 'Ab', 'aB', 'ab'])
    expect(r.pg.map((x) => x[0])).toEqual(['AB', 'Ab', 'aB', 'ab'])
  })
})
