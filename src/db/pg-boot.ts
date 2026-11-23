// The PostgreSQL boot path (phase 3, step 6c-1): the asynchronous counterpart of the SQLite chain in db/index.ts.
//
// Selected by `MARVEEN_PG_URL` (db/pg/url.ts). The rules, from the 6c decisions:
//   - URL present  = the PostgreSQL backend. Any failing step REFUSES THE BOOT with an error that names the step.
//                    There is no fallback to SQLite: an install configured for PostgreSQL that silently ran on the old
//                    file would write data nobody reads.
//   - URL absent   = nothing here runs, no pool is opened and the `pg` driver is not even loaded.
//
// The steps, in this order, each one a named failure (PgBootStep):
//   url        the value is a postgres:// or postgresql:// URL (the value is never echoed: it carries a password)
//   pool       a pool is made and one connection is proven (SELECT 1)
//   migrate    src/migrations-pg/ is applied (db-migrations-pg.ts). Before the preflight on purpose: the files create
//              the unaccent and vector extensions that the preflight then insists on, so a fresh database passes it
//   preflight  encoding and extensions (db/pg/preflight.ts), fail closed
//   caches     the backend is switched on (useDbxBackend) and the three synchronous caches are loaded for it. A failure
//              here puts the backend back to SQLite and ends the pool, so a refused boot leaves nothing half-wired
//
// What this boot deliberately does NOT run (the importers and their helpers, db/index.ts initDatabase()): a PostgreSQL
// database only ever receives data from a SQLite database that already ran them (the phase 5 import) or is a fresh
// install. The ones that still matter on PostgreSQL (the claude-plans seed, the cost-budgets importer, the dashboard
// token enrolment) are ported in 6c-2. config.ts still reads its boot values from SQLite until 6c-3.
import { logger } from '../logger.js'
import { applyPgMigrations, type PgMigrationResult } from '../db-migrations-pg.js'
import { loadSystemConfigCacheAsync } from './config-cache.js'
import { loadModelProfileMapCacheAsync } from './model-profile-map-cache.js'
import { loadAgentSettingsCacheAsync } from './agent-settings-cache.js'
import { useDbxBackend } from './facade.js'
import type { PgPoolSettings } from './pg/pool.js'
import { pgPreflight } from './pg/preflight.js'
import { PG_URL_KEY, resolvePgUrl } from './pg/url.js'
import type pg from 'pg'

export type PgBootStep = 'url' | 'pool' | 'migrate' | 'preflight' | 'caches'

/** A PostgreSQL boot step failed: the process must not go on. `step` names where; the message never holds the URL. */
export class PgBootError extends Error {
  readonly step: PgBootStep
  constructor(step: PgBootStep, detail: string, cause?: unknown) {
    super(`PostgreSQL boot refused at step "${step}": ${detail}`, { cause })
    this.name = 'PgBootError'
    this.step = step
  }
}

export interface PgBootOptions {
  /** The URL to boot on (default: the configured MARVEEN_PG_URL). Tests pass a throwaway database. */
  url?: string
  /** A migrations directory other than the shipped one (tests: a failing file, an extension-less set). */
  migrationsDir?: string
  /** Pool limits (default: the DB_PG_* environment variables, then the adapter defaults). */
  pool?: PgPoolSettings
}

export interface PgBootResult {
  migrations: PgMigrationResult
  /** Non-fatal preflight findings. */
  warnings: string[]
}

let activePool: pg.Pool | null = null

/** What a text may carry of the URL: nothing. The whole URL is masked, and so is its password as written and as decoded. */
export function redactUrl(text: string, url: string): string {
  let out = text.split(url).join('[url]')
  let password = ''
  try {
    password = new URL(url).password
  } catch {
    /* the URL step has already judged the value */
  }
  if (password) {
    const forms = new Set([password])
    try {
      forms.add(decodeURIComponent(password))
    } catch {
      /* a malformed escape: the raw form is still masked */
    }
    for (const form of forms) out = out.split(form).join('***')
  }
  return out
}

/**
 * A copy of an error that is safe to log: message and stack redacted, the driver's `code` kept. The raw error is NOT kept
 * as the `cause` of the boot error: the logger serialises the whole cause chain, and a driver error can quote the
 * connection string (an unparsable URL, a failing connect).
 */
export function sanitizeError(err: unknown, url: string): Error {
  const source = err instanceof Error ? err : new Error(String(err))
  const copy = new Error(redactUrl(source.message, url))
  copy.name = source.name
  if (source.stack) copy.stack = redactUrl(source.stack, url)
  const code = (source as { code?: unknown }).code
  if (typeof code === 'string') (copy as { code?: string }).code = code
  return copy
}

function detailOf(err: unknown, url: string): string {
  const raw = err instanceof Error ? err.message : String(err)
  return redactUrl(raw || (err instanceof Error ? err.name : 'unknown error'), url)
}

function checkUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PgBootError('url', `${PG_URL_KEY} is not a valid URL`)
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new PgBootError('url', `${PG_URL_KEY} must start with postgres:// or postgresql://`)
  }
}

/** Ends the pool of this boot (if any) and puts the facade back on SQLite. Safe to call twice. */
export async function closePgBackend(): Promise<void> {
  const pool = activePool
  activePool = null
  useDbxBackend(null)
  if (pool) {
    try {
      await pool.end()
    } catch (err) {
      logger.warn({ err }, 'PostgreSQL pool did not end cleanly')
    }
  }
}

/**
 * Boots the PostgreSQL backend: see the header for the steps. Resolves when the facade runs on PostgreSQL and the three
 * synchronous caches are loaded; throws a PgBootError (and leaves no pool and no backend behind) otherwise.
 */
export async function bootPgBackend(opts: PgBootOptions = {}): Promise<PgBootResult> {
  if (activePool !== null) throw new Error('bootPgBackend: a PostgreSQL backend is already booted in this process')
  const url = opts.url ?? resolvePgUrl()
  if (url === undefined) throw new PgBootError('url', `${PG_URL_KEY} is not set`)
  checkUrl(url)

  // loaded here, not at the top: an install on SQLite never pays for (or depends on) the driver. pool.js and dbx.js
  // are loaded the same way because pool.js pulls the driver in (its type parsers), and db.js re-exports this module.
  const [{ default: pgDriver }, { pgPoolConfig }, { createPgDbx }] = await Promise.all([
    import('pg'),
    import('./pg/pool.js'),
    import('./pg/dbx.js'),
  ])
  let pool: pg.Pool
  try {
    pool = new pgDriver.Pool(pgPoolConfig(url, opts.pool))
  } catch (err) {
    // a driver that cannot even take the URL (or an invalid pool setting): refused like any other pool failure
    throw new PgBootError('pool', detailOf(err, url), sanitizeError(err, url))
  }
  let switched = false
  const refuse = async (step: PgBootStep, err: unknown): Promise<never> => {
    if (switched) useDbxBackend(null)
    await pool.end().catch(() => undefined)
    throw new PgBootError(step, detailOf(err, url), sanitizeError(err, url))
  }

  try {
    await pool.query('SELECT 1')
  } catch (err) {
    return refuse('pool', err)
  }

  let migrations: PgMigrationResult
  try {
    migrations = await applyPgMigrations(pool, opts.migrationsDir === undefined ? {} : { dir: opts.migrationsDir })
  } catch (err) {
    return refuse('migrate', err)
  }

  let warnings: string[]
  try {
    warnings = (await pgPreflight(pool)).warnings
  } catch (err) {
    return refuse('preflight', err)
  }

  try {
    useDbxBackend(createPgDbx(pool), 'pg')
    switched = true
    // after the switch: a cache belongs to the epoch the switch started
    await loadSystemConfigCacheAsync()
    await loadModelProfileMapCacheAsync()
    await loadAgentSettingsCacheAsync()
  } catch (err) {
    return refuse('caches', err)
  }

  activePool = pool
  for (const warning of warnings) logger.warn({ warning }, 'PostgreSQL preflight warning')
  logger.info({ applied: migrations.applied.length, alreadyApplied: migrations.alreadyApplied }, 'PostgreSQL backend ready')
  return { migrations, warnings }
}

/**
 * The process cannot run on PostgreSQL yet. Not a PgBootError: nothing about the database is wrong, and no database was
 * touched to find out (the refusal comes before the port takeover and before any pool exists).
 */
export class PgProcessNotSupportedError extends Error {
  constructor() {
    super(
      `${PG_URL_KEY} is set, but the dashboard process cannot run on PostgreSQL yet: ` +
        'the rest of the boot (config.ts, the file retirements, the embedding backfill, the raw SQLite statements) still uses the ' +
        `synchronous SQLite handle, which a PostgreSQL boot never opens. Unset ${PG_URL_KEY} to run on SQLite. ` +
        'This refusal is lifted by the config bootstrap step and the cutover.',
    )
    this.name = 'PgProcessNotSupportedError'
  }
}

/**
 * THE ONE place that keeps the process off PostgreSQL until it can run there. src/index.ts calls it FIRST in main(), before
 * the port takeover (acquireLock) and before any database work: a refused process must not SIGTERM the running dashboard
 * and must not open a pool it would only have to end. The decision is the configuration alone (resolvePgUrl), so it needs
 * no pool and never reads or echoes the URL. The step that lifts it (config bootstrap, 6c-3, then the cutover) deletes the
 * call in src/index.ts; bootPgBackend and initDatabaseAsync are unaffected (the PG tests call them directly). No override
 * flag, on purpose.
 */
export function refuseProcessOnPg(): void {
  if (resolvePgUrl() !== undefined) throw new PgProcessNotSupportedError()
}
