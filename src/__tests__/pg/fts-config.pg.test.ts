// The marveen_fts configuration, the normalizer and the bytea wrapper, against FTS5 (phase 3, c1). PostgreSQL only: the
// SQLite side of every differential is an in-memory FTS5 table of the same test, so the two engines are compared on the
// same input in the same run. The preflight is tested on throwaway databases (a missing extension, a non-UTF8 encoding).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import pg from 'pg'
import { createPgTestDb, pgTestUrl, type PgTestDb } from '../helpers/pg-test-db.js'
import { pgPreflight, PgPreflightError } from '../../db/pg/preflight.js'

const CFG = "'public.marveen_fts'"
let db: PgTestDb
const extra: PgTestDb[] = []

beforeAll(async () => {
  db = await createPgTestDb()
})

afterAll(async () => {
  for (const d of extra) await d.close()
  if (db) await db.close()
})

/** Ids of the docs whose normalized text matches the prefix probe (a tsquery word with :*), on PostgreSQL. */
async function pgHits(docs: string[], probe: string): Promise<number[]> {
  // one plain table per probe, dropped at the end (the pool may hand each statement to another session)
  const table = `fts_probe_${Math.random().toString(36).slice(2, 10)}`
  await db.pool.query(`CREATE TABLE ${table} (id int PRIMARY KEY, body text)`)
  try {
    for (const [i, d] of docs.entries()) await db.pool.query(`INSERT INTO ${table} (id, body) VALUES ($1, $2)`, [i + 1, d])
    const r = await db.pool.query(
      `SELECT id FROM ${table} WHERE to_tsvector(${CFG}, fts_norm(body)) @@ to_tsquery(${CFG}, $1) ORDER BY id`,
      [`${probe}:*`],
    )
    return r.rows.map((row) => Number(row.id))
  } finally {
    await db.pool.query(`DROP TABLE ${table}`)
  }
}

/** The same question on SQLite FTS5 (default unicode61 tokenizer), for the same docs. */
function sqliteHits(docs: string[], probe: string): number[] {
  const s = new Database(':memory:')
  try {
    s.exec('CREATE VIRTUAL TABLE f USING fts5(body)')
    const ins = s.prepare('INSERT INTO f (rowid, body) VALUES (?, ?)')
    docs.forEach((d, i) => ins.run(i + 1, d))
    return (s.prepare('SELECT rowid FROM f WHERE f MATCH ? ORDER BY rowid').all(`${probe}*`) as Array<{ rowid: number }>)
      .map((r) => Number(r.rowid))
  } finally {
    s.close()
  }
}

describe('the accent fold: nine Hungarian letters, both cases, against FTS5', () => {
  // Each letter in its own doc, lower and upper case. The probe is the ASCII vowel the letter folds to.
  const letters = ['á', 'é', 'í', 'ó', 'ö', 'ő', 'ú', 'ü', 'ű']
  const docs = letters.flatMap((l) => [l, l.toUpperCase()])
  it('the hit sets of every vowel probe are the same on PostgreSQL and FTS5', async () => {
    for (const probe of ['a', 'e', 'i', 'o', 'u']) {
      expect(await pgHits(docs, probe)).toEqual(sqliteHits(docs, probe))
    }
  })

  it('o, u collect the three letters each: ó ö ő and ú ü ű, both cases (six docs), a e i one letter each', async () => {
    expect((await pgHits(docs, 'o')).length).toBe(6)
    expect((await pgHits(docs, 'u')).length).toBe(6)
    expect((await pgHits(docs, 'a')).length).toBe(2)
    expect((await pgHits(docs, 'e')).length).toBe(2)
    expect((await pgHits(docs, 'i')).length).toBe(2)
  })
})

describe('punctuation: the same words are found on both engines', () => {
  const doc = 'serper.dev rank-check a_b http://x.hu/p?q=1 jo@ex.com'
  const words = ['serper', 'dev', 'rank', 'check', 'a', 'b', 'http', 'x', 'hu', 'p', 'q', 'jo', 'ex', 'com']
  it('every word of the text is found, and the same way as FTS5 finds it', async () => {
    for (const w of words) {
      const pgs = await pgHits([doc], w)
      expect(pgs, `word ${w}`).toEqual(sqliteHits([doc], w))
      expect(pgs, `word ${w}`).toEqual([1])
    }
  })
})

describe('the bytea wrapper', () => {
  it('reads valid UTF-8 and gives an empty text for an invalid sequence, a NULL and never fails', async () => {
    const r = await db.pool.query(
      "SELECT public.fts_bytes_text('árvíz'::bytea) AS ok, public.fts_bytes_text('\\xfffe'::bytea) AS bad, public.fts_bytes_text(NULL) AS nul",
    )
    expect(r.rows[0]).toEqual({ ok: 'árvíz', bad: '', nul: '' })
  })

  // Call-site check, not an in-body fault: a value of the wrong type is refused by PostgreSQL before the body runs, and the
  // wrapper must not turn that refusal into an empty text. (The in-body case is narrowed to the invalid-byte errors; a
  // cell for an out-of-body fault would need a fault injection, which the test database does not offer.)
  it('a call with a value that is not bytea is refused, not answered with an empty text', async () => {
    await expect(db.pool.query('SELECT public.fts_bytes_text(1) AS x')).rejects.toThrow()
  })
})

describe('size: a 2 MB text indexes, and the 300000-character cap is the pinned divergence', () => {
  it('a text of about 2 MB with distinct tokens builds its tsvector without error and its first word is found', async () => {
    const big = Array.from({ length: 200000 }, (_, i) => `tok${String(i).padStart(7, '0')}`).join(' ')
    expect(big.length).toBeGreaterThan(1_900_000)
    const r = await db.pool.query(
      `SELECT to_tsvector(${CFG}, fts_norm($1)) @@ to_tsquery(${CFG}, 'tok0000000:*') AS hit`,
      [big],
    )
    expect(r.rows[0]?.['hit']).toBe(true)
  })

  it('a word after the first 300000 characters is not searchable on PostgreSQL (SQLite indexes it: a named divergence)', async () => {
    const filler = 'filler '.repeat(50000) // 300000 characters
    const text = `leadword ${filler} tailzzz`
    const r = await db.pool.query(
      `SELECT to_tsvector(${CFG}, fts_norm($1)) @@ to_tsquery(${CFG}, 'leadword:*') AS lead,
              to_tsvector(${CFG}, fts_norm($1)) @@ to_tsquery(${CFG}, 'tailzzz:*') AS tail`,
      [text],
    )
    expect(r.rows[0]).toEqual({ lead: true, tail: false })
    expect(sqliteHits([text], 'tailzzz')).toEqual([1])
  })
})

describe('preflight: a database without the capability is refused, a complete one is accepted', () => {
  it('accepts the migrated database (UTF8, unaccent installed)', async () => {
    const report = await pgPreflight(db.pool)
    expect(Array.isArray(report.warnings)).toBe(true)
  })

  it('refuses a database without the unaccent extension', async () => {
    const other = await createPgTestDb()
    extra.push(other)
    await other.pool.query('DROP EXTENSION unaccent CASCADE')
    await expect(pgPreflight(other.pool)).rejects.toThrow(PgPreflightError)
    await expect(pgPreflight(other.pool)).rejects.toThrow(/unaccent/)
  })

  it('refuses a database whose encoding is not UTF8', async () => {
    const admin = new pg.Client({ connectionString: pgTestUrl() })
    await admin.connect()
    const name = `marveen_t_sqlascii_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
    try {
      await admin.query(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'SQL_ASCII'`)
      const u = new URL(pgTestUrl())
      u.pathname = `/${name}`
      const pool = new pg.Pool({ connectionString: u.toString(), max: 1 })
      try {
        await expect(pgPreflight(pool)).rejects.toThrow(/encoding/)
      } finally {
        await pool.end()
        await admin.query(`DROP DATABASE IF EXISTS ${name}`)
      }
    } finally {
      await admin.end()
    }
  })
})
