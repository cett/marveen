// The one place where a process loads the system_config snapshot before config.ts evaluates (phase 3, step F1). Every process
// that starts separately from the application body calls ensureConfigSnapshot() first, then imports its body dynamically:
// the bootstrap of src/index.ts, the channel-coordinator and reconnect-cli bootstraps, and the CLI runner.
//
// A leaf for config.ts: it imports nothing that imports config.ts (db/pg/url.ts, the snapshot modules and the loader only).
// Keep it that way, or the snapshot would be set after config.ts has already evaluated.
//
// On an install on SQLite there is no PostgreSQL URL and the call does nothing. The load runs once per process; a failed load
// rejects with the same error on every call, so a caller cannot continue past it by calling again.
import { capturePgCredentials, resolvePgUrl } from './db/pg/url.js'
import { setConfigSnapshot } from './config-snapshot.js'
import { loadSystemConfigSnapshot } from './config-snapshot-loader.js'

let pending: Promise<void> | undefined

/**
 * Loads and sets the snapshot when a PostgreSQL URL is configured. Idempotent: the first call decides for the process.
 * The first step takes the PostgreSQL URLs out of process.env, so nothing spawned after this call inherits them.
 */
export function ensureConfigSnapshot(): Promise<void> {
  capturePgCredentials()
  if (pending === undefined) pending = loadOnce()
  return pending
}

async function loadOnce(): Promise<void> {
  const pgUrl = resolvePgUrl()
  if (pgUrl === undefined) return
  setConfigSnapshot(await loadSystemConfigSnapshot(pgUrl))
}
