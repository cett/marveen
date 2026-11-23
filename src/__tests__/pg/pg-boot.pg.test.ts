// The PostgreSQL boot (db/pg-boot.ts) against a live server: the success path, and a refusal per step that needs one
// (migrate, preflight, caches). The steps that need no server (url, pool) are in ../pg-boot-refusal.test.ts.
// Each refusal must leave nothing behind: the facade back on SQLite, the pool ended (no session left on the database),
// and the next boot attempt a fresh one.
//
// Privacy: neutral fixtures only.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPgTestDb, pgTestUrl, type PgTestDb } from '../helpers/pg-test-db.js'
import { bootPgBackend, closePgBackend, PgBootError, PgProcessNotSupportedError, refuseProcessOnPg } from '../../db/pg-boot.js'
import { dbxDialect, useDbxBackend } from '../../db/facade.js'
import { createPgDbx } from '../../db/pg/dbx.js'
import { loadSystemConfigCacheAsync } from '../../db/config-cache.js'
import { dbx, listSystemConfig, getSystemConfig, setSystemConfig } from '../../db.js'
import { loadPgMigrationFiles } from '../../db-migrations-pg.js'

const made: PgTestDb[] = []
const dirs: string[] = []

afterEach(async () => {
  await closePgBackend()
})

afterAll(async () => {
  for (const d of made) await d.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A database cloned from the full baseline (every migration applied, the extensions in place). */
async function baselineDb(): Promise<PgTestDb> {
  const d = await createPgTestDb()
  made.push(d)
  return d
}

/** A database cloned from an EMPTY template: no table, no extension, no schema_version. */
async function emptyDb(): Promise<PgTestDb> {
  const dir = mkdtempSync(join(tmpdir(), 'pg-boot-empty-'))
  dirs.push(dir)
  const d = await createPgTestDb({ migrationsDir: dir })
  made.push(d)
  return d
}

/** Runs statements on the database through a client of its own, so the test database's pool stays untouched. */
async function sql(db: PgTestDb, ...statements: string[]): Promise<void> {
  const c = new pg.Client({ connectionString: db.url })
  await c.connect()
  try {
    for (const s of statements) await c.query(s)
  } finally {
    await c.end()
  }
}

/** The number of sessions on the database, seen from the server (polled: a closed session leaves a moment later). */
async function sessionsOn(db: PgTestDb): Promise<number> {
  const admin = new pg.Client({ connectionString: pgTestUrl() })
  await admin.connect()
  try {
    let n = -1
    for (let i = 0; i < 40; i++) {
      n = Number((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [db.name])).rows[0]!.n)
      if (n === 0) break
      await new Promise((r) => setTimeout(r, 50))
    }
    return n
  } finally {
    await admin.end()
  }
}

const refusalOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as PgBootError)

describe('bootPgBackend: success', () => {
  it('boots a database that already carries the baseline: the facade runs on PostgreSQL and the caches are served', async () => {
    const db = await baselineDb()
    const result = await bootPgBackend({ url: db.url })
    expect(dbxDialect()).toBe('pg')
    expect(result.migrations.applied).toEqual([])
    expect(result.migrations.alreadyApplied).toBe(loadPgMigrationFiles().length)
    // a synchronous cache reader answers (it throws "cache not loaded in PG mode" when nothing was loaded for this backend)
    expect(Array.isArray(listSystemConfig())).toBe(true)
    // and the write goes to the server, then the cache
    await setSystemConfig('pg_boot_probe', 'v1')
    expect(getSystemConfig('pg_boot_probe')?.value).toBe('v1')
    expect((await dbx.get<{ value: string }>('SELECT value FROM system_config WHERE key = ?', 'pg_boot_probe'))?.value).toBe('v1')
  })

  it('migrates a fresh database BEFORE the preflight: the migrations create the extensions the preflight demands', async () => {
    const db = await emptyDb()
    const result = await bootPgBackend({ url: db.url })
    expect(result.migrations.applied.length).toBe(loadPgMigrationFiles().length)
    expect(dbxDialect()).toBe('pg')
    expect(Array.isArray(listSystemConfig())).toBe(true)
  })

  it('closePgBackend puts the facade back on SQLite and ends the pool', async () => {
    const db = await baselineDb()
    await bootPgBackend({ url: db.url })
    await closePgBackend()
    expect(dbxDialect()).toBe('sqlite')
    expect(await sessionsOn(db)).toBe(0)
  })

  it('a cache filled under one backend epoch is not served under the next: the reader refuses until it is loaded again', async () => {
    const db = await baselineDb()
    await bootPgBackend({ url: db.url })
    expect(Array.isArray(listSystemConfig())).toBe(true)
    // a second switch is a new epoch (the same database, another pool): what the first epoch loaded belongs to nobody now
    const second = new pg.Pool({ connectionString: db.url, max: 1 })
    try {
      useDbxBackend(createPgDbx(second), 'pg')
      expect(() => getSystemConfig('pg_boot_probe')).toThrow(/cache not loaded in PG mode: call loadSystemConfigCacheAsync\(\)/)
      expect(() => listSystemConfig()).toThrow(/loadSystemConfigCacheAsync/)
      await loadSystemConfigCacheAsync()
      expect(Array.isArray(listSystemConfig())).toBe(true)
    } finally {
      useDbxBackend(null)
      await second.end()
    }
  })

  it('the process refusal opens no connection: with the URL configured it throws before any pool exists, and the facade stays on SQLite', async () => {
    const db = await baselineDb()
    vi.stubEnv('MARVEEN_PG_URL', db.url)
    try {
      expect(() => refuseProcessOnPg()).toThrow(PgProcessNotSupportedError)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(dbxDialect()).toBe('sqlite')
    expect(await sessionsOn(db)).toBe(0)
  })

  it('a second boot while one is active is refused, not stacked', async () => {
    const db = await baselineDb()
    await bootPgBackend({ url: db.url })
    await expect(bootPgBackend({ url: db.url })).rejects.toThrow(/already booted/)
    expect(dbxDialect()).toBe('pg')
  })
})

describe('bootPgBackend: a refusal per step', () => {
  it('step "migrate": a migration file that drifted from what the database applied refuses the boot', async () => {
    const db = await baselineDb()
    await sql(db, "UPDATE schema_version SET checksum = 'drifted' WHERE version = 1")
    const err = await refusalOf(bootPgBackend({ url: db.url }))
    expect(err).toBeInstanceOf(PgBootError)
    expect(err!.step).toBe('migrate')
    expect(dbxDialect()).toBe('sqlite')
    expect(await sessionsOn(db)).toBe(0)
  })

  it('step "preflight": a database without the unaccent extension refuses the boot and names it', async () => {
    const db = await baselineDb()
    await sql(db, 'DROP EXTENSION unaccent CASCADE')
    const err = await refusalOf(bootPgBackend({ url: db.url }))
    expect(err).toBeInstanceOf(PgBootError)
    expect(err!.step).toBe('preflight')
    expect(err!.message).toMatch(/unaccent/)
    expect(dbxDialect()).toBe('sqlite')
    expect(await sessionsOn(db)).toBe(0)
  })

  it('step "caches": a failing cache load refuses the boot, takes the backend switch back and ends the pool', async () => {
    const db = await baselineDb()
    await sql(db, 'DROP TABLE system_config CASCADE')
    const err = await refusalOf(bootPgBackend({ url: db.url }))
    expect(err).toBeInstanceOf(PgBootError)
    expect(err!.step).toBe('caches')
    expect(dbxDialect()).toBe('sqlite')
    expect(await sessionsOn(db)).toBe(0)
  })

  it('a refused boot leaves nothing registered: after the cause is fixed the same process boots', async () => {
    const db = await baselineDb()
    await sql(db, 'DROP EXTENSION unaccent CASCADE')
    expect((await refusalOf(bootPgBackend({ url: db.url })))!.step).toBe('preflight')
    await sql(db, 'CREATE EXTENSION unaccent')
    await bootPgBackend({ url: db.url })
    expect(dbxDialect()).toBe('pg')
  })

  it('no refusal message carries the URL or its password', async () => {
    const db = await baselineDb()
    await sql(db, 'DROP TABLE system_config CASCADE')
    const err = await refusalOf(bootPgBackend({ url: db.url }))
    expect(err).toBeInstanceOf(PgBootError)
    const u = new URL(db.url)
    expect(err!.message).not.toContain(db.url)
    if (u.password) expect(err!.message).not.toContain(u.password)
  })
})
