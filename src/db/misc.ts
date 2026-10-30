// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { dbx, type SqlOps } from './facade.js'
import { resolveWriteTenant } from './write-tenant.js'

export interface BackgroundTask {
  id: string
  agent_id: string
  prompt: string
  status: 'running' | 'done' | 'failed' | 'timeout'
  tmux_session: string | null
  started_at: number
  finished_at: number | null
  output: string | null
}

// The count check and the insert share one transaction: the connection lock keeps a second caller's statements out
// until COMMIT. On PostgreSQL (Phase 2) a plain READ COMMITTED transaction does not stop two callers from both seeing
// count < max; that move needs a per-agent advisory lock or a SERIALIZABLE retry here.
export async function createBackgroundTaskAtomic(id: string, agentId: string, prompt: string, tmuxSession: string, maxConcurrent: number): Promise<BackgroundTask | null> {
  const now = Math.floor(Date.now() / 1000)
  // Resolved before the transaction: the lookup reads through the facade, which inside the body would run on another
  // connection once the backend pools.
  const tenantId = await resolveWriteTenant(agentId)
  const result = await dbx.tx(async (tx) => {
    const running = ((await tx.get("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'", agentId)) as { c: number }).c
    if (running >= maxConcurrent) return null
    await tx.run('INSERT INTO background_tasks (id, agent_id, prompt, status, tmux_session, started_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?)', id, agentId, prompt, 'running', tmuxSession, now, tenantId)
    return { id, agent_id: agentId, prompt, status: 'running' as const, tmux_session: tmuxSession, started_at: now, finished_at: null, output: null }
  })
  return result
}

export async function getRunningBackgroundTasks(): Promise<BackgroundTask[]> {
  return dbx.all<BackgroundTask>("SELECT * FROM background_tasks WHERE status = 'running'")
}

/**
 * Closes a task that is still running. Returns false when the row was already closed (or is gone): the poll
 * ('done') and the timeout sweep ('timeout') race for the same row, and exactly one of them may win.
 */
export async function finishBackgroundTask(id: string, status: 'done' | 'failed' | 'timeout', output: string | null): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const info = await dbx.run("UPDATE background_tasks SET status = ?, finished_at = ?, output = ? WHERE id = ? AND status = 'running'", status, now, output, id)
  return info.changes > 0
}

export async function getBackgroundTasks(agentId?: string, includeFinished = false): Promise<BackgroundTask[]> {
  if (agentId) {
    const sql = includeFinished
      ? 'SELECT * FROM background_tasks WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50'
      : "SELECT * FROM background_tasks WHERE agent_id = ? AND status = 'running' ORDER BY started_at DESC"
    return dbx.all<BackgroundTask>(sql, agentId)
  }
  const sql = includeFinished
    ? 'SELECT * FROM background_tasks ORDER BY started_at DESC LIMIT 50'
    : "SELECT * FROM background_tasks WHERE status = 'running' ORDER BY started_at DESC"
  return dbx.all<BackgroundTask>(sql)
}

export async function getBackgroundTask(id: string): Promise<BackgroundTask | undefined> {
  return dbx.get<BackgroundTask>('SELECT * FROM background_tasks WHERE id = ?', id)
}

export async function countRunningBackgroundTasks(agentId: string): Promise<number> {
  return ((await dbx.get("SELECT COUNT(*) as c FROM background_tasks WHERE agent_id = ? AND status = 'running'", agentId)) as { c: number }).c
}

export async function markOrphanedTasksFailed(): Promise<number> {
  const now = Math.floor(Date.now() / 1000)
  const info = await dbx.run("UPDATE background_tasks SET status = 'failed', finished_at = ?, output = '(orphaned on restart)' WHERE status = 'running'", now)
  return info.changes
}

export interface PendingChannelRequest {
  id: number
  agent: string
  channel_id: string
  channel_name: string | null
  user_id: string | null
  requested_at: number
  status: 'pending' | 'approved' | 'denied'
}

/**
 * One statement, so two overlapping calls cannot both insert: a pending row is stopped by the partial unique index
 * idx_pcr_agent_channel (ON CONFLICT DO NOTHING), a recently denied one (7 days) by the NOT EXISTS. Returns true
 * when this call created the row.
 */
export async function upsertChannelRequest(agent: string, channelId: string, userId?: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const sevenDaysAgo = now - 7 * 86400
  const info = await dbx.run(
    `INSERT INTO pending_channel_requests (agent, channel_id, user_id, requested_at, status)
     SELECT ?, ?, ?, ?, 'pending'
     WHERE NOT EXISTS (
       SELECT 1 FROM pending_channel_requests
       WHERE agent = ? AND channel_id = ? AND status = 'denied' AND COALESCE(resolved_at, requested_at) > ?
     )
     ON CONFLICT DO NOTHING`,
    agent, channelId, userId ?? null, now, agent, channelId, sevenDaysAgo,
  )
  return info.changes > 0
}

export async function listPendingChannelRequests(agent: string): Promise<PendingChannelRequest[]> {
  return dbx.all<PendingChannelRequest>("SELECT * FROM pending_channel_requests WHERE agent = ? AND status = 'pending' ORDER BY requested_at DESC", agent)
}

export async function updateChannelRequestStatus(id: number, status: 'approved' | 'denied'): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run('UPDATE pending_channel_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = ?', status, now, id, 'pending')).changes > 0
}

export async function updateChannelRequestName(id: number, channelName: string): Promise<void> {
  await dbx.run('UPDATE pending_channel_requests SET channel_name = ? WHERE id = ?', channelName, id)
}

export async function saveTelegramMessage(
  chatId: string,
  messageId: string,
  direction: 'in' | 'out',
  text: string,
  userId?: string,
  ts?: number,
): Promise<void> {
  const now = ts ?? Math.floor(Date.now() / 1000)
  await dbx.run(`INSERT INTO telegram_history (chat_id, message_id, user_id, direction, text, ts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`, chatId, messageId, userId ?? null, direction, text, now)
}

export interface TelegramHistoryRow {
  id: number
  chat_id: string
  message_id: string
  user_id: string | null
  direction: 'in' | 'out'
  text: string
  ts: number
}

export async function getTelegramHistory(chatId: string, limit: number = 50): Promise<TelegramHistoryRow[]> {
  return dbx.all<TelegramHistoryRow>('SELECT * FROM telegram_history WHERE chat_id = ? ORDER BY ts DESC LIMIT ?', chatId, limit)
}

export interface IdeaBoxRow {
  id: string
  title: string
  description: string | null
  category: string
  status: 'new' | 'reviewed' | 'kanban' | 'rejected'
  source: string
  kanban_id: string | null
  impact: number | null
  effort: number | null
  tenant_id: string
  created_at: number
  updated_at: number
}

// tenantId is omitted (not null) for the admin "all tenants" listing --
// mirrors kanban.ts's effectiveTenantId convention (null/omitted = unscoped).
//
// status: 'active' is a pseudo-status meaning "new or reviewed" -- the
// dashboard's default filter, previously applied client-side AFTER fetching
// every idea unfiltered (which broke once the list gained server-side
// pagination: a page cut before the client filter ran would silently
// under-fill and its total wouldn't match what was actually shown).
export async function listIdeas(opts?: { status?: string; category?: string; tenantId?: string; limit?: number; offset?: number }): Promise<{ items: IdeaBoxRow[]; total: number }> {
  let where = ' WHERE 1=1'
  const params: string[] = []
  if (opts?.status === 'active') {
    where += " AND status IN ('new', 'reviewed')"
  } else if (opts?.status) {
    where += ' AND status = ?'; params.push(opts.status)
  }
  if (opts?.category) { where += ' AND category = ?'; params.push(opts.category) }
  if (opts?.tenantId) { where += ' AND tenant_id = ?'; params.push(opts.tenantId) }

  const total = ((await dbx.get(`SELECT COUNT(*) AS c FROM idea_box${where}`, ...params)) as { c: number }).c

  let q = `SELECT * FROM idea_box${where} ORDER BY created_at DESC`
  const allParams: unknown[] = [...params]
  if (opts?.limit !== undefined) {
    q += ' LIMIT ? OFFSET ?'
    allParams.push(opts.limit, opts.offset ?? 0)
  }
  const items = await dbx.all<IdeaBoxRow>(q, ...allParams)
  return { items, total }
}

// Status counts for the stats strip -- always tenant-scoped only (no
// status/category filter), so the numbers stay accurate regardless of which
// page or status filter the list itself is currently showing.
export async function getIdeaStatusCounts(tenantId?: string): Promise<Record<string, number>> {
  let q = "SELECT status, COUNT(*) AS c FROM idea_box"
  const params: string[] = []
  if (tenantId) { q += ' WHERE tenant_id = ?'; params.push(tenantId) }
  q += ' GROUP BY status'
  const rows = (await dbx.all(q, ...params)) as { status: string; c: number }[]
  const counts: Record<string, number> = { new: 0, reviewed: 0, kanban: 0, rejected: 0 }
  for (const r of rows) counts[r.status] = r.c
  return counts
}

export async function createIdea(idea: Omit<IdeaBoxRow, 'created_at' | 'updated_at'>): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run(`INSERT INTO idea_box (id, title, description, category, status, source, kanban_id, impact, effort, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, idea.id, idea.title, idea.description ?? null, idea.category, idea.status, idea.source, idea.kanban_id ?? null, idea.impact ?? null, idea.effort ?? null, idea.tenant_id, now, now)
}

type IdeaPatch = Partial<Pick<IdeaBoxRow, 'title' | 'description' | 'category' | 'status' | 'kanban_id' | 'impact' | 'effort'>>

async function updateIdeaOn(ops: SqlOps, id: string, patch: IdeaPatch): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  if (patch.category !== undefined) { sets.push('category = ?'); params.push(patch.category) }
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
  if (patch.kanban_id !== undefined) { sets.push('kanban_id = ?'); params.push(patch.kanban_id) }
  if (patch.impact !== undefined) { sets.push('impact = ?'); params.push(patch.impact) }
  if (patch.effort !== undefined) { sets.push('effort = ?'); params.push(patch.effort) }
  params.push(id)
  return (await ops.run(`UPDATE idea_box SET ${sets.join(', ')} WHERE id = ?`, ...params)).changes > 0
}

export async function updateIdea(id: string, patch: IdeaPatch): Promise<boolean> {
  return updateIdeaOn(dbx, id, patch)
}

/**
 * The idea update and its status-log row in one transaction, so a failure of the log write does not leave a changed
 * status without its audit row (and the reverse). The log row is written only when the idea row was changed.
 * Returns whether the idea row was changed.
 */
export async function updateIdeaWithStatusLog(
  id: string,
  patch: IdeaPatch,
  log: { from: string | null; to: string; actor: string; note?: string },
): Promise<boolean> {
  return dbx.tx(async (tx) => {
    if (!(await updateIdeaOn(tx, id, patch))) return false
    await logIdeaStatusChangeOn(tx, id, log.from, log.to, log.actor, log.note)
    return true
  })
}

export async function deleteIdea(id: string): Promise<boolean> {
  return (await dbx.run('DELETE FROM idea_box WHERE id = ?', id)).changes > 0
}

export async function listIdeaCategories(): Promise<string[]> {
  return ((await dbx.all('SELECT DISTINCT category FROM idea_box ORDER BY category')) as { category: string }[]).map(r => r.category)
}

export interface IdeaComment {
  id: number
  idea_id: string
  author: string
  content: string
  created_at: number
}

export async function getIdeaComments(ideaId: string): Promise<IdeaComment[]> {
  return dbx.all<IdeaComment>('SELECT * FROM idea_comments WHERE idea_id = ? ORDER BY created_at ASC', ideaId)
}

export async function addIdeaComment(ideaId: string, author: string, content: string): Promise<IdeaComment> {
  const now = Math.floor(Date.now() / 1000)
  // The comment and the idea's updated_at move together: a failed second write must not leave the comment behind.
  return dbx.tx(async (tx) => {
    const { id } = (await tx.get('INSERT INTO idea_comments (idea_id, author, content, created_at) VALUES (?, ?, ?, ?) RETURNING id', ideaId, author, content, now)) as { id: number }
    await tx.run('UPDATE idea_box SET updated_at = ? WHERE id = ?', now, ideaId)
    return { id, idea_id: ideaId, author, content, created_at: now }
  })
}

export interface IdeaStatusLogRow {
  id: number
  idea_id: string
  from_status: string | null
  to_status: string
  actor: string
  note: string | null
  created_at: number
}

async function logIdeaStatusChangeOn(
  ops: SqlOps,
  ideaId: string,
  fromStatus: string | null,
  toStatus: string,
  actor: string,
  note?: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await ops.run('INSERT INTO idea_status_log (idea_id, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?)', ideaId, fromStatus ?? null, toStatus, actor, note ?? null, now)
}

export async function logIdeaStatusChange(
  ideaId: string,
  fromStatus: string | null,
  toStatus: string,
  actor: string,
  note?: string,
): Promise<void> {
  await logIdeaStatusChangeOn(dbx, ideaId, fromStatus, toStatus, actor, note)
}

export async function getIdeaStatusLog(ideaId: string): Promise<IdeaStatusLogRow[]> {
  return dbx.all<IdeaStatusLogRow>('SELECT * FROM idea_status_log WHERE idea_id = ? ORDER BY created_at ASC', ideaId)
}

// Revert a promoted idea back to 'reviewed' when its kanban card is deleted or archived.
// Returns the idea id if a matching idea was found and reverted, null otherwise. The read, the update and the log row
// are one transaction: two overlapping reverts of one card write exactly one log row, and a failed log write leaves
// the idea promoted.
export async function revertIdeaFromKanban(kanbanId: string): Promise<string | null> {
  return dbx.tx(async (tx) => {
    const idea = await tx.get<{ id: string; status: string }>("SELECT id, status FROM idea_box WHERE kanban_id = ? AND status = 'kanban'", kanbanId)
    if (!idea) return null
    const now = Math.floor(Date.now() / 1000)
    const info = await tx.run("UPDATE idea_box SET status = 'reviewed', kanban_id = NULL, updated_at = ? WHERE id = ? AND status = 'kanban'", now, idea.id)
    if (info.changes === 0) return null
    await logIdeaStatusChangeOn(tx, idea.id, 'kanban', 'reviewed', 'system', `Kanban card removed: ${kanbanId}`)
    return idea.id
  })
}

// ── Homoglyph journal (homoglyph_findings) ───────────────────────────

export interface HomoglyphFindingRow {
  id: number
  src_table: string
  src_id: string
  sample: string
  found_at: number
  resolved_at: number | null
}

export async function listHomoglyphFindings(includeResolved: boolean): Promise<HomoglyphFindingRow[]> {
  return dbx.all<HomoglyphFindingRow>(`SELECT id, src_table, src_id, sample, found_at, resolved_at
       FROM homoglyph_findings
       ${includeResolved ? '' : 'WHERE resolved_at IS NULL'}
       ORDER BY id DESC LIMIT 200`)
}

/** Returns the number of findings newly marked resolved (0 when absent or already resolved). */
export async function resolveHomoglyphFinding(id: number): Promise<number> {
  return (await dbx.run('UPDATE homoglyph_findings SET resolved_at = unixepoch() WHERE id = ? AND resolved_at IS NULL', id)).changes
}

// ── Idea box lookup ──────────────────────────────────────────────────

export async function getIdeaById(id: string): Promise<IdeaBoxRow | undefined> {
  return dbx.get<IdeaBoxRow>('SELECT * FROM idea_box WHERE id = ?', id)
}
