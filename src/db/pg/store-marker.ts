// The PostgreSQL install marker (P-E): <store dir>/.pg-installed, one line, written ONCE by the PostgreSQL boot.
//
// It is the one durable fact about "this install runs on PostgreSQL" that lives outside the configuration: the URL, the
// secret mount, the .env line and the MARVEEN_PG_CONFIGURED variable can all be lost, and when they are, every consumer
// would read the install as SQLite and use the frozen file. The shell helper (scripts/pg-configured.sh) and the hook side
// (scripts/hooks/hook_pg_mode.py) read this file as a fifth layer. The app's SQLite entry refuses on it too (decision D3, assertSqliteEntryAllowed in url.ts).
//
// Rules: written only when absent (idempotent, never rewritten), mode 0644, atomic (temp file and rename), and best effort:
// a failed write is logged once and the boot goes on (the marker is a safety net, not a boot condition). The content
// carries no URL and no secret, only the time of the first boot. The store dir is the one of this process, so an isolated
// instance with its own MARVEEN_STORE_DIR gets its own marker and never inherits the live one.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../../web/atomic-write.js'
import { logger } from '../../logger.js'

export const PG_MARKER_FILE = '.pg-installed'

let warned = false

// Two boots that race both see the marker absent and both rename into place: the last rename wins, and the two contents
// differ only in the timestamp. Accepted (PR 959 nit 9): the marker's job is the fact that it exists, not its time.
/** Writes the marker into `storeDir` when it is absent. Returns true when this call wrote it. Never throws. */
export function writePgInstalledMarker(storeDir: string, now: Date = new Date()): boolean {
  const path = join(storeDir, PG_MARKER_FILE)
  if (existsSync(path)) return false
  try {
    atomicWriteFileSync(path, `pg-installed ${now.toISOString()}\n`, { mode: 0o644 })
    return true
  } catch (err) {
    // once per process: a store dir that cannot be written is one condition, not one line per call
    if (!warned) {
      warned = true
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'PostgreSQL install marker not written; the boot goes on')
    }
    return false
  }
}
