// Persistence for per-device dashboard keys (device_keys table). The key
// lifecycle (hashing, cache, debounce, expiry policy) lives in
// web/auth-device-keys.ts; this module only owns the SQL.

import { dbx } from './facade.js'

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

export async function insertDeviceKey(
  keyHash: string,
  name: string,
  createdAt: number,
  expiresAt: number | null,
  installId: string | null,
): Promise<number> {
  const { id } = (await dbx.get('INSERT INTO device_keys (key_hash, name, created_at, last_used_at, expires_at, install_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', keyHash, name, createdAt, null, expiresAt, installId)) as { id: number }
  return id
}

export async function deleteDeviceKeyByHash(keyHash: string): Promise<void> {
  await dbx.run('DELETE FROM device_keys WHERE key_hash = ?', keyHash)
}

export async function getDeviceKeyAuthRowByHash(keyHash: string): Promise<DeviceKeyAuthRow | undefined> {
  return dbx.get<DeviceKeyAuthRow>('SELECT id, name, last_used_at, expires_at FROM device_keys WHERE key_hash = ?', keyHash)
}

/** Returns the number of rows touched (0 = the key no longer exists). */
export async function touchDeviceKeyLastUsed(keyHash: string, now: number): Promise<number> {
  return (await dbx.run('UPDATE device_keys SET last_used_at = ? WHERE key_hash = ?', now, keyHash)).changes
}

export async function listDeviceKeyRows(): Promise<DeviceKeyRow[]> {
  return dbx.all<DeviceKeyRow>(`SELECT ${INFO_COLUMNS} FROM device_keys ORDER BY created_at DESC`)
}

export async function getDeviceKeyRowById(id: number): Promise<DeviceKeyRow | undefined> {
  return dbx.get<DeviceKeyRow>(`SELECT ${INFO_COLUMNS} FROM device_keys WHERE id = ?`, id)
}

export async function getDeviceKeyRowByInstallId(installId: string): Promise<DeviceKeyRow | undefined> {
  return dbx.get<DeviceKeyRow>(`SELECT ${INFO_COLUMNS} FROM device_keys WHERE install_id = ?`, installId)
}

export async function deleteDeviceKeyById(id: number): Promise<number> {
  return (await dbx.run('DELETE FROM device_keys WHERE id = ?', id)).changes
}

export async function deleteAllDeviceKeys(): Promise<number> {
  return (await dbx.run('DELETE FROM device_keys')).changes
}

export async function deleteExpiredDeviceKeys(now: number): Promise<number> {
  return (await dbx.run('DELETE FROM device_keys WHERE expires_at IS NOT NULL AND expires_at < ?', now)).changes
}

export async function setDeviceKeyTenant(id: number, tenantId: string | null): Promise<number> {
  return (await dbx.run('UPDATE device_keys SET tenant_id = ? WHERE id = ?', tenantId, id)).changes
}
