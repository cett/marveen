// The system_config snapshot loader (config-snapshot-loader.ts) against a real PostgreSQL: the rows, a database without the table
// (the first boot before the baseline has run), a wrong password, an unreachable host, and no connection left open.
// Runs through `npm run test:pg` / the pg-parity job (MARVEEN_PG_TEST_URL). Privacy: a throwaway database, a placeholder password.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { loadSystemConfigSnapshot } from '../../config-snapshot-loader.js'

let db: PgTestDb
let probe: pg.Client

beforeAll(async () => {
  db = await createPgTestDb()
  probe = new pg.Client({ connectionString: db.url })
  await probe.connect()
}, 60000)

afterAll(async () => {
  if (probe) await probe.end()
  if (db) await db.close()
})

const withPassword = (url: string, password: string): string => {
  const u = new URL(url)
  u.password = password
  return u.toString()
}

describe('loadSystemConfigSnapshot against PostgreSQL', () => {
  it('reads the rows of system_config as a key -> value map', async () => {
    await probe.query("INSERT INTO system_config (key, value) VALUES ('SCHEDULER_TZ', 'Europe/Budapest') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value")
    const snap = await loadSystemConfigSnapshot(db.url)
    expect(snap.SCHEDULER_TZ).toBe('Europe/Budapest')
  })

  it('a database without the system_config table is an empty snapshot (SQLSTATE 42P01)', async () => {
    // a throwaway clone: this one database loses its table, the other cells use their own clones
    const scratch = await createPgTestDb()
    try {
      const c = new pg.Client({ connectionString: scratch.url })
      await c.connect()
      await c.query('DROP TABLE system_config')
      await c.end()
      expect(await loadSystemConfigSnapshot(scratch.url)).toEqual({})
    } finally {
      await scratch.close()
    }
  })

  it('a wrong password throws, and neither the password nor the URL is in the message', async () => {
    const bad = withPassword(db.url, 'wrong-placeholder-password')
    const err = await loadSystemConfigSnapshot(bad).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain('wrong-placeholder-password')
    expect((err as Error).message).not.toContain(bad)
  })

  it('an unreachable host throws within the connect timeout, and the host is not in the message', async () => {
    const unreachable = 'postgres://user:placeholder@127.0.0.1:1/marveen'
    const started = Date.now()
    const err = await loadSystemConfigSnapshot(unreachable, 2000).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect((err as Error).message).not.toContain('127.0.0.1')
    expect((err as Error).message).not.toContain('placeholder')
  })

  it('no connection is left open: the count of the database connections is the same before and after a load', async () => {
    const count = async (): Promise<number> => Number((await probe.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()')).rows[0].n)
    const before = await count()
    await loadSystemConfigSnapshot(db.url)
    await loadSystemConfigSnapshot(withPassword(db.url, 'wrong-placeholder-password')).catch(() => undefined)
    expect(await count()).toBe(before)
  })
})
