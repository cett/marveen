// PostgreSQL test harness for the Phase 2 parity tests (and the PG tests that follow them).
//
// One database per test file, cloned from a template that holds the PG baseline (src/migrations-pg/*.sql, applied in
// file-name order). The server comes from MARVEEN_PG_TEST_URL, an admin URL of a throwaway server (the CI service
// container, or a local one): the harness creates and drops databases on it. There is no skip when the variable is
// missing, a PG test without a server is an error, because a skipped parity test proves nothing. The PG tests live in
// src/__tests__/pg/ and run through `npm run test:pg` (vitest.pg.config.ts); the default suite does not see them.
//
// The template name carries a hash of the SQL it was built from, so a changed baseline builds a new template and an
// old one is never reused. Building and cloning run under one advisory lock: PostgreSQL refuses a CREATE DATABASE
// from a template that another session is using, and two vitest workers start at the same time. The template is
// built under a temporary name and renamed when complete, so a crash mid-build leaves no half-built template that a
// later run would trust. The template is built by the PG migration runner (src/db-migrations-pg.ts), the same code path
// a real database takes, so a test database carries the schema_version rows of the files it was built from.
//
// int8 (bigint) comes back as a JS number, checked: a value beyond Number.MAX_SAFE_INTEGER throws instead of
// rounding silently (the default driver returns a string, better-sqlite3 returns a number, and the facade code is
// written for numbers). Every other type keeps the driver's default parser.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { applyPgMigrations } from '../../db-migrations-pg.js'
import { createPgDbx, type PgDbx } from '../../db/pg/dbx.js'
import { parseInt8Safe, pgTypes } from '../../db/pg/types.js'

export const PG_TEST_URL_ENV = 'MARVEEN_PG_TEST_URL'
const LOCK_KEY = 'marveen-pg-test-template'
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations-pg', import.meta.url))

/** The admin URL of the test server; throws (does not skip) when it is not set. */
export function pgTestUrl(): string {
  const url = process.env[PG_TEST_URL_ENV]
  if (!url) {
    throw new Error(`${PG_TEST_URL_ENV} is not set: the PG tests need a throwaway PostgreSQL server (an admin URL, e.g. postgres://postgres:postgres@127.0.0.1:5432/postgres)`)
  }
  return url
}

// The int8 parser lives with the adapter now (src/db/pg/types.ts); the tests keep importing it from here.
export { parseInt8Safe, pgTypes }

/** The `.sql` files of a baseline directory in file-name order; an absent directory is an empty baseline. */
export function listBaselineFiles(dir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(dir, f))
}

// bump when the way the template is built changes in a way the SQL text does not show
const TEMPLATE_BUILD_SALT = 'runner-v2-roles'

// The cluster roles the template is built with, the way production will build it: the OWNER holds the objects and runs
// the migrations, the APP role is what the dashboard serves with (no DDL, no ownership, no BYPASSRLS), the BACKUP role
// is the one that may read past row-level security. The passwords are throwaway values that exist only in this harness
// and only for the test server (a CREATE ROLE here is cluster-level and survives a dropped database); they are not
// credentials of anything.
export const PG_TEST_OWNER_ROLE = 'marveen_owner'
export const PG_TEST_APP_ROLE = 'marveen_app'
export const PG_TEST_BACKUP_ROLE = 'marveen_backup'
const TEST_ROLE_PASSWORD: Record<string, string> = {
  [PG_TEST_OWNER_ROLE]: 'harness-only-owner',
  [PG_TEST_APP_ROLE]: 'harness-only-app',
  [PG_TEST_BACKUP_ROLE]: 'harness-only-backup',
}
// The attributes every role must have; only the backup role bypasses row-level security, nobody is a superuser. They are
// spelled out in full (the unspoken ones are the PostgreSQL defaults) so a role left behind by an older run is detected.
const ROLE_ATTRS: Record<string, { rolbypassrls: boolean }> = {
  [PG_TEST_OWNER_ROLE]: { rolbypassrls: false },
  [PG_TEST_APP_ROLE]: { rolbypassrls: false },
  [PG_TEST_BACKUP_ROLE]: { rolbypassrls: true },
}
const roleDdl = (role: string): string =>
  `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION ${ROLE_ATTRS[role].rolbypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS'}`

/** The URL of a database of the test server as one of the harness roles. */
export function pgTestRoleUrl(adminUrl: string, database: string, role: string): string {
  const u = new URL(adminUrl)
  u.pathname = `/${database}`
  u.username = role
  u.password = TEST_ROLE_PASSWORD[role]
  return u.toString()
}

/**
 * Creates the three roles when missing (CREATE ROLE IF NOT EXISTS does not exist, so pg_roles is asked first) and
 * corrects the attributes of a role that drifted (a role an older run left on the server) WITHOUT touching its password:
 * the throwaway password is set at CREATE only. The caller holds the advisory lock, so two workers cannot both see
 * "missing" and race on the CREATE.
 */
async function ensureRoles(admin: pg.Client): Promise<void> {
  for (const role of Object.keys(ROLE_ATTRS)) {
    const have = await admin.query<{ ok: boolean }>(
      `SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND rolcanlogin
              AND rolbypassrls = $2 AS ok FROM pg_roles WHERE rolname = $1`, [role, ROLE_ATTRS[role].rolbypassrls])
    if (have.rowCount === 0) {
      await admin.query(`CREATE ROLE ${quote(role)} ${roleDdl(role)} PASSWORD '${TEST_ROLE_PASSWORD[role]}'`)
    } else if (!have.rows[0].ok) {
      // attributes only: a role that already exists on the server may be a real one with its own password, and a test
      // harness must never set a password on it
      await admin.query(`ALTER ROLE ${quote(role)} ${roleDdl(role)}`)
    }
  }
}

/** The template database name for a baseline: a different SQL text is a different name. */
export function templateName(files: string[]): string {
  const h = createHash('sha256').update(TEMPLATE_BUILD_SALT).update('\0')
  for (const f of files) h.update(path.basename(f)).update('\0').update(readFileSync(f)).update('\0')
  return `marveen_tpl_${h.digest('hex').slice(0, 16)}`
}

const quote = (ident: string): string => `"${ident.replace(/"/g, '""')}"`

export interface PgTestDb {
  /** The database name on the test server. */
  name: string
  /** The admin URL of this database. */
  url: string
  /** The template this database was cloned from. */
  template: string
  /**
   * The ADMIN pool (superuser): setup, and the oracle ("the row exists", whatever the policies say). Every existing
   * test uses it, unchanged.
   */
  pool: pg.Pool
  /**
   * A pool connected as the app role (marveen_app): what an isolation cell claims against. It holds only DML rights,
   * owns nothing and does not bypass row-level security, the way the dashboard will serve.
   */
  appPool: pg.Pool
  /** A pool connected as the owner role (marveen_owner): only for the DDL a cell needs (a test-local table and policy). */
  ownerPool: pg.Pool
  /** The facade over the app pool: `createPgDbx(appPool)`, a new facade per call over the one pool. */
  appDbx(): PgDbx
  /** Ends the pool and drops the database. */
  close(): Promise<void>
}

export interface PgTestDbOptions {
  /** Directory of the baseline `.sql` files (default src/migrations-pg). */
  migrationsDir?: string
  /** Admin URL (default MARVEEN_PG_TEST_URL). */
  url?: string
}

function withDatabase(adminUrl: string, database: string): string {
  const u = new URL(adminUrl)
  u.pathname = `/${database}`
  return u.toString()
}

/**
 * Grants to the app role what production will give it. HARNESS CODE FOR NOW: S3 moves these statements into migration
 * 0009 (they are part of the migration there), and then this block is DELETED, not duplicated. No TRUNCATE, REFERENCES,
 * TRIGGER or CREATE: the serving role does DML only. Run by the owner, so the default privileges are the owner's.
 */
async function grantAppRole(owner: pg.Pool): Promise<void> {
  const app = quote(PG_TEST_APP_ROLE)
  const me = quote(PG_TEST_OWNER_ROLE)
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${app}`)
  await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${app}`)
  await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app}`)
  await owner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${me} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app}`)
  await owner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${me} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${app}`)
}

async function dropBuilding(adminUrl: string, building: string): Promise<void> {
  const cleanup = new pg.Client({ connectionString: adminUrl })
  await cleanup.connect()
  try { await cleanup.query(`DROP DATABASE IF EXISTS ${quote(building)} WITH (FORCE)`) } finally { await cleanup.end() }
}

async function buildTemplate(adminUrl: string, template: string, files: string[], dir: string): Promise<void> {
  const building = `${template}_building`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quote(building)} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${quote(building)} OWNER ${quote(PG_TEST_OWNER_ROLE)}`)
  } finally {
    await admin.end()
  }
  // The extensions are created by the admin (R1: provisioning does it; the migrations keep their IF NOT EXISTS, which
  // is then a no-op for the owner). Only for a template that has a baseline: an EMPTY template stays empty, no table and
  // no extension, because a test that boots on it relies on the migrations creating what the boot preflight demands.
  if (files.length > 0) {
    const ext = new pg.Client({ connectionString: withDatabase(adminUrl, building) })
    await ext.connect()
    try {
      await ext.query('CREATE EXTENSION IF NOT EXISTS unaccent')
      await ext.query('CREATE EXTENSION IF NOT EXISTS vector')
    } catch (err) {
      await ext.end()
      await dropBuilding(adminUrl, building)
      throw new Error(`the test server cannot provide the unaccent and vector extensions: ${(err as Error).message}`, { cause: err })
    }
    await ext.end()
  }
  // The migrations run as the OWNER, so every object is the owner's, the way a production database is built.
  const builder = new pg.Pool({ connectionString: pgTestRoleUrl(adminUrl, building, PG_TEST_OWNER_ROLE), max: 1 })
  try {
    if (files.length > 0) await applyPgMigrations(builder, { dir }) // no file = an empty template
    await grantAppRole(builder)
  } catch (err) {
    await builder.end()
    await dropBuilding(adminUrl, building)
    throw new Error(`baseline ${files.map((x) => path.basename(x)).join(', ')} failed to apply: ${(err as Error).message}`, { cause: err })
  }
  await builder.end()
  const rename = new pg.Client({ connectionString: adminUrl })
  await rename.connect()
  try { await rename.query(`ALTER DATABASE ${quote(building)} RENAME TO ${quote(template)}`) } finally { await rename.end() }
}

/** A fresh database cloned from the baseline template (built first when it does not exist yet). */
export async function createPgTestDb(opts: PgTestDbOptions = {}): Promise<PgTestDb> {
  const adminUrl = opts.url ?? pgTestUrl()
  const files = listBaselineFiles(opts.migrationsDir)
  const template = templateName(files)
  const name = `marveen_t_${process.pid}_${randomBytes(5).toString('hex')}`

  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    await admin.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY])
    try {
      await ensureRoles(admin)
      const have = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [template])
      if (have.rowCount === 0) await buildTemplate(adminUrl, template, files, opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR)
      await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(template)} OWNER ${quote(PG_TEST_OWNER_ROLE)}`)
    } finally {
      await admin.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY])
    }
  } finally {
    await admin.end()
  }

  const url = withDatabase(adminUrl, name)
  const pool = new pg.Pool({ connectionString: url, types: pgTypes, max: 4 })
  const appPool = new pg.Pool({ connectionString: pgTestRoleUrl(adminUrl, name, PG_TEST_APP_ROLE), types: pgTypes, max: 4 })
  const ownerPool = new pg.Pool({ connectionString: pgTestRoleUrl(adminUrl, name, PG_TEST_OWNER_ROLE), types: pgTypes, max: 2 })
  return {
    name,
    url,
    template,
    pool: appPool, // DISCOVERY (throwaway, never merged): every test's dbx runs as the app role
    appPool,
    ownerPool,
    appDbx: () => createPgDbx(appPool),
    async close() {
      await appPool.end()
      await ownerPool.end()
      await pool.end()
      const a = new pg.Client({ connectionString: adminUrl })
      await a.connect()
      try { await a.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`) } finally { await a.end() }
    },
  }
}

/** Drops a template database (a test that built its own baseline cleans it up with this). */
export async function dropPgTemplate(template: string, url: string = pgTestUrl()): Promise<void> {
  const a = new pg.Client({ connectionString: url })
  await a.connect()
  try { await a.query(`DROP DATABASE IF EXISTS ${quote(template)} WITH (FORCE)`) } finally { await a.end() }
}
