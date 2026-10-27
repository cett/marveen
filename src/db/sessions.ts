// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { APP_TZ } from '../config.js'
import { db } from './connection.js'
import { dbx } from './facade.js'
import { resolveWriteTenant } from './write-tenant.js'
import { Memory, RECENCY_OVERSAMPLE, buildFtsMatchExpression, reRankByRecency, withoutRank } from './memory.js'

export async function getSession(chatId: string): Promise<{ sessionId: string; messageCount: number } | undefined> {
  const row = await dbx.get<{ session_id: string; message_count: number }>('SELECT session_id, message_count FROM sessions WHERE chat_id = ?', chatId)
  if (!row) return undefined
  return { sessionId: row.session_id, messageCount: row.message_count }
}

export async function setSession(chatId: string, sessionId: string, messageCount = 0): Promise<void> {
  await dbx.run(`INSERT INTO sessions (chat_id, session_id, updated_at, message_count) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET session_id = excluded.session_id,
       updated_at = excluded.updated_at, message_count = excluded.message_count`, chatId, sessionId, Math.floor(Date.now() / 1000), messageCount)
}

// One statement: the new count is the one this call wrote (two overlapping calls get two different counts), and 0
// means there is no session for the chat.
export async function incrementSessionCount(chatId: string): Promise<number> {
  const row = await dbx.get<{ message_count: number }>(
    'UPDATE sessions SET message_count = message_count + 1 WHERE chat_id = ? RETURNING message_count',
    chatId,
  )
  return row?.message_count ?? 0
}

export async function clearSession(chatId: string): Promise<void> {
  await dbx.run('DELETE FROM sessions WHERE chat_id = ?', chatId)
}

export interface DashboardUser {
  id: number
  username: string
  password_hash: string
  created_at: number
  updated_at: number
  disabled: number
  role: string
  tenant_id: string | null
  email: string | null
  display_name: string | null
}

export type DashboardUserPublic = Omit<DashboardUser, 'password_hash'>

export async function createDashboardUser(username: string, passwordHash: string): Promise<DashboardUser> {
  const now = Math.floor(Date.now() / 1000)
  const tenantId = null  // NULL = global scope; tenant-scoped users are created via the admin provisioning API
  // First-user-wins bootstrap: if the table is empty, the first user becomes the global admin (role=admin,
  // tenant_id=NULL). All subsequent users start as viewer so they can only read until an admin grants them higher
  // access. The emptiness check and the insert are ONE statement: a count read first and an insert after it would
  // let two overlapping first sign-ups both see an empty table and both become admin.
  const { id, role } = (await dbx.get<{ id: number; role: string }>(
    `INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at)
     VALUES (?, ?, CASE WHEN (SELECT COUNT(*) FROM dashboard_users) = 0 THEN 'admin' ELSE 'viewer' END, ?, ?, ?)
     RETURNING id, role`,
    username, passwordHash, tenantId, now, now,
  ))!
  return { id, username, password_hash: passwordHash, role, tenant_id: tenantId, email: null, display_name: null, created_at: now, updated_at: now, disabled: 0 }
}

export async function getDashboardUser(username: string): Promise<DashboardUser | undefined> {
  return dbx.get<DashboardUser>('SELECT * FROM dashboard_users WHERE username = ? COLLATE NOCASE', username)
}

export async function listDashboardUsers(): Promise<DashboardUserPublic[]> {
  return dbx.all<DashboardUserPublic>('SELECT id, username, role, tenant_id, created_at, updated_at, disabled FROM dashboard_users ORDER BY username COLLATE NOCASE')
}

// enabled-only count feeds `login_available`; total count feeds `setup_required`.
export async function countDashboardUsers(includeDisabled = false): Promise<number> {
  const sql = includeDisabled
    ? 'SELECT COUNT(*) AS c FROM dashboard_users'
    : 'SELECT COUNT(*) AS c FROM dashboard_users WHERE disabled = 0'
  return ((await dbx.get(sql)) as { c: number }).c
}

export async function updateDashboardUserPassword(userId: number, passwordHash: string): Promise<void> {
  await dbx.run('UPDATE dashboard_users SET password_hash = ?, updated_at = ? WHERE id = ?', passwordHash, Math.floor(Date.now() / 1000), userId)
}

export async function deleteDashboardUser(username: string): Promise<boolean> {
  const info = await dbx.run('DELETE FROM dashboard_users WHERE username = ? COLLATE NOCASE', username)
  return info.changes > 0
}

export type DeleteUserOutcome = 'deleted' | 'last_admin' | 'not_found'

/**
 * Delete a user unless that would remove the last administrator: the check is part of the DELETE (a compare-and-set
 * on the admin count), so two overlapping deletions of the only two admins cannot both go through. An `admin` row is
 * deleted only while more than one active admin (role admin, not disabled) exists. `deleteDashboardUser` stays the
 * unguarded variant (removing the last user is the documented way back to token-only mode).
 */
export async function deleteDashboardUserKeepingLastAdmin(username: string): Promise<DeleteUserOutcome> {
  // The name is resolved once (case-insensitively, by getDashboardUser); the guarded delete then goes by id.
  const user = await getDashboardUser(username)
  if (!user) return 'not_found'
  const info = await dbx.run(
    `DELETE FROM dashboard_users
     WHERE id = ?
       AND NOT (role = 'admin' AND (SELECT COUNT(*) FROM dashboard_users WHERE role = 'admin' AND disabled = 0) <= 1)`,
    user.id,
  )
  if (info.changes > 0) return 'deleted'
  // Nothing deleted: either the guard held or the user went away since the lookup. Only the answer depends on this read.
  return (await dbx.get('SELECT 1 AS present FROM dashboard_users WHERE id = ?', user.id)) ? 'last_admin' : 'not_found'
}

/**
 * The calendar day (YYYY-MM-DD) in the app's time zone, which is the day daily_logs rows are filed under.
 * Not the UTC day: between local midnight and the UTC midnight the two differ. en-CA formats as YYYY-MM-DD.
 */
export function appLocalDate(at: Date = new Date()): string {
  return at.toLocaleDateString('en-CA', { timeZone: APP_TZ })
}

export async function appendDailyLog(agentId: string, content: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  // Budapest calendar day, not UTC -- otherwise an entry written 00:00-02:00
  // local time lands on the previous day and the "ma" recall query misses it.
  const today = appLocalDate()
  await dbx.run('INSERT INTO daily_logs (agent_id, date, content, created_at, tenant_id) VALUES (?, ?, ?, ?, ?)', agentId, today, content, now, resolveWriteTenant(agentId))
}

export async function getDailyLog(agentId: string, date: string): Promise<{ id: number; content: string; created_at: number }[]> {
  return (await dbx.all('SELECT id, content, created_at FROM daily_logs WHERE agent_id = ? AND date = ? ORDER BY created_at ASC', agentId, date)) as { id: number; content: string; created_at: number }[]
}

export async function getDailyLogDates(agentId: string, limit: number = 14): Promise<string[]> {
  return ((await dbx.all('SELECT DISTINCT date FROM daily_logs WHERE agent_id = ? ORDER BY date DESC LIMIT ?', agentId, limit)) as { date: string }[]).map(r => r.date)
}

export interface ArtifactPointer {
  id: string
  title: string
  kind: string
  created_at: number
  score: number
}

export interface RecallResult {
  logs: { id: number; agent_id: string; date: string; content: string; created_at: number }[]
  memories: Memory[]
  dateRange: { from: string; to: string }
  related_artifacts?: ArtifactPointer[]
}

function toBudapestTs(dateStr: string, endOfDay: boolean): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const refDate = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}`)
  const parts = fmt.formatToParts(refDate)
  const get = (t: string) => parts.find(p => p.type === t)?.value || '0'
  const localStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  const localMs = new Date(localStr + 'Z').getTime()
  const offsetMs = localMs - refDate.getTime()
  const target = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}Z`)
  return Math.floor((target.getTime() - offsetMs) / 1000)
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export async function recallByDateRange(from: string, to: string, agentId?: string, tenantId?: string): Promise<RecallResult> {
  const logSql = agentId
    ? 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? AND agent_id = ? ORDER BY date ASC, created_at ASC'
    : 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? ORDER BY date ASC, created_at ASC'
  const logParams = agentId ? [from, to, agentId] : [from, to]
  const logs = (await dbx.all(logSql, ...logParams)) as RecallResult['logs']

  const fromTs = toBudapestTs(from, false)
  const toTs = toBudapestTs(to, true)
  // daily_logs has no tenant_id column (Jonas Q3 decision: no migration). Only memories are tenant-filtered.
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  const memSql = agentId
    ? `SELECT * FROM memories WHERE created_at >= ? AND created_at <= ? AND (agent_id = ? OR category = 'shared')${tc} ORDER BY created_at ASC`
    : `SELECT * FROM memories WHERE created_at >= ? AND created_at <= ?${tc} ORDER BY created_at ASC`
  const memParams = agentId ? [fromTs, toTs, agentId, ...tp] : [fromTs, toTs, ...tp]
  const memories = await dbx.all<Memory>(memSql, ...memParams)

  return { logs, memories, dateRange: { from, to } }
}

export async function recallSearch(query: string, agentId?: string, limit = 50, tenantId?: string): Promise<RecallResult> {
  const terms = buildFtsMatchExpression(query)
  let memories: Memory[] = []
  const escaped = escapeLike(query)
  const tc = tenantId ? ' AND m.tenant_id = ?' : ''
  const tcFb = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  if (terms) {
    try {
      // Was ORDER BY created_at DESC (pure recency, relevance ignored); now the
      // same λ-blend as the other search paths, so a strongly matching older
      // memory can still surface above barely-matching fresh noise.
      const sql = agentId
        ? `SELECT m.*, f.rank AS rank FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared')${tc} ORDER BY rank LIMIT ?`
        : `SELECT m.*, f.rank AS rank FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE f.memories_fts MATCH ?${tc} ORDER BY rank LIMIT ?`
      const candidates = agentId
        ? (await dbx.all(sql, terms, agentId, ...tp, limit * RECENCY_OVERSAMPLE)) as (Memory & { rank: number })[]
        : (await dbx.all(sql, terms, ...tp, limit * RECENCY_OVERSAMPLE)) as (Memory & { rank: number })[]
      memories = withoutRank(reRankByRecency(candidates, limit)) as Memory[]
    } catch {
      const sql = agentId
        ? `SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')${tcFb} ORDER BY created_at DESC LIMIT ?`
        : `SELECT * FROM memories WHERE (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')${tcFb} ORDER BY created_at DESC LIMIT ?`
      const pat = `%${escaped}%`
      memories = agentId
        ? await dbx.all<Memory>(sql, agentId, pat, pat, ...tp, limit)
        : await dbx.all<Memory>(sql, pat, pat, ...tp, limit)
    }
  }

  const logSql = agentId
    ? "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' AND agent_id = ? ORDER BY date DESC, created_at DESC LIMIT ?"
    : "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' ORDER BY date DESC, created_at DESC LIMIT ?"
  const logPat = `%${escaped}%`
  const logs = agentId
    ? (await dbx.all(logSql, logPat, agentId, limit)) as RecallResult['logs']
    : (await dbx.all(logSql, logPat, limit)) as RecallResult['logs']

  const dates = logs.map(l => l.date)
  const from = dates.length ? dates[dates.length - 1] : ''
  const to = dates.length ? dates[0] : ''

  return { logs, memories, dateRange: { from, to } }
}

// ── Dashboard browser sessions (auth_sessions) ───────────────────────
// Persistence only; the cookie hashing, cache and TTL policy live in
// web/auth-sessions.ts.

export interface AuthSessionRow {
  user_id: number
  username: string
  created_at: number
  last_seen_at: number
}

export interface AuthSessionListRow {
  id_hash: string
  created_at: number
  last_seen_at: number
  user_agent: string | null
}

export function insertAuthSession(
  idHash: string,
  userId: number,
  username: string,
  now: number,
  userAgent: string | null,
  remoteNote: string | null,
): void {
  db.prepare('INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at, user_agent, remote_note) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(idHash, userId, username, now, now, userAgent, remoteNote)
}

export function deleteAuthSessionByHash(idHash: string): void {
  db.prepare('DELETE FROM auth_sessions WHERE id_hash = ?').run(idHash)
}

export function getAuthSessionByHash(idHash: string): AuthSessionRow | undefined {
  return db
    .prepare('SELECT user_id, username, created_at, last_seen_at FROM auth_sessions WHERE id_hash = ?')
    .get(idHash) as AuthSessionRow | undefined
}

/** Returns the number of rows touched (0 = the session no longer exists). */
export function touchAuthSessionLastSeen(idHash: string, now: number): number {
  return db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, idHash).changes
}

/** Deletes every session of a user, optionally sparing one (by hash). */
export function deleteAuthSessionsForUser(userId: number, exceptHash: string | null): void {
  if (exceptHash) {
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND id_hash != ?').run(userId, exceptHash)
  } else {
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId)
  }
}

export function deleteAllAuthSessions(): number {
  return db.prepare('DELETE FROM auth_sessions').run().changes
}

export function listAuthSessionRowsForUser(userId: number): AuthSessionListRow[] {
  return db
    .prepare('SELECT id_hash, created_at, last_seen_at, user_agent FROM auth_sessions WHERE user_id = ? ORDER BY last_seen_at DESC')
    .all(userId) as AuthSessionListRow[]
}

export function deleteExpiredAuthSessions(idleCutoff: number, absoluteCutoff: number): number {
  return db
    .prepare('DELETE FROM auth_sessions WHERE last_seen_at < ? OR created_at < ?')
    .run(idleCutoff, absoluteCutoff).changes
}

/** Role and tenant scope of an ENABLED dashboard user (case-insensitive name), for the auth gate. */
export function getDashboardUserAuthRow(username: string): { role: string; tenant_id: string | null } | undefined {
  return db
    .prepare('SELECT role, tenant_id FROM dashboard_users WHERE username = ? COLLATE NOCASE AND disabled = 0')
    .get(username) as { role: string; tenant_id: string | null } | undefined
}
