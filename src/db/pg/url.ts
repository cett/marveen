// Where the production PostgreSQL connection URL comes from (phase 3, step 6c-1).
//
// `MARVEEN_PG_URL` is the single switch of the backend: present = PostgreSQL, absent = SQLite, exactly as before.
// It is read BEFORE config.ts needs it and never from `system_config` (a database setting cannot name the database
// that holds it). Precedence, the same shape as config.ts's cfg() without its database layer, FIRST NON-EMPTY wins:
//   1. the secret mount (/run/secrets/MARVEEN_PG_URL), so the password stays out of .env,
//   2. process.env (moved out of it at process start by capturePgCredentials(), so children never inherit the URL),
//   3. the .env file of the install.
// An empty or whitespace-only value counts as absent and falls through to the next layer (as cfg() does): a half-edited
// .env line must not switch the backend, and an unset URL and an empty one are the same answer.
//
// This file is a leaf on purpose (env.ts and secret-resolver.ts only): db/connection.ts imports it for the SQLite
// entry guard below, and connection.ts must stay acyclic (it never imports a domain module).
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../../paths.js'
import { readEnvFile } from '../../env.js'

/** The PostgreSQL install marker's file name (store/.pg-installed, P-E). Kept here, not imported, so this module stays a leaf. */
const PG_INSTALL_MARKER = '.pg-installed'
import { resolveSecret } from '../../secret-resolver.js'

export const PG_URL_KEY = 'MARVEEN_PG_URL'

/**
 * The second URL of the boot split: the connection the schema step migrates with (the owner of the objects), used for
 * that one step and then ended. The serving pool is never built from it. Resolved through the same three layers as
 * `MARVEEN_PG_URL`; absent = the boot only checks that the schema is current and never changes it.
 */
export const PG_MIGRATE_URL_KEY = 'MARVEEN_PG_MIGRATE_URL'

/** Set to '1' at process start when a serving URL was captured: a non-secret marker for the children (see capturePgCredentials). */
export const PG_CONFIGURED_KEY = 'MARVEEN_PG_CONFIGURED'

/**
 * The values of the two keys, taken out of `process.env` by `capturePgCredentials()`. A process that spawns children
 * (the agent sessions, tmux, the helpers) passes its environment on, so the keys stay out of it once the snapshot is
 * loaded; this map keeps them for the resolvers that run later in the same process.
 */
const captured = new Map<string, string>()

/**
 * Moves the two PostgreSQL keys out of `process.env` into this module. Call it once, first thing at process start,
 * before anything spawns a child. Synchronous and idempotent. A value is kept only when non-empty after trimming; the
 * key is removed either way, so an empty one does not reach a child either. Never logs a value.
 */
export function capturePgCredentials(): void {
  for (const key of [PG_URL_KEY, PG_MIGRATE_URL_KEY]) {
    const value = process.env[key]?.trim()
    if (value) captured.set(key, value)
    delete process.env[key]
  }
  // A child process cannot read the URL from its environment any more. The marker is not a secret: it says only that
  // this install is configured for PostgreSQL, so a SQLite-only entry point in the child refuses instead of opening
  // the stale SQLite file.
  if (captured.has(PG_URL_KEY)) process.env[PG_CONFIGURED_KEY] = '1'
}

/** Test-only: forgets the captured values, so a cell starts from an empty capture. */
export function resetPgCredentialCaptureForTests(): void {
  captured.clear()
}

function resolveKey(key: string): string | undefined {
  // lazy: the .env file is read only when the two layers above it said nothing
  const layers: Array<() => string | undefined> = [
    () => resolveSecret(key),
    () => captured.get(key) ?? process.env[key],
    () => readEnvFile([key])[key],
  ]
  for (const layer of layers) {
    const value = layer()?.trim()
    if (value) return value
  }
  return undefined
}

/** The configured PostgreSQL URL, or undefined when the install runs on SQLite. Never logs, never validates. */
export function resolvePgUrl(): string | undefined {
  return resolveKey(PG_URL_KEY)
}

/** The configured migration URL, or undefined (the boot then checks the schema and does not migrate). Never logs, never validates. */
export function resolvePgMigrateUrl(): string | undefined {
  return resolveKey(PG_MIGRATE_URL_KEY)
}

/** Thrown by a SQLite-only entry point when the install is configured for PostgreSQL. */
export class SqliteEntryRefusedError extends Error {
  /**
   * `unreadable`: the marker says PostgreSQL, but this process cannot read the URL (a child of the scrubbed process).
   * `marker`: the store holds the PostgreSQL install marker (store/.pg-installed, P-E): the install is PostgreSQL whatever
   * the configuration says, and the way back is a written step (decision D3).
   */
  constructor(entry: string, unreadable: boolean | 'marker' = false) {
    super(
      unreadable === 'marker'
        ? `${entry}: the store holds the PostgreSQL install marker (store/.pg-installed), so this install is PostgreSQL, ` +
          'and this entry point refuses to open the stale SQLite file. ' +
          'Put the URL where it lives (see docs/pg-provisioning.md, "Where the URLs live"). ' +
          'To go back to SQLite on purpose: unset MARVEEN_PG_URL and delete store/.pg-installed by hand.'
        : unreadable
        ? `${entry}: the install is configured for PostgreSQL (${PG_CONFIGURED_KEY}=1), but this process cannot read ${PG_URL_KEY}. ` +
          'It would open the stale SQLite file instead of the database the install is configured for. ' +
          'Put the URL in the secret mount or in the 0600 .env file of the install (see docs/pg-provisioning.md, "Where the URLs live").'
        : `${entry}: ${PG_URL_KEY} is set, and this entry point is SQLite-only until the PostgreSQL cutover. ` +
          'It would open the stale SQLite file instead of the database the install is configured for. ' +
          `Unset ${PG_URL_KEY} to run it on SQLite.`,
    )
    this.name = 'SqliteEntryRefusedError'
  }
}

/**
 * The guard of the synchronous SQLite initialiser: with a PostgreSQL URL configured it throws, so a CLI or a script
 * cannot silently work on the old file. A caller that names its own database (a test's ':memory:', a throwaway file)
 * is not an install entry point and does not pass through here.
 */
export function assertSqliteEntryAllowed(entry: string): void {
  if (resolvePgUrl() !== undefined) throw new SqliteEntryRefusedError(entry)
  if (process.env[PG_CONFIGURED_KEY] === '1') throw new SqliteEntryRefusedError(entry, true)
  // decision D3: the store marker of a PostgreSQL install refuses the SQLite entry even when every configuration layer is gone.
  // An unreadable marker counts as present (doubt is PostgreSQL, as in the hooks).
  if (pgInstallMarkerPresent()) throw new SqliteEntryRefusedError(entry, 'marker')
}

function pgInstallMarkerPresent(): boolean {
  return pgInstallMarkerPresentIn(STORE_DIR)
}

/**
 * The store marker (P-E) is present in `storeDir`: the marker file can be stat'ed, or the stat fails for any reason other
 * than "absent" (an unreadable store, a store that is a file). Doubt is PostgreSQL, the same rule as the shell reference
 * (scripts/pg-configured.sh) and the hook side (scripts/hooks/hook_pg_mode.py). Exported so the parity cell calls THIS
 * reader, not a copy of it.
 */
export function pgInstallMarkerPresentIn(storeDir: string): boolean {
  try {
    statSync(join(storeDir, PG_INSTALL_MARKER))
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}
