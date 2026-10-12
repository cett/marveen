// Read/write access to autonomy_categories (migration 0052; default rows
// hardcoded into migration 0053 -- the app-side JSON-file seed this module
// used to provide was retired once store/autonomy-config.json itself was
// removed from the repo).

import { db } from './connection.js'

export interface AutonomyCategoryRow {
  key: string
  label: string
  level: number
  locked: number
  max_level: number
  timeout_minutes: number | null
  updated_at: number
  updated_by: string
  /** 1 = a category an agent may never decide for itself (migration 0080); adds to the code's floor. */
  human_only?: number
}

const SELECT_COLUMNS = 'key, label, level, locked, max_level, timeout_minutes, updated_at, updated_by, human_only'

export function listAutonomyCategories(): AutonomyCategoryRow[] {
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM autonomy_categories ORDER BY key`).all() as AutonomyCategoryRow[]
}

export function getAutonomyCategory(key: string): AutonomyCategoryRow | undefined {
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM autonomy_categories WHERE key = ?`).get(key) as
    | AutonomyCategoryRow
    | undefined
}

export function setAutonomyCategoryLevel(key: string, level: number, updatedBy: string): void {
  db.prepare(
    `UPDATE autonomy_categories SET level = ?, updated_at = unixepoch(), updated_by = ? WHERE key = ?`
  ).run(level, updatedBy, key)
}

/** Set (or, with null, clear back to the server's 24 h ceiling) a category's approval timeout. */
export function setAutonomyCategoryTimeout(key: string, timeoutMinutes: number | null, updatedBy: string): void {
  db.prepare(
    `UPDATE autonomy_categories SET timeout_minutes = ?, updated_at = unixepoch(), updated_by = ? WHERE key = ?`
  ).run(timeoutMinutes, updatedBy, key)
}

/** Keys of the categories marked human-only in the table (the code's floor is not in here). */
export function listHumanOnlyCategoryKeys(): string[] {
  return (db.prepare('SELECT key FROM autonomy_categories WHERE human_only = 1').all() as { key: string }[]).map((r) => r.key)
}

export function setAutonomyCategoryHumanOnly(key: string, humanOnly: boolean, updatedBy: string): void {
  db.prepare(
    `UPDATE autonomy_categories SET human_only = ?, updated_at = ?, updated_by = ? WHERE key = ?`
  ).run(humanOnly ? 1 : 0, Math.floor(Date.now() / 1000), updatedBy, key)
}

// Full row upsert, used by fleet-transfer.ts import (replaces the whole
// category set from an imported snapshot).
export function upsertAutonomyCategory(row: Omit<AutonomyCategoryRow, 'updated_at'> & { updated_at?: number }): void {
  db.prepare(
    `INSERT INTO autonomy_categories (key, label, level, locked, max_level, timeout_minutes, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, unixepoch()), ?)
     ON CONFLICT(key) DO UPDATE SET
       label = excluded.label, level = excluded.level, locked = excluded.locked,
       max_level = excluded.max_level, timeout_minutes = excluded.timeout_minutes,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(row.key, row.label, row.level, row.locked, row.max_level, row.timeout_minutes, row.updated_at ?? null, row.updated_by)
}
