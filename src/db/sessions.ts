// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { APP_TZ } from '../config.js'
import { db } from './connection.js'
import { Memory, RECENCY_OVERSAMPLE, buildFtsMatchExpression, reRankByRecency, withoutRank } from './memory.js'

export function getSession(chatId: string): { sessionId: string; messageCount: number } | undefined {
  const row = db
    .prepare('SELECT session_id, message_count FROM sessions WHERE chat_id = ?')
    .get(chatId) as { session_id: string; message_count: number } | undefined
  if (!row) return undefined
  return { sessionId: row.session_id, messageCount: row.message_count }
}

export function setSession(chatId: string, sessionId: string, messageCount = 0): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (chat_id, session_id, updated_at, message_count) VALUES (?, ?, ?, ?)'
  ).run(chatId, sessionId, Math.floor(Date.now() / 1000), messageCount)
}

export function incrementSessionCount(chatId: string): number {
  db.prepare('UPDATE sessions SET message_count = message_count + 1 WHERE chat_id = ?').run(chatId)
  const row = db.prepare('SELECT message_count FROM sessions WHERE chat_id = ?').get(chatId) as { message_count: number } | undefined
  return row?.message_count ?? 0
}

export function clearSession(chatId: string): void {
  db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId)
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

export function createDashboardUser(username: string, passwordHash: string): DashboardUser {
  const now = Math.floor(Date.now() / 1000)
  // First-user-wins bootstrap: if the table is currently empty, the first user
  // becomes the global admin (role=admin, tenant_id=NULL). All subsequent users
  // start as viewer so they can only read until an admin grants them higher access.
  const isFirst = (db.prepare('SELECT COUNT(*) AS c FROM dashboard_users').get() as { c: number }).c === 0
  const role = isFirst ? 'admin' : 'viewer'
  const tenantId = null  // NULL = global scope; tenant-scoped users are created via the admin provisioning API
  const info = db
    .prepare(
      'INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(username, passwordHash, role, tenantId, now, now)
  return { id: Number(info.lastInsertRowid), username, password_hash: passwordHash, role, tenant_id: tenantId, email: null, display_name: null, created_at: now, updated_at: now, disabled: 0 }
}

export function getDashboardUser(username: string): DashboardUser | undefined {
  return db
    .prepare('SELECT * FROM dashboard_users WHERE username = ? COLLATE NOCASE')
    .get(username) as DashboardUser | undefined
}

export function listDashboardUsers(): DashboardUserPublic[] {
  return db
    .prepare('SELECT id, username, role, tenant_id, created_at, updated_at, disabled FROM dashboard_users ORDER BY username COLLATE NOCASE')
    .all() as DashboardUserPublic[]
}

// enabled-only count feeds `login_available`; total count feeds `setup_required`.
export function countDashboardUsers(includeDisabled = false): number {
  const sql = includeDisabled
    ? 'SELECT COUNT(*) AS c FROM dashboard_users'
    : 'SELECT COUNT(*) AS c FROM dashboard_users WHERE disabled = 0'
  return (db.prepare(sql).get() as { c: number }).c
}

export function updateDashboardUserPassword(userId: number, passwordHash: string): void {
  db.prepare('UPDATE dashboard_users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(passwordHash, Math.floor(Date.now() / 1000), userId)
}

export function deleteDashboardUser(username: string): boolean {
  const info = db.prepare('DELETE FROM dashboard_users WHERE username = ? COLLATE NOCASE').run(username)
  return info.changes > 0
}

export function appendDailyLog(agentId: string, content: string): void {
  const now = Math.floor(Date.now() / 1000)
  // Budapest calendar day, not UTC -- otherwise an entry written 00:00-02:00
  // local time lands on the previous day and the "ma" recall query misses it.
  // en-CA formats as YYYY-MM-DD.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ })
  db.prepare('INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES (?, ?, ?, ?)').run(agentId, today, content, now)
}

export function getDailyLog(agentId: string, date: string): { id: number; content: string; created_at: number }[] {
  return db.prepare('SELECT id, content, created_at FROM daily_logs WHERE agent_id = ? AND date = ? ORDER BY created_at ASC').all(agentId, date) as { id: number; content: string; created_at: number }[]
}

export function getDailyLogDates(agentId: string, limit: number = 14): string[] {
  return (db.prepare('SELECT DISTINCT date FROM daily_logs WHERE agent_id = ? ORDER BY date DESC LIMIT ?').all(agentId, limit) as { date: string }[]).map(r => r.date)
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

export function recallByDateRange(from: string, to: string, agentId?: string, tenantId?: string): RecallResult {
  const logSql = agentId
    ? 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? AND agent_id = ? ORDER BY date ASC, created_at ASC'
    : 'SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE date >= ? AND date <= ? ORDER BY date ASC, created_at ASC'
  const logParams = agentId ? [from, to, agentId] : [from, to]
  const logs = db.prepare(logSql).all(...logParams) as RecallResult['logs']

  const fromTs = toBudapestTs(from, false)
  const toTs = toBudapestTs(to, true)
  // daily_logs has no tenant_id column (Jonas Q3 decision: no migration). Only memories are tenant-filtered.
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  const memSql = agentId
    ? `SELECT * FROM memories WHERE created_at >= ? AND created_at <= ? AND (agent_id = ? OR category = 'shared')${tc} ORDER BY created_at ASC`
    : `SELECT * FROM memories WHERE created_at >= ? AND created_at <= ?${tc} ORDER BY created_at ASC`
  const memParams = agentId ? [fromTs, toTs, agentId, ...tp] : [fromTs, toTs, ...tp]
  const memories = db.prepare(memSql).all(...memParams) as Memory[]

  return { logs, memories, dateRange: { from, to } }
}

export function recallSearch(query: string, agentId?: string, limit = 50, tenantId?: string): RecallResult {
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
        ? db.prepare(sql).all(terms, agentId, ...tp, limit * RECENCY_OVERSAMPLE) as (Memory & { rank: number })[]
        : db.prepare(sql).all(terms, ...tp, limit * RECENCY_OVERSAMPLE) as (Memory & { rank: number })[]
      memories = withoutRank(reRankByRecency(candidates, limit)) as Memory[]
    } catch {
      const sql = agentId
        ? `SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')${tcFb} ORDER BY created_at DESC LIMIT ?`
        : `SELECT * FROM memories WHERE (content LIKE ? ESCAPE '\\' OR keywords LIKE ? ESCAPE '\\')${tcFb} ORDER BY created_at DESC LIMIT ?`
      const pat = `%${escaped}%`
      memories = agentId
        ? db.prepare(sql).all(agentId, pat, pat, ...tp, limit) as Memory[]
        : db.prepare(sql).all(pat, pat, ...tp, limit) as Memory[]
    }
  }

  const logSql = agentId
    ? "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' AND agent_id = ? ORDER BY date DESC, created_at DESC LIMIT ?"
    : "SELECT id, agent_id, date, content, created_at FROM daily_logs WHERE content LIKE ? ESCAPE '\\' ORDER BY date DESC, created_at DESC LIMIT ?"
  const logPat = `%${escaped}%`
  const logs = agentId
    ? db.prepare(logSql).all(logPat, agentId, limit) as RecallResult['logs']
    : db.prepare(logSql).all(logPat, limit) as RecallResult['logs']

  const dates = logs.map(l => l.date)
  const from = dates.length ? dates[dates.length - 1] : ''
  const to = dates.length ? dates[0] : ''

  return { logs, memories, dateRange: { from, to } }
}
