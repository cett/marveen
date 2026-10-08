// The migration runner decides what is pending from what is RECORDED, not from the highest recorded
// number, so a migration merged after a higher-numbered one is still applied. Plus the numbering
// gate over the real migrations directory. Real in-memory SQLite.

import Database from 'better-sqlite3'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { applyMigrations } from '../db-migrations.js'
import { logger } from '../logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REAL_DIR = join(__dirname, '..', 'migrations')

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'migr-order-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const write = (dir: string, name: string, sql: string) => writeFileSync(join(dir, name), sql, 'utf-8')
const versions = (db: Database.Database) =>
  (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map(r => r.version)

// Every migration logs its own number into run_log, so the tests see what actually ran and in what order.
function logging(version: string, extra = ''): string {
  return `CREATE TABLE IF NOT EXISTS run_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL);
INSERT INTO run_log (v) VALUES ('${version}'); ${extra}`
}
const ran = (db: Database.Database) => (db.prepare('SELECT v FROM run_log ORDER BY seq').all() as { v: string }[]).map(r => r.v)

describe('a migration merged out of order', () => {
  it('is applied although a higher version is already recorded, and says so', () => {
    const dir = tempDir()
    write(dir, '0001_baseline.sql', logging('1'))
    write(dir, '0002_second.sql', logging('2'))
    write(dir, '0004_fourth.sql', logging('4'))
    const db = new Database(':memory:')
    applyMigrations(db, dir)
    expect(versions(db)).toEqual([1, 2, 4])

    write(dir, '0003_third.sql', logging('3', 'CREATE TABLE late (id INTEGER);'))
    const warn = vi.spyOn(logger, 'warn')
    applyMigrations(db, dir)

    expect(versions(db)).toEqual([1, 2, 3, 4])
    expect(ran(db)).toEqual(['1', '2', '4', '3'])
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'late'").get()).toBeDefined()
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ version: 3, highestApplied: 4 }), expect.stringContaining('missed earlier'))
  })

  it('applies several missed versions in ascending order', () => {
    const dir = tempDir()
    write(dir, '0001_a.sql', logging('1'))
    write(dir, '0005_e.sql', logging('5'))
    const db = new Database(':memory:')
    applyMigrations(db, dir)
    write(dir, '0004_d.sql', logging('4'))
    write(dir, '0002_b.sql', logging('2'))
    write(dir, '0003_c.sql', logging('3'))
    applyMigrations(db, dir)
    expect(ran(db)).toEqual(['1', '5', '2', '3', '4'])
  })

  it('re-runs nothing on a database where every file is recorded, however often it boots', () => {
    const dir = tempDir()
    for (const v of ['0001_a', '0002_b', '0003_c']) write(dir, `${v}.sql`, logging(v.slice(0, 4)))
    const db = new Database(':memory:')
    applyMigrations(db, dir)
    const warn = vi.spyOn(logger, 'warn')
    applyMigrations(db, dir)
    applyMigrations(db, dir)
    expect(ran(db)).toEqual(['0001', '0002', '0003'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not mind a number that has no file at all (a historical hole)', () => {
    const dir = tempDir()
    write(dir, '0001_a.sql', logging('1'))
    write(dir, '0003_c.sql', logging('3'))
    const db = new Database(':memory:')
    applyMigrations(db, dir)
    const warn = vi.spyOn(logger, 'warn')
    applyMigrations(db, dir)
    expect(versions(db)).toEqual([1, 3])
    expect(warn).not.toHaveBeenCalled()
  })

  it('a missed migration that fails stops the boot and records nothing for it', () => {
    const dir = tempDir()
    write(dir, '0001_a.sql', logging('1'))
    write(dir, '0003_c.sql', logging('3'))
    const db = new Database(':memory:')
    applyMigrations(db, dir)
    write(dir, '0002_b.sql', 'THIS IS NOT SQL;')
    expect(() => applyMigrations(db, dir)).toThrow()
    expect(versions(db)).toEqual([1, 3])
  })
})

describe('duplicate version numbers', () => {
  it('refuse to start instead of silently skipping the second file', () => {
    const dir = tempDir()
    write(dir, '0001_a.sql', logging('1'))
    write(dir, '0002_first.sql', logging('2a'))
    write(dir, '0002_second.sql', logging('2b'))
    const db = new Database(':memory:')
    expect(() => applyMigrations(db, dir)).toThrow(/Duplicate migration version 2/)
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'run_log'").get()).toBeUndefined()
  })
})

describe('the real migrations directory (numbering gate)', () => {
  const files = readdirSync(REAL_DIR).filter(f => /^\d{4,}_.+\.sql$/.test(f)).sort()
  const numbers = files.map(f => parseInt(f.slice(0, f.indexOf('_')), 10))

  // Numbers that were never used. A new hole means a migration was renumbered or dropped after others
  // were numbered past it: look at the branch order first, add the number here only if it is deliberate.
  const KNOWN_NUMBER_HOLES = [14]

  it('has no duplicate number', () => {
    expect(numbers.filter((n, i) => numbers.indexOf(n) !== i)).toEqual([])
  })

  it('has no new hole in the numbering', () => {
    const holes: number[] = []
    for (let n = 1; n <= numbers[numbers.length - 1]!; n++) if (!numbers.includes(n)) holes.push(n)
    expect(holes).toEqual(KNOWN_NUMBER_HOLES)
  })

  it('applies cleanly when one migration reaches the database after its successors (0074 + 0076, then 0075)', () => {
    const dir = tempDir()
    for (const f of files) if (!f.startsWith('0075')) copyFileSync(join(REAL_DIR, f), join(dir, f))
    const db = new Database(':memory:')
    applyMigrations(db, dir)
    expect(versions(db)).not.toContain(75)
    expect(versions(db)).toContain(76)

    const f75 = files.find(f => f.startsWith('0075'))!
    copyFileSync(join(REAL_DIR, f75), join(dir, f75))
    applyMigrations(db, dir)

    expect(versions(db)).toContain(75)
    const cols = (db.prepare('PRAGMA table_info(conversation_log)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('tenant_id')
    // The full chain in one go ends in the same schema as the out-of-order one.
    const inOrder = new Database(':memory:')
    applyMigrations(inOrder, REAL_DIR)
    const shape = (d: Database.Database) =>
      (d.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string | null }[])
    expect(shape(db)).toEqual(shape(inOrder))
  })
})
