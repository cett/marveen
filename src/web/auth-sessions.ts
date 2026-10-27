// Browser-login session store for the optional dashboard password auth.
//
// A session id is 32 random bytes (base64url) handed to the client in an
// HttpOnly cookie. Only sha256(id) is stored -- in the DB (auth_sessions) AND in
// the in-memory cache -- so neither a DB leak nor a heap dump yields a usable
// cookie value.
//
// Two TTLs, both server-authoritative regardless of the cookie's Max-Age:
//   idle (sliding)  7 days  -- last_seen_at bumped on use, DB write debounced 60s
//   absolute cap   30 days  -- from created_at, non-renewable => monthly re-login
//
// The cache is hydrated lazily from SQLite, so a session survives the frequent
// dashboard restarts / auto-updates (resolveSession re-reads the row on a cache
// miss). Restart is treated as an in-memory reset only; the durable state is the
// table.

import { randomBytes, createHash } from 'node:crypto'
import {
  insertAuthSession,
  deleteAuthSessionByHash,
  getAuthSessionByHash,
  touchAuthSessionLastSeen,
  deleteAuthSessionsForUser,
  deleteAllAuthSessions,
  listAuthSessionRowsForUser,
  deleteExpiredAuthSessions,
} from '../db.js'

const IDLE_TTL_SEC = 7 * 24 * 60 * 60
const ABSOLUTE_TTL_SEC = 30 * 24 * 60 * 60
const LAST_SEEN_DEBOUNCE_SEC = 60

export interface AuthSessionUser {
  userId: number
  username: string
}

export interface ResolvedSession {
  userId: number
  username: string
}

export interface UserSessionInfo {
  idHashPrefix: string
  createdAt: number
  lastSeenAt: number
  userAgent: string | null
}

interface CachedSession {
  userId: number
  username: string
  createdAt: number
  lastSeenAt: number
}

const cache = new Map<string, CachedSession>()

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

// Mint a fresh session (always at successful login only -- never from a
// client-supplied value) and return the raw token for the Set-Cookie header.
export async function createSession(user: AuthSessionUser, opts: { userAgent?: string | null; remoteNote?: string | null } = {}): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const idHash = sha256hex(token)
  const now = nowSec()
  // The row first, the cache after it: a failed insert leaves no cache entry, so no cookie outlives the process
  // without a durable row behind it.
  await insertAuthSession(idHash, user.userId, user.username, now, opts.userAgent ?? null, opts.remoteNote ?? null)
  cache.set(idHash, { userId: user.userId, username: user.username, createdAt: now, lastSeenAt: now })
  return token
}

// Counts the revocations that have finished. A rehydrating resolveSession reads it before its table read and
// compares it afterwards: with the table read asynchronous, a revoke can finish between the read and the
// cache.set, and without the comparison the revoked session would be put back in the cache.
let revokeEpoch = 0

function revoked(): void {
  revokeEpoch++
}

// The table first, the cache after it (a revoke that deleted the cache entry first could see it put back by a
// resolveSession whose table read still found the row).
async function removeByHash(idHash: string): Promise<void> {
  await deleteAuthSessionByHash(idHash)
  cache.delete(idHash)
  revoked()
}

function toCached(row: { user_id: number; username: string; created_at: number; last_seen_at: number }): CachedSession {
  return { userId: row.user_id, username: row.username, createdAt: row.created_at, lastSeenAt: row.last_seen_at }
}

// Cache miss (fresh process after a restart, or a session minted by another path): rehydrate from the durable
// table. Null = no such session.
async function rehydrate(idHash: string): Promise<CachedSession | null> {
  const epoch = revokeEpoch
  const row = await getAuthSessionByHash(idHash)
  if (!row) return null
  if (epoch === revokeEpoch) {
    const entry = toCached(row)
    cache.set(idHash, entry)
    return entry
  }
  // A revoke finished while the row was being read: the row may be one it removed. Ask the table again and
  // do not cache the answer (the next request rehydrates cleanly).
  const again = await getAuthSessionByHash(idHash)
  return again ? toCached(again) : null
}

// Validate a presented cookie value. Returns the session principal or null.
// Enforces both TTLs and debounces the last_seen write to <= once per 60s.
// A table error rejects: the caller refuses the request, it never falls through to another auth lane.
export async function resolveSession(cookieValue: string): Promise<ResolvedSession | null> {
  if (!cookieValue) return null
  const idHash = sha256hex(cookieValue)
  const entry = cache.get(idHash) ?? await rehydrate(idHash)
  if (!entry) return null
  const now = nowSec()
  if (now - entry.createdAt > ABSOLUTE_TTL_SEC) {
    await removeByHash(idHash)
    return null
  }
  if (now - entry.lastSeenAt > IDLE_TTL_SEC) {
    await removeByHash(idHash)
    return null
  }
  if (now - entry.lastSeenAt >= LAST_SEEN_DEBOUNCE_SEC) {
    entry.lastSeenAt = now
    const changes = await touchAuthSessionLastSeen(idHash, now)
    // Zero changed rows = the session row was deleted OUTSIDE this process
    // (dashboard-user sessions:clear / security:reset run in their own process
    // and cannot reach this cache). Honor the revocation within <=60s instead
    // of serving the cached session until the next restart.
    if (changes === 0) {
      cache.delete(idHash)
      return null
    }
  }
  return { userId: entry.userId, username: entry.username }
}

export async function revokeSession(cookieValue: string): Promise<void> {
  if (!cookieValue) return
  await removeByHash(sha256hex(cookieValue))
}

// Revoke every session of a user, optionally sparing the caller's own (used by
// password-change and logout-all). exceptCookieValue is the RAW cookie value.
// Table first, cache after it (see removeByHash).
export async function revokeAllForUser(userId: number, exceptCookieValue?: string | null): Promise<void> {
  const exceptHash = exceptCookieValue ? sha256hex(exceptCookieValue) : null
  await deleteAuthSessionsForUser(userId, exceptHash)
  for (const [hash, entry] of cache) {
    if (entry.userId === userId && hash !== exceptHash) cache.delete(hash)
  }
  revoked()
}

// Revoke EVERY browser session at once (break-glass security reset). Cache and
// table go together -- a DB-only delete would leave cached sessions resolving
// until the next restart. Table first, cache after it (see removeByHash).
export async function revokeAllSessions(): Promise<number> {
  const removed = await deleteAllAuthSessions()
  cache.clear()
  revoked()
  return removed
}

export async function listUserSessions(userId: number): Promise<UserSessionInfo[]> {
  return (await listAuthSessionRowsForUser(userId)).map((r) => ({ idHashPrefix: r.id_hash.slice(0, 12), createdAt: r.created_at, lastSeenAt: r.last_seen_at, userAgent: r.user_agent }))
}

// Hourly sweep of rows past either TTL. Cheap: two indexed range deletes plus a
// cache prune. Returns the number of DB rows removed. The cutoffs are fixed before
// the first await, so the table delete and the cache prune use the same instant.
export async function sweepExpiredSessions(): Promise<number> {
  const now = nowSec()
  const idleCutoff = now - IDLE_TTL_SEC
  const absoluteCutoff = now - ABSOLUTE_TTL_SEC
  const removed = await deleteExpiredAuthSessions(idleCutoff, absoluteCutoff)
  for (const [hash, entry] of cache) {
    if (entry.lastSeenAt < idleCutoff || entry.createdAt < absoluteCutoff) cache.delete(hash)
  }
  return removed
}

// Test seam: drop the in-memory cache to simulate a process restart (durable
// rows in auth_sessions must still resolve afterwards).
export function _clearSessionCacheForTest(): void {
  cache.clear()
}

// Test seam: direct cache access, so tests can age a last_seen stamp across
// the debounce window without sleeping.
export const _cacheForTest = cache
