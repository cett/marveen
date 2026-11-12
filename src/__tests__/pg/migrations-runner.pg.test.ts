// The PostgreSQL migration runner against a real server (MARVEEN_PG_TEST_URL, `npm run test:pg`). Every database here
// is a fresh empty one: the runner, not the harness, builds the schema. The mutants are listed in the PR description.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import Database from 'better-sqlite3'
import { applyMigrations } from '../../db-migrations.js'
import { applyPgMigrations, loadPgMigrationFiles } from '../../db-migrations-pg.js'
import { actualFromPg, diffSchemas, expectedFromSqlite } from '../helpers/pg-parity.js'
import { pgTestUrl } from '../helpers/pg-test-db.js'

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`
const withDatabase = (database: string): string => { const u = new URL(pgTestUrl()); u.pathname = `/${database}`; return u.toString() }

let dbName: string
let pool: pg.Pool
let dir: string
const created: pg.Pool[] = []

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: pgTestUrl() })
  await c.connect()
  try { return await fn(c) } finally { await c.end() }
}
const newPool = (): pg.Pool => { const p = new pg.Pool({ connectionString: withDatabase(dbName), max: 2 }); created.push(p); return p }
const put = (name: string, sql: string): void => { writeFileSync(path.join(dir, name), sql) }
const versions = async (p: pg.Pool = pool): Promise<number[]> =>
  (await p.query<{ version: string }>('SELECT version FROM schema_version ORDER BY version')).rows.map((r) => Number(r.version))
const tableExists = async (name: string): Promise<boolean> =>
  (await pool.query("SELECT to_regclass($1)::text AS t", [`public.${name}`])).rows[0].t !== null

beforeEach(async () => {
  dbName = `marveen_runner_${process.pid}_${Math.random().toString(16).slice(2, 10)}`
  await admin((c) => c.query(`CREATE DATABASE ${q(dbName)}`))
  pool = newPool()
  dir = mkdtempSync(path.join(tmpdir(), 'pg-runner-'))
})

afterEach(async () => {
  await Promise.all(created.splice(0).map((p) => p.end().catch(() => undefined)))
  await admin((c) => c.query(`DROP DATABASE IF EXISTS ${q(dbName)} WITH (FORCE)`))
  rmSync(dir, { recursive: true, force: true })
})

describe('the real files', () => {
  it('an empty database through the runner has the same schema as the SQLite chain (the runner is the path, not the harness)', async () => {
    const result = await applyPgMigrations(pool)
    expect(result.applied).toEqual(loadPgMigrationFiles().map((f) => f.version))
    const sqlite = new Database(':memory:')
    applyMigrations(sqlite)
    const probe = await pool.connect()
    try {
      const expected = await expectedFromSqlite(sqlite, probe)
      const actual = await actualFromPg(probe)
      expect(expected.problems).toEqual([])
      expect(diffSchemas(expected.model, actual)).toEqual([])
    } finally {
      probe.release()
      sqlite.close()
    }
  })

  it('records one schema_version row per file with its checksum, and the second run changes nothing', async () => {
    const first = await applyPgMigrations(pool)
    const files = loadPgMigrationFiles()
    expect(await versions()).toEqual(files.map((f) => f.version))
    const rows = (await pool.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_version ORDER BY version')).rows
    expect(rows.map((r) => r.checksum)).toEqual(files.map((f) => f.checksum))
    const before = (await pool.query('SELECT version, applied_at, description, checksum FROM schema_version ORDER BY version')).rows
    const second = await applyPgMigrations(pool)
    expect(first.applied.length).toBe(files.length)
    expect(second).toEqual({ applied: [], alreadyApplied: files.length })
    expect((await pool.query('SELECT version, applied_at, description, checksum FROM schema_version ORDER BY version')).rows).toEqual(before)
  })
})

describe('one transaction per file', () => {
  it('a broken second file leaves the first applied and nothing of the second, no version row either', async () => {
    put('0001_ok.sql', 'CREATE TABLE ok_t (id bigint PRIMARY KEY);')
    put('0002_broken.sql', 'CREATE TABLE half_t (id bigint); SELECT * FROM no_such_table;')
    await expect(applyPgMigrations(pool, { dir })).rejects.toThrow(/PG migration 2 .*0002_broken\.sql.*rolled back.*no_such_table/s)
    expect(await tableExists('ok_t')).toBe(true)
    expect(await tableExists('half_t')).toBe(false) // the DDL before the failing statement went with the rollback
    expect(await versions()).toEqual([1])
  })

  it('positive pair: the same files with the second one fixed apply both, and the run after the fix applies only the second', async () => {
    put('0001_ok.sql', 'CREATE TABLE ok_t (id bigint PRIMARY KEY);')
    put('0002_broken.sql', 'SELECT * FROM no_such_table;')
    await expect(applyPgMigrations(pool, { dir })).rejects.toThrow()
    put('0002_broken.sql', 'CREATE TABLE half_t (id bigint);')
    const r = await applyPgMigrations(pool, { dir })
    expect(r).toEqual({ applied: [2], alreadyApplied: 1 })
    expect(await versions()).toEqual([1, 2])
  })

  it('the lock is released after a failure (a following run is not stuck behind a dead one)', async () => {
    put('0001_bad.sql', 'SELECT * FROM no_such_table;')
    await expect(applyPgMigrations(pool, { dir })).rejects.toThrow()
    put('0001_bad.sql', 'CREATE TABLE fixed_t (id bigint);')
    const other = newPool()
    expect((await applyPgMigrations(other, { dir })).applied).toEqual([1])
  })
})

describe('immutability and order', () => {
  it('a file that changed after it was applied is an error that names it; the data is untouched', async () => {
    put('0001_a.sql', 'CREATE TABLE a_t (id bigint);')
    await applyPgMigrations(pool, { dir })
    put('0001_a.sql', 'CREATE TABLE a_t (id bigint, extra text);')
    await expect(applyPgMigrations(pool, { dir })).rejects.toThrow(/PG migration 1 .*changed after it was applied/)
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'a_t'")).rows
    expect(cols).toEqual([{ column_name: 'id' }])
  })

  it('an applied version whose file is gone is an error', async () => {
    put('0001_a.sql', 'CREATE TABLE a_t (id bigint);')
    put('0002_b.sql', 'CREATE TABLE b_t (id bigint);')
    await applyPgMigrations(pool, { dir })
    rmSync(path.join(dir, '0002_b.sql'))
    await expect(applyPgMigrations(pool, { dir })).rejects.toThrow(/PG migration 2 is applied but its file is gone/)
  })

  it('an unapplied file below an applied one (merged out of order) is refused and nothing runs', async () => {
    put('0001_a.sql', 'CREATE TABLE a_t (id bigint);')
    put('0003_c.sql', 'CREATE TABLE c_t (id bigint);')
    await applyPgMigrations(pool, { dir })
    put('0002_b.sql', 'CREATE TABLE b_t (id bigint);')
    await expect(applyPgMigrations(pool, { dir })).rejects.toThrow(/PG migration 2 .*not applied but 3 is/)
    expect(await tableExists('b_t')).toBe(false)
  })

  it('there is no tolerance: a file that creates what already exists fails, it is not swallowed', async () => {
    put('0001_a.sql', 'CREATE TABLE a_t (id bigint);')
    put('0002_dup.sql', 'CREATE TABLE a_t (id bigint);')
    await expect(applyPgMigrations(pool, { dir })).rejects.toThrow(/already exists/)
    expect(await versions()).toEqual([1])
  })
})

describe('two processes that start at once', () => {
  it('apply every file exactly once between them (the loser applies nothing)', async () => {
    // each file takes a moment, so both runs are really in flight together
    put('0001_a.sql', 'SELECT pg_sleep(0.3); CREATE TABLE a_t (id bigint);')
    put('0002_b.sql', 'SELECT pg_sleep(0.3); CREATE TABLE b_t (id bigint);')
    const a = newPool()
    const b = newPool()
    const [ra, rb] = await Promise.all([applyPgMigrations(a, { dir }), applyPgMigrations(b, { dir })])
    expect([...ra.applied, ...rb.applied].sort()).toEqual([1, 2])
    expect(ra.applied.length === 0 || rb.applied.length === 0).toBe(true)
    expect(await versions()).toEqual([1, 2])
  })
})
