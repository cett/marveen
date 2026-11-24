// The database state the status endpoint reports (pg-boot.ts pgRuntimeStatus()), recorded by a REAL bootPgBackend on a
// throwaway database: a baseline database (current), and a NEWER one (an applied migration this build does not ship). The
// override is read from the process environment only, so the cells set it there and nowhere else.
//
// Privacy: neutral fixtures only. The future version is an arbitrary high number, not a real migration.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { bootPgBackend, closePgBackend, pgRuntimeStatus, PgBootError } from '../../db/pg-boot.js'
import { loadPgMigrationFiles } from '../../db-migrations-pg.js'

const made: PgTestDb[] = []

afterEach(async () => {
  await closePgBackend()
  vi.unstubAllEnvs()
})

afterAll(async () => {
  for (const d of made) await d.close()
})

async function baselineDb(): Promise<PgTestDb> {
  const d = await createPgTestDb()
  made.push(d)
  return d
}

/**
 * A row the build does not ship: an applied migration of a newer release. Written through the ADMIN URL (setup, like the
 * other cells): the owner role is under row-level security on schema_version, and the admin is the test's oracle.
 */
async function addFutureMigration(db: PgTestDb, version: number): Promise<void> {
  const c = new pg.Client({ connectionString: db.url })
  await c.connect()
  try {
    await c.query('INSERT INTO schema_version (version, applied_at, description, checksum) VALUES ($1, 0, $2, NULL)', [version, 'future'])
  } finally {
    await c.end()
  }
}

const shippedHighest = Math.max(0, ...loadPgMigrationFiles().map((f) => f.version))

describe('pgRuntimeStatus after a real boot', () => {
  it('a current database: backend pg, not a newer database, the database and the shipped highest are the same', async () => {
    const db = await baselineDb()
    await bootPgBackend({ url: db.appUrl })
    const s = pgRuntimeStatus()
    expect(s).not.toBeNull()
    expect(s!.backend).toBe('pg')
    expect(s!.runningOnNewerDatabase).toBe(false)
    expect(s!.shippedHighest).toBe(shippedHighest)
    expect(s!.databaseHighest).toBe(shippedHighest)
  })

  it('a NEWER database refuses without the override (override off)', async () => {
    const db = await baselineDb()
    await addFutureMigration(db, 9999)
    vi.stubEnv('MARVEEN_PG_ALLOW_NEWER_DATABASE', '')
    const err = await bootPgBackend({ url: db.appUrl }).then(() => null, (e: unknown) => e as PgBootError)
    expect(err).toBeInstanceOf(PgBootError)
    expect(err!.step).toBe('schema')
    expect(err!.message).toMatch(/this build ships up to/)
  })

  it('a NEWER database with the override on starts, reports both versions, and runs nothing', async () => {
    const db = await baselineDb()
    await addFutureMigration(db, 9999)
    vi.stubEnv('MARVEEN_PG_ALLOW_NEWER_DATABASE', '1')
    const result = await bootPgBackend({ url: db.appUrl })
    expect(result.migrations.state).toBe('NEWER')
    expect(result.migrations.applied).toEqual([])
    expect(result.warnings.some((w) => /running on a newer database: migration 9999/.test(w))).toBe(true)
    const s = pgRuntimeStatus()
    expect(s!.backend).toBe('pg')
    expect(s!.runningOnNewerDatabase).toBe(true)
    expect(s!.databaseHighest).toBe(9999)
    expect(s!.shippedHighest).toBe(shippedHighest)
  })
})
