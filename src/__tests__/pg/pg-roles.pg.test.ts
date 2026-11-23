// The roles of the PG test harness (src/__tests__/helpers/pg-test-db.ts): the template is built the way production will
// build it (an owner role holds the objects and runs the migrations, an app role serves with DML rights only), and the
// harness hands out an app-role pool next to the admin pool. Catalog cells, no data: what the roles ARE, before any
// policy exists. `npm run test:pg` (a real server, MARVEEN_PG_TEST_URL).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import {
  createPgTestDb, dropPgTemplate, pgTestUrl, PG_TEST_APP_ROLE, PG_TEST_BACKUP_ROLE, PG_TEST_OWNER_ROLE, type PgTestDb,
} from '../helpers/pg-test-db.js'

let db: PgTestDb
beforeAll(async () => { db = await createPgTestDb() })
afterAll(async () => { await db.close() })

interface RoleRow {
  rolname: string
  rolsuper: boolean
  rolcreatedb: boolean
  rolcreaterole: boolean
  rolreplication: boolean
  rolbypassrls: boolean
  rolcanlogin: boolean
}

describe('the three cluster roles', () => {
  it('exist with exactly the attributes the isolation design needs', async () => {
    const r = await db.pool.query<RoleRow>(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
         FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [[PG_TEST_OWNER_ROLE, PG_TEST_APP_ROLE, PG_TEST_BACKUP_ROLE]])
    const base = { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolcanlogin: true }
    expect(r.rows).toEqual([
      { rolname: PG_TEST_APP_ROLE, ...base, rolbypassrls: false },
      { rolname: PG_TEST_BACKUP_ROLE, ...base, rolbypassrls: true },
      { rolname: PG_TEST_OWNER_ROLE, ...base, rolbypassrls: false },
    ])
  })

  it('only the backup role may read past row-level security', async () => {
    const r = await db.pool.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1) AND rolbypassrls', [[PG_TEST_OWNER_ROLE, PG_TEST_APP_ROLE, PG_TEST_BACKUP_ROLE]])
    expect(r.rows.map((x) => x.rolname)).toEqual([PG_TEST_BACKUP_ROLE])
  })
})

describe('the template is built by the owner', () => {
  it('the database and every table, sequence and view in the public schema belong to the owner role', async () => {
    const dbOwner = await db.pool.query<{ o: string }>(
      'SELECT pg_get_userbyid(datdba) AS o FROM pg_database WHERE datname = current_database()')
    expect(dbOwner.rows[0].o).toBe(PG_TEST_OWNER_ROLE)
    const foreign = await db.pool.query<{ relname: string; o: string }>(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS o
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
          AND pg_get_userbyid(c.relowner) <> $1
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')`, [PG_TEST_OWNER_ROLE])
    expect(foreign.rows).toEqual([])
  })

  it('the schema_version rows were written by the migration runner as the owner (the baseline is there)', async () => {
    const n = await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM schema_version')
    expect(n.rows[0].n).toBeGreaterThan(0)
  })
})

describe('the app role', () => {
  it('is no superuser, does not bypass row-level security, owns no table and no schema and no database', async () => {
    const me = await db.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [PG_TEST_APP_ROLE])
    expect(me.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false })
    const owned = await db.pool.query<{ what: string }>(
      `SELECT 'class:' || c.relname AS what FROM pg_class c WHERE pg_get_userbyid(c.relowner) = $1
       UNION ALL SELECT 'schema:' || nspname FROM pg_namespace WHERE pg_get_userbyid(nspowner) = $1
       UNION ALL SELECT 'database:' || datname FROM pg_database WHERE pg_get_userbyid(datdba) = $1`, [PG_TEST_APP_ROLE])
    expect(owned.rows).toEqual([])
  })

  it('has no TRUNCATE, REFERENCES or TRIGGER on any table, and no CREATE on the schema or the database', async () => {
    const r = await db.pool.query<{ relname: string; priv: string }>(
      `SELECT c.relname, p.priv
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND has_table_privilege($1, c.oid, p.priv)`, [PG_TEST_APP_ROLE])
    expect(r.rows).toEqual([])
    const create = await db.pool.query<{ schema_create: boolean; database_create: boolean }>(
      `SELECT has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
              has_database_privilege($1, current_database(), 'CREATE') AS database_create`, [PG_TEST_APP_ROLE])
    expect(create.rows[0]).toEqual({ schema_create: false, database_create: false })
  })

  it('has the four DML grants on every baseline table and USAGE+SELECT on every sequence', async () => {
    const tables = await db.pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND NOT (has_table_privilege($1, c.oid, 'SELECT') AND has_table_privilege($1, c.oid, 'INSERT')
               AND has_table_privilege($1, c.oid, 'UPDATE') AND has_table_privilege($1, c.oid, 'DELETE'))`, [PG_TEST_APP_ROLE])
    expect(tables.rows).toEqual([])
    const seqs = await db.pool.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'S'
          AND NOT (has_sequence_privilege($1, c.oid, 'USAGE') AND has_sequence_privilege($1, c.oid, 'SELECT'))`, [PG_TEST_APP_ROLE])
    expect(seqs.rows).toEqual([])
    // not vacuous: the baseline has tables and identity sequences to be checked
    const counts = await db.pool.query<{ t: number; s: number }>(
      `SELECT count(*) FILTER (WHERE c.relkind IN ('r', 'p'))::int AS t, count(*) FILTER (WHERE c.relkind = 'S')::int AS s
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'`)
    expect(counts.rows[0].t).toBeGreaterThan(80)
    expect(counts.rows[0].s).toBeGreaterThan(0)
  })

  it('can take a number from a baseline sequence (USAGE is real, not only in the catalog)', async () => {
    const seq = await db.pool.query<{ s: string }>("SELECT pg_get_serial_sequence('task_runs', 'id') AS s")
    expect(seq.rows[0].s).toBeTruthy()
    const n = await db.appPool.query<{ v: string }>('SELECT nextval($1::regclass) AS v', [seq.rows[0].s])
    expect(Number(n.rows[0].v)).toBeGreaterThan(0)
  })

  it('writes and reads a baseline table through its own pool (DML works without owning anything)', async () => {
    await db.appPool.query("INSERT INTO task_runs (name, agent, ts) VALUES ('role-cell', 'agent-a', 1)")
    const r = await db.appPool.query<{ n: number }>("SELECT count(*)::int AS n FROM task_runs WHERE name = 'role-cell'")
    expect(r.rows[0].n).toBe(1)
    await db.appPool.query("UPDATE task_runs SET agent = 'agent-b' WHERE name = 'role-cell'")
    await db.appPool.query("DELETE FROM task_runs WHERE name = 'role-cell'")
  })

  it('cannot create an object, truncate a table or drop one (no DDL rights)', async () => {
    await expect(db.appPool.query('CREATE TABLE app_made (id int)')).rejects.toMatchObject({ code: '42501' })
    await expect(db.appPool.query('TRUNCATE task_runs')).rejects.toMatchObject({ code: '42501' })
    await expect(db.appPool.query('DROP TABLE task_runs')).rejects.toMatchObject({ code: '42501' })
  })

  it('reads a table the owner creates later (the default privileges are in the template)', async () => {
    await db.ownerPool.query('CREATE TABLE later_table (id bigint GENERATED BY DEFAULT AS IDENTITY, v text)')
    await db.ownerPool.query("INSERT INTO later_table (v) VALUES ('x')")
    const r = await db.appPool.query<{ v: string }>('SELECT v FROM later_table')
    expect(r.rows).toEqual([{ v: 'x' }])
    await db.appPool.query("INSERT INTO later_table (v) VALUES ('y')")
    const seq = await db.pool.query<{ s: string }>("SELECT pg_get_serial_sequence('later_table', 'id') AS s")
    expect(Number((await db.appPool.query<{ v: string }>('SELECT nextval($1::regclass) AS v', [seq.rows[0].s])).rows[0].v)).toBeGreaterThan(0)
    await expect(db.appPool.query('TRUNCATE later_table')).rejects.toMatchObject({ code: '42501' })
  })
})

describe('what the template provisioning does and does not touch', () => {
  it('an EMPTY template stays empty: no extension is created for a baseline without a file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pg-roles-empty-'))
    const empty = await createPgTestDb({ migrationsDir: dir })
    try {
      const n = await empty.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_extension WHERE extname IN ('unaccent', 'vector')")
      expect(n.rows[0].n).toBe(0)
      // the roles and the owner are still the harness's: only the extensions depend on a baseline
      const owner = await empty.pool.query<{ o: string }>('SELECT pg_get_userbyid(datdba) AS o FROM pg_database WHERE datname = current_database()')
      expect(owner.rows[0].o).toBe(PG_TEST_OWNER_ROLE)
    } finally {
      await empty.close()
      await dropPgTemplate(empty.template)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a role whose attributes drifted is corrected, and its password is left exactly as it was', async () => {
    const admin = new pg.Client({ connectionString: pgTestUrl() })
    await admin.connect()
    try {
      const hash = async (): Promise<string> =>
        (await admin.query<{ h: string }>('SELECT rolpassword AS h FROM pg_authid WHERE rolname = $1', [PG_TEST_OWNER_ROLE])).rows[0].h
      const before = await hash()
      expect(before).toBeTruthy()
      await admin.query(`ALTER ROLE ${PG_TEST_OWNER_ROLE} CREATEDB`) // an attribute only this file looks at
      const again = await createPgTestDb()
      try {
        const r = await admin.query<{ rolcreatedb: boolean }>('SELECT rolcreatedb FROM pg_roles WHERE rolname = $1', [PG_TEST_OWNER_ROLE])
        expect(r.rows[0].rolcreatedb).toBe(false)
        // a re-salted hash would differ: the SCRAM verifier is built with a fresh salt on every PASSWORD
        expect(await hash()).toBe(before)
      } finally {
        await again.close()
      }
    } finally {
      await admin.end()
    }
  })
})
