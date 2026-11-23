// The pools the PG harness hands out (src/__tests__/helpers/pg-test-db.ts): `pool` is the admin (setup and the oracle),
// `appPool` is what an isolation cell claims against, `ownerPool` is only for the DDL a cell needs, and `appDbx()` is the
// facade over the app pool. `npm run test:pg` (a real server, MARVEEN_PG_TEST_URL). No policy exists yet, so no cell here
// says anything about row-level security except which role is connected.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPgTestDb, PG_TEST_APP_ROLE, PG_TEST_OWNER_ROLE, type PgTestDb } from '../helpers/pg-test-db.js'
import { runAs } from '../../db/context.js'
import { PG_SET_CONTEXT_SQL, pgContextValues } from '../../db/pg/dbx.js'

let db: PgTestDb
beforeAll(async () => { db = await createPgTestDb() })
afterAll(async () => { await db.close() })

interface Who { current_user: string; rolsuper: boolean; rolbypassrls: boolean }
const WHO = 'SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'

describe('the pools of the harness', () => {
  it('the app pool is the app role: not a superuser, not BYPASSRLS', async () => {
    expect((await db.appPool.query<Who>(WHO)).rows[0]).toEqual({ current_user: PG_TEST_APP_ROLE, rolsuper: false, rolbypassrls: false })
  })

  it('the owner pool is the owner role, and the admin pool is neither of them (the oracle sees everything)', async () => {
    const owner = (await db.ownerPool.query<Who>(WHO)).rows[0]
    expect(owner).toEqual({ current_user: PG_TEST_OWNER_ROLE, rolsuper: false, rolbypassrls: false })
    const admin = (await db.pool.query<Who>(WHO)).rows[0]
    expect([PG_TEST_APP_ROLE, PG_TEST_OWNER_ROLE]).not.toContain(admin.current_user)
    expect(admin.rolsuper).toBe(true)
  })

  it('a row the app role writes is seen by the admin pool, the oracle (the three pools are one database)', async () => {
    // under row-level security the write needs a context: the system one, set the way the facade sets it
    const c = await db.appPool.connect()
    try {
      await c.query('BEGIN')
      await c.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues({ role: 'system', name: 'pool-cell' }) })
      await c.query("INSERT INTO task_runs (name, agent, ts) VALUES ('pool-cell', 'agent-a', 1)")
      await c.query('COMMIT')
    } finally {
      c.release()
    }
    const seen = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM task_runs WHERE name = 'pool-cell'")
    expect(seen.rows[0].n).toBe(1)
  })

  it('the app pool parses the same types as the admin pool: an int8 is a number on both', async () => {
    const a = await db.appPool.query<{ n: unknown }>('SELECT 42::int8 AS n')
    const b = await db.pool.query<{ n: unknown }>('SELECT 42::int8 AS n')
    expect(a.rows[0].n).toBe(42)
    expect(b.rows[0].n).toBe(42)
  })
})

describe('appDbx()', () => {
  it('runs a lone statement as the app role', async () => {
    expect((await db.appDbx().get<{ u: string }>('SELECT current_user AS u'))!.u).toBe(PG_TEST_APP_ROLE)
  })

  it('runs a transaction body as the app role, and the work of the body is the app role writing', async () => {
    const dbx = db.appDbx()
    const u = await runAs.system('app-pool-cell', () => dbx.tx(async (tx) => {
      await tx.run("INSERT INTO task_runs (name, agent, ts) VALUES ('dbx-cell', 'agent-a', 2)")
      return (await tx.get<{ u: string }>('SELECT current_user AS u'))!.u
    }))
    expect(u).toBe(PG_TEST_APP_ROLE)
    const seen = await db.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM task_runs WHERE name = 'dbx-cell'")
    expect(seen.rows[0].n).toBe(1)
  })

  it('a statement that needs DDL rights fails through it with 42501 (the facade adds no rights)', async () => {
    await expect(db.appDbx().run('TRUNCATE task_runs')).rejects.toMatchObject({ code: '42501' })
  })

  it('every call is its own facade over the same app pool', () => {
    expect(db.appDbx()).not.toBe(db.appDbx())
  })
})
