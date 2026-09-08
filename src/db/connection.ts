// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync } from 'node:fs'
import { load as loadSqliteVec } from 'sqlite-vec'
import { DB_FILENAME, STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { applyMigrations } from '../db-migrations.js'

export let db: Database.Database
export let vecExtensionLoaded = false
let vecExtensionAttempted = false

// Lock the DB file and its sidecars (WAL, SHM, rollback journal) down to
// owner-only. better-sqlite3 opens the main file with the process umask
// (typically 0o644), which leaves a TOCTOU window where any other local
// process -- malicious npm postinstall, rogue shell script, unrelated
// tool running under the operator's UID -- can open() it for read BEFORE
// we narrow the mode. The narrowed chmod would not revoke an already-
// opened fd. Defense in depth:
//   (1) Pre-create the main DB file via openSync('wx', 0o600) so better-
//       sqlite3 inherits the tight mode on fresh installs and the race
//       window is closed entirely.
//   (2) After Database() + PRAGMA wal, chmod the sidecars (WAL/SHM/
//       journal) -- they were created during the pragma call at umask.
//       This path also fixes older installs whose files sit at 0o644.
function tightenDbPermissions(dbPath: string): void {
  const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]
  for (const path of sidecars) {
    if (!existsSync(path)) continue
    try { chmodSync(path, 0o600) } catch (err) {
      logger.warn({ err, path }, 'Failed to tighten DB file permissions')
    }
  }
}

// dbPathOverride is for tests: pass ':memory:' (or a temp file path) to open an
// isolated database instead of the real store/claudeclaw.db. ':memory:' has no
// path to chmod, so the file-precreate (openSync 'wx') and tightenDbPermissions
// steps are skipped for it. A real on-disk override path (e.g. a /tmp temp file)
// STILL gets pre-create + tighten -- this lets the permission tests exercise the
// tightening logic on a throwaway file instead of touching the prod DB. The
// STORE_DIR mkdir stays prod-only; a temp-file override owns its own directory.
export function initDatabase(dbPathOverride?: string): void {
  const useOverride = dbPathOverride !== undefined
  const isMemory = dbPathOverride === ':memory:'
  if (!useOverride) mkdirSync(STORE_DIR, { recursive: true })
  // Idempotent re-init: close a previous handle before opening a new one
  // so repeated calls (tests, hot-reload, recovery paths) do not leak
  // the old better-sqlite3 fd.
  if (db) {
    try { db.close() } catch { /* already closed */ }
  }
  vecExtensionLoaded = false
  vecExtensionAttempted = false
  const dbPath = useOverride ? dbPathOverride! : join(STORE_DIR, DB_FILENAME)
  // Step 1: close the TOCTOU window on fresh installs. openSync with 'wx'
  // + 0o600 creates the file ONLY if it doesn't exist and sets the strict
  // mode atomically. better-sqlite3 then opens the existing file rather
  // than creating one at the default umask. Skipped only for ':memory:'.
  if (!isMemory && !existsSync(dbPath)) {
    try {
      closeSync(openSync(dbPath, 'wx', 0o600))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // EEXIST: a concurrent startup won the race and created it. The
      // tightenDbPermissions call below will correct its mode.
      if (code !== 'EEXIST') {
        logger.warn({ err, dbPath }, 'Pre-create of DB file failed, continuing; mode will be tightened post-open')
      }
    }
  }
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  // Performance pragmas: safe with WAL, applied after journal_mode is set.
  // cache_size: negative value = kibibytes; -8192 → 8 MB page cache (was 64 MB).
  //   In WAL mode the page cache has minimal I/O impact; 8 MB is ample for the
  //   query mix here and saves ~56 MB RSS at idle (the memory-reduction plan P1).
  // mmap_size: memory-mapped I/O in bytes; 64 MB (was 256 MB). Still covers the
  //   typical DB size and avoids the large anonymous mapping that bloats RSS (P2).
  // synchronous = NORMAL: safe under WAL (only full-fsync skipped, not the WAL checkpoint).
  db.pragma('cache_size = -8192')
  if (!isMemory) db.pragma('mmap_size = 67108864')
  db.pragma('synchronous = NORMAL')
  // Concurrency pragmas: applied before migrations so the retry window is
  // active even during the first-run schema creation.
  //
  // busy_timeout: retry for up to 5 s on SQLITE_BUSY instead of failing
  // immediately. Covers transient write-lock contention (checkpoint, dual-
  // process on the same DB, long batch transactions).
  db.pragma('busy_timeout = 5000')
  // wal_autocheckpoint: raise from 1000 to 2000 pages (~8 MB WAL max).
  // Fewer automatic checkpoints = fewer brief exclusive-lock windows that
  // could race with concurrent writers in the k8rack dual-instance setup.
  db.pragma('wal_autocheckpoint = 2000')
  // Startup checkpoint: collapse the WAL into the main DB file so every
  // fresh start begins with a minimal WAL (currently 5.9 MB before fix).
  // TRUNCATE resets the WAL to zero bytes after all frames are written.
  // Skipped for :memory: databases (no WAL file on disk).
  if (!isMemory) db.pragma('wal_checkpoint(TRUNCATE)')
  if (!isMemory) tightenDbPermissions(dbPath)

  // Load sqlite-vec BEFORE migrations. A schema-changing migration (table
  // rebuild: create-copy-drop-rename) makes SQLite reparse the schema, which
  // validates every trigger -- including the vec0-backed memories triggers. If
  // the extension is not loaded on this connection yet, that reparse fails with
  // "no such module: vec0" and the process dies before the dashboard can start
  // (2026-08-28 outage, migration 0022). Safe no-op when the binary is missing;
  // initVecSupport() below still does the virtual-table setup.
  tryLoadVecExtension()

  // Runtime invariant: tryLoadVecExtension() must be called before any
  // migration. If this throws, someone moved the call below applyMigrations --
  // do NOT suppress this error; restore the call order above.
  if (!vecExtensionAttempted) {
    throw new Error(
      'BUG: tryLoadVecExtension() must run before applyMigrations() -- ' +
      'see 2026-08-28 outage: table-rebuild migrations trigger a full schema ' +
      'reparse that validates vec0-backed triggers before the module is loaded',
    )
  }

  applyMigrations(db)

  // INVARIANT: a row that says 'delivered' must carry a delivered_at.
  //
  // On 2026-07-27 an operator bulk-closed a 28-row backlog with raw SQL that
  // set status without a timestamp. Nothing broke loudly -- but the queue,
  // which is the only signal we have for "what actually went out", started
  // claiming that messages had been delivered when they never left. It took an
  // hour of log archaeology to work out which of them the recipients had
  // genuinely received and which they had only read out of band, and the answer
  // was recoverable that day purely by luck.
  //
  // Enforced with a trigger rather than a CHECK constraint because SQLite
  // cannot add a CHECK to an existing table without rebuilding it, and this is
  // not worth a rebuild of the message log. Self-healing rather than ABORT:
  // aborting would turn a bookkeeping slip into a failed operation for the
  // caller, and the point is to keep the RECORD honest, not to police writers.
  // The row gets a timestamp AND -- if nothing else explains it -- a marker
  // saying it was closed without ever being delivered, so the distinction
  // survives in the data instead of in someone's memory.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS agent_messages_delivered_needs_ts
    AFTER UPDATE OF status ON agent_messages
    FOR EACH ROW WHEN NEW.status = 'delivered' AND NEW.delivered_at IS NULL
    BEGIN
      UPDATE agent_messages
         SET delivered_at = CAST(strftime('%s','now') AS INTEGER),
             result = COALESCE(result, 'closed-without-delivery')
       WHERE id = NEW.id;
    END
  `)

  // One-time L1 backfill: federation system ids are now stored lowercase, but
  // rows written by a pre-L1 build (an install that federated with a
  // display-cased id like "Teodor/agent") keep their old case. Left alone,
  // thread grouping and conversation history key on the exact string and
  // silently SPLIT such a peer into two threads once new lowercase rows
  // arrive. Fold the SYSTEM prefix of qualified rows in place (the agent
  // segment keeps its case -- it is the peer's namespace). Idempotent: an
  // already-lowercase prefix compares equal and is skipped, so this is a
  // safe no-op after the first run and on fresh installs.
  db.exec(`
    UPDATE agent_messages
       SET from_agent = lower(substr(from_agent, 1, instr(from_agent, '/') - 1)) || substr(from_agent, instr(from_agent, '/'))
     WHERE instr(from_agent, '/') > 0
       AND substr(from_agent, 1, instr(from_agent, '/') - 1) <> lower(substr(from_agent, 1, instr(from_agent, '/') - 1))
  `)
  db.exec(`
    UPDATE agent_messages
       SET to_agent = lower(substr(to_agent, 1, instr(to_agent, '/') - 1)) || substr(to_agent, instr(to_agent, '/'))
     WHERE instr(to_agent, '/') > 0
       AND substr(to_agent, 1, instr(to_agent, '/') - 1) <> lower(substr(to_agent, 1, instr(to_agent, '/') - 1))
  `)


  // One-shot migration from the old JSON file (which had a read-modify-write
  // race). Import rows if they exist, then rename the file so we don't keep
  // re-importing. Wrapped in a transaction so a crash mid-import is safe.
  migrateTaskRunsFromJson()

  // Convert any remaining JSON-text embeddings to compact Float32 BLOB and null
  // out the TEXT column. Idempotent: rows already having embedding_blob are
  // skipped; on fresh installs or after a full backfill this is a no-op.
  // Vector-domain post-migration setup (ANN table/trigger wiring, embedding
  // BLOB migration, import-shadow backfill) runs from db/index.ts's
  // initDatabase() wrapper, AFTER this function returns -- see db/index.ts.
  // connection.ts intentionally never imports a domain module (see db/index.ts
  // header comment) so it stays the acyclic root every other db/*.ts depends on.
}

function migrateTaskRunsFromJson(): void {
  const legacyPath = join(STORE_DIR, 'task-run-history.json')
  if (!existsSync(legacyPath)) return
  const existingCount = (db.prepare('SELECT COUNT(*) as c FROM task_runs').get() as { c: number }).c
  if (existingCount > 0) {
    // Already migrated in a previous run. Rename the file out of the way if
    // still present so the migration doesn't keep re-running with zero effect.
    try { renameSync(legacyPath, `${legacyPath}.migrated`) } catch { /* fine */ }
    return
  }
  try {
    const raw = readFileSync(legacyPath, 'utf-8')
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return
    const insert = db.prepare('INSERT INTO task_runs (name, agent, ts) VALUES (?, ?, ?)')
    const tx = db.transaction((rows: unknown[]) => {
      for (const e of rows) {
        if (!e || typeof e !== 'object') continue
        const { name, agent, ts } = e as { name?: unknown; agent?: unknown; ts?: unknown }
        if (typeof name !== 'string' || typeof agent !== 'string' || typeof ts !== 'number') continue
        insert.run(name, agent, ts)
      }
    })
    tx(arr)
    try { renameSync(legacyPath, `${legacyPath}.migrated`) } catch { /* fine */ }
  } catch { /* corrupt file, skip */ }
}

export function getDb(): Database.Database {
  return db
}

export function tryLoadVecExtension(): void {
  vecExtensionAttempted = true
  try {
    loadSqliteVec(db)
    vecExtensionLoaded = true
  } catch {
    logger.debug('sqlite-vec extension unavailable, using BLOB cosine similarity fallback')
  }
}
