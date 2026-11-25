// The database boot of the channel coordinator: the SLIM counterpart of the dashboard's boot.
//
// The coordinator is its own launchd unit and only backfills inbound events, so it opens a connection and checks the schema and
// does nothing else: no importers, no file retirements, no cache loads that are not its own (see the PostgreSQL branch below).
//
//   SQLite      initProcessDatabase(): the file, the pragmas, the migration runner (the same as the dashboard's, so a
//               coordinator-first boot cannot drift from the schema the dashboard expects).
//   PostgreSQL  bootPgBackend({ migrateUrl: '' }): the serving pool on the application role, the role and extension preflights,
//               and a CHECK that the schema is current. NEVER a migration: the dashboard owns the schema, and a coordinator
//               that starts before it on a database that is behind refuses to boot with the step named, it does not create
//               tables. The empty migrate URL is the whole point of this file: without it bootPgBackend would take
//               MARVEEN_PG_MIGRATE_URL (the OWNER role) from the install .env and run DDL as the owner from this process.
//
// The URL is resolved the way the dashboard resolves it (secret mount, process environment, the install's .env: db/pg/url.ts);
// the bootstrap (channel-coordinator.ts) has already moved it out of process.env. Nothing here reads or logs it.
import { resolvePgUrl } from '../db/pg/url.js'
import { bootPgBackend, closePgBackend } from '../db/pg-boot.js'
import { closeDatabase, initProcessDatabase } from '../db/connection.js'

export type CoordinatorBackend = 'sqlite' | 'pg'

let booted: CoordinatorBackend | null = null

/** Boots the database of this process. Throws (PgBootError names the step) instead of running on the wrong database. */
export async function bootCoordinatorDb(): Promise<CoordinatorBackend> {
  if (booted !== null) return booted
  if (resolvePgUrl() !== undefined) {
    // migrateUrl '' = none, whatever the environment says (see the header)
    await bootPgBackend({ migrateUrl: '' })
    booted = 'pg'
  } else {
    initProcessDatabase()
    booted = 'sqlite'
  }
  return booted
}

/** Ends the pool or closes the file. Safe to call twice and before a boot. */
export async function closeCoordinatorDb(): Promise<void> {
  const was = booted
  booted = null
  if (was === 'pg') await closePgBackend()
  else if (was === 'sqlite') closeDatabase()
}
