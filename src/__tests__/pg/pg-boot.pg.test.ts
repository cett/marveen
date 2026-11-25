// The PostgreSQL boot (db/pg-boot.ts) against a live server: the success path, and a refusal per step that needs one
// (schema, preflight, caches). The steps that need no server (url, pool) are in ../pg-boot-refusal.test.ts.
// Each refusal must leave nothing behind: the facade back on SQLite, the pool ended (no session left on the database),
// and the next boot attempt a fresh one.
//
// Privacy: neutral fixtures only.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPgTestDb, pgTestUrl, PG_TEST_APP_ROLE, PG_TEST_OWNER_ROLE, type PgTestDb } from '../helpers/pg-test-db.js'
import { bootPgBackend, closePgBackend, PgBootError } from '../../db/pg-boot.js'
import { pgRolePreflight } from '../../db/pg/preflight.js'
import { dbxDialect, useDbxBackend } from '../../db/facade.js'
import { runAs } from '../../db/context.js'
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
    const result = await bootPgBackend({ url: db.appUrl })
    expect(dbxDialect()).toBe('pg')
    expect(result.migrations.applied).toEqual([])
    expect(result.migrations.alreadyApplied).toBe(loadPgMigrationFiles().length)
    // a synchronous cache reader answers (it throws "cache not loaded in PG mode" when nothing was loaded for this backend)
    expect(Array.isArray(listSystemConfig())).toBe(true)
    // and the write goes to the server, then the cache
    // system_config is privileged-only under row-level security: the write and the read-back run as the system context
    await runAs.system('pg-boot-cell', async () => {
      await setSystemConfig('pg_boot_probe', 'v1')
      expect(getSystemConfig('pg_boot_probe')?.value).toBe('v1')
      expect((await dbx.get<{ value: string }>('SELECT value FROM system_config WHERE key = ?', 'pg_boot_probe'))?.value).toBe('v1')
    })
  })

  it('migrates a fresh database BEFORE the preflight: the migrations create the extensions the preflight demands', async () => {
    const db = await emptyDb()
    // the admin URL is the migration URL here: only an admin may create the extensions (the owner-only run is the next describe).
    // The serving role is the app role (the role step refuses an admin), so what the admin's migrations create must be
    // readable by it: the admin's default privileges, for this database only, give it what the owner's do in the harness
    await sql(db,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${PG_TEST_APP_ROLE}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${PG_TEST_APP_ROLE}`)
    const result = await bootPgBackend({ url: db.appUrl, migrateUrl: db.url })
    expect(result.migrations.applied.length).toBe(loadPgMigrationFiles().length)
    expect(dbxDialect()).toBe('pg')
    expect(Array.isArray(listSystemConfig())).toBe(true)
  })

  it('closePgBackend puts the facade back on SQLite and ends the pool', async () => {
    const db = await baselineDb()
    await bootPgBackend({ url: db.appUrl })
    await closePgBackend()
    expect(dbxDialect()).toBe('sqlite')
    expect(await sessionsOn(db)).toBe(0)
  })

  it('a cache filled under one backend epoch is not served under the next: the reader refuses until it is loaded again', async () => {
    const db = await baselineDb()
    await bootPgBackend({ url: db.appUrl })
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

  it('a second boot while one is active is refused, not stacked', async () => {
    const db = await baselineDb()
    await bootPgBackend({ url: db.appUrl })
    await expect(bootPgBackend({ url: db.appUrl })).rejects.toThrow(/already booted/)
    expect(dbxDialect()).toBe('pg')
  })
})

/** Sessions of one role on the database (polled: a closed session leaves a moment later). */
async function sessionsOfRole(db: PgTestDb, role: string): Promise<number> {
  const admin = new pg.Client({ connectionString: pgTestUrl() })
  await admin.connect()
  try {
    let n = -1
    for (let i = 0; i < 40; i++) {
      n = Number((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND usename = $2', [db.name, role])).rows[0]!.n)
      if (n === 0) break
      await new Promise((r) => setTimeout(r, 50))
    }
    return n
  } finally {
    await admin.end()
  }
}

describe('bootPgBackend: the boot split (the serving pool is the app role, the migration pool is the owner and is gone)', () => {
  it('with a migration URL a fresh database boots, and the serving pool is the app role', async () => {
    const db = await emptyDb()
    // provisioning, as the admin (the migrations keep their IF NOT EXISTS: a no-op for the owner)
    await sql(db, 'CREATE EXTENSION IF NOT EXISTS unaccent', 'CREATE EXTENSION IF NOT EXISTS vector')
    const result = await bootPgBackend({ url: db.appUrl, migrateUrl: db.ownerUrl })
    expect(result.migrations.applied.length).toBe(loadPgMigrationFiles().length)
    expect(dbxDialect()).toBe('pg')
    expect((await dbx.get<{ u: string }>('SELECT current_user AS u'))!.u).toBe(PG_TEST_APP_ROLE)
    // the objects the migrations made belong to the owner, not to the role that serves
    const owners = await dbx.get<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user")
    expect(owners!.n).toBe(0)
  })

  it('the migration pool is ended before the boot returns: the owner holds no connection', async () => {
    const db = await emptyDb()
    await sql(db, 'CREATE EXTENSION IF NOT EXISTS unaccent', 'CREATE EXTENSION IF NOT EXISTS vector')
    await bootPgBackend({ url: db.appUrl, migrateUrl: db.ownerUrl })
    expect(dbxDialect()).toBe('pg')
    expect(await sessionsOfRole(db, PG_TEST_OWNER_ROLE)).toBe(0)
  })

  it('the migration pool is ended when the migration fails, too', async () => {
    const db = await baselineDb()
    await sql(db, "UPDATE schema_version SET checksum = 'drifted' WHERE version = 1")
    const err = await refusalOf(bootPgBackend({ url: db.appUrl, migrateUrl: db.ownerUrl }))
    expect(err!.step).toBe('schema')
    expect(await sessionsOfRole(db, PG_TEST_OWNER_ROLE)).toBe(0)
  })

  it('without a migration URL a database that is current boots, as the app role', async () => {
    const db = await baselineDb()
    const result = await bootPgBackend({ url: db.appUrl, migrateUrl: '' })
    expect(result.migrations.applied).toEqual([])
    expect(result.migrations.alreadyApplied).toBe(loadPgMigrationFiles().length)
    expect((await dbx.get<{ u: string }>('SELECT current_user AS u'))!.u).toBe(PG_TEST_APP_ROLE)
  })

  it('without a migration URL a database one file behind refuses at "schema", says how many, and fixes nothing', async () => {
    const db = await baselineDb()
    const files = loadPgMigrationFiles()
    await sql(db, `DELETE FROM schema_version WHERE version = ${files[files.length - 1]!.version}`)
    const err = await refusalOf(bootPgBackend({ url: db.appUrl, migrateUrl: '' }))
    expect(err).toBeInstanceOf(PgBootError)
    expect(err!.step).toBe('schema')
    expect(err!.message).toMatch(/1 migration file\(s\) are not applied/)
    expect(err!.message).not.toContain(db.appUrl)
    expect(dbxDialect()).toBe('sqlite')
    expect(await sessionsOn(db)).toBe(0)
    // nothing was applied by the refused boot: the row is still missing
    const c = new pg.Client({ connectionString: db.url })
    await c.connect()
    try {
      expect((await c.query('SELECT count(*)::int AS n FROM schema_version')).rows[0].n).toBe(files.length - 1)
    } finally { await c.end() }
  })

  it('a wrong migration URL refuses at "schema", and neither password is in the message', async () => {
    const db = await baselineDb()
    const wrong = new URL(db.ownerUrl)
    // a role that does not exist fails on every server, whatever its authentication method (a trust rule would accept a wrong password)
    wrong.username = 'marveen_missing_owner'
    wrong.password = 'not-the-owner-password'
    const err = await refusalOf(bootPgBackend({ url: db.appUrl, migrateUrl: wrong.toString() }))
    expect(err).toBeInstanceOf(PgBootError)
    expect(err!.step).toBe('schema')
    for (const text of [err!.message, JSON.stringify({ message: err!.cause instanceof Error ? err!.cause.message : '', stack: err!.cause instanceof Error ? err!.cause.stack : '' })]) {
      expect(text).not.toContain('not-the-owner-password')
      expect(text).not.toContain(new URL(db.appUrl).password)
      expect(text).not.toContain(new URL(db.ownerUrl).password)
      expect(text).not.toContain(wrong.toString())
    }
    expect(dbxDialect()).toBe('sqlite')
    expect(await sessionsOn(db)).toBe(0)
  })
})

// The role step (RLS step S2, c3). The three conditions are separate roles, each one failing ONLY its own condition, so a
// mutant that drops one condition turns exactly its cell red: the bootstrap superuser would not do for the superuser cell
// (it carries BYPASSRLS as well, so the BYPASSRLS condition alone would still refuse it). A CREATE ROLE is cluster-level and two
// workers share the server: the names carry the process id and are dropped afterwards.
describe('bootPgBackend: the role step (the serving role must be one that row-level security binds)', () => {
  const SU_ROLE = `marveen_t_su_${process.pid}`
  const BYPASS_ROLE = `marveen_t_byp_${process.pid}`
  // members of a privileged role: each one is itself NOSUPERUSER NOBYPASSRLS and owns nothing, so only the membership can refuse it
  const MEMBER_OWNER_ROLE = `marveen_t_mo_${process.pid}`
  const MEMBER_SU_ROLE = `marveen_t_ms_${process.pid}`
  const MEMBER_BYPASS_ROLE = `marveen_t_mb_${process.pid}`
  // a member WITHOUT inheritance: it has none of the superuser's rights until it runs SET ROLE, which is exactly why any membership counts
  const MEMBER_NOINHERIT_ROLE = `marveen_t_mn_${process.pid}`
  // the same for the OWNER role: no inherited rights, but SET ROLE makes the session the owner, whom the policies do not bind
  const MEMBER_OWNER_NOINHERIT_ROLE = `marveen_t_mp_${process.pid}`
  // CREATEROLE alone (hardening: on PostgreSQL 16 it hands out nothing it does not administer, on older majors it could)
  const CREATEROLE_ROLE = `marveen_t_cr_${process.pid}`
  // a login whose startup option drops it to the app role: current_user is clean, the login role is a member of the owner role
  const SESSION_OWNER_ROLE = `marveen_t_sx_${process.pid}`
  // members of the three built-in roles that reach the server host
  const REACH_BUILTINS = ['pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files'] as const
  const reachRole = (builtin: string): string => `marveen_t_${builtin.slice(3, 7)}_${process.pid}`
  // owns a table of ANOTHER schema only (not the connection's current schema): the owned count is about every non-system schema
  const OTHER_SCHEMA_ROLE = `marveen_t_os_${process.pid}`
  const OTHER_SCHEMA = `t_other_${process.pid}`
  const EMPTY_SCHEMA = `t_empty_${process.pid}`
  const ROLE_PASSWORD = 'harness-only-role-cell'
  // members first: the order the roles are dropped in (a membership goes with either role, but a clear order costs nothing)
  const ROLES = [MEMBER_OWNER_ROLE, MEMBER_SU_ROLE, MEMBER_BYPASS_ROLE, MEMBER_NOINHERIT_ROLE, MEMBER_OWNER_NOINHERIT_ROLE, CREATEROLE_ROLE, SESSION_OWNER_ROLE,
    ...REACH_BUILTINS.map(reachRole), OTHER_SCHEMA_ROLE, SU_ROLE, BYPASS_ROLE]

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: pgTestUrl() })
    await admin.connect()
    try {
      for (const role of ROLES) await admin.query(`DROP ROLE IF EXISTS ${role}`)
      await admin.query(`CREATE ROLE ${SU_ROLE} LOGIN SUPERUSER NOBYPASSRLS PASSWORD '${ROLE_PASSWORD}'`)
      await admin.query(`CREATE ROLE ${BYPASS_ROLE} LOGIN NOSUPERUSER BYPASSRLS PASSWORD '${ROLE_PASSWORD}'`)
      const plain = `LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${ROLE_PASSWORD}'`
      await admin.query(`CREATE ROLE ${MEMBER_OWNER_ROLE} ${plain} IN ROLE ${PG_TEST_OWNER_ROLE}`)
      await admin.query(`CREATE ROLE ${MEMBER_SU_ROLE} ${plain} IN ROLE ${SU_ROLE}`)
      await admin.query(`CREATE ROLE ${MEMBER_BYPASS_ROLE} ${plain} IN ROLE ${BYPASS_ROLE}`)
      await admin.query(`CREATE ROLE ${MEMBER_NOINHERIT_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${ROLE_PASSWORD}' IN ROLE ${SU_ROLE}`)
      await admin.query(`CREATE ROLE ${MEMBER_OWNER_NOINHERIT_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${ROLE_PASSWORD}' IN ROLE ${PG_TEST_OWNER_ROLE}`)
      await admin.query(`CREATE ROLE ${CREATEROLE_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD '${ROLE_PASSWORD}'`)
      // a member of the owner role AND of the app role (so a startup option may drop it to the app role)
      await admin.query(`CREATE ROLE ${SESSION_OWNER_ROLE} ${plain} IN ROLE ${PG_TEST_OWNER_ROLE}, ${PG_TEST_APP_ROLE}`)
      for (const builtin of REACH_BUILTINS) await admin.query(`CREATE ROLE ${reachRole(builtin)} ${plain} IN ROLE ${builtin}`)
      await admin.query(`CREATE ROLE ${OTHER_SCHEMA_ROLE} ${plain}`)
    } finally {
      await admin.end()
    }
  })

  afterAll(async () => {
    const admin = new pg.Client({ connectionString: pgTestUrl() })
    await admin.connect()
    try {
      for (const role of ROLES) await admin.query(`DROP ROLE IF EXISTS ${role}`)
    } finally {
      await admin.end()
    }
  })

  const roleUrl = (db: PgTestDb, role: string): string => {
    const u = new URL(db.url)
    u.username = role
    u.password = ROLE_PASSWORD
    return u.toString()
  }

  /** What pgRolePreflight says of a pool connected as the given URL (null = accepted). */
  async function verdictOf(url: string): Promise<string | null> {
    const pool = new pg.Pool({ connectionString: url, max: 1 })
    try {
      await pgRolePreflight(pool)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    } finally {
      await pool.end()
    }
  }

  it('the verdict is the role: the app role is accepted, a superuser, a BYPASSRLS role and the owner each get their own message', async () => {
    const db = await baselineDb()
    expect(await verdictOf(db.appUrl)).toBeNull()
    expect(await verdictOf(roleUrl(db, SU_ROLE))).toMatch(/is a superuser/)
    expect(await verdictOf(roleUrl(db, BYPASS_ROLE))).toMatch(/has BYPASSRLS/)
    expect(await verdictOf(db.ownerUrl)).toMatch(/owns a table in the database/)
  })

  it('a MEMBER of a privileged role is refused: of the owner role with the owner message, of a superuser or a BYPASSRLS role with the SET ROLE message', async () => {
    const db = await baselineDb()
    expect(await verdictOf(roleUrl(db, MEMBER_OWNER_ROLE))).toMatch(/owns a table in the database, or is a member of the role that does/)
    expect(await verdictOf(roleUrl(db, MEMBER_OWNER_NOINHERIT_ROLE))).toMatch(/owns a table in the database, or is a member of the role that does/)
    expect(await verdictOf(roleUrl(db, MEMBER_SU_ROLE))).toMatch(/member of a role that is a superuser or has BYPASSRLS/)
    expect(await verdictOf(roleUrl(db, MEMBER_BYPASS_ROLE))).toMatch(/member of a role that is a superuser or has BYPASSRLS/)
    expect(await verdictOf(roleUrl(db, MEMBER_NOINHERIT_ROLE))).toMatch(/member of a role that is a superuser or has BYPASSRLS/)
    // the app role is in none of those groups
    expect(await verdictOf(db.appUrl)).toBeNull()
  })

  it('a role that owns a table of ANOTHER schema only is refused: the owned count covers every non-system schema, not the current one', async () => {
    const db = await baselineDb()
    await sql(db, `CREATE SCHEMA ${OTHER_SCHEMA}`, `CREATE TABLE ${OTHER_SCHEMA}.o_t (id int)`, `ALTER TABLE ${OTHER_SCHEMA}.o_t OWNER TO ${OTHER_SCHEMA_ROLE}`)
    try {
      expect(await verdictOf(roleUrl(db, OTHER_SCHEMA_ROLE))).toMatch(/owns a table in the database/)
    } finally {
      // the role must own nothing when the roles are dropped at the end
      await sql(db, `DROP SCHEMA ${OTHER_SCHEMA} CASCADE`)
    }
  })

  it('an owner login whose search_path starts with an EMPTY schema is refused too (the owner\'s tables are in public, out of sight of current_schema())', async () => {
    const db = await baselineDb()
    // USAGE for everyone: current_schema() skips a schema the role cannot use, and then the construction would not be the one under test
    await sql(db, `CREATE SCHEMA ${EMPTY_SCHEMA}`, `GRANT USAGE ON SCHEMA ${EMPTY_SCHEMA} TO PUBLIC`)
    try {
      for (const path of [`${EMPTY_SCHEMA},public`, EMPTY_SCHEMA]) {
        const u = new URL(db.ownerUrl)
        u.searchParams.set('options', `-c search_path=${path}`)
        // the construction is real: the current schema is the empty one (a cell that only saw public would pass for the wrong reason)
        const probe = new pg.Client({ connectionString: u.toString() })
        await probe.connect()
        try {
          expect((await probe.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s).toBe(EMPTY_SCHEMA)
        } finally { await probe.end() }
        expect(await verdictOf(u.toString())).toMatch(/owns a table in the database/)
      }
    } finally {
      await sql(db, `DROP SCHEMA ${EMPTY_SCHEMA}`)
    }
  })

  it('an owner login whose search_path names NO existing schema is refused: current_schema() is NULL there, and "= NULL" is never true', async () => {
    const db = await baselineDb()
    const u = new URL(db.ownerUrl)
    u.searchParams.set('options', '-c search_path=t_no_such_schema')
    // the construction is real: the current schema is NULL (this is the case where a current_schema() filter matched nothing)
    const probe = new pg.Client({ connectionString: u.toString() })
    await probe.connect()
    try {
      expect((await probe.query<{ s: string | null }>('SELECT current_schema() AS s')).rows[0]!.s).toBeNull()
    } finally { await probe.end() }
    expect(await verdictOf(u.toString())).toMatch(/owns a table in the database/)
    // and the plain app login stays accepted
    expect(await verdictOf(db.appUrl)).toBeNull()
  })

  it('a temporary table of ANOTHER session of the app role is not an owned table: the pg_* schemas are skipped', async () => {
    const db = await baselineDb()
    // the app role holds an open session with a temporary table (it lives in a pg_temp_N schema that pg_tables lists)
    const holder = new pg.Client({ connectionString: db.appUrl })
    await holder.connect()
    try {
      await holder.query('CREATE TEMP TABLE t_scratch (id int)')
      const seen = await holder.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 't_scratch' AND tableowner = current_user")
      expect(seen.rows[0]!.n).toBe(1)
      expect(await verdictOf(db.appUrl)).toBeNull()
    } finally { await holder.end() }
  })

  it('a role with CREATEROLE is refused with its own message (hardening on PostgreSQL 16)', async () => {
    const db = await baselineDb()
    expect(await verdictOf(roleUrl(db, CREATEROLE_ROLE))).toMatch(/has CREATEROLE/)
  })

  it.each(REACH_BUILTINS.map((b) => [b] as const))('a member of the built-in role %s (a reach into the server host) is refused', async (builtin) => {
    const db = await baselineDb()
    expect(await verdictOf(roleUrl(db, reachRole(builtin)))).toMatch(/member of a built-in role that reaches the server host/)
  })

  /** The URL with a startup option that drops the session to the app role: the login role stays what it was. */
  const asAppRole = (url: string): string => {
    const u = new URL(url)
    u.searchParams.set('options', `-c role=${PG_TEST_APP_ROLE}`)
    return u.toString()
  }

  it('the LOGIN role is judged too: a privileged login that starts as the app role is refused, whichever way it is privileged', async () => {
    const db = await baselineDb()
    // the construction is real: current_user is the app role, session_user is the login role (a vacuous cell would pass anyway)
    const probe = new pg.Client({ connectionString: asAppRole(roleUrl(db, SU_ROLE)) })
    await probe.connect()
    try {
      const who = (await probe.query<{ cu: string; su: string }>('SELECT current_user AS cu, session_user AS su')).rows[0]!
      expect(who).toEqual({ cu: PG_TEST_APP_ROLE, su: SU_ROLE })
    } finally { await probe.end() }
    expect(await verdictOf(asAppRole(roleUrl(db, SU_ROLE)))).toMatch(/login role of the session is a superuser/)
    expect(await verdictOf(asAppRole(roleUrl(db, SESSION_OWNER_ROLE)))).toMatch(/login role of the session owns a table in the database, or is a member/)
    // and the plain app login is judged twice with the same, clean answer
    expect(await verdictOf(db.appUrl)).toBeNull()
  })

  it('the superuser condition is checked first: the bootstrap-style admin (superuser AND BYPASSRLS) is named a superuser', async () => {
    const db = await baselineDb()
    expect(await verdictOf(db.url)).toMatch(/is a superuser/)
  })

  it.each([
    ['a superuser', (db: PgTestDb) => roleUrl(db, SU_ROLE), /is a superuser/],
    ['a BYPASSRLS role', (db: PgTestDb) => roleUrl(db, BYPASS_ROLE), /has BYPASSRLS/],
    ['the owner role', (db: PgTestDb) => db.ownerUrl, /owns a table in the database/],
    ['a member of the owner role', (db: PgTestDb) => roleUrl(db, MEMBER_OWNER_ROLE), /owns a table in the database, or is a member/],
    ['a member of the owner role without inheritance', (db: PgTestDb) => roleUrl(db, MEMBER_OWNER_NOINHERIT_ROLE), /owns a table in the database, or is a member/],
    ['a CREATEROLE role', (db: PgTestDb) => roleUrl(db, CREATEROLE_ROLE), /has CREATEROLE/],
    ['a superuser login that starts as the app role', (db: PgTestDb) => asAppRole(roleUrl(db, SU_ROLE)), /login role of the session is a superuser/],
    ['a member of a superuser role', (db: PgTestDb) => roleUrl(db, MEMBER_SU_ROLE), /member of a role that is a superuser or has BYPASSRLS/],
    ['a member of a BYPASSRLS role', (db: PgTestDb) => roleUrl(db, MEMBER_BYPASS_ROLE), /member of a role that is a superuser or has BYPASSRLS/],
    ['the admin', (db: PgTestDb) => db.url, /is a superuser/],
  ] as const)('a boot as %s refuses at "role", leaves nothing behind and never echoes the URL or its password', async (_name, urlOf, message) => {
    const db = await baselineDb()
    const url = urlOf(db)
    const err = await refusalOf(bootPgBackend({ url, migrateUrl: '' }))
    expect(err).toBeInstanceOf(PgBootError)
    expect(err!.step).toBe('role')
    expect(err!.message).toMatch(message)
    expect(err!.message).not.toContain(url)
    const password = new URL(url).password
    if (password) expect(err!.message).not.toContain(password)
    expect(dbxDialect()).toBe('sqlite')
    expect(await sessionsOn(db)).toBe(0)
  })

  it('the role is judged BEFORE the schema: a superuser URL with a migration URL on an empty database refuses, and nothing was migrated', async () => {
    const db = await emptyDb()
    const err = await refusalOf(bootPgBackend({ url: roleUrl(db, SU_ROLE), migrateUrl: db.ownerUrl }))
    expect(err!.step).toBe('role')
    // the migration pool was never opened: the owner holds no session, and no schema_version table was made
    expect(await sessionsOfRole(db, PG_TEST_OWNER_ROLE)).toBe(0)
    const c = new pg.Client({ connectionString: db.url })
    await c.connect()
    try {
      expect((await c.query("SELECT to_regclass('public.schema_version') AS t")).rows[0].t).toBeNull()
    } finally { await c.end() }
  })

  it('the role is judged AGAIN after the schema step: one role as both URLs on an empty database refuses at "role" on the FIRST boot', async () => {
    const db = await emptyDb()
    await sql(db, 'CREATE EXTENSION IF NOT EXISTS unaccent', 'CREATE EXTENSION IF NOT EXISTS vector')
    // the first judgement sees no table (the database is empty) and passes; the migration then makes this role the owner of
    // every table, and the dashboard would serve as the owner. Only the second judgement catches it.
    const err = await refusalOf(bootPgBackend({ url: db.ownerUrl, migrateUrl: db.ownerUrl }))
    expect(err).toBeInstanceOf(PgBootError)
    expect(err!.step).toBe('role')
    expect(err!.message).toMatch(/owns a table in the database/)
    expect(dbxDialect()).toBe('sqlite')
    expect(await sessionsOn(db)).toBe(0)
  })

  it('the owner role still MIGRATES: it is judged on the serving pool only, and the serving app role then boots', async () => {
    const db = await emptyDb()
    await sql(db, 'CREATE EXTENSION IF NOT EXISTS unaccent', 'CREATE EXTENSION IF NOT EXISTS vector')
    const result = await bootPgBackend({ url: db.appUrl, migrateUrl: db.ownerUrl })
    expect(result.migrations.applied.length).toBe(loadPgMigrationFiles().length)
  })

  it('a refused role leaves the process able to boot: after the URL is the app role the same process boots', async () => {
    const db = await baselineDb()
    expect((await refusalOf(bootPgBackend({ url: db.ownerUrl, migrateUrl: '' })))!.step).toBe('role')
    await bootPgBackend({ url: db.appUrl, migrateUrl: '' })
    expect(dbxDialect()).toBe('pg')
  })
})

describe('bootPgBackend: a refusal per step', () => {
  it('step "schema": a migration file that drifted from what the database applied refuses the boot, with and without a migration URL', async () => {
    const db = await baselineDb()
    await sql(db, "UPDATE schema_version SET checksum = 'drifted' WHERE version = 1")
    for (const migrateUrl of ['', db.ownerUrl]) {
      const err = await refusalOf(bootPgBackend({ url: db.appUrl, migrateUrl }))
      expect(err).toBeInstanceOf(PgBootError)
      expect(err!.step).toBe('schema')
      expect(dbxDialect()).toBe('sqlite')
      expect(await sessionsOn(db)).toBe(0)
    }
  })

  it('step "preflight": a database without the unaccent extension refuses the boot and names it', async () => {
    const db = await baselineDb()
    await sql(db, 'DROP EXTENSION unaccent CASCADE')
    const err = await refusalOf(bootPgBackend({ url: db.appUrl }))
    expect(err).toBeInstanceOf(PgBootError)
    expect(err!.step).toBe('preflight')
    expect(err!.message).toMatch(/unaccent/)
    expect(dbxDialect()).toBe('sqlite')
    expect(await sessionsOn(db)).toBe(0)
  })

  it('step "caches": a failing cache load refuses the boot, takes the backend switch back and ends the pool', async () => {
    const db = await baselineDb()
    await sql(db, 'DROP TABLE system_config CASCADE')
    const err = await refusalOf(bootPgBackend({ url: db.appUrl }))
    expect(err).toBeInstanceOf(PgBootError)
    expect(err!.step).toBe('caches')
    expect(dbxDialect()).toBe('sqlite')
    expect(await sessionsOn(db)).toBe(0)
  })

  it('a refused boot leaves nothing registered: after the cause is fixed the same process boots', async () => {
    const db = await baselineDb()
    await sql(db, 'DROP EXTENSION unaccent CASCADE')
    expect((await refusalOf(bootPgBackend({ url: db.appUrl })))!.step).toBe('preflight')
    await sql(db, 'CREATE EXTENSION unaccent')
    await bootPgBackend({ url: db.appUrl })
    expect(dbxDialect()).toBe('pg')
  })

  it('no refusal message carries the URL or its password', async () => {
    const db = await baselineDb()
    await sql(db, 'DROP TABLE system_config CASCADE')
    const err = await refusalOf(bootPgBackend({ url: db.appUrl }))
    expect(err).toBeInstanceOf(PgBootError)
    const u = new URL(db.appUrl)
    expect(err!.message).not.toContain(db.appUrl)
    if (u.password) expect(err!.message).not.toContain(u.password)
  })
})
