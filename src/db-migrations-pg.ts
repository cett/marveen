import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type pg from 'pg'
import { logger } from './logger.js'

// The PostgreSQL migration runner: the numbered files of src/migrations-pg/ applied in order, each in ONE
// transaction together with its schema_version row, under a session advisory lock. Nothing in the production start-up
// calls it (the dashboard stays on SQLite until the backend switch); the PG tests and the adapter work build on it.
//
// Rules, each one with a cell in the PG test:
//   - a file is applied once: the second run changes nothing;
//   - a file that fails leaves nothing behind (no DDL, no version row), the files before it stay applied;
//   - an applied file whose content changed (checksum) is an error: a migration is immutable once it ran;
//   - an applied version whose file is gone is an error, and so is an unapplied file that sits BELOW an applied
//     one (a migration merged out of order);
//   - two processes that start at the same moment run the files once between them (the lock is held for the whole
//     run, and the loser reads schema_version only after it got the lock);
//   - there is no tolerance: no "already exists" is swallowed (PostgreSQL has ADD COLUMN IF NOT EXISTS natively,
//     a file that wants it says so);
//   - waiting for the lock has a limit (lockTimeoutMs): a migrator that hangs while holding it must not block every
//     later start for ever, the waiting run fails with a message that names the lock.
//
// A file runs inside a transaction, so a statement PostgreSQL refuses inside one cannot be in a migration file:
// CREATE INDEX CONCURRENTLY, VACUUM, ALTER SYSTEM, CREATE DATABASE. Such a step is run by hand before the file that
// needs it, and the file says so in a comment.
//
// A file does not open or close a transaction either: no COMMIT, ROLLBACK or BEGIN (not even COMMIT; BEGIN;, which looks
// harmless). The runner reads txid_current() before and after the file, in the same transaction; a different id means
// the file ended it, and the run stops with `file ended the transaction` before the version row is written.
//
// The pool's statement_timeout does not apply to the file section (a backfill may run for minutes): the runner turns it
// off for the transaction only, with a transaction-local setting, so it is back on the connection once the file is done.
//
// Under row-level security the owner role is bound by the policies too (FORCE, so a mistaken owner connection elsewhere
// is not a bypass). The runner therefore opens each file's transaction in the `system` context, with the one context
// statement of the facade (never a second statement that sets an `app.*` value): the file's own writes (a backfill)
// and the schema_version row, which only a privileged context may write, run as the dashboard itself. The settings are
// transaction-local, so they go with the COMMIT or ROLLBACK and never stay on a pooled connection.
//
// schema_version is the table the baseline (0001) creates, with the shape of the SQLite one (version, applied_at,
// description, checksum): the schema parity test holds the two together, so the runner does not invent a second
// shape. It is read before 0001 ran (no table yet means nothing applied) and the runner's own CREATE TABLE IF NOT
// EXISTS in each file's transaction only matters for a directory whose files do not create it (the runner tests).

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Migrations live next to this source file (src/ in dev). Tests pass another directory. */
export const DEFAULT_PG_MIGRATIONS_DIR = join(__dirname, 'migrations-pg')

/** The key of the session advisory lock, hashed by the server (`hashtext`) into the lock's number. */
export const PG_MIGRATIONS_LOCK_KEY = 'marveen-pg-migrations'

/** How long a run waits for the migration lock before it gives up (0 waits for ever). */
export const DEFAULT_PG_MIGRATION_LOCK_TIMEOUT_MS = 60_000

const LOCK_NOT_AVAILABLE = '55P03'

/** The `app.job` of the runner's transactions: the migration step, run on the owner connection in the `system` context. */
export const PG_MIGRATION_JOB = 'pg-migration'

const FILE_PATTERN = /^(\d{4,})_(.+)\.sql$/

export interface PgMigrationFile {
  version: number
  description: string
  path: string
  sql: string
  checksum: string
}

export interface PgMigrationResult {
  /** the schema state the check found (absent on the paths that do not classify) */
  state?: PgSchemaState
  /** a NEWER database: the highest applied version and the highest version this build ships */
  newer?: { appliedMax: number; shippedMax: number }

  /** The versions this run applied, in order. */
  applied: number[]
  /** How many files were already applied (and unchanged) when the run started. */
  alreadyApplied: number
}

/** What the runner needs of a pool: one dedicated connection (the lock is a session lock). */
export type PgMigrationPool = Pick<pg.Pool, 'connect'>

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

/**
 * The migration files of a directory in version order. A `.sql` file whose name is not NNNN_description.sql is an
 * error (a typo would otherwise be a migration that never runs), and so are two files with one number.
 */
export function loadPgMigrationFiles(dir: string = DEFAULT_PG_MIGRATIONS_DIR): PgMigrationFile[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    throw new Error(`Cannot read the PG migrations directory ${dir}: ${(err as Error).message}`, { cause: err })
  }
  const files: PgMigrationFile[] = []
  for (const name of names) {
    if (!name.endsWith('.sql')) continue
    const m = FILE_PATTERN.exec(name)
    if (!m) throw new Error(`PG migration file ${name} does not match NNNN_description.sql and would never run`)
    const path = join(dir, name)
    const sql = readFileSync(path, 'utf-8')
    files.push({ version: parseInt(m[1]!, 10), description: m[2]!.replace(/-/g, ' '), path, sql, checksum: sha256(sql) })
  }
  files.sort((a, b) => a.version - b.version)
  for (let i = 1; i < files.length; i++) {
    if (files[i]!.version === files[i - 1]!.version) {
      throw new Error(`Duplicate PG migration version ${files[i]!.version}: ${files[i - 1]!.path} and ${files[i]!.path}`)
    }
  }
  return files
}

export interface AppliedRow { version: number; checksum: string | null }

async function readApplied(client: Pick<pg.PoolClient, 'query'>): Promise<Map<number, AppliedRow>> {
  // unqualified on purpose: the table is looked up on the search_path, exactly as the SELECT below and the files read
  // it, so a database whose schema is not `public` is not taken for an empty one
  const have = await client.query<{ t: string | null }>("SELECT to_regclass('schema_version')::text AS t")
  if (have.rows[0]?.t == null) return new Map()
  // version is a bigint: the driver hands it back as text, and a migration number is far below 2^53
  const res = await client.query<{ version: string; checksum: string | null }>('SELECT version, checksum FROM schema_version')
  return new Map(res.rows.map((r) => [Number(r.version), { version: Number(r.version), checksum: r.checksum }]))
}

/**
 * The four outcomes of the schema check (decided 11-24, the cutover plan's G3):
 * - CURRENT: every shipped file is applied, nothing else is.
 * - BEHIND: shipped files are not applied yet, and the database has nothing this build does not ship.
 * - NEWER: every shipped file is applied, and the database has applied migrations this build does not ship (a rollback
 *   of the build after a newer migration ran).
 * - DIVERGED: anything else: a checksum changed, a shipped file is missing below an applied one, or the database has
 *   unknown migrations AND misses shipped ones. Never overridable.
 */
export type PgSchemaState = 'CURRENT' | 'BEHIND' | 'NEWER' | 'DIVERGED'

export interface PgSchemaClassification {
  state: PgSchemaState
  /** the refusal text for DIVERGED, and for NEWER (the default refusal) */
  problem?: string
  /** applied versions this build does not ship */
  orphans: number[]
  /** shipped versions that are not applied */
  missing: number[]
  shippedMax: number
  appliedMax: number
}

/** Classifies the applied rows against the shipped files. Pure: no database, no throw. */
export function classifyPgSchema(files: PgMigrationFile[], applied: Map<number, AppliedRow>): PgSchemaClassification {
  const byVersion = new Map(files.map((f) => [f.version, f]))
  const orphans = [...applied.keys()].filter((v) => !byVersion.has(v)).sort((a, b) => a - b)
  const missing = files.filter((f) => !applied.has(f.version)).map((f) => f.version)
  const shippedMax = Math.max(0, ...files.map((f) => f.version))
  const appliedMax = Math.max(0, ...applied.keys())
  const base = { orphans, missing, shippedMax, appliedMax }
  for (const row of applied.values()) {
    const file = byVersion.get(row.version)
    if (file && row.checksum !== file.checksum) {
      return {
        ...base,
        state: 'DIVERGED',
        problem: `PG migration ${row.version} (${file.path}) changed after it was applied: a migration is immutable, add a new file instead`,
      }
    }
  }
  if (orphans.length > 0 && missing.length > 0) {
    return {
      ...base,
      state: 'DIVERGED',
      problem: `PG migration ${orphans[orphans.length - 1]} is applied but its file is gone, and shipped migration ${missing[0]} is not applied: ` +
        'the database and this build disagree; no override applies to that',
    }
  }
  const outOfOrder = missing.find((v) => v < appliedMax)
  if (outOfOrder !== undefined) {
    const f = byVersion.get(outOfOrder)!
    return {
      ...base,
      state: 'DIVERGED',
      problem: `PG migration ${outOfOrder} (${f.path}) is not applied but ${appliedMax} is: out-of-order migrations are refused`,
    }
  }
  if (orphans.length > 0) {
    return {
      ...base,
      state: 'NEWER',
      problem: `PG migration ${orphans[orphans.length - 1]} is applied but its file is gone: the database is at migration ${appliedMax}, ` +
        `this build ships up to ${shippedMax}; run the build that matches the database`,
    }
  }
  return { ...base, state: missing.length > 0 ? 'BEHIND' : 'CURRENT' }
}


/** The result of a NEWER database that the override lets through: nothing applied, the versions named. */
function newerResult(c: PgSchemaClassification, applied: Map<number, AppliedRow>): PgMigrationResult {
  return {
    applied: [],
    alreadyApplied: applied.size,
    state: 'NEWER',
    newer: { appliedMax: c.appliedMax, shippedMax: c.shippedMax },
  }
}

/**
 * The check of a boot that has NO migration URL: reads `schema_version` (a SELECT, so the serving role can do it) and
 * throws unless every shipped file is applied and the applied rows still agree with the files (the same rules as the
 * runner). It never writes and never takes the migration lock: a serving role holds no DDL rights, and a schema that is
 * behind is a deployment that has to run the migrations first, not something this boot may fix. The message says how
 * many files are missing, never where the database is.
 */
export async function assertPgSchemaCurrent(
  pool: Pick<pg.Pool, 'query'>,
  opts: { dir?: string; allowNewer?: boolean } = {},
): Promise<PgMigrationResult> {
  const files = loadPgMigrationFiles(opts.dir)
  const applied = await readApplied(pool)
  const c = classifyPgSchema(files, applied)
  if (c.state === 'DIVERGED') throw new Error(c.problem)
  if (c.state === 'NEWER') {
    if (!opts.allowNewer) throw new Error(c.problem)
    return newerResult(c, applied)
  }
  const missing = files.filter((f) => !applied.has(f.version))
  if (missing.length > 0) {
    throw new Error(
      `the schema is behind: ${missing.length} migration file(s) are not applied (the next is ${missing[0]!.version}), ` +
        'and this boot has no migration URL to apply them with: run the migrations with the owner role first',
    )
  }
  return { applied: [], alreadyApplied: applied.size }
}

const ENSURE_SCHEMA_VERSION = `CREATE TABLE IF NOT EXISTS schema_version (
  version     bigint,
  applied_at  bigint NOT NULL,
  description text NOT NULL,
  checksum    text,
  PRIMARY KEY (version)
)`

/** The file closed the runner's transaction itself (COMMIT, ROLLBACK, or COMMIT; BEGIN;): the one-transaction rule is broken. */
class FileEndedTransactionError extends Error {}

/** The id of the current transaction. Never equal across two transactions, which `now()` (the transaction start) can be. */
async function currentTxid(client: pg.PoolClient): Promise<string> {
  const res = await client.query<{ xid: string }>('SELECT txid_current()::text AS xid')
  return res.rows[0]!.xid
}

async function applyOne(client: pg.PoolClient, file: PgMigrationFile): Promise<void> {
  // Loaded here and not at the top of the module: the facade module pulls in the pg driver, and a SQLite boot imports this
  // file without ever using it (pg-boot-refusal pins that the driver stays unloaded). A runner call has a pool, so the
  // driver is there anyway. Before BEGIN, so a failed load is not a rolled-back file.
  const { PG_SET_CONTEXT_SQL, pgContextValues } = await import('./db/pg/dbx.js')
  await client.query('BEGIN')
  try {
    // First statement of the transaction: the context (see the header). It comes before the file, the version row and
    // the table guard, all of which may be policy-bound.
    await client.query({ text: PG_SET_CONTEXT_SQL, values: pgContextValues({ role: 'system', name: PG_MIGRATION_JOB }) })
    // A file may run longer than the pool's statement_timeout (an index build, a backfill). The setting is local to this
    // transaction, so it goes with the COMMIT or ROLLBACK and never stays on the connection.
    await client.query("SELECT set_config('statement_timeout', '0', true)")
    const before = await currentTxid(client)
    await client.query(file.sql)
    if ((await currentTxid(client)) !== before) {
      throw new FileEndedTransactionError(
        `PG migration ${file.version} (${file.path}): file ended the transaction (a COMMIT, ROLLBACK or BEGIN inside a migration file is not allowed); ` +
        'what it did before that may already be committed, and no schema_version row was written',
      )
    }
    await client.query(ENSURE_SCHEMA_VERSION)
    await client.query(
      'INSERT INTO schema_version (version, applied_at, description, checksum) VALUES ($1, $2, $3, $4)',
      [file.version, Math.floor(Date.now() / 1000), file.description, file.checksum],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (err instanceof FileEndedTransactionError) throw err // "rolled back" would be false: the file committed on its own
    throw new Error(`PG migration ${file.version} (${file.path}) failed and was rolled back: ${(err as Error).message}`, { cause: err })
  }
}

/**
 * Brings the database behind `pool` up to the newest file of `dir`. Takes one connection for the whole run (the
 * advisory lock belongs to the session), and gives it back whatever happens.
 */
export async function applyPgMigrations(
  pool: PgMigrationPool,
  opts: { dir?: string; lockTimeoutMs?: number; allowNewer?: boolean } = {},
): Promise<PgMigrationResult> {
  const files = loadPgMigrationFiles(opts.dir)
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_PG_MIGRATION_LOCK_TIMEOUT_MS
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw new RangeError(`lockTimeoutMs must be a whole number of milliseconds, 0 or more (got ${lockTimeoutMs})`)
  }
  const client = await pool.connect()
  let broken = false
  try {
    // lock_timeout bounds the wait for the advisory lock too; the session value is put back once the lock is held
    let previous: string
    try {
      const was = await client.query<{ previous: string }>("SELECT current_setting('lock_timeout') AS previous")
      previous = was.rows[0]!.previous
      await client.query("SELECT set_config('lock_timeout', $1, false)", [`${lockTimeoutMs}ms`])
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [PG_MIGRATIONS_LOCK_KEY])
    } catch (err) {
      broken = true // no answer to the lock (or a timeout): the connection is not to be reused, its lock_timeout stays on it
      if ((err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
        throw new Error(`PG migrations: the migration lock was not free within ${lockTimeoutMs} ms (another migrator holds it, or is stuck)`, { cause: err })
      }
      throw err
    }
    try {
      await client.query("SELECT set_config('lock_timeout', $1, false)", [previous])
      const applied = await readApplied(client)
      const c = classifyPgSchema(files, applied)
      if (c.state === 'DIVERGED') throw new Error(c.problem)
      if (c.state === 'NEWER') {
        // an override that is on starts the process on a newer database WITHOUT running anything: no file, no DDL
        if (!opts.allowNewer) throw new Error(c.problem)
        return newerResult(c, applied)
      }
      const done: number[] = []
      for (const file of files) {
        if (applied.has(file.version)) continue
        await applyOne(client, file)
        done.push(file.version)
        logger.info({ version: file.version, description: file.description }, 'PG migration applied')
      }
      return { applied: done, alreadyApplied: applied.size }
    } finally {
      // an unlock that fails means the connection is not usable: do not hand it back to the pool
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [PG_MIGRATIONS_LOCK_KEY]).catch(() => { broken = true })
    }
  } finally {
    client.release(broken ? true : undefined)
  }
}
