// Where the production PostgreSQL connection URL comes from (phase 3, step 6c-1).
//
// `MARVEEN_PG_URL` is the single switch of the backend: present = PostgreSQL, absent = SQLite, exactly as before.
// It is read BEFORE config.ts needs it and never from `system_config` (a database setting cannot name the database
// that holds it). Precedence, the same shape as config.ts's cfg() without its database layer, FIRST NON-EMPTY wins:
//   1. the secret mount (/run/secrets/MARVEEN_PG_URL), so the password stays out of .env,
//   2. process.env,
//   3. the .env file of the install.
// An empty or whitespace-only value counts as absent and falls through to the next layer (as cfg() does): a half-edited
// .env line must not switch the backend, and an unset URL and an empty one are the same answer.
//
// This file is a leaf on purpose (env.ts and secret-resolver.ts only): db/connection.ts imports it for the SQLite
// entry guard below, and connection.ts must stay acyclic (it never imports a domain module).
import { readEnvFile } from '../../env.js'
import { resolveSecret } from '../../secret-resolver.js'

export const PG_URL_KEY = 'MARVEEN_PG_URL'

/**
 * The second URL of the boot split: the connection the schema step migrates with (the owner of the objects), used for
 * that one step and then ended. The serving pool is never built from it. Resolved through the same three layers as
 * `MARVEEN_PG_URL`; absent = the boot only checks that the schema is current and never changes it.
 */
export const PG_MIGRATE_URL_KEY = 'MARVEEN_PG_MIGRATE_URL'

function resolveKey(key: string): string | undefined {
  // lazy: the .env file is read only when the two layers above it said nothing
  const layers: Array<() => string | undefined> = [
    () => resolveSecret(key),
    () => process.env[key],
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
  constructor(entry: string) {
    super(
      `${entry}: ${PG_URL_KEY} is set, and this entry point is SQLite-only until the PostgreSQL cutover. ` +
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
}
