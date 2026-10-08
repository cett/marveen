// Persistence for per-device dashboard keys (device_keys table). The key
// lifecycle (hashing, cache, debounce, expiry policy) lives in
// web/auth-device-keys.ts; this module only owns the SQL.

import { db } from './connection.js'

export interface DeviceKeyRow {
  id: number
  name: string
  created_at: number
  last_used_at: number | null
  expires_at: number | null
  install_id: string | null
  tenant_id: string
}

export interface DeviceKeyAuthRow {
  id: number
  name: string
  last_used_at: number | null
  expires_at: number | null
}

const INFO_COLUMNS = 'id, name, created_at, last_used_at, expires_at, install_id, tenant_id'

export function insertDeviceKey(
  keyHash: string,
  name: string,
  createdAt: number,
  expiresAt: number | null,
  installId: string | null,
): number {
  const { id } = db
    .prepare('INSERT INTO device_keys (key_hash, name, created_at, last_used_at, expires_at, install_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .get(keyHash, name, createdAt, null, expiresAt, installId) as { id: number }
  return id
}

export function deleteDeviceKeyByHash(keyHash: string): void {
  db.prepare('DELETE FROM device_keys WHERE key_hash = ?').run(keyHash)
}

export function getDeviceKeyAuthRowByHash(keyHash: string): DeviceKeyAuthRow | undefined {
  return db
    .prepare('SELECT id, name, last_used_at, expires_at FROM device_keys WHERE key_hash = ?')
    .get(keyHash) as DeviceKeyAuthRow | undefined
}

/** Returns the number of rows touched (0 = the key no longer exists). */
export function touchDeviceKeyLastUsed(keyHash: string, now: number): number {
  return db.prepare('UPDATE device_keys SET last_used_at = ? WHERE key_hash = ?').run(now, keyHash).changes
}

export function listDeviceKeyRows(): DeviceKeyRow[] {
  return db.prepare(`SELECT ${INFO_COLUMNS} FROM device_keys ORDER BY created_at DESC`).all() as DeviceKeyRow[]
}

export function getDeviceKeyRowById(id: number): DeviceKeyRow | undefined {
  return db.prepare(`SELECT ${INFO_COLUMNS} FROM device_keys WHERE id = ?`).get(id) as DeviceKeyRow | undefined
}

export function getDeviceKeyRowByInstallId(installId: string): DeviceKeyRow | undefined {
  return db.prepare(`SELECT ${INFO_COLUMNS} FROM device_keys WHERE install_id = ?`).get(installId) as DeviceKeyRow | undefined
}

export function deleteDeviceKeyById(id: number): number {
  return db.prepare('DELETE FROM device_keys WHERE id = ?').run(id).changes
}

export function deleteAllDeviceKeys(): number {
  return db.prepare('DELETE FROM device_keys').run().changes
}

export function deleteExpiredDeviceKeys(now: number): number {
  return db.prepare('DELETE FROM device_keys WHERE expires_at IS NOT NULL AND expires_at < ?').run(now).changes
}

export function setDeviceKeyTenant(id: number, tenantId: string | null): number {
  return db.prepare('UPDATE device_keys SET tenant_id = ? WHERE id = ?').run(tenantId, id).changes
}
