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
//   pool       the SERVING pool is made (the app role) and one connection is proven (SELECT 1)
//   role       the SERVING role is one that row-level security binds (db/pg/preflight.ts pgRolePreflight): not a superuser, no
//              BYPASSRLS, owns no table in the database (any non-system schema). Unconditional, no override: a database served through such a role has
//              no tenant isolation. Judged TWICE: before the schema step (nothing is migrated or read on a refused role) and
//              again right after it (an empty database showed no owned table the first time, and a migration run by the
//              serving role itself makes it the owner). The migration pool (the owner) is not judged by it: it is a
//              different pool, ended before anything is served
//   schema     the schema is brought to, or checked against, src/migrations-pg/ (db-migrations-pg.ts). WITH a migration URL
//              (MARVEEN_PG_MIGRATE_URL, the owner of the objects) a pool of ONE connection on it applies the files and is
//              ENDED before anything is served: the serving pool never holds DDL rights. WITHOUT one the boot only reads
//              schema_version through the serving pool and refuses when a shipped file is not applied. Before the preflight
//              on purpose: a migration may create the extensions the preflight then insists on
//   preflight  encoding and extensions (db/pg/preflight.ts), fail closed
//   caches     the backend is switched on (useDbxBackend) and the three synchronous caches are loaded for it. A failure
//              here puts the backend back to SQLite and ends the pool, so a refused boot leaves nothing half-wired
//
// What this boot deliberately does NOT run (the importers and their helpers, db/index.ts initDatabase()): a PostgreSQL
// database only ever receives data from a SQLite database that already ran them (the phase 5 import) or is a fresh
// install. The ones that still matter on PostgreSQL (the claude-plans seed, the cost-budgets importer, the dashboard
// token enrolment) are ported in 6c-2.
import { logger } from '../logger.js'
import { STORE_DIR } from '../paths.js'
import { writePgInstalledMarker } from './pg/store-marker.js'
import { applyPgMigrations, assertPgSchemaCurrent, loadPgMigrationFiles, type PgMigrationResult } from '../db-migrations-pg.js'
import { loadSystemConfigCacheAsync } from './config-cache.js'
import { loadModelProfileMapCacheAsync } from './model-profile-map-cache.js'
import { loadAgentSettingsCacheAsync } from './agent-settings-cache.js'
import { useDbxBackend } from './facade.js'
import { systemJob } from './background-jobs.js'
import type { PgPoolSettings } from './pg/pool.js'
import { pgPreflight, pgRolePreflight } from './pg/preflight.js'
import { PG_MIGRATE_URL_KEY, PG_URL_KEY, resolvePgMigrateUrl, resolvePgUrl } from './pg/url.js'
import type pg from 'pg'

export type PgBootStep = 'url' | 'pool' | 'role' | 'schema' | 'preflight' | 'caches'

/** A PostgreSQL boot step failed: the process must not go on. `step` names where; the message never holds the URL. */
export class PgBootError extends Error {
  readonly step: PgBootStep
  constructor(step: PgBootStep, detail: string, cause?: unknown) {
    super(`PostgreSQL boot refused at step "${step}": ${detail}`, { cause })
    this.name = 'PgBootError'
    this.step = step
  }
}

/**
 * The override for a NEWER database (the build is older than the schema, after a rollback): the boot continues, nothing
 * is migrated, and the state is logged and reported on every boot. Read from the process environment only, so it is
 * never a hidden persistent switch in a mount or an .env file. Only the value `1` turns it on.
 */
export const PG_ALLOW_NEWER_KEY = 'MARVEEN_PG_ALLOW_NEWER_DATABASE'

export function allowNewerFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PG_ALLOW_NEWER_KEY] === '1'
}

/** The schema state of the last boot, for the status surface: null on SQLite and before the first boot. */
export interface PgRuntimeStatus {
  backend: 'pg'
  /** true when the boot ran on a NEWER database under the override */
  runningOnNewerDatabase: boolean
  /** the highest migration the database has applied (null when it has none) */
  databaseHighest: number | null
  /** the highest migration this build ships (null when it ships none) */
  shippedHighest: number | null
}

let runtimeStatus: PgRuntimeStatus | null = null

/** The state of the last successful PostgreSQL boot; null on SQLite and before the first boot. Set by bootPgBackend. */
export function pgRuntimeStatus(): PgRuntimeStatus | null {
  return runtimeStatus ? { ...runtimeStatus } : null
}

export interface PgBootOptions {
  /** The URL to boot on (default: the configured MARVEEN_PG_URL). Tests pass a throwaway database. */
  url?: string
  /**
   * The URL the schema step migrates with (default: the configured MARVEEN_PG_MIGRATE_URL). An empty string means none,
   * whatever the environment says: the boot then only checks that the schema is current.
   */
  migrateUrl?: string
  /** A migrations directory other than the shipped one (tests: a failing file, an extension-less set). */
  migrationsDir?: string
  /** Start on a NEWER database without migrating (default: the MARVEEN_PG_ALLOW_NEWER_DATABASE value `1`). */
  allowNewer?: boolean
  /** Pool limits (default: the DB_PG_* environment variables, then the adapter defaults). */
  pool?: PgPoolSettings
  /**
   * Write the PostgreSQL install marker (store/.pg-installed, P-E) into this process's store dir once the boot passed.
   * Opt-in: only the real process boot (initDatabaseAsync) sets it. A test or a CLI helper that boots against a
   * throwaway database must never mark the checkout it runs in (PR 959 adversarial review, finding 1).
   */
  writeInstallMarker?: boolean
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
export function sanitizeError(err: unknown, url: string, ...more: string[]): Error {
  const source = err instanceof Error ? err : new Error(String(err))
  const redact = (text: string): string => [url, ...more].reduce((acc, u) => redactUrl(acc, u), text)
  const copy = new Error(redact(source.message))
  copy.name = source.name
  if (source.stack) copy.stack = redact(source.stack)
  const code = (source as { code?: unknown }).code
  if (typeof code === 'string') (copy as { code?: string }).code = code
  return copy
}

// `more` are the other URLs of the boot (the migration URL carries a password too): every text that leaves is redacted for all of them
function detailOf(err: unknown, url: string, ...more: string[]): string {
  const raw = err instanceof Error ? err.message : String(err)
  return [url, ...more].reduce((acc, u) => redactUrl(acc, u), raw || (err instanceof Error ? err.name : 'unknown error'))
}

function checkUrl(url: string, key: string = PG_URL_KEY, step: PgBootStep = 'url'): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PgBootError(step, `${key} is not a valid URL`)
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new PgBootError(step, `${key} must start with postgres:// or postgresql://`)
  }
}

/**
 * Applies the migrations on a pool of ONE connection built from the migration URL, and ENDS that pool before it returns, on
 * success and on failure alike: the connection that holds DDL rights is gone before the serving pool serves anything.
 */
async function migrateOnItsOwnPool(
  driver: typeof import('pg').default,
  poolConfig: typeof import('./pg/pool.js').pgPoolConfig,
  migrateUrl: string,
  dirOpts: { dir?: string },
): Promise<PgMigrationResult> {
  const migratePool = new driver.Pool(poolConfig(migrateUrl, { max: 1 }))
  try {
    return await applyPgMigrations(migratePool, dirOpts)
  } finally {
    await migratePool.end().catch(() => undefined)
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
  // the migration URL: configured or passed, empty = none. It carries a password too, so every refusal redacts it as well.
  const migrateUrl = (opts.migrateUrl === undefined ? resolvePgMigrateUrl() ?? '' : opts.migrateUrl).trim() || undefined
  const others = migrateUrl === undefined ? [] : [migrateUrl]
  let switched = false
  const refuse = async (step: PgBootStep, err: unknown): Promise<never> => {
    if (switched) useDbxBackend(null)
    await pool.end().catch(() => undefined)
    throw new PgBootError(step, detailOf(err, url, ...others), sanitizeError(err, url, ...others))
  }

  try {
    await pool.query('SELECT 1')
  } catch (err) {
    return refuse('pool', err)
  }

  try {
    await pgRolePreflight(pool)
  } catch (err) {
    return refuse('role', err)
  }

  let migrations: PgMigrationResult
  const dirOptsForStatus = opts.migrationsDir === undefined ? undefined : opts.migrationsDir
  try {
    const allowNewer = opts.allowNewer ?? allowNewerFromEnv()
    const dirOpts = { ...(opts.migrationsDir === undefined ? {} : { dir: opts.migrationsDir }), allowNewer }
    if (migrateUrl === undefined) {
      // no migration URL: the serving role only READS schema_version; a schema that is behind is refused, never fixed here
      migrations = await assertPgSchemaCurrent(pool, dirOpts)
    } else {
      checkUrl(migrateUrl, PG_MIGRATE_URL_KEY, 'schema')
      migrations = await migrateOnItsOwnPool(pgDriver, pgPoolConfig, migrateUrl, dirOpts)
    }
  } catch (err) {
    return refuse('schema', err)
  }

  // The role is judged a SECOND time, now that the schema exists: the first call (before the schema step) refuses a role that
  // is already an owner and keeps a refused role from migrating anything, but on an empty database it sees no table, and a
  // migration run by the very role that serves (url = migrateUrl, one role for both) makes that role the owner of every
  // table. Without this call the first boot of such an install would pass and only the second would be refused.
  try {
    await pgRolePreflight(pool)
  } catch (err) {
    return refuse('role', err)
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
    // The caches hold every tenant's rows (system_config is privileged-only, agent_settings is a tenant table): read them
    // in the function's OWN system context, never in whatever context the caller has. An empty context sees zero rows
    // under row-level security and the caches would boot empty without an error (the RBAC mode would fall back to its default).
    await systemJob('pg-boot-caches', async () => {
      await loadSystemConfigCacheAsync()
      await loadModelProfileMapCacheAsync()
      await loadAgentSettingsCacheAsync()
    })()
  } catch (err) {
    return refuse('caches', err)
  }

  // the durable marker that this store belongs to PostgreSQL (P-E): written once, after the check passed, and only when the
  // caller is the real process boot (writeInstallMarker); a failed write is logged and the boot goes on (never throws)
  if (opts.writeInstallMarker === true) writePgInstalledMarker(STORE_DIR)

  const shippedHighest = Math.max(0, ...loadPgMigrationFiles(dirOptsForStatus).map((f) => f.version))
  if (migrations.state === 'NEWER' && migrations.newer) {
    const { appliedMax, shippedMax } = migrations.newer
    const warning = `running on a newer database: migration ${appliedMax} is applied, this build ships up to ${shippedMax}; ` +
      `nothing was migrated (${PG_ALLOW_NEWER_KEY}=1)`
    warnings = [...warnings, warning]
    logger.warn({ appliedMax, shippedMax }, 'PostgreSQL running on a newer database under the override')
    runtimeStatus = { backend: 'pg', runningOnNewerDatabase: true, databaseHighest: appliedMax, shippedHighest: shippedMax }
  } else {
    // a boot that passed the check has applied exactly the shipped files: the database's highest is the shipped one
    runtimeStatus = {
      backend: 'pg',
      runningOnNewerDatabase: false,
      databaseHighest: shippedHighest || null,
      shippedHighest: shippedHighest || null,
    }
  }
  activePool = pool
  for (const warning of warnings) logger.warn({ warning }, 'PostgreSQL preflight warning')
  logger.info({ applied: migrations.applied.length, alreadyApplied: migrations.alreadyApplied }, 'PostgreSQL backend ready')
  return { migrations, warnings }
}

