// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { APP_TZ } from '../config.js'
import { db } from './connection.js'
import { dbx, dbxDialect, type Tx } from './facade.js'
import { advisoryLockSql, eqNoCase, forUpdate, likeNoCase, orderBytes, orderNoCase } from './dialect.js'
import { resolveWriteTenant } from './write-tenant.js'
import { TENANTLESS_ROLES_SQL_LIST, isBlankTenant } from './user-tenant-rule.js'
import { Memory, RECENCY_OVERSAMPLE, buildFtsMatchExpression, reRankByRecency, withoutRank } from './memory.js'
import { FTS_MATCH, ftsPgTsQuery, ftsTokens, PG_FTS_CONFIG, pgRankSql } from './fts.js'

/** The advisory key of the first-admin election (see createDashboardUser). */
export const ELECTION_KEY = 'dashboard-users-election'

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
  // The election lock comes first, on the same transaction: a second sign-up waits until the first one has committed,
  // and then its statement sees the first admin. One key for the whole table: the election is global (tenant NULL), so a
  // per-tenant key would not serialize two sign-ups that both write NULL. Tenant-scoped provisioning takes no lock here.
  // ACCEPTED RACE (not a bug): a tenant admin created in parallel (provisionDashboardUser, no election lock) is counted
  // only if it committed before this statement's snapshot. Either order of the two writes is a serial order, so the
  // outcome depends on the order the database chose. The invariant that holds on both orders: a global sign-up becomes
  // admin only when the table had no user at its snapshot, and two global sign-ups never both become admin.
  // The lock is transaction-level (pg_advisory_xact_lock): it is released at COMMIT or ROLLBACK, never kept by the pool.
  const { id, role } = await dbx.tx(async (tx) => {
    const lock = advisoryLockSql(ELECTION_KEY)
    if (lock) await tx.run(lock)
    return (await tx.get<{ id: number; role: string }>(
      `INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, CASE WHEN (SELECT COUNT(*) FROM dashboard_users) = 0 THEN 'admin' ELSE 'viewer' END, ?, ?, ?)
       RETURNING id, role`,
      username, passwordHash, tenantId, now, now,
    ))!
  })
  return { id, username, password_hash: passwordHash, role, tenant_id: tenantId, email: null, display_name: null, created_at: now, updated_at: now, disabled: 0 }
}

export async function getDashboardUser(username: string): Promise<DashboardUser | undefined> {
  return dbx.get<DashboardUser>(`SELECT * FROM dashboard_users WHERE ${eqNoCase('username', '?')}`, username)
}

/** The four columns the login needs, nothing else (no role, tenant, e-mail): what the login lookup returns. */
export interface LoginUser {
  id: number
  username: string
  password_hash: string
  disabled: number
}

/**
 * The login lookup of a caller who has no session yet. On PostgreSQL it goes through the gateway function
 * `app.auth_login_user` (migration 0009): the `public` context reads nothing of dashboard_users, and the function hands out
 * exactly these four columns for one case-folded name (an unknown name, `%` or the empty string: no row). On SQLite the same
 * four columns by the same case-insensitive match. The authenticated routes keep `getDashboardUser` (own row or privileged).
 */
export async function getLoginUser(username: string): Promise<LoginUser | undefined> {
  if (dbxDialect() === 'pg') {
    return dbx.get<LoginUser>('SELECT id, username, password_hash, disabled FROM app.auth_login_user(?)', username)
  }
  return dbx.get<LoginUser>(
    `SELECT id, username, password_hash, disabled FROM dashboard_users WHERE ${eqNoCase('username', '?')}`, username)
}

export async function listDashboardUsers(): Promise<DashboardUserPublic[]> {
  // Ties after the case fold (not possible while username is unique ignoring case, but the order must not depend on it)
  // are broken in byte order, then by id: the same order on both engines.
  return dbx.all<DashboardUserPublic>(
    `SELECT id, username, role, tenant_id, created_at, updated_at, disabled FROM dashboard_users ORDER BY ${orderNoCase('username')}, ${orderBytes('username')}, id`)
}

/**
 * How many stored users have no tenant and a role that needs one (user-tenant-rule.ts): rows from before the rule, which
 * nothing changes. Disabled users are counted too, an admin can enable them again. A count only, never a name.
 */
export async function countTenantlessWriteRoleUsers(): Promise<number> {
  // The rows whose role needs a tenant are read and the blank judgment is made here (isBlankTenant): the table of
  // dashboard users is small, and a SQL TRIM would not read a tab, a newline or a no-break space as blank.
  const rows = await dbx.all<{ tenant_id: string | null }>(
    `SELECT tenant_id FROM dashboard_users WHERE role NOT IN (${TENANTLESS_ROLES_SQL_LIST})`)
  return rows.filter((r) => isBlankTenant(r.tenant_id)).length
}

// enabled-only count feeds `login_available`; total count feeds `setup_required`.
export async function countDashboardUsers(includeDisabled = false): Promise<number> {
  if (dbxDialect() === 'pg') {
    // Through the gateway on every context: a direct COUNT would answer per the caller's row visibility (a tenant would count
    // only the users of its own tenant, and a public caller zero, so the status route would say "setup required" on a database
    // that has users). Same numbers for every caller.
    const r = (await dbx.get<{ c: number | string }>(`SELECT ${includeDisabled ? 'total' : 'enabled'} AS c FROM app.auth_user_counts()`))!
    return Number(r.c)
  }
  const sql = includeDisabled
    ? 'SELECT COUNT(*) AS c FROM dashboard_users'
    : 'SELECT COUNT(*) AS c FROM dashboard_users WHERE disabled = 0'
  return ((await dbx.get(sql)) as { c: number }).c
}

export async function updateDashboardUserPassword(userId: number, passwordHash: string): Promise<void> {
  await dbx.run('UPDATE dashboard_users SET password_hash = ?, updated_at = ? WHERE id = ?', passwordHash, Math.floor(Date.now() / 1000), userId)
}

export async function deleteDashboardUser(username: string): Promise<boolean> {
  const info = await dbx.run(`DELETE FROM dashboard_users WHERE ${eqNoCase('username', '?')}`, username)
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
  return dbx.tx(async (tx) => {
    // The lock comes first: two guarded writes on the active admins would otherwise both count the admins before either
    // one commits (READ COMMITTED: each statement sees the snapshot at its start), and both would pass.
    await lockAdminRows(tx, user.id)
    const info = await tx.run(
      `DELETE FROM dashboard_users
       WHERE id = ?
         AND NOT (role = 'admin' AND (SELECT COUNT(*) FROM dashboard_users WHERE role = 'admin' AND disabled = 0) <= 1)`,
      user.id,
    )
    if (info.changes > 0) return 'deleted'
    // Nothing deleted: either the guard held or the user went away since the lookup. Only the answer depends on this read.
    return (await tx.get('SELECT 1 AS present FROM dashboard_users WHERE id = ?', user.id)) ? 'last_admin' : 'not_found'
  })
}

/**
 * The lock of a guarded write on the admin set: the target row and every active admin, in id order, held until the
 * transaction ends. ONE statement with ONE order for every caller: a caller that locks the admins and the target in
 * two steps, or in another order, can deadlock with a second caller (each holds the row the other waits for). Call it
 * on the transaction handle, before the guarded statement, never on the ambient handle.
 *
 * ORDER OF THE READS (equivalence of the target row): the lock does not read the
 * target's admin status, only its row. The status is read by the guarded statement that follows, AFTER the lock is
 * granted (READ COMMITTED: that statement takes its snapshot when it starts, which is after the lock). A status read
 * before the lock would be stale after a concurrent demotion, and then the target row would have to be locked on its
 * own; the guarded write does not do that. Keep the guarded statement after lockAdminRows.
 *
 * Equivalence (the target row is not locked on its own): every guarded write touches only an ACTIVE admin, and those rows
 * are all in the lock. A target that is not an active admin when the guarded statement runs is not counted, so it needs no
 * admin lock. The one case that is not covered by the lock: an inactive target admin that is activated concurrently. Such a
 * reactivation starts from zero active admins (the lock sees the active set without it), so it is outside the invariant
 * (the invariant is about the active set, not about the rows that are being reactivated).
 *
 * A lock statement that leaves the target row out is killed by a TEXT pin in the test file, not by a behavioural cell:
 * it is behaviourally equivalent (killed by a text pin, behaviourally equivalent). The same holds for a lock statement
 * without ORDER BY on SQLite: the text pin is the only kill there, the PostgreSQL cells are the behavioural ones.
 */
export async function lockAdminRows(tx: Tx, targetId: number): Promise<void> {
  await tx.all(`SELECT id FROM dashboard_users WHERE id = ? OR (role = 'admin' AND disabled = 0) ORDER BY id ${forUpdate()}`, targetId)
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
  await dbx.run('INSERT INTO daily_logs (agent_id, date, content, created_at, tenant_id) VALUES (?, ?, ?, ?, ?)', agentId, today, content, now, await resolveWriteTenant(agentId))
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
  if (terms && dbxDialect() === 'pg') {
    // PostgreSQL: the tsvector of both weights, the agent's rows and the shared ones; no LIKE fallback (an error is an error).
    const tsq = ftsPgTsQuery(ftsTokens(query)) ?? ''
    const sqlPg = agentId
      ? `SELECT m.*, ${pgRankSql('m.fts', `to_tsquery(${PG_FTS_CONFIG}, ?)`)} AS rank FROM memories m WHERE m.fts @@ to_tsquery(${PG_FTS_CONFIG}, ?) AND (m.agent_id = ? OR m.category = 'shared')${tc} ORDER BY rank, m.id LIMIT ?`
      : `SELECT m.*, ${pgRankSql('m.fts', `to_tsquery(${PG_FTS_CONFIG}, ?)`)} AS rank FROM memories m WHERE m.fts @@ to_tsquery(${PG_FTS_CONFIG}, ?)${tc} ORDER BY rank, m.id LIMIT ?`
    const candidates = agentId
      ? (await dbx.all(sqlPg, tsq, tsq, agentId, ...tp, limit * RECENCY_OVERSAMPLE)) as (Memory & { rank: number })[]
      : (await dbx.all(sqlPg, tsq, tsq, ...tp, limit * RECENCY_OVERSAMPLE)) as (Memory & { rank: number })[]
    memories = withoutRank(reRankByRecency(candidates, limit)) as Memory[]
  } else if (terms) {
    try {
      // Was ORDER BY created_at DESC (pure recency, relevance ignored); now the
      // same λ-blend as the other search paths, so a strongly matching older
      // memory can still surface above barely-matching fresh noise.
      const sql = agentId
        ? `SELECT m.*, f.rank AS rank FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE ${FTS_MATCH.memoryAll} AND (m.agent_id = ? OR m.category = 'shared')${tc} ORDER BY rank LIMIT ?`
        : `SELECT m.*, f.rank AS rank FROM memories m JOIN memories_fts f ON m.id = f.rowid WHERE ${FTS_MATCH.memoryAll}${tc} ORDER BY rank LIMIT ?`
      const candidates = agentId
        ? (await dbx.all(sql, terms, agentId, ...tp, limit * RECENCY_OVERSAMPLE)) as (Memory & { rank: number })[]
        : (await dbx.all(sql, terms, ...tp, limit * RECENCY_OVERSAMPLE)) as (Memory & { rank: number })[]
      memories = withoutRank(reRankByRecency(candidates, limit)) as Memory[]
    } catch {
      const textMatch = `(${likeNoCase('content', '?')} OR ${likeNoCase('keywords', '?')})`
      const sql = agentId
        ? `SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND ${textMatch}${tcFb} ORDER BY created_at DESC LIMIT ?`
        : `SELECT * FROM memories WHERE ${textMatch}${tcFb} ORDER BY created_at DESC LIMIT ?`
      const pat = `%${escaped}%`
      memories = agentId
        ? await dbx.all<Memory>(sql, agentId, pat, pat, ...tp, limit)
        : await dbx.all<Memory>(sql, pat, pat, ...tp, limit)
    }
  }

  const logMatch = likeNoCase('content', '?')
  const logSql = agentId
    ? `SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE ${logMatch} AND agent_id = ? ORDER BY date DESC, created_at DESC LIMIT ?`
    : `SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE ${logMatch} ORDER BY date DESC, created_at DESC LIMIT ?`
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

export async function insertAuthSession(
  idHash: string,
  userId: number,
  username: string,
  now: number,
  userAgent: string | null,
  remoteNote: string | null,
): Promise<void> {
  if (dbxDialect() === 'pg') {
    // The login of an unauthenticated or another user's cookie context: the gateway function is the one write it may do.
    await dbx.run('SELECT app.auth_session_create(?, ?, ?, ?, ?, ?)', idHash, userId, username, now, userAgent, remoteNote)
    return
  }
  await dbx.run(
    'INSERT INTO auth_sessions (id_hash, user_id, username, created_at, last_seen_at, user_agent, remote_note) VALUES (?, ?, ?, ?, ?, ?, ?)',
    idHash, userId, username, now, now, userAgent, remoteNote,
  )
}

export async function deleteAuthSessionByHash(idHash: string): Promise<void> {
  if (dbxDialect() === 'pg') {
    await dbx.run('SELECT app.auth_session_revoke(?)', idHash)
    return
  }
  await dbx.run('DELETE FROM auth_sessions WHERE id_hash = ?', idHash)
}

export async function getAuthSessionByHash(idHash: string): Promise<AuthSessionRow | undefined> {
  return dbx.get<AuthSessionRow>('SELECT user_id, username, created_at, last_seen_at FROM auth_sessions WHERE id_hash = ?', idHash)
}

/** Returns the number of rows touched (0 = the session no longer exists). */
export async function touchAuthSessionLastSeen(idHash: string, now: number): Promise<number> {
  return (await dbx.run('UPDATE auth_sessions SET last_seen_at = ? WHERE id_hash = ?', now, idHash)).changes
}

/** Deletes every session of a user, optionally sparing one (by hash). */
export async function deleteAuthSessionsForUser(userId: number, exceptHash: string | null): Promise<void> {
  if (exceptHash) {
    await dbx.run('DELETE FROM auth_sessions WHERE user_id = ? AND id_hash != ?', userId, exceptHash)
  } else {
    await dbx.run('DELETE FROM auth_sessions WHERE user_id = ?', userId)
  }
}

export async function deleteAllAuthSessions(): Promise<number> {
  return (await dbx.run('DELETE FROM auth_sessions')).changes
}

export async function listAuthSessionRowsForUser(userId: number): Promise<AuthSessionListRow[]> {
  return dbx.all<AuthSessionListRow>(
    'SELECT id_hash, created_at, last_seen_at, user_agent FROM auth_sessions WHERE user_id = ? ORDER BY last_seen_at DESC',
    userId,
  )
}

export async function deleteExpiredAuthSessions(idleCutoff: number, absoluteCutoff: number): Promise<number> {
  return (await dbx.run('DELETE FROM auth_sessions WHERE last_seen_at < ? OR created_at < ?', idleCutoff, absoluteCutoff)).changes
}

/** Role and tenant scope of an ENABLED dashboard user (case-insensitive name), for the auth gate. */
export async function getDashboardUserAuthRow(username: string): Promise<{ role: string; tenant_id: string | null } | undefined> {
  return dbx.get<{ role: string; tenant_id: string | null }>(
    `SELECT role, tenant_id FROM dashboard_users WHERE ${eqNoCase('username', '?')} AND disabled = 0`,
    username,
  )
}
