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

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from './connection.js'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

export interface SystemConfigRow {
  key: string
  value: string
  updated_at: number
  source: string
}

export function getSystemConfig(key: string): SystemConfigRow | undefined {
  return db.prepare('SELECT key, value, updated_at, source FROM system_config WHERE key = ?').get(key) as
    | SystemConfigRow
    | undefined
}

export function listSystemConfig(): SystemConfigRow[] {
  return db.prepare('SELECT key, value, updated_at, source FROM system_config ORDER BY key').all() as SystemConfigRow[]
}

// Upsert. source defaults to 'db' (an operator/admin set this directly,
// as opposed to 'migrated_from_json' -- see migrateConfigOverridesToSystemConfig).
export function setSystemConfig(key: string, value: string, source: string = 'db'): void {
  db.prepare(
    `INSERT INTO system_config (key, value, updated_at, source) VALUES (?, ?, unixepoch(), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, source = excluded.source`
  ).run(key, value, source)
}

// One-time migration of store/config-overrides.json into system_config.
// INSERT OR IGNORE: a key already present in system_config -- whether set by
// an operator (source='db') or by a previous run of this same migration --
// is left untouched, never overwritten. That makes this safe to call on
// every boot (see db/index.ts initDatabase()): the first run backfills
// whatever is in the JSON side-car, every later run is a no-op for keys it
// already migrated. The JSON file itself is left in place -- still the
// active read/write target for config.ts / settings-store.ts until a later
// step retires it.
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
    `INSERT OR IGNORE INTO system_config (key, value, updated_at, source) VALUES (?, ?, unixepoch(), 'migrated_from_json')`
  )
  let migrated = 0
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || value === undefined) continue
    const result = stmt.run(key, String(value))
    if (result.changes > 0) migrated++
  }
  return migrated
}
