// The ORDER of the tenant context on a real server (the parked item G3): the five settings are in force for the FIRST work
// statement and survive what dbx does around it (BEGIN, SAVEPOINT, ROLLBACK TO SAVEPOINT, COMMIT, a connection that is
// reused). Only a real server shows it: a policy reads the settings when the statement is planned, so a context set one
// statement too late is a wrong answer, not an error.
//
// The table is test-local (created by the owner pool in the cell, not a baseline table) with a HAND-WRITTEN policy; the
// migration that enables row-level security on the real tables replaces it with the real helpers. The claims go through
// the app pool: the owner would be subject to the policy only with FORCE (set here, as production will), the admin is
// never subject to it and seeds and judges the rows (the oracle). `npm run test:pg`.
//
// Privacy: neutral fixtures only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import pg from 'pg'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { createPgDbx } from '../../db/pg/dbx.js'
import { pgTypes } from '../../db/pg/types.js'
import { runAs } from '../../db/context.js'
import type { Tx } from '../../db/facade.js'

let db: PgTestDb
const TABLE = 'g3_items'
const READ = `SELECT id FROM ${TABLE} ORDER BY id`

beforeAll(async () => {
  db = await createPgTestDb()
  await db.ownerPool.query(`CREATE TABLE ${TABLE} (id text PRIMARY KEY, tenant_id text NOT NULL)`)
  await db.ownerPool.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`)
  await db.ownerPool.query(`ALTER TABLE ${TABLE} FORCE ROW LEVEL SECURITY`)
  // the tenant of the row is the tenant of the context; the role system (a privileged branch) sees and writes every row.
  // current_setting(..., true) is NULL on a connection that never set it and '' after a set_config: both match nothing.
  await db.ownerPool.query(
    `CREATE POLICY g3_isolation ON ${TABLE}
       USING (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.role', true) = 'system')
       WITH CHECK (tenant_id = current_setting('app.tenant_id', true) OR current_setting('app.role', true) = 'system')`)
})
afterAll(async () => { await db.close() })

// the oracle (the admin pool is not subject to the policy) puts the same three rows back before every cell
beforeEach(async () => {
  await db.pool.query(`DELETE FROM ${TABLE}`)
  await db.pool.query(`INSERT INTO ${TABLE} (id, tenant_id) VALUES ('a1', 'tenant-a'), ('a2', 'tenant-a'), ('b1', 'tenant-b')`)
})

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id)

type Ctx = { name: string; run: <T>(fn: () => Promise<T>) => Promise<T>; sees: string[] }
const CONTEXTS: Ctx[] = [
  { name: 'tenant A', run: (fn) => runAs.tenant('tenant-a', fn), sees: ['a1', 'a2'] },
  { name: 'tenant B', run: (fn) => runAs.tenant('tenant-b', fn), sees: ['b1'] },
  { name: 'no context (fail closed)', run: (fn) => fn(), sees: [] },
  { name: 'role system (the privileged branch)', run: (fn) => runAs.system('g3-cell', fn), sees: ['a1', 'a2', 'b1'] },
]

describe('G3 cell 1: the first work statement already sees the context', () => {
  it.each(CONTEXTS)('a lone statement, $name', async ({ run, sees }) => {
    const dbx = db.appDbx()
    expect(ids(await run(() => dbx.all<{ id: string }>(READ)))).toEqual(sees)
  })

  it.each(CONTEXTS)('the first statement of a transaction body, $name', async ({ run, sees }) => {
    const dbx = db.appDbx()
    const seen = await run(() => dbx.tx(async (tx: Tx) => tx.all<{ id: string }>(READ)))
    expect(ids(seen)).toEqual(sees)
  })

  it.each(CONTEXTS)('the first statement of a SAVEPOINT child body, $name', async ({ run, sees }) => {
    const dbx = db.appDbx()
    const seen = await run(() => dbx.tx(async (tx: Tx) => tx.tx(async (child: Tx) => child.all<{ id: string }>(READ))))
    expect(ids(seen)).toEqual(sees)
  })
})

describe('G3 cell 2: a nested runAs inside an open transaction keeps the tenant the transaction started with', () => {
  it('a read in a body that enters runAs.tenant(B) still sees tenant A rows only', async () => {
    const dbx = db.appDbx()
    const seen = await runAs.tenant('tenant-a', () =>
      dbx.tx(async (tx: Tx) => runAs.tenant('tenant-b', () => tx.all<{ id: string }>(READ))))
    expect(ids(seen)).toEqual(['a1', 'a2'])
  })

  it('a write stamped B in that body is refused by the policy (42501), a write stamped A is accepted', async () => {
    const dbx = db.appDbx()
    await runAs.tenant('tenant-a', () =>
      dbx.tx(async (tx: Tx) => {
        await runAs.tenant('tenant-b', async () => {
          // a savepoint, so the refused statement does not abort the whole transaction
          await expect(tx.tx((c: Tx) => c.run(`INSERT INTO ${TABLE} (id, tenant_id) VALUES ('x-b', 'tenant-b')`)))
            .rejects.toMatchObject({ code: '42501' })
          await tx.run(`INSERT INTO ${TABLE} (id, tenant_id) VALUES ('x-a', 'tenant-a')`)
        })
      }))
    // the oracle: the refused row is not there, the accepted one is
    const rows = await db.pool.query<{ id: string }>(`SELECT id FROM ${TABLE} WHERE id LIKE 'x-%' ORDER BY id`)
    expect(ids(rows.rows)).toEqual(['x-a'])
  })
})

describe('G3 cell 3: a failing inner SAVEPOINT does not undo the context', () => {
  it('after a failing statement in the child body (ROLLBACK TO SAVEPOINT) the outer body still sees tenant A', async () => {
    const dbx = db.appDbx()
    const after = await runAs.tenant('tenant-a', () =>
      dbx.tx(async (tx: Tx) => {
        // a unique violation inside the savepoint: the child is undone alone
        await expect(tx.tx((c: Tx) => c.run(`INSERT INTO ${TABLE} (id, tenant_id) VALUES ('a1', 'tenant-a')`)))
          .rejects.toMatchObject({ code: '23505' })
        return tx.all<{ id: string }>(READ)
      }))
    expect(ids(after)).toEqual(['a1', 'a2'])
  })

  it('and after a child body that threw after its own statement, a second child and the outer body both still see tenant A', async () => {
    const dbx = db.appDbx()
    const out = await runAs.tenant('tenant-a', () =>
      dbx.tx(async (tx: Tx) => {
        await expect(tx.tx(async (c: Tx) => { await c.all(READ); throw new Error('child failed') })).rejects.toThrow('child failed')
        const second = await tx.tx((c: Tx) => c.all<{ id: string }>(READ))
        const outer = await tx.all<{ id: string }>(READ)
        return { second: ids(second), outer: ids(outer) }
      }))
    expect(out).toEqual({ second: ['a1', 'a2'], outer: ['a1', 'a2'] })
  })
})

describe('G3 cell 4: a pool of ONE connection, two concurrent contexts', () => {
  let one: pg.Pool
  beforeEach(() => { one = new pg.Pool({ connectionString: db.appUrl, types: pgTypes, max: 1 }) })
  afterEach(async () => { await one.end() })

  it('the second runAs queues behind the first on the one connection, and each sees only its own rows', async () => {
    const dbx = createPgDbx(one)
    const [a, b] = await Promise.all([
      runAs.tenant('tenant-a', () => dbx.tx(async (tx: Tx) => {
        const rows = await tx.all<{ id: string }>(READ)
        await new Promise((r) => setTimeout(r, 30)) // the other transaction is waiting for this connection meanwhile
        return rows
      })),
      runAs.tenant('tenant-b', () => dbx.tx(async (tx: Tx) => tx.all<{ id: string }>(READ))),
    ])
    expect(ids(a)).toEqual(['a1', 'a2'])
    expect(ids(b)).toEqual(['b1'])
  })

  it('after the COMMIT the setting on that connection is the EMPTY STRING, not unset (what a NULLIF in the real policy depends on)', async () => {
    // a connection that never set it: unset (NULL)
    const fresh = await one.query<{ v: string | null }>("SELECT current_setting('app.tenant_id', true) AS v")
    expect(fresh.rows[0].v).toBeNull()
    const dbx = createPgDbx(one)
    // an agent context fills tenant, role and agent; a system context fills role and job: the four named settings all carried a value
    await runAs.agent('agent-a', 'tenant-a', () => dbx.get('SELECT 1 AS one'))
    await runAs.system('g3-cell', () => dbx.get('SELECT 1 AS one'))
    // the same single connection, outside any transaction: the transaction-local values are gone, the names are not
    const after = await one.query<Record<string, string | null>>(
      `SELECT current_setting('app.tenant_id', true) AS tenant_id, current_setting('app.role', true) AS role,
              current_setting('app.agent_id', true) AS agent_id, current_setting('app.job', true) AS job`)
    expect(after.rows[0]).toEqual({ tenant_id: '', role: '', agent_id: '', job: '' })
  })

  it('a tenant that ran on the connection leaves nothing for the next statement without a context', async () => {
    const dbx = createPgDbx(one)
    await runAs.tenant('tenant-a', () => dbx.all(READ))
    expect(ids(await dbx.all<{ id: string }>(READ))).toEqual([])
  })
})
