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
const TEMPLATE_BUILD_SALT = 'runner-v1'

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
  url: string
  /** The template this database was cloned from. */
  template: string
  pool: pg.Pool
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

async function buildTemplate(adminUrl: string, template: string, files: string[], dir: string): Promise<void> {
  const building = `${template}_building`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quote(building)} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${quote(building)}`)
  } finally {
    await admin.end()
  }
  const builder = new pg.Pool({ connectionString: withDatabase(adminUrl, building), max: 1 })
  try {
    if (files.length > 0) await applyPgMigrations(builder, { dir }) // no file = an empty template
  } catch (err) {
    await builder.end()
    const cleanup = new pg.Client({ connectionString: adminUrl })
    await cleanup.connect()
    try { await cleanup.query(`DROP DATABASE IF EXISTS ${quote(building)} WITH (FORCE)`) } finally { await cleanup.end() }
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
      const have = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [template])
      if (have.rowCount === 0) await buildTemplate(adminUrl, template, files, opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR)
      await admin.query(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(template)}`)
    } finally {
      await admin.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY])
    }
  } finally {
    await admin.end()
  }

  const url = withDatabase(adminUrl, name)
  const pool = new pg.Pool({ connectionString: url, types: pgTypes, max: 4 })
  return {
    name,
    url,
    template,
    pool,
    async close() {
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
