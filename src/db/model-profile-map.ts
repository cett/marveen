// Read/write access to model_profile_map (migration 0054; default rows are
// hardcoded into the same migration -- there is no app-side JSON-file seed
// for this table, unlike the autonomy_categories table's now-retired
// seedAutonomyCategoriesFromJson (see migration 0053).
//
// Reads stay synchronous (model-profile-map-cache.ts, the system_config
// pattern): `agent-config.ts`'s model-resolution hot path reaches these
// transitively and must not become asynchronous. Writes go through the
// async facade -- their callers (the dashboard route, fleet-transfer's
// import) already are, or can be, async.

import { dbx } from './facade.js'
import { db } from './connection.js'
import { cachedModelProfileMapEntry, cachedModelProfileMapList, cacheAfterModelProfileWrite } from './model-profile-map-cache.js'

export interface ModelProfileMapRow {
  profile_id: string
  model_id: string
  updated_at: number
  updated_by: string
}

const SELECT_COLUMNS = 'profile_id, model_id, updated_at, updated_by'

export function listModelProfileMap(): ModelProfileMapRow[] {
  const cached = cachedModelProfileMapList()
  if (cached !== null) return cached
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM model_profile_map ORDER BY profile_id`).all() as ModelProfileMapRow[]
}

export function getModelProfileMapEntry(profileId: string): ModelProfileMapRow | undefined {
  const cached = cachedModelProfileMapEntry(profileId)
  if (cached !== null) return cached
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM model_profile_map WHERE profile_id = ?`).get(profileId) as
    | ModelProfileMapRow
    | undefined
}

export async function setModelProfileMapEntry(profileId: string, modelId: string, updatedBy: string): Promise<void> {
  await dbx.run(
    `UPDATE model_profile_map SET model_id = ?, updated_at = unixepoch(), updated_by = ? WHERE profile_id = ?`,
    modelId, updatedBy, profileId
  )
  cacheAfterModelProfileWrite(profileId) // database first, then the cache
}

// Full row upsert, used by fleet-transfer.ts import (replaces individual
// rows from an imported snapshot, mirroring upsertAutonomyCategory).
export async function upsertModelProfileMapEntry(row: Omit<ModelProfileMapRow, 'updated_at'> & { updated_at?: number }): Promise<void> {
  await dbx.run(
    `INSERT INTO model_profile_map (profile_id, model_id, updated_at, updated_by)
     VALUES (?, ?, COALESCE(?, unixepoch()), ?)
     ON CONFLICT(profile_id) DO UPDATE SET
       model_id = excluded.model_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    row.profile_id, row.model_id, row.updated_at ?? null, row.updated_by
  )
  cacheAfterModelProfileWrite(row.profile_id) // database first, then the cache
}
