// Per-device dashboard keys (AUTHPLAN1 #1).
//
// A device key is a long-lived Bearer credential minted for ONE device (a
// Bridge install, a phone) so it can be revoked alone, without rotating the
// shared dashboard token that every fleet script embeds. Modeled on
// auth-sessions.ts: only sha256(key) is stored -- in the DB (device_keys) and
// the in-memory cache -- so neither a DB leak nor a heap dump yields a usable
// credential.
//
// Differences from sessions, both deliberate:
//   - No idle/absolute TTL by default. A rarely used phone must not die
//     silently; expiry is per-key OPT-IN (expires_at) chosen at mint time.
//   - The principal is the device itself (name + id), not a user.
//
// Zero rows = the feature is off: resolveDeviceKey misses and the gate falls
// through exactly as before, so a byte-copy fresh install is unaffected.
//
// What a device key may DO is decided elsewhere: the gate hands out
// { kind: 'device' } and the per-endpoint allowlists (routes/auth.ts) deny it
// on every access-granting path -- a device can use the dashboard, it can
// never mint users, keys, or reset passwords.

import { randomBytes, createHash } from 'node:crypto'
import {
  insertDeviceKey,
  deleteDeviceKeyByHash,
  getDeviceKeyAuthRowByHash,
  touchDeviceKeyLastUsed,
  listDeviceKeyRows,
  getDeviceKeyRowById,
  getDeviceKeyRowByInstallId,
  deleteDeviceKeyById,
  deleteAllDeviceKeys,
  deleteExpiredDeviceKeys,
  setDeviceKeyTenant,
  type DeviceKeyRow,
} from '../db.js'

const LAST_USED_DEBOUNCE_SEC = 60

// Prefix makes a leaked credential recognizable in logs/repos (secret
// scanners) and visually distinct from the 64-hex dashboard token.
const KEY_PREFIX = 'mvdk_'

export interface DeviceKeyPrincipal {
  id: number
  name: string
}

export interface DeviceKeyInfo {
  id: number
  name: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  /** SSH enrollment id (marveen-remote:<uuid>) for Bridge-paired keys; null
   *  for keys minted outside the pairing flow. */
  installId: string | null
  /** Tenant this key is scoped to. null = fleet-wide (legacy default). */
  tenantId: string | null
}

export interface MintedDeviceKey extends DeviceKeyInfo {
  /** The raw credential. Returned ONCE at mint time, never recoverable. */
  key: string
}

interface CachedKey {
  id: number
  name: string
  lastUsedAt: number | null
  expiresAt: number | null
}

const cache = new Map<string, CachedKey>()

// The lookups are asynchronous, so a revoke can land between a lookup's database read and the moment it puts the
// row in the cache: without a guard the revoked key would be cached again and honoured until the next debounced
// write notices (up to LAST_USED_DEBOUNCE_SEC). Every removal bumps this counter AFTER it has deleted the row and
// the cache entry; resolveDeviceKey re-reads when the counter moved during its read, and never caches a row it
// read across a removal.
let removalEpoch = 0

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function rowToInfo(r: DeviceKeyRow): DeviceKeyInfo {
  return { id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at, installId: r.install_id, tenantId: r.tenant_id ?? null }
}

// Mint a new key. The raw value exists only in the returned object; the row
// stores its hash. expiresInDays is opt-in -- omitted means the key lives until
// revoked.
export async function createDeviceKey(name: string, opts: { expiresInDays?: number; installId?: string } = {}): Promise<MintedDeviceKey> {
  const raw = KEY_PREFIX + randomBytes(32).toString('base64url')
  const keyHash = sha256hex(raw)
  const now = nowSec()
  const expiresAt = opts.expiresInDays ? now + Math.floor(opts.expiresInDays * 24 * 60 * 60) : null
  const installId = opts.installId ?? null
  const id = await insertDeviceKey(keyHash, name, now, expiresAt, installId)
  cache.set(keyHash, { id, name, lastUsedAt: null, expiresAt })
  return { id, name, createdAt: now, lastUsedAt: null, expiresAt, installId, tenantId: null, key: raw }
}

async function removeByHash(keyHash: string): Promise<void> {
  cache.delete(keyHash)
  await deleteDeviceKeyByHash(keyHash)
  removalEpoch++
}

// Validate a presented raw key. Returns the device principal or null. Enforces
// the opt-in expiry and debounces the last_used write to <= once per 60s. The
// cache is hydrated lazily from SQLite so keys survive dashboard restarts.
export async function resolveDeviceKey(raw: string): Promise<DeviceKeyPrincipal | null> {
  if (!raw || !raw.startsWith(KEY_PREFIX)) return null
  const keyHash = sha256hex(raw)
  let entry = cache.get(keyHash)
  if (!entry) {
    // A removal during the read means the row may already be gone: read again, and after a few attempts deny
    // (fail closed) rather than trust a row that may be stale.
    for (let attempt = 0; entry === undefined; attempt++) {
      if (attempt >= 3) return null
      const epoch = removalEpoch
      const row = await getDeviceKeyAuthRowByHash(keyHash)
      if (!row) return null
      if (epoch !== removalEpoch) continue
      entry = { id: row.id, name: row.name, lastUsedAt: row.last_used_at, expiresAt: row.expires_at }
      cache.set(keyHash, entry)
    }
  }
  const now = nowSec()
  if (entry.expiresAt !== null && now > entry.expiresAt) {
    await removeByHash(keyHash)
    return null
  }
  if (entry.lastUsedAt === null || now - entry.lastUsedAt >= LAST_USED_DEBOUNCE_SEC) {
    entry.lastUsedAt = now
    const changes = await touchDeviceKeyLastUsed(keyHash, now)
    // The debounced write doubles as an existence check: zero changed rows
    // means the key was revoked OUTSIDE this process (dashboard-user
    // security:reset runs in its own process and cannot reach this cache), so
    // an out-of-band revocation takes effect here within <=60s instead of
    // lingering until the next restart.
    if (changes === 0) {
      cache.delete(keyHash)
      return null
    }
  }
  return { id: entry.id, name: entry.name }
}

export async function listDeviceKeys(): Promise<DeviceKeyInfo[]> {
  return (await listDeviceKeyRows()).map(rowToInfo)
}

export async function getDeviceKey(id: number): Promise<DeviceKeyInfo | null> {
  const row = await getDeviceKeyRowById(id)
  return row ? rowToInfo(row) : null
}

/** Bridge re-pairing: find the key minted by a previous enrollment of the same
 *  device (same marveen-remote:<uuid>), so it can be replaced, not duplicated. */
export async function findDeviceKeyByInstallId(installId: string): Promise<DeviceKeyInfo | null> {
  const row = await getDeviceKeyRowByInstallId(installId)
  return row ? rowToInfo(row) : null
}

// Revocation is immediate: the row and any cached entry go together, so the
// very next request with the key falls through the gate.
export async function revokeDeviceKey(id: number): Promise<boolean> {
  const changes = await deleteDeviceKeyById(id)
  for (const [hash, entry] of cache) {
    if (entry.id === id) cache.delete(hash)
  }
  removalEpoch++
  return changes > 0
}

// Nuclear option for the security:reset break-glass path (#5): every device
// loses access at once. Returns the number of keys revoked.
export async function revokeAllDeviceKeys(): Promise<number> {
  const changes = await deleteAllDeviceKeys()
  cache.clear()
  removalEpoch++
  return changes
}

// Hourly sweep of keys past their (opt-in) expiry, alongside the session sweep.
// Keys without expires_at are never touched.
export async function sweepExpiredDeviceKeys(): Promise<number> {
  const now = nowSec()
  const changes = await deleteExpiredDeviceKeys(now)
  for (const [hash, entry] of cache) {
    if (entry.expiresAt !== null && entry.expiresAt < now) cache.delete(hash)
  }
  removalEpoch++
  return changes
}

/** Assign (or clear) the tenant scope of a device key. Returns false if not found. */
export async function assignDeviceKeyTenant(id: number, tenantId: string | null): Promise<boolean> {
  return await setDeviceKeyTenant(id, tenantId) > 0
}

// Test seam: drop the in-memory cache to simulate a process restart (durable
// rows in device_keys must still resolve afterwards).
export function _clearDeviceKeyCacheForTest(): void {
  cache.clear()
}

// Test seam: direct cache access, so tests can age a last_used stamp across
// the debounce window without sleeping.
export const _cacheForTest = cache
