// Read/write access to autonomy_categories (migration 0052) plus the
// one-time seeder that copies the existing store/autonomy-config.json
// categories into it, mirroring migrateConfigOverridesToSystemConfig in
// system-config.ts.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from './connection.js'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

export interface AutonomyCategoryRow {
  key: string
  label: string
  level: number
  locked: number
  max_level: number
  timeout_minutes: number | null
  updated_at: number
  updated_by: string
}

const SELECT_COLUMNS = 'key, label, level, locked, max_level, timeout_minutes, updated_at, updated_by'

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

interface LegacyAutonomyCategory {
  key: string
  label: string
  level: number
  locked: boolean
  maxLevel: number
  timeout_minutes?: number | null
}

interface LegacyAutonomyConfig {
  categories: LegacyAutonomyCategory[]
}

// One-time seed of store/autonomy-config.json into autonomy_categories, same
// every-boot-but-effectively-once shape as migrateConfigOverridesToSystemConfig:
// only runs when the table is still empty, so an operator's later level
// changes are never overwritten by a stale JSON file still sitting on disk.
export function seedAutonomyCategoriesFromJson(): number {
  const existingCount = (db.prepare('SELECT COUNT(*) as c FROM autonomy_categories').get() as { c: number }).c
  if (existingCount > 0) return 0

  const configPath = join(STORE_DIR, 'autonomy-config.json')
  if (!existsSync(configPath)) return 0

  let parsed: LegacyAutonomyConfig
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch (err) {
    logger.warn({ err }, 'autonomy_categories seed: failed to parse autonomy-config.json, skipping')
    return 0
  }
  if (!parsed || !Array.isArray(parsed.categories)) return 0

  const stmt = db.prepare(
    `INSERT INTO autonomy_categories (key, label, level, locked, max_level, timeout_minutes, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch(), 'migrated_from_json')`
  )
  let seeded = 0
  for (const cat of parsed.categories) {
    if (!cat.key) continue
    stmt.run(cat.key, cat.label, cat.level, cat.locked ? 1 : 0, cat.maxLevel, cat.timeout_minutes ?? null)
    seeded++
  }
  return seeded
}
