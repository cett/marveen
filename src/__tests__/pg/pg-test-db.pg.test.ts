// The PG test harness (src/__tests__/helpers/pg-test-db.ts) against a real throwaway server: MARVEEN_PG_TEST_URL.
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import {
  PG_TEST_URL_ENV, pgTestUrl, parseInt8Safe, pgTypes, listBaselineFiles, templateName,
  createPgTestDb, dropPgTemplate, type PgTestDb,
} from '../helpers/pg-test-db.js'

const dirs: string[] = []
const templates = new Set<string>()
const open: PgTestDb[] = []

function baselineDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pg-harness-'))
  dirs.push(dir)
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql)
  return dir
}

async function make(files: Record<string, string>): Promise<PgTestDb> {
  const db = await createPgTestDb({ migrationsDir: baselineDir(files) })
  templates.add(db.template)
  open.push(db)
  return db
}

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const db of open.splice(0)) await db.close()
})
afterAll(async () => {
  for (const t of templates) await dropPgTemplate(t)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function databaseNames(like: string): Promise<string[]> {
  const c = new pg.Client({ connectionString: pgTestUrl() })
  await c.connect()
  try {
    const r = await c.query('SELECT datname FROM pg_database WHERE datname LIKE $1 ORDER BY datname', [like])
    return r.rows.map((x: { datname: string }) => x.datname)
  } finally { await c.end() }
}

describe('parseInt8Safe', () => {
  it.each([['0', 0], ['42', 42], ['-7', -7], ['9007199254740991', Number.MAX_SAFE_INTEGER], ['-9007199254740991', Number.MIN_SAFE_INTEGER]])(
    '%s -> %d', (text, n) => { expect(parseInt8Safe(text)).toBe(n) })

  it.each(['9007199254740992', '-9007199254740992', '9223372036854775807', 'not a number', ''])(
    'refuses %j', (text) => { expect(() => parseInt8Safe(text)).toThrow(RangeError) })
})

describe('pgTestUrl', () => {
  it('throws, and does not skip, when the variable is missing', () => {
    vi.stubEnv(PG_TEST_URL_ENV, '')
    expect(() => pgTestUrl()).toThrow(new RegExp(PG_TEST_URL_ENV))
  })
})

describe('listBaselineFiles and templateName', () => {
  it('lists only .sql files in file-name order, an absent directory is an empty baseline', () => {
    const dir = baselineDir({ '0002_b.sql': 'select 2', '0001_a.sql': 'select 1', 'README.md': 'x', '0003.sql.bak': 'y' })
    expect(listBaselineFiles(dir).map((f) => path.basename(f))).toEqual(['0001_a.sql', '0002_b.sql'])
    expect(listBaselineFiles(path.join(dir, 'does-not-exist'))).toEqual([])
  })

  it('a different SQL text, file name or file order is a different template; the same files are the same', () => {
    const a = baselineDir({ '0001_x.sql': 'create table t (id bigint)' })
    const b = baselineDir({ '0001_x.sql': 'create table t (id bigint)' })
    const c = baselineDir({ '0001_x.sql': 'create table t (id bigint, n text)' })
    const d = baselineDir({ '0002_x.sql': 'create table t (id bigint)' })
    expect(templateName(listBaselineFiles(a))).toBe(templateName(listBaselineFiles(b)))
    expect(templateName(listBaselineFiles(a))).not.toBe(templateName(listBaselineFiles(c)))
    expect(templateName(listBaselineFiles(a))).not.toBe(templateName(listBaselineFiles(d)))
    expect(templateName(listBaselineFiles(a))).toMatch(/^marveen_tpl_[0-9a-f]{16}$/)
  })
})

describe('createPgTestDb', () => {
  it('clones the baseline: its tables and rows are there', async () => {
    const db = await make({ '0001_base.sql': 'create table kv (k text primary key, v bigint); insert into kv values (\'a\', 1);' })
    const r = await db.pool.query('select k, v from kv')
    expect(r.rows).toEqual([{ k: 'a', v: 1 }])
  })

  it('applies several files in file-name order', async () => {
    const db = await make({
      '0002_more.sql': 'alter table t add column n text; update t set n = \'x\';',
      '0001_base.sql': 'create table t (id bigint); insert into t values (1);',
    })
    expect((await db.pool.query('select id, n from t')).rows).toEqual([{ id: 1, n: 'x' }])
  })

  it('returns bigint as a number and refuses one beyond the safe range', async () => {
    const db = await make({ '0001_x.sql': 'create table n (v bigint);' })
    await db.pool.query('insert into n values ($1)', ['9007199254740991'])
    expect((await db.pool.query('select v from n')).rows[0].v).toBe(Number.MAX_SAFE_INTEGER)
    await db.pool.query('delete from n')
    await db.pool.query('insert into n values ($1)', ['9007199254740993'])
    await expect(db.pool.query('select v from n')).rejects.toThrow(/safe integer/)
  })

  it('keeps every other type as the driver has it (numeric stays text, smallint a number, bytea a Buffer)', async () => {
    const db = await make({ '0001_x.sql': 'create table o (a numeric, b smallint, c bytea, d text);' })
    await db.pool.query('insert into o values (1.50, 3, $1, $2)', [Buffer.from([1, 2, 3]), 'x'])
    const row = (await db.pool.query('select a, b, c, d from o')).rows[0]
    expect(row.a).toBe('1.50')
    expect(row.b).toBe(3)
    expect(Buffer.isBuffer(row.c)).toBe(true)
    expect(row.d).toBe('x')
    expect(pgTypes.getTypeParser(20, 'text')).toBe(parseInt8Safe)
  })

  it('gives every call its own database: a write in one is not seen in the other', async () => {
    const files = { '0001_x.sql': 'create table t (id bigint);' }
    const a = await make(files)
    const b = await make(files)
    expect(a.name).not.toBe(b.name)
    expect(a.template).toBe(b.template)
    await a.pool.query('insert into t values (1)')
    expect((await a.pool.query('select count(*)::int as n from t')).rows[0].n).toBe(1)
    expect((await b.pool.query('select count(*)::int as n from t')).rows[0].n).toBe(0)
  })

  it('close() drops the database', async () => {
    const db = await createPgTestDb({ migrationsDir: baselineDir({ '0001_x.sql': 'create table t (id bigint);' }) })
    templates.add(db.template)
    expect(await databaseNames(db.name)).toEqual([db.name])
    await db.close()
    expect(await databaseNames(db.name)).toEqual([])
  })

  it('an empty or absent baseline gives an empty database', async () => {
    const db = await createPgTestDb({ migrationsDir: path.join(tmpdir(), 'pg-harness-no-such-dir') })
    templates.add(db.template)
    open.push(db)
    const r = await db.pool.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'")
    expect(r.rows[0].n).toBe(0)
  })

  it('four databases at once from a fresh baseline: the template is built once and every clone succeeds', async () => {
    const dir = baselineDir({ '0001_x.sql': `create table t (id bigint); -- ${Math.random()}` })
    const dbs = await Promise.all([1, 2, 3, 4].map(() => createPgTestDb({ migrationsDir: dir })))
    open.push(...dbs)
    templates.add(dbs[0].template)
    expect(new Set(dbs.map((d) => d.template)).size).toBe(1)
    expect(new Set(dbs.map((d) => d.name)).size).toBe(4)
    expect(await databaseNames(`${dbs[0].template}%`)).toEqual([dbs[0].template])
  })

  it('a baseline that fails to apply rejects with its file name and leaves no half-built template', async () => {
    const dir = baselineDir({ '0001_ok.sql': 'create table t (id bigint);', '0002_broken.sql': `select * from no_such_table; -- ${Math.random()}` })
    const name = templateName(listBaselineFiles(dir))
    await expect(createPgTestDb({ migrationsDir: dir })).rejects.toThrow(/0002_broken\.sql.*failed to apply.*no_such_table/s)
    expect(await databaseNames(`${name}%`)).toEqual([])
    // the lock was released: a later, valid baseline works
    const db = await make({ '0001_x.sql': 'create table t (id bigint);' })
    expect((await db.pool.query('select 1 as one')).rows[0].one).toBe(1)
  })
})
