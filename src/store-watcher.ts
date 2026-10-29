import { watch, statSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logStoreFileEvent } from './db.js'
import { logger } from './logger.js'

import { runAs } from './db/context.js'
// --- System file denylist ---
// Only files NOT on this list (and not matching SYSTEM_RE) are logged.
// Everything else = Marveen-managed state that would produce noise.
// "Agent-created" files are those that remain after filtering.
const SYSTEM_FILES = new Set([
  // SQLite database
  'claudeclaw.db', 'claudeclaw.db-wal', 'claudeclaw.db-shm',
  // Marveen runtime / scheduler state
  'schedule-last-run.json', 'external-ops-last-run',
  'kanban-audit-state.json',
  // Settings and config overrides written by dashboard routes
  'dashboard-settings.json',
  // Fleet and agent management
  'agents-desired.json', 'auto-restart.json',
  // Auth and secrets
  '.dashboard-token', '.agent-token', '.operator-token', '.vault-key', 'vault.json', '.claude-oauth-token', '.claim-signing-key',
  // Federation config + inbound peer token (written by /api/federation/peers)
  'federation.json', '.federation-token',
  // Capability-summary cache (written by the capability-summary runner);
  // capability text, not a secret -- deliberately NOT in SENSITIVE_NAMES.
  'capability-summaries.json',
  // Usage and keepalive
  'claude-usage.json', '.channel-keepalive', '.channel-last-respawn',
  // Egress-gate hook: DB-backed since migration 0056 (#985); the file stays
  // as the hook's fail-safe fallback and its own disk-cache, neither of
  // which are agent-created state worth an audit row.
  'egress-allowlist.json', '.egress-allowlist-cache.json',
  // Known Marveen-written log files
  'channels.log', 'channels.error.log',
  'dashboard.log', 'dashboard.error.log',
  'update.log',
])

// Regex for system-generated filename patterns.
// Also covers atomic-write temp files (keep in sync with settings-store.ts).
// \.deprecated$ covers config-overrides.json.deprecated (S8B): the file gets
// renamed to this suffix as the one-time retirement migration runs, and that
// rename must not surface as a "new agent-created file" audit row.
const SYSTEM_RE = /\.pid$|\.tmp$|\.tmp\.[a-f0-9]+$|\.migrated$|\.bak$|\.deprecated$|^\.DS_Store$/

// Filenames whose presence is sensitive; the audit row is flagged so the UI
// can show a sanitised label instead of hinting at secret values.
const SENSITIVE_NAMES = new Set(['.dashboard-token', '.agent-token', '.operator-token', 'vault.json', '.vault-key', '.claude-oauth-token', '.claim-signing-key', '.federation-token', 'federation.json'])

// --- Attribution ---
// A new store file is recorded without an actor (agent NULL, "ismeretlen" in the UI): fs.watch
// calls back from the file system's own async origin, so nothing of the writing request (an
// AsyncLocalStorage value, a process-wide slot) can be read there, and the OS offers no writer
// identity. No code writes a store file on behalf of a request today; who changed a setting
// stays in config_change_log. See docs/db-facade.md, Known limits.

// --- Known-files tracking for creation detection ---
// Populated at watcher startup by scanning store/. A rename event for a path
// NOT in this set where the file NOW EXISTS means a new file was created.
let knownFiles = new Set<string>()

function scanStore(dir: string, relBase: string = ''): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        scanStore(join(dir, entry.name), rel)
      } else {
        knownFiles.add(rel)
      }
    }
  } catch { /* non-fatal; store may not exist yet */ }
}

// --- Dedup ---
// fs.watch fires the same (eventType, filename) multiple times for a single
// logical operation. Collapse repeats within a short window.
const DEDUP_MS = 1000
const recentEvents = new Map<string, number>()

let watcher: ReturnType<typeof watch> | null = null

// Whole-directory denylist prefixes, for trees whose filenames vary (so a
// fixed-name SYSTEM_FILES entry can't cover them). scheduled-runs/ is the
// Snapshot dir: ~100 new files/day by design (one per large-task fire),
// which would otherwise drown every real agent-created-file audit row in
// scheduler noise.
const SYSTEM_DIR_PREFIXES = ['scheduled-runs/']

function isSystemFile(rel: string): boolean {
  const name = basename(rel)
  if (SYSTEM_FILES.has(name) || SYSTEM_RE.test(name)) return true
  return SYSTEM_DIR_PREFIXES.some(prefix => rel.startsWith(prefix))
}

export function startStoreWatcher(): void {
  if (watcher) return

  knownFiles = new Set<string>()
  scanStore(STORE_DIR)

  try {
    watcher = watch(STORE_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      const rel = filename.replace(/\\/g, '/')

      // Only rename events can indicate a new file. change = modification.
      if (eventType !== 'rename') return

      // Skip system and temp files -- Marveen's own runtime writes.
      if (isSystemFile(rel)) return

      // If the file no longer exists it was deleted or renamed away -- not a creation.
      let fileSize: number | null = null
      try {
        const st = statSync(`${STORE_DIR}/${rel}`)
        fileSize = st.size
      } catch {
        // File gone: deletion or rename-away. Update knownFiles and skip.
        knownFiles.delete(rel)
        return
      }

      // Already known → not a new creation (could be a rename-to-same or
      // replace; ignore to avoid false positives).
      if (knownFiles.has(rel)) return

      // Dedup: fs.watch may fire the rename event several times.
      const now = Date.now()
      const dedupKey = rel
      const last = recentEvents.get(dedupKey)
      if (last !== undefined && now - last < DEDUP_MS) return
      recentEvents.set(dedupKey, now)
      if (recentEvents.size > 200) {
        for (const [k, t] of recentEvents) if (now - t >= DEDUP_MS) recentEvents.delete(k)
      }

      // New file -- record it and mark as known.
      knownFiles.add(rel)
      const isSensitive = SENSITIVE_NAMES.has(basename(rel)) ? 1 : 0

      // A watch callback is synchronous: the write is left to run, and its failure is logged here.
      runAs.system('store-watcher', () => logStoreFileEvent(rel, 'create', isSensitive, fileSize)).catch((err: unknown) => {
        logger.warn({ err, rel }, 'store-watcher: failed to log new file event')
      })
    })
    logger.info({ dir: STORE_DIR, knownCount: knownFiles.size }, 'Store file watcher started')
  } catch (err) {
    logger.warn({ err }, 'Store file watcher failed to start')
  }
}

export function stopStoreWatcher(): void {
  if (!watcher) return
  try { watcher.close() } catch { /* best-effort */ }
  watcher = null
}
