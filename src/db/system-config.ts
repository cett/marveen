// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).
//
// Read/write access to system_config (migration 0051) plus the one-time
// migrator that copies existing store/config-overrides.json entries into it,
// as part of the wider zero-install work. config.ts's cfg() reads this same
// table too, but through its OWN standalone read-only connection rather than
// through this module -- see the comment above readSystemConfigTable() in
// config.ts for why (importing this module there would cycle back through
// connection.ts's config.ts import).

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { db } from './connection.js'
import { dbx } from './facade.js'
import { cacheAfterWrite, cachedSystemConfig, cachedSystemConfigList, refreshSystemConfigCacheIfLive } from './config-cache.js'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

export interface SystemConfigRow {
  key: string
  value: string
  updated_at: number
  source: string
}

// Reads are served from the synchronous write-through cache (config-cache.ts) once initDatabase() has loaded
// it for the current connection; until then (and for a connection the cache was not loaded for) they read the
// table, exactly as before. The reads stay synchronous when the db layer turns async.
export function getSystemConfig(key: string): SystemConfigRow | undefined {
  const cached = cachedSystemConfig(key)
  if (cached !== null) return cached
  return db.prepare('SELECT key, value, updated_at, source FROM system_config WHERE key = ?').get(key) as
    | SystemConfigRow
    | undefined
}

export function listSystemConfig(): SystemConfigRow[] {
  const cached = cachedSystemConfigList()
  if (cached !== null) return cached
  return db.prepare('SELECT key, value, updated_at, source FROM system_config ORDER BY key').all() as SystemConfigRow[]
}

const UPSERT_SQL = `INSERT INTO system_config (key, value, updated_at, source) VALUES (?, ?, unixepoch(), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, source = excluded.source`

// Upsert. source defaults to 'db' (an operator/admin set this directly,
// as opposed to 'migrated_from_json' -- see migrateConfigOverridesToSystemConfig).
export async function setSystemConfig(key: string, value: string, source: string = 'db'): Promise<void> {
  await dbx.run(UPSERT_SQL, key, value, source)
  cacheAfterWrite(key) // database first, then the cache
}

// The boot twin of setSystemConfig: initDatabase() runs before anything can await, and it restores the
// schedule tick stamp with one write. Only db/index.ts calls it (db-boot-sync-twins.test.ts).
// @boot-sync-twin
export function setSystemConfigSync(key: string, value: string, source: string = 'db'): void {
  db.prepare(UPSERT_SQL).run(key, value, source)
  cacheAfterWrite(key) // database first, then the cache
}

/**
 * Read-modify-write of one key that cannot lose an update. The current value is read FROM THE DATABASE inside an
 * immediate transaction (never from the cache: the cache is the other writer's last word only after its commit),
 * `mutate` turns it into the next value, and the write is part of the same transaction. Two overlapping calls
 * therefore both land: the second sees what the first wrote. The cache follows the commit.
 *
 * `mutate` runs under the connection's transaction lock: pure code only, no I/O, no awaits. Returning `undefined`
 * leaves the row alone (no write, no `updated_at` bump). Resolves to whether a write happened.
 */
export async function updateSystemConfig(
  key: string,
  mutate: (current: string | undefined) => string | undefined,
  source: string = 'db',
): Promise<boolean> {
  const wrote = await dbx.tx(async (tx) => {
    const row = await tx.get<{ value: string }>('SELECT value FROM system_config WHERE key = ?', key)
    const next = mutate(row?.value)
    if (next === undefined) return false
    await tx.run(UPSERT_SQL, key, next, source)
    return true
  }, { mode: 'immediate' })
  if (wrote) cacheAfterWrite(key) // database first, then the cache
  return wrote
}

/**
 * Write several keys as one unit: one transaction, and the cache follows the commit for all of them in one
 * synchronous step, so a reader never sees half of the group (the writes were atomic against the event loop
 * while they were synchronous; three awaited `setSystemConfig` calls would not be).
 */
export async function setSystemConfigMany(entries: ReadonlyArray<readonly [string, string]>, source: string = 'db'): Promise<void> {
  if (entries.length === 0) return
  await dbx.tx(async (tx) => {
    for (const [key, value] of entries) await tx.run(UPSERT_SQL, key, value, source)
  }, { mode: 'immediate' })
  for (const [key] of entries) cacheAfterWrite(key) // database first, then the cache
}

// Insert only when the key has no row yet; an existing row is never touched. Returns true when this
// call created the row. For one-time backfills that must be safe to repeat on every boot.
export async function insertSystemConfigIfAbsent(key: string, value: string, source: string): Promise<boolean> {
  const info = await dbx.run(
    `INSERT INTO system_config (key, value, updated_at, source) VALUES (?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    key,
    value,
    Math.floor(Date.now() / 1000),
    source,
  )
  if (info.changes > 0) cacheAfterWrite(key) // database first, then the cache
  return info.changes > 0
}

// Hard delete, not a value clear -- for keys that may hold secret material
// (e.g. federation peer tokens), leaving a stale row with an empty value is
// worse than removing it outright. Used by removeFederationStore().
export async function deleteSystemConfig(key: string): Promise<void> {
  await dbx.run('DELETE FROM system_config WHERE key = ?', key)
  cacheAfterWrite(key) // database first, then the cache
}

// One-time migration of store/config-overrides.json into system_config.
// INSERT OR IGNORE: a key already present in system_config -- whether set by
// an operator (source='db') or by a previous run of this same migration --
// is left untouched, never overwritten. That makes this safe to call on
// every boot (see db/index.ts initDatabase()): the first run backfills
// whatever is in the JSON side-car, every later run is a no-op for keys it
// already migrated. Kept running after S8B (config.ts / settings-store.ts no
// longer read the JSON file at all) as the safety net for an install
// upgrading straight from a pre-S4 version that still has un-migrated keys
// sitting in the file -- reading a file that will usually not exist post-S8B
// is a harmless no-op via the existsSync check below.
export function migrateConfigOverridesToSystemConfig(): number {
  const overridesPath = join(STORE_DIR, 'config-overrides.json')
  if (!existsSync(overridesPath)) return 0

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(overridesPath, 'utf-8'))
  } catch (err) {
    logger.warn({ err }, 'system_config migration: failed to parse config-overrides.json, skipping')
    return 0
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0

  const stmt = db.prepare(
    `INSERT INTO system_config (key, value, updated_at, source) VALUES (?, ?, unixepoch(), 'migrated_from_json')
     ON CONFLICT DO NOTHING`
  )
  let migrated = 0
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined) continue
    const result = stmt.run(key, String(value))
    if (result.changes > 0) migrated++
  }
  if (migrated > 0) refreshSystemConfigCacheIfLive()
  return migrated
}

// S8B: one-time retirement rename of store/config-overrides.json to
// config-overrides.json.deprecated. Called from src/index.ts's real process
// boot, always AFTER initDatabase() -> migrateConfigOverridesToSystemConfig()
// has run, so by the time this runs every key the JSON file held is
// guaranteed to already be a row in system_config (INSERT OR IGNORE never
// skips a key that isn't already there). Idempotent: a missing source file
// (already renamed, or never existed) is a no-op -- nothing to log, nothing
// to do. Logged on an actual rename so a live system's boot log shows the
// retirement happening. The renamed .deprecated file is the manual rollback
// net (an operator can rename it back and re-run the migrator);
// store-watcher.ts's SYSTEM_RE already denylists the .deprecated suffix so
// the rename itself does not surface as an audited "new file".
//
// Deliberately NOT called from db/index.ts's initDatabase() itself (unlike
// the migrator above): that function also runs from every test file's
// beforeEach against the SAME real, shared worktree store/ directory (no
// per-test STORE_DIR isolation in this codebase), and a rename there would
// race other concurrently-running test files reading/writing the same
// physical path. The migrator is read-only w.r.t. the filesystem (writes
// only into its own process-local DB connection), so it doesn't share this
// problem.
// One-time migration of store/model-fallback.json, store/agents-desired.json,
// and store/terminal-input.json into system_config (#985 group 5/8). Unlike
// group 1's egress-allowlist (slowly-changing admin data, safe to bake a
// static "current values" seed into the migration SQL), these three carry
// either an install-dependent value (the fallback chain's primary must match
// the actually-running model -- see defaultChainForInstall() in
// model-fallback-store.ts) or a security-sensitive default (terminal-input:
// operator must explicitly opt in, OFF otherwise) -- baking this fork's
// current operator choices into the shipped migration would silently
// override a fresh install's correct defaults. So this is the same
// idempotent per-key INSERT-OR-IGNORE backfill as
// migrateConfigOverridesToSystemConfig above, just reading these three JSON
// side-cars instead of config-overrides.json: an existing install keeps
// whatever it already had, a fresh install (no file) gets no row here and
// falls through to the code-level DEFAULT_* each store module already
// applies when a key is absent. Safe to call on every boot.
function migrateOneGroup5File(filename: string, extract: (parsed: unknown) => Array<[string, string]>): number {
  const filePath = join(STORE_DIR, filename)
  if (!existsSync(filePath)) return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch (err) {
    logger.warn({ err, filePath }, 'system_config migration: failed to parse file, skipping')
    return 0
  }
  const stmt = db.prepare(
    `INSERT INTO system_config (key, value, updated_at, source) VALUES (?, ?, unixepoch(), 'migrated_from_json')
     ON CONFLICT DO NOTHING`
  )
  let migrated = 0
  for (const [key, value] of extract(parsed)) {
    const result = stmt.run(key, value)
    if (result.changes > 0) migrated++
  }
  if (migrated > 0) refreshSystemConfigCacheIfLive()
  return migrated
}

export function migrateGroup5StateFromFiles(): number {
  let migrated = 0
  migrated += migrateOneGroup5File('model-fallback.json', (parsed) => {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const o = parsed as Record<string, unknown>
    const out: Array<[string, string]> = []
    if (typeof o.enabled === 'boolean') out.push(['model_fallback_enabled', o.enabled ? '1' : '0'])
    if (Array.isArray(o.chain) && o.chain.every((m) => typeof m === 'string')) {
      out.push(['model_fallback_chain', JSON.stringify(o.chain)])
    }
    if (typeof o.revertAfterMinutes === 'number' && Number.isFinite(o.revertAfterMinutes)) {
      out.push(['model_fallback_revert_after_minutes', String(o.revertAfterMinutes)])
    }
    return out
  })
  migrated += migrateOneGroup5File('agents-desired.json', (parsed) => {
    if (!Array.isArray(parsed)) return []
    const names = parsed.filter((x): x is string => typeof x === 'string')
    return [['agents_desired', JSON.stringify(names)]]
  })
  migrated += migrateOneGroup5File('terminal-input.json', (parsed) => {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const o = parsed as Record<string, unknown>
    return [['terminal_input_enabled', o.enabled === true ? '1' : '0']]
  })
  return migrated
}

// group 5/8: the three files migrateGroup5StateFromFiles() backfills
// above were left un-retired -- every other group renames its source file(s)
// to .deprecated once the backfill has guaranteed the DB holds everything the
// file had (retireAgentSettingsFiles() in db/index.ts is the closest sibling,
// same multi-file loop). Deliberately NOT called from initDatabase() itself,
// same shared-worktree-store/-dir test-race reason as retireConfigOverridesFile()
// above -- called once from src/index.ts's real process boot instead.
export function retireGroup5StateFiles(): void {
  for (const name of ['model-fallback.json', 'agents-desired.json', 'terminal-input.json']) {
    const p = join(STORE_DIR, name)
    if (!existsSync(p)) continue
    try {
      renameSync(p, `${p}.deprecated`)
      logger.info({ path: p }, 'group 5/8 state file retired (renamed to .deprecated) -- system_config DB is now the only read source')
    } catch (err) {
      logger.warn({ err, path: p }, 'system_config migration: failed to rename file to .deprecated')
    }
  }
}

export function retireConfigOverridesFile(): void {
  const overridesPath = join(STORE_DIR, 'config-overrides.json')
  if (!existsSync(overridesPath)) return
  try {
    renameSync(overridesPath, `${overridesPath}.deprecated`)
    logger.info({ overridesPath }, 'config-overrides.json retired (renamed to .deprecated) -- system_config DB is now the only read source')
  } catch (err) {
    logger.warn({ err, overridesPath }, 'system_config migration: failed to rename config-overrides.json to .deprecated')
  }
}
