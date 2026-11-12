// The file side of the PostgreSQL migration runner (no server): which files count, in which order, and what is refused
// before a connection is ever taken. The behaviour against a database is in src/__tests__/pg/migrations-runner.pg.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPgMigrations, DEFAULT_PG_MIGRATIONS_DIR, loadPgMigrationFiles } from '../db-migrations-pg.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pg-mig-files-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const put = (name: string, sql = 'SELECT 1;'): void => { writeFileSync(join(dir, name), sql) }

describe('loadPgMigrationFiles', () => {
  it('reads the real directory: the baseline first, then the twins, in version order', () => {
    const files = loadPgMigrationFiles()
    expect(files.map((f) => f.version).slice(0, 2)).toEqual([1, 2])
    expect(files[0]!.path).toContain('0001_baseline.sql')
    expect(DEFAULT_PG_MIGRATIONS_DIR).toContain('migrations-pg')
  })

  it('sorts by number, not by file name text (0010 after 0009 even when the names are listed the other way)', () => {
    put('0010_ten.sql'); put('0009_nine.sql'); put('0002_two.sql')
    expect(loadPgMigrationFiles(dir).map((f) => f.version)).toEqual([2, 9, 10])
  })

  it('the checksum is the sha256 of the content and changes with it', () => {
    put('0001_a.sql', 'SELECT 1;')
    const first = loadPgMigrationFiles(dir)[0]!
    expect(first.checksum).toBe(createHash('sha256').update('SELECT 1;', 'utf-8').digest('hex'))
    put('0001_a.sql', 'SELECT 2;')
    expect(loadPgMigrationFiles(dir)[0]!.checksum).not.toBe(first.checksum)
  })

  it('two files with one number are refused', () => {
    put('0003_a.sql'); put('0003_b.sql')
    expect(() => loadPgMigrationFiles(dir)).toThrow(/Duplicate PG migration version 3/)
  })

  it('a .sql file that does not match NNNN_description.sql is refused (it would never run), a non-sql file is ignored', () => {
    put('notes.txt'); put('README.md')
    expect(loadPgMigrationFiles(dir)).toEqual([])
    put('03_short.sql')
    expect(() => loadPgMigrationFiles(dir)).toThrow(/does not match NNNN_description\.sql/)
  })

  it('a directory that cannot be read is an error that names it', () => {
    expect(() => loadPgMigrationFiles(join(dir, 'missing'))).toThrow(/Cannot read the PG migrations directory/)
  })
})

describe('applyPgMigrations does not touch the database for a bad directory', () => {
  it('a duplicate version fails before a connection is taken', async () => {
    put('0003_a.sql'); put('0003_b.sql')
    const connect = vi.fn()
    await expect(applyPgMigrations({ connect } as never, { dir })).rejects.toThrow(/Duplicate PG migration version/)
    expect(connect).not.toHaveBeenCalled()
  })
})
