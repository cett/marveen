import Database from 'better-sqlite3'
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyMigrations, describeSchema, getSchemaReport } from '../db-migrations.js'
import { logger } from '../logger.js'

// The schema report: how the recorded schema relates to the migration files this code ships.
// The default must never refuse to start (a code-only rollback onto a newer database has to boot);
// SCHEMA_STRICT=1 is the opt-in refusal, taken BEFORE any pending migration runs.

const FUTURE_VERSION = 8 // above the highest fixture file (3)

let dir = ''
let db: Database.Database

function writeMigration(name: string, sql: string): void {
  writeFileSync(join(dir, name), sql, 'utf-8')
}

/** Three tiny migrations: versions 1, 2, 3 (codeMax = 3). */
function writeFixtureMigrations(): void {
  writeMigration('0001_a.sql', 'CREATE TABLE IF NOT EXISTS t_a (id INTEGER PRIMARY KEY);')
  writeMigration('0002_b.sql', 'CREATE TABLE IF NOT EXISTS t_b (id INTEGER PRIMARY KEY);')
  writeMigration('0003_c.sql', 'CREATE TABLE IF NOT EXISTS t_c (id INTEGER PRIMARY KEY);')
}

function recordFutureVersion(version = FUTURE_VERSION): void {
  db.prepare('INSERT INTO schema_version (version, applied_at, description, checksum) VALUES (?, 0, ?, NULL)')
    .run(version, 'recorded by a newer release')
}

function versions(): number[] {
  return (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as { version: number }[]).map((r) => r.version)
}

function tableExists(name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

let warnSpy: ReturnType<typeof vi.spyOn>
let infoSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marveen-schema-drift-'))
  db = new Database(':memory:')
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger)
  delete process.env.SCHEMA_STRICT
  writeFixtureMigrations()
})

afterEach(() => {
  delete process.env.SCHEMA_STRICT
  warnSpy.mockRestore()
  infoSpy.mockRestore()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** True when a spy was called with a message containing `text` (pino: the message is the second argument). */
function callsWith(spy: ReturnType<typeof vi.spyOn>, text: string): unknown[][] {
  return spy.mock.calls.filter((c: unknown[]) => c.some((a) => typeof a === 'string' && a.includes(text)))
}
function logged(spy: ReturnType<typeof vi.spyOn>, text: string): boolean {
  return callsWith(spy, text).length > 0
}

describe('applyMigrations: database newer than the code (default: boots and says so)', () => {
  it('T1: reports dbAhead, warns with the list, and does not throw', () => {
    applyMigrations(db, dir)
    recordFutureVersion()
    expect(() => applyMigrations(db, dir)).not.toThrow()

    const report = getSchemaReport()
    expect(report).toMatchObject({ dbMax: FUTURE_VERSION, codeMax: 3, dbAhead: [FUTURE_VERSION], pending: [] })
    const warns = callsWith(warnSpy, 'newer than this code')
    expect(warns, 'a warn about the newer schema').toHaveLength(1)
    expect(warns[0][0]).toMatchObject({ dbAhead: [FUTURE_VERSION], dbMax: FUTURE_VERSION, codeMax: 3 })
  })

  it('T6: SCHEMA_STRICT unset or "0" still boots on a newer database (the rollback case)', () => {
    applyMigrations(db, dir)
    recordFutureVersion()
    expect(() => applyMigrations(db, dir)).not.toThrow()
    process.env.SCHEMA_STRICT = '0'
    expect(() => applyMigrations(db, dir)).not.toThrow()
    expect(getSchemaReport()?.dbAhead).toEqual([FUTURE_VERSION])
  })
})

describe('applyMigrations: SCHEMA_STRICT=1', () => {
  it('T2: throws naming the version, and applies NO pending migration first', () => {
    applyMigrations(db, dir)
    recordFutureVersion()
    // A pending migration that the strict check must stop before it runs.
    writeMigration('0004_d.sql', 'CREATE TABLE t_d (id INTEGER PRIMARY KEY);')
    process.env.SCHEMA_STRICT = '1'

    expect(() => applyMigrations(db, dir)).toThrow(new RegExp(`newer than the code.*${FUTURE_VERSION}`))
    expect(tableExists('t_d'), 'the pending migration must not have run').toBe(false)
    expect(versions()).not.toContain(4)
  })

  it('T3: a clean database logs the INFO line, has no dbAhead and does not throw', () => {
    process.env.SCHEMA_STRICT = '1'
    expect(() => applyMigrations(db, dir)).not.toThrow()
    expect(getSchemaReport()).toEqual({
      dbMax: 3, codeMax: 3, appliedCount: 3, pending: [], dbAhead: [], missingFile: [], mismatched: [],
    })
    expect(logged(infoSpy, 'schema: db 3 / code 3, applied 3')).toBe(true)
    expect(logged(warnSpy, 'newer than this code')).toBe(false)
  })

  it('T4: a recorded version below codeMax with no file is missingFile: INFO only, no throw even in strict mode', () => {
    applyMigrations(db, dir)
    rmSync(join(dir, '0002_b.sql'))
    process.env.SCHEMA_STRICT = '1'

    expect(() => applyMigrations(db, dir)).not.toThrow()
    expect(getSchemaReport()).toMatchObject({ missingFile: [2], dbAhead: [] })
    expect(logged(infoSpy, 'without a file')).toBe(true)
    expect(logged(warnSpy, 'newer than this code')).toBe(false)
  })

  it('T9: the version equal to codeMax is not "ahead" (strict does not trip on the boundary)', () => {
    process.env.SCHEMA_STRICT = '1'
    applyMigrations(db, dir)
    expect(() => applyMigrations(db, dir)).not.toThrow()
    expect(getSchemaReport()?.dbAhead).toEqual([])
  })
})

describe('applyMigrations: checksum mismatch stays a per-version warning', () => {
  it('T5: an edited-in-DB checksum lists the version in mismatched and keeps the existing WARN', () => {
    applyMigrations(db, dir)
    db.prepare('UPDATE schema_version SET checksum = ? WHERE version = 3').run('0'.repeat(64))
    applyMigrations(db, dir)

    expect(getSchemaReport()?.mismatched).toEqual([3])
    expect(logged(warnSpy, 'checksum mismatch')).toBe(true)
  })
})

describe('describeSchema (pure)', () => {
  const sql = (v: number) => `-- v${v}`
  const files = [1, 2, 3].map((v) => ({ version: v, sql: sql(v) }))

  it('T7a: an empty database: dbMax 0, everything pending, nothing else', () => {
    expect(describeSchema(new Map(), files)).toEqual({
      dbMax: 0, codeMax: 3, appliedCount: 0, pending: [1, 2, 3], dbAhead: [], missingFile: [], mismatched: [],
    })
  })

  it('T7b: a gap in the recorded set is pending, not missingFile or dbAhead (out-of-order number)', () => {
    const r = describeSchema(new Map([[1, null], [3, null]]), files)
    expect(r).toMatchObject({ dbMax: 3, pending: [2], dbAhead: [], missingFile: [] })
  })

  it('T7c: the boundary: recorded == codeMax is not ahead, codeMax + 1 is', () => {
    expect(describeSchema(new Map([[3, null]]), files).dbAhead).toEqual([])
    expect(describeSchema(new Map([[3, null], [4, null]]), files).dbAhead).toEqual([4])
  })

  it('T7d: a recorded version with no file below codeMax is missingFile, sorted, and not dbAhead', () => {
    const r = describeSchema(new Map([[2, null], [1, null]]), [files[0], files[2]])
    expect(r.missingFile).toEqual([2])
    expect(r.dbAhead).toEqual([])
  })

  it('T7e: no files at all: codeMax 0 and every recorded version is ahead', () => {
    const r = describeSchema(new Map([[2, null], [1, null]]), [])
    expect(r).toMatchObject({ codeMax: 0, dbMax: 2, dbAhead: [1, 2], pending: [] })
  })

  it('T7f: mismatched needs a recorded checksum that differs; null is legacy and a known-safe version is excluded', () => {
    const sha = (s: string) => createHash('sha256').update(s, 'utf-8').digest('hex')
    const withSafe = [...files, { version: 4, sql: sql(4) }] // 4 is in KNOWN_SAFE_MISMATCHES
    const applied = new Map<number, string | null>([
      [1, sha(sql(1))], // same
      [2, null], // legacy row, no checksum
      [3, 'f'.repeat(64)], // differs
      [4, 'f'.repeat(64)], // differs but known safe
    ])
    expect(describeSchema(applied, withSafe).mismatched).toEqual([3])
  })
})
