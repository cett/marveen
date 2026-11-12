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
//     a file that wants it says so).
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

const FILE_PATTERN = /^(\d{4,})_(.+)\.sql$/

export interface PgMigrationFile {
  version: number
  description: string
  path: string
  sql: string
  checksum: string
}

export interface PgMigrationResult {
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

interface AppliedRow { version: number; checksum: string | null }

async function readApplied(client: pg.PoolClient): Promise<Map<number, AppliedRow>> {
  const have = await client.query<{ t: string | null }>("SELECT to_regclass('public.schema_version')::text AS t")
  if (have.rows[0]?.t == null) return new Map()
  // version is a bigint: the driver hands it back as text, and a migration number is far below 2^53
  const res = await client.query<{ version: string; checksum: string | null }>('SELECT version, checksum FROM schema_version')
  return new Map(res.rows.map((r) => [Number(r.version), { version: Number(r.version), checksum: r.checksum }]))
}

/** Throws unless the applied rows and the files agree (see the rules above). */
function checkAgainstFiles(files: PgMigrationFile[], applied: Map<number, AppliedRow>): void {
  const byVersion = new Map(files.map((f) => [f.version, f]))
  for (const row of applied.values()) {
    const file = byVersion.get(row.version)
    if (!file) throw new Error(`PG migration ${row.version} is applied but its file is gone`)
    if (row.checksum !== file.checksum) {
      throw new Error(`PG migration ${row.version} (${file.path}) changed after it was applied: a migration is immutable, add a new file instead`)
    }
  }
  const highestApplied = Math.max(0, ...applied.keys())
  for (const f of files) {
    if (!applied.has(f.version) && f.version < highestApplied) {
      throw new Error(`PG migration ${f.version} (${f.path}) is not applied but ${highestApplied} is: out-of-order migrations are refused`)
    }
  }
}

const ENSURE_SCHEMA_VERSION = `CREATE TABLE IF NOT EXISTS schema_version (
  version     bigint,
  applied_at  bigint NOT NULL,
  description text NOT NULL,
  checksum    text,
  PRIMARY KEY (version)
)`

async function applyOne(client: pg.PoolClient, file: PgMigrationFile): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(file.sql)
    await client.query(ENSURE_SCHEMA_VERSION)
    await client.query(
      'INSERT INTO schema_version (version, applied_at, description, checksum) VALUES ($1, $2, $3, $4)',
      [file.version, Math.floor(Date.now() / 1000), file.description, file.checksum],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw new Error(`PG migration ${file.version} (${file.path}) failed and was rolled back: ${(err as Error).message}`, { cause: err })
  }
}

/**
 * Brings the database behind `pool` up to the newest file of `dir`. Takes one connection for the whole run (the
 * advisory lock belongs to the session), and gives it back whatever happens.
 */
export async function applyPgMigrations(pool: PgMigrationPool, opts: { dir?: string } = {}): Promise<PgMigrationResult> {
  const files = loadPgMigrationFiles(opts.dir)
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [PG_MIGRATIONS_LOCK_KEY]).catch((err: unknown) => {
      broken = true // no answer to the lock: the connection is not to be reused
      throw err
    })
    try {
      const applied = await readApplied(client)
      checkAgainstFiles(files, applied)
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
