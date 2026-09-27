// Read/write access to model_profile_map (migration 0054; default rows are
// hardcoded into the same migration -- there is no app-side JSON-file seed
// for this table, unlike the autonomy_categories table's now-retired
// seedAutonomyCategoriesFromJson (see migration 0053).

import { db } from './connection.js'

export interface ModelProfileMapRow {
  profile_id: string
  model_id: string
  updated_at: number
  updated_by: string
}

const SELECT_COLUMNS = 'profile_id, model_id, updated_at, updated_by'

export function listModelProfileMap(): ModelProfileMapRow[] {
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM model_profile_map ORDER BY profile_id`).all() as ModelProfileMapRow[]
}

export function getModelProfileMapEntry(profileId: string): ModelProfileMapRow | undefined {
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM model_profile_map WHERE profile_id = ?`).get(profileId) as
    | ModelProfileMapRow
    | undefined
}

export function setModelProfileMapEntry(profileId: string, modelId: string, updatedBy: string): void {
  db.prepare(
    `UPDATE model_profile_map SET model_id = ?, updated_at = unixepoch(), updated_by = ? WHERE profile_id = ?`
  ).run(modelId, updatedBy, profileId)
}

// Full row upsert, used by fleet-transfer.ts import (replaces individual
// rows from an imported snapshot, mirroring upsertAutonomyCategory).
export function upsertModelProfileMapEntry(row: Omit<ModelProfileMapRow, 'updated_at'> & { updated_at?: number }): void {
  db.prepare(
    `INSERT INTO model_profile_map (profile_id, model_id, updated_at, updated_by)
     VALUES (?, ?, COALESCE(?, unixepoch()), ?)
     ON CONFLICT(profile_id) DO UPDATE SET
       model_id = excluded.model_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(row.profile_id, row.model_id, row.updated_at ?? null, row.updated_by)
}
