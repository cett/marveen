// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { randomUUID } from 'node:crypto'
import { writeAgentAuditLog } from './audit.js'
import { db } from './connection.js'
import { KanbanCard } from './kanban.js'
import { Tenant } from './observability.js'

export interface HeartbeatKanbanSummary {
  urgent: KanbanCard[]
  in_progress: KanbanCard[]
  waiting: KanbanCard[]
}

/**
 * The ONE definition of "what the heartbeat lists". Both consumers read it from
 * here: the built-in heartbeat prompt (heartbeat.ts) and the heartbeat AGENT,
 * which gets it over /api/kanban/heartbeat-summary instead of composing its own
 * query. Two hand-written copies of the same filter is how they drift apart.
 *
 * `urgent` means urgent and NOT FINISHED: priority='urgent', not archived, not
 * `done`. `planned` stays IN on purpose -- "urgent and nobody has touched it" is
 * one of the states most worth seeing, and a list that hides it would be quiet
 * for the wrong reason. (A first draft of this change narrowed it to
 * waiting/in_progress; that was withdrawn precisely because it would have hidden
 * untouched urgent work.)
 *
 * What DID have to go is closed work: on 2026-08-04 the 09:00 report listed five
 * items of which three were already `done`, and the 08-03 count was 22 done
 * against 2 waiting -- the most prominent line of an hourly report was mostly
 * finished cards, so it stopped being read. Those 22 were only reachable through
 * a hand-written query; this statement never returned them, which is why the real
 * fix is that the heartbeat agent no longer writes its own query.
 */
/** Exported so a test can execute the SHIPPED statement against a fixture DB
 *  instead of re-typing an equivalent one and proving nothing. */
export const HEARTBEAT_URGENT_SQL =
  "SELECT * FROM kanban_cards WHERE archived_at IS NULL AND priority = 'urgent' AND status != 'done'"
export const HEARTBEAT_IN_PROGRESS_SQL =
  "SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'in_progress'"
export const HEARTBEAT_WAITING_SQL =
  "SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'waiting'"

// HBKANBANDRIFT819 follow-up: the heartbeat report format asks for a planned
// line, so the number needs a sanctioned server-side source like every other
// count -- without it the agent manufactures the value (measured: planned: 0
// reported against a real 305). COUNT only: no card list is served for
// planned, the line is a bare number.
export const HEARTBEAT_PLANNED_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM kanban_cards WHERE archived_at IS NULL AND status = 'planned'"

export function countPlannedKanbanCards(): number {
  const row = db.prepare(HEARTBEAT_PLANNED_COUNT_SQL).get() as { n: number } | undefined
  return row?.n ?? 0
}

export function getHeartbeatKanbanSummary(): HeartbeatKanbanSummary {
  const urgent = db
    .prepare("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND priority = 'urgent' AND status != 'done'")
    .all() as KanbanCard[]
  const in_progress = db
    .prepare("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'in_progress'")
    .all() as KanbanCard[]
  const waiting = db
    .prepare("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'waiting'")
    .all() as KanbanCard[]
  return { urgent, in_progress, waiting }
}

/**
 * HBMEMBLIND819: the heartbeat's "new hot memories (1h)" number is computed
 * HERE, server-side, and served over /api/kanban/heartbeat-summary -- the
 * heartbeat agent copies it like the kanban counts, it never runs the query.
 *
 * This is the SECOND failure of the prescribe-the-query pattern for this
 * metric. HBMEMBLIND807 (2026-08-07): the agent composed its own SQL and
 * reported 0 beside three hot memories; the fix prescribed a ready-made query
 * with "do not rewrite the query". HBMEMBLIND819 (2026-08-19): measured
 * 14/14 rounds reporting 0 over 24h with real values of 2 in three of them --
 * the agent ran the prescribed query SHAPE but with agent_id='heartbeat'
 * substituted for the main agent's id. Timeline over 8 sessions / 196 runs:
 * the identity rewrite appears on post-compact rounds (the agent reconstructs
 * the query from memory as "count MY hot memories" instead of re-reading the
 * prescription) and then persists as its own precedent. A prescription the
 * measured party must re-copy every round is not a mechanism; the kanban
 * counts on the SAME agent never drifted, because an endpoint number has no
 * query to rewrite. Same closure as getHeartbeatKanbanSummary above.
 */
/** Exported so a test can execute the SHIPPED statement against a fixture DB
 *  instead of re-typing an equivalent one and proving nothing. */
export const HEARTBEAT_NEW_HOT_MEMORIES_SQL =
  "SELECT COUNT(*) AS n FROM memories WHERE agent_id = ? AND category = 'hot' AND created_at > unixepoch() - 3600"

export function countNewHotMemories(agentId: string): number {
  const row = db.prepare(HEARTBEAT_NEW_HOT_MEMORIES_SQL).get(agentId) as { n: number } | undefined
  return row?.n ?? 0
}

export interface AgentMessage {
  id: number
  from_agent: string
  to_agent: string
  content: string
  status: 'pending' | 'delivered' | 'done' | 'failed'
  result: string | null
  created_at: number
  delivered_at: number | null
  completed_at: number | null
  // Card 06f062e4: optional, self-declared attributability tag (e.g. a
  // sub-agent's own task/branch name) -- NOT an authentication mechanism,
  // see the table-creation comment. Null for every caller that doesn't pass one.
  origin_note: string | null
  // Card def5a189: distributed trace context (message-router middleware).
  trace_id: string | null
  span_id: string | null
  parent_span_id: string | null
  tenant_id: string | null
}

export function createAgentMessage(
  from: string,
  to: string,
  content: string,
  originNote?: string | null,
  traceCtx?: { trace_id: string; span_id: string; parent_span_id: string | null } | null,
  tenantId: string = 'default',
): AgentMessage {
  const now = Math.floor(Date.now() / 1000)
  const info = db.prepare(
    'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, origin_note, trace_id, span_id, parent_span_id, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(from, to, content, 'pending', now, originNote ?? null, traceCtx?.trace_id ?? null, traceCtx?.span_id ?? null, traceCtx?.parent_span_id ?? null, tenantId)
  const id = Number(info.lastInsertRowid)
  try {
    writeAgentAuditLog({ agent_id: from, entity: 'message', action: 'create', entity_id: id, detail: { to, preview: content.slice(0, 80) } })
  } catch { /* audit failure must not abort message creation */ }
  return {
    id,
    from_agent: from, to_agent: to, content, status: 'pending',
    result: null, created_at: now, delivered_at: null, completed_at: null,
    origin_note: originNote ?? null,
    trace_id: traceCtx?.trace_id ?? null,
    span_id: traceCtx?.span_id ?? null,
    parent_span_id: traceCtx?.parent_span_id ?? null,
    tenant_id: tenantId ?? null,
  }
}

export function getPendingMessages(toAgent?: string, tenantId?: string): AgentMessage[] {
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  if (toAgent) {
    return db.prepare(`SELECT * FROM agent_messages WHERE status = 'pending' AND to_agent = ?${tc} ORDER BY created_at ASC`)
      .all(toAgent, ...tp) as AgentMessage[]
  }
  return db.prepare(`SELECT * FROM agent_messages WHERE status = 'pending'${tc} ORDER BY created_at ASC`)
    .all(...tp) as AgentMessage[]
}

// Status-guarded (pending only): the federation removal path bulk-fails
// pending rows CONCURRENTLY with an in-flight bridge send -- an unguarded
// UPDATE would flip such a row failed->delivered after the fact. If the row
// is no longer pending, this returns false and the caller must not record a
// result either.
export function markMessageDelivered(id: number): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'pending'").run(now, id).changes > 0
}

// Per-agent backlog: how many messages are waiting, and how old the oldest one
// is. The queue only surfaces when somebody opens a pane and notices, which is
// how an 18-row backlog went unseen on 2026-07-27 and got mistaken for data
// loss. Age matters more than count: three messages from a minute ago is a busy
// agent working normally, one message from two hours ago is an agent that is
// never going to pick it up.
export type AgentBacklog = { agent: string; pending: number; oldestAgeSeconds: number }

export function getPendingBacklogByAgent(): AgentBacklog[] {
  const now = Math.floor(Date.now() / 1000)
  const rows = db.prepare(
    `SELECT to_agent AS agent, COUNT(*) AS pending, MIN(created_at) AS oldest
       FROM agent_messages
      WHERE status = 'pending'
      GROUP BY to_agent`,
  ).all() as { agent: string; pending: number; oldest: number }[]
  return rows
    .map(r => ({ agent: r.agent, pending: r.pending, oldestAgeSeconds: Math.max(0, now - r.oldest) }))
    // oldest-first: whoever has been waiting longest is the one worth looking at
    .sort((a, b) => b.oldestAgeSeconds - a.oldestAgeSeconds)
}

// Close a pending backlog that is NOT going to be delivered -- stale rows an
// operator does not want the router to replay (an old thank-you note, a legal
// warning whose content has since changed). Separate from markMessageDelivered
// because the two mean opposite things: one records that a message went out,
// this one records that it never will. Both leave a timestamp, and this one
// leaves a reason, so the log can still answer "was this actually delivered?"
// afterwards. Without it the only way to clear a backlog is raw SQL, which is
// how the queue got 24 rows claiming delivery they never had.
export function closeMessagesWithoutDelivery(ids: number[], reason: string): number {
  if (!ids.length) return 0
  const now = Math.floor(Date.now() / 1000)
  const note = `closed-without-delivery: ${reason}`
  const stmt = db.prepare(
    `UPDATE agent_messages SET status = 'delivered', delivered_at = ?, result = ?
      WHERE id = ? AND status = 'pending'`,
  )
  const run = db.transaction((rows: number[]) => {
    let n = 0
    for (const id of rows) n += stmt.run(now, note, id).changes
    return n
  })
  return run(ids)
}

// Supplementary result text WITHOUT a status change. The federation bridge
// records the peer-assigned id on delivered rows ("fed:<peer>:<remote id>")
// so a cross-system message can be traced without a schema migration.
export function setMessageResult(id: number, result: string): boolean {
  return db.prepare('UPDATE agent_messages SET result = ? WHERE id = ?').run(result, id).changes > 0
}

// Bulk-fail PENDING federated (slash-qualified to_agent) messages -- the
// deterministic counterpart of the bridge's drip-fail on disable/removal.
// ONE statement (claimPendingForAgent idiom: no SELECT-then-UPDATE window).
// pending only: delivered/done/failed rows are conversation history.
// Per-peer scoping compares the exact prefix segment via instr/substr -- a
// LIKE pattern would treat '_' in a peer id as a wildcard ('te_dor' purging
// 'teodor'). lower() on both sides: system ids are case-insensitive, and rows
// written before the lowercase normalization may carry an uppercase prefix
// that must still be purged with its peer (ASCII-only lower() is fine -- the
// id charset is [a-zA-Z0-9_-]).
export function failPendingFederatedMessages(peerId: string | undefined, reason: string): number[] {
  const now = Math.floor(Date.now() / 1000)
  const rows = peerId === undefined
    ? db.prepare(
        `UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ?
           WHERE status = 'pending' AND instr(to_agent, '/') > 0
         RETURNING id`,
      ).all(reason, now) as Array<{ id: number }>
    : db.prepare(
        `UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ?
           WHERE status = 'pending' AND instr(to_agent, '/') > 0
             AND lower(substr(to_agent, 1, instr(to_agent, '/') - 1)) = lower(?)
         RETURNING id`,
      ).all(reason, now, peerId) as Array<{ id: number }>
  return rows.map((r) => r.id)
}

// Atomically CLAIM (pending -> delivered) the oldest `limit` pending messages
// for an agent, returning the claimed rows. A SINGLE `UPDATE ... WHERE
// status='pending' RETURNING` (NOT a SELECT-then-UPDATE) so two concurrent
// drains can never double-claim the same message (-> no ghost double-delivery).
// Backs the main-agent inbox PULL model: the main agent drains its own inbox at
// each turn (via the drain-inbox endpoint + UserPromptSubmit hook) instead of
// the router tmux-injecting into its perpetually-busy channel session.
export function claimPendingForAgent(toAgent: string, limit: number): AgentMessage[] {
  const now = Math.floor(Date.now() / 1000)
  const rows = db.prepare(
    `UPDATE agent_messages SET status = 'delivered', delivered_at = ?
       WHERE id IN (
         SELECT id FROM agent_messages
         WHERE to_agent = ? AND status = 'pending'
         ORDER BY created_at ASC, id ASC
         LIMIT ?
       )
     RETURNING id, from_agent, to_agent, content, status, result, created_at, delivered_at, completed_at`,
  ).all(now, toAgent, limit) as AgentMessage[]
  // RETURNING row order is unspecified; restore FIFO (created_at, then id as the
  // tiebreaker for same-second inserts) for delivery.
  return rows.sort((a, b) => (a.created_at - b.created_at) || (a.id - b.id))
}

export function markMessageDone(id: number, result?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  // COALESCE: some done-transitions skip the delivered step entirely (e.g. a
  // still-pending row marked done directly via PUT), so backfill delivered_at
  // only when it was never set -- don't clobber a real earlier delivery time.
  return db.prepare("UPDATE agent_messages SET status = 'done', result = ?, completed_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?").run(result ?? null, now, now, id).changes > 0
}

export function markMessageFailed(id: number, error?: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ? WHERE id = ?").run(error ?? null, now, id).changes > 0
}

// Status-guarded fail for the federation bridge's terminal branches: it must
// only fire (and only bounce a failure notice) when THIS call actually closed
// a still-pending row. The unguarded markMessageFailed above would also
// "succeed" on a row a concurrent disable/removal purge already failed
// (result/completed_at change -> changes>0), producing a spurious second
// notice. The drain-inbox path deliberately keeps the unguarded variant (it
// fails an already-delivered row).
export function markPendingFederatedFailed(id: number, error: string): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare("UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ? WHERE id = ? AND status = 'pending'").run(error, now, id).changes > 0
}

export function listAgentMessages(limit = 50, tenantId?: string): AgentMessage[] {
  if (tenantId) {
    return db.prepare('SELECT * FROM agent_messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?').all(tenantId, limit) as AgentMessage[]
  }
  return db.prepare('SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?').all(limit) as AgentMessage[]
}

export interface DispatchedPendingStats {
  /** Count of messages sent by fromAgent with status pending|delivered, within staleCutoffMs. */
  count: number
  /** Any messages sent by fromAgent that WOULD have blocked but are beyond staleCutoffMs. */
  hasStale: boolean
}

/**
 * Check how many outbound messages this agent dispatched that have not yet
 * received a result (status pending or delivered), separating live (within
 * staleCutoffMs) from stale (beyond it). Used by the context-restart gate.
 */
export function getDispatchedPendingStats(
  fromAgent: string,
  nowMs: number,
  staleCutoffMs: number,
): DispatchedPendingStats {
  const cutoffEpoch = Math.floor((nowMs - staleCutoffMs) / 1000)
  const liveRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM agent_messages
       WHERE from_agent = ? AND status IN ('pending','delivered')
         AND CAST(created_at AS INTEGER) > ?`,
  ).get(fromAgent, cutoffEpoch) as { cnt: number }
  const staleRow = db.prepare(
    `SELECT COUNT(*) AS cnt FROM agent_messages
       WHERE from_agent = ? AND status IN ('pending','delivered')
         AND CAST(created_at AS INTEGER) <= ?`,
  ).get(fromAgent, cutoffEpoch) as { cnt: number }
  return {
    count:    liveRow?.cnt ?? 0,
    hasStale: (staleRow?.cnt ?? 0) > 0,
  }
}

/**
 * True when the agent's last inbound channel message has no later outbound
 * (unanswered question). Used by the context-restart gate.
 */
export function hasOpenInboundQuestion(agentId: string): boolean {
  const row = db.prepare(
    `SELECT id, created_at FROM conversation_log
       WHERE agent_id = ? AND direction = 'in'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(agentId) as { id: number; created_at: number } | undefined
  if (!row) return false
  const laterOut = db.prepare(
    `SELECT 1 FROM conversation_log
       WHERE agent_id = ? AND direction = 'out'
         AND (created_at > ? OR (created_at = ? AND id > ?))
       LIMIT 1`,
  ).get(agentId, row.created_at, row.created_at, row.id)
  return !laterOut
}

// System/automation participants that are not real conversation peers. They are
// excluded as THREAD rows in the dashboard sidebar (you don't chat with the
// heartbeat or the coordinator), but messages involving them still count toward
// the human/agent peer they are paired with (so a thread's count matches what
// getAgentConversation returns when you open it).
export const CHAT_SYSTEM_AGENTS = ['heartbeat', 'telegram-coordinator', 'channel-coordinator', 'system'] as const

const AGENT_MESSAGE_LIMIT_CAP = 200

// The actual last-N messages for ONE agent, filtered in SQL (NOT global-last-N
// then JS-filter -- that starved rarely-active agents' threads, dashboard bug
// 2026-06-03). `beforeId` pages older: pass the oldest id you already have to
// fetch the next-older batch (scroll-up pagination). Newest-first.
export function getAgentConversation(agent: string, limit = 50, beforeId?: number, tenantId?: string): AgentMessage[] {
  const cap = Math.min(Math.max(1, Math.floor(limit) || 1), AGENT_MESSAGE_LIMIT_CAP)
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  if (beforeId !== undefined && Number.isFinite(beforeId)) {
    return db.prepare(
      `SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) AND id < ?${tc} ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(agent, agent, beforeId, ...tp, cap) as AgentMessage[]
  }
  return db.prepare(
    `SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?)${tc} ORDER BY created_at DESC, id DESC LIMIT ?`
  ).all(agent, agent, ...tp, cap) as AgentMessage[]
}

export interface AgentThread {
  agent: string
  count: number
  lastMessage: AgentMessage | null
}

// One row per distinct conversation peer (from_agent OR to_agent), excluding
// CHAT_SYSTEM_AGENTS, each with its total message count and its most-recent
// message. Drives the dashboard sidebar. Recency is computed per-peer (max
// created_at) so a rarely-active peer's last message is never hidden behind the
// global recency window (the bug the JS-filter path had). Sorted newest-first.
export function getAgentConversationThreads(tenantId?: string): AgentThread[] {
  const tc = tenantId ? ' WHERE tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  const countTc = tenantId ? ' AND m.tenant_id = ?' : ''
  const parties = db.prepare(`
    WITH parties AS (
      SELECT from_agent AS agent FROM agent_messages${tc}
      UNION
      SELECT to_agent AS agent FROM agent_messages${tc}
    )
    SELECT p.agent AS agent,
      (SELECT COUNT(*) FROM agent_messages m WHERE (m.from_agent = p.agent OR m.to_agent = p.agent)${countTc}) AS count
    FROM parties p
  `).all(...tp, ...tp, ...tp) as { agent: string; count: number }[]

  const lastStmt = tenantId
    ? db.prepare('SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) AND tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    : db.prepare('SELECT * FROM agent_messages WHERE from_agent = ? OR to_agent = ? ORDER BY created_at DESC, id DESC LIMIT 1')

  const system = new Set<string>(CHAT_SYSTEM_AGENTS)
  const threads: AgentThread[] = []
  for (const p of parties) {
    if (!p.agent || system.has(p.agent)) continue
    const lastMessage = (tenantId
      ? lastStmt.get(p.agent, p.agent, tenantId)
      : lastStmt.get(p.agent, p.agent)) as AgentMessage | undefined ?? null
    threads.push({ agent: p.agent, count: p.count, lastMessage })
  }
  threads.sort((a, b) => {
    const ca = a.lastMessage?.created_at ?? 0
    const cb = b.lastMessage?.created_at ?? 0
    if (cb !== ca) return cb - ca
    return (b.lastMessage?.id ?? 0) - (a.lastMessage?.id ?? 0) // tiebreak: newest id first
  })
  return threads
}

export interface BlackboardHistoryRow {
  id: number
  agent_id: string
  task_ref: string | null
  status: string
  summary: string
  created_at: number
  tenant_id: string
}

export function insertBlackboardHistory(entry: {
  agent_id: string
  task_ref: string | null
  status: string
  summary: string
}): void {
  db.prepare(
    'INSERT INTO fleet_blackboard_history (agent_id, task_ref, status, summary, tenant_id) VALUES (?, ?, ?, ?, ?)'
  ).run(entry.agent_id, entry.task_ref, entry.status, entry.summary, resolveAgentTenant(entry.agent_id))
}

export function listBlackboardHistory(opts: {
  agent_id?: string
  since?: number
  limit?: number
  tenantId?: string | null
} = {}): BlackboardHistoryRow[] {
  const limit = Math.min(opts.limit ?? 50, 200)
  const parts: string[] = []
  const params: (string | number)[] = []
  if (opts.agent_id) { parts.push('agent_id = ?'); params.push(opts.agent_id) }
  if (opts.since !== undefined) { parts.push('created_at >= ?'); params.push(opts.since) }
  if (opts.tenantId) { parts.push('tenant_id = ?'); params.push(opts.tenantId) }
  const where = parts.length ? 'WHERE ' + parts.join(' AND ') : ''
  params.push(limit)
  return db.prepare(
    `SELECT id, agent_id, task_ref, status, summary, created_at, tenant_id
     FROM fleet_blackboard_history ${where}
     ORDER BY created_at DESC LIMIT ?`
  ).all(...params) as BlackboardHistoryRow[]
}

export function pruneBlackboardHistory(ttlDays = 30): number {
  const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 86400
  return db.prepare('DELETE FROM fleet_blackboard_history WHERE created_at < ?').run(cutoff).changes
}

// Mark fleet_blackboard 'active'/'assigned' rows as 'stale' when they have
// not been updated for longer than the applicable threshold. 'active' rows
// use the per-agent tier threshold (thresholdsByAgent/defaultThresholdSec);
// 'assigned' rows (delegated but never picked up) use the flat
// assignedThresholdSec instead, since a not-yet-started task has no tier of
// its own. Returns how many rows were marked. Called by the
// blackboard-stale-sweeper on a background interval.
export function markBlackboardStale(
  thresholdsByAgent: Record<string, number>,
  defaultThresholdSec: number,
  assignedThresholdSec: number,
  nowSec = Math.floor(Date.now() / 1000),
): number {
  const rows = db.prepare(
    `SELECT id, agent_id, task_ref, summary, updated_at, status FROM fleet_blackboard WHERE status IN ('active', 'assigned')`,
  ).all() as { id: string; agent_id: string; task_ref: string | null; summary: string; updated_at: number; status: string }[]
  let marked = 0
  for (const row of rows) {
    const threshold = row.status === 'assigned' ? assignedThresholdSec : (thresholdsByAgent[row.agent_id] ?? defaultThresholdSec)
    if (nowSec - row.updated_at > threshold) {
      db.prepare(
        `UPDATE fleet_blackboard SET status = 'stale', updated_at = ? WHERE id = ?`,
      ).run(nowSec, row.id)
      insertBlackboardHistory({ agent_id: row.agent_id, task_ref: row.task_ref, status: 'stale', summary: row.summary })
      marked++
    }
  }
  return marked
}

export function getAgentTier(agentId: string): string {
  const row = db.prepare('SELECT tier FROM agent_blackboard_tier WHERE agent_id = ?').get(agentId) as { tier: string } | undefined
  return row?.tier ?? 'default'
}

export function getActiveBlackboardAgentIds(): string[] {
  const rows = db.prepare("SELECT DISTINCT agent_id FROM fleet_blackboard WHERE status IN ('active', 'assigned')").all() as { agent_id: string }[]
  return rows.map((r) => r.agent_id)
}

// Remove fleet_blackboard rows that have been stuck in 'active' for longer
// than ttlHours without any agent updating them. These are orphaned entries
// from tasks whose sawTurn=false path cleared the watchdog without writing

export interface BlackboardRow {
  id: string
  agent_id: string
  task_ref: string | null
  status: 'active' | 'done' | 'blocked' | 'stale' | 'assigned'
  summary: string
  updated_at: number
  tenant_id: string
}

export function findBlackboardRowByAgent(agent_id: string): BlackboardRow | undefined {
  return db.prepare('SELECT * FROM fleet_blackboard WHERE agent_id = ?').get(agent_id) as BlackboardRow | undefined
}

// Resolve which tenant a blackboard row for agent_id belongs to, derived from
// tenant_agent_availability (deny-by-default opt-in matrix -- only enabled=1
// rows count as a real assignment; a disabled row means the agent is NOT
// available to that tenant, see 0026_tenant_agent_availability.sql).
//   0 enabled rows -> fleet agent, 'default'
//   1 enabled row  -> that tenant
//   2+ enabled rows -> '_multi_' sentinel: never matches a real ctx.tenantId,
//     so the row is admin-only visible (see tryHandleBlackboard tenant filter).
export function resolveAgentTenant(agent_id: string): string {
  const rows = db
    .prepare('SELECT tenant_id FROM tenant_agent_availability WHERE agent_id = ? AND enabled = 1')
    .all(agent_id) as { tenant_id: string }[]
  if (rows.length === 0) return 'default'
  if (rows.length === 1) return rows[0]!.tenant_id
  return '_multi_'
}

// Upsert a fleet blackboard row for agent_id, writing a history entry only
// when the status, summary, or task_ref actually changes.
export function upsertBlackboard(
  agent_id: string,
  data: { task_ref?: string | null; status?: string; summary: string },
): BlackboardRow {
  const existing = db.prepare('SELECT * FROM fleet_blackboard WHERE agent_id = ?').get(agent_id) as BlackboardRow | undefined
  const id = existing?.id ?? randomUUID().replace(/-/g, '').slice(0, 8)
  const tenant_id = resolveAgentTenant(agent_id)
  db.prepare(`
    INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary, updated_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, unixepoch(), ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      task_ref   = excluded.task_ref,
      status     = excluded.status,
      summary    = excluded.summary,
      updated_at = unixepoch(),
      tenant_id  = excluded.tenant_id
  `).run(id, agent_id, data.task_ref ?? null, data.status ?? 'active', data.summary, tenant_id)
  const row = db.prepare('SELECT * FROM fleet_blackboard WHERE id = ?').get(id) as BlackboardRow
  const changed = !existing ||
    existing.status !== row.status ||
    existing.summary !== row.summary ||
    (existing.task_ref ?? null) !== (row.task_ref ?? null)
  if (changed) {
    insertBlackboardHistory({ agent_id: row.agent_id, task_ref: row.task_ref, status: row.status, summary: row.summary })
  }
  return row
}

// ── Tenant-agent availability (deny-by-default opt-in matrix) ─────────────────

export interface TenantAgentAvailability {
  tenant_id: string
  agent_id: string
  enabled: 0 | 1
  updated_at: number
}

/** List all availability rows for a tenant (enabled + disabled). */
export function listTenantAgentAvailability(tenantId: string): TenantAgentAvailability[] {
  return db
    .prepare('SELECT tenant_id, agent_id, enabled, updated_at FROM tenant_agent_availability WHERE tenant_id = ? ORDER BY agent_id')
    .all(tenantId) as TenantAgentAvailability[]
}

/** Upsert a (tenant, agent) availability row. Returns the new row. */
export function setTenantAgentAvailability(tenantId: string, agentId: string, enabled: boolean): TenantAgentAvailability {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tenant_id, agent_id) DO UPDATE SET
      enabled    = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(tenantId, agentId, enabled ? 1 : 0, now)
  return db.prepare('SELECT tenant_id, agent_id, enabled, updated_at FROM tenant_agent_availability WHERE tenant_id = ? AND agent_id = ?').get(tenantId, agentId) as TenantAgentAvailability
}

/** Check if an agent is explicitly enabled for a tenant. */
export function isTenantAgentEnabled(tenantId: string, agentId: string): boolean {
  const row = db
    .prepare('SELECT enabled FROM tenant_agent_availability WHERE tenant_id = ? AND agent_id = ?')
    .get(tenantId, agentId) as { enabled: number } | undefined
  return row?.enabled === 1
}

/** List agent_ids explicitly enabled=1 for a tenant (deny-by-default: agents
 *  with no row, or enabled=0, are not returned). */
export function getEnabledAgentsForTenant(tenantId: string): string[] {
  const rows = db
    .prepare('SELECT agent_id FROM tenant_agent_availability WHERE tenant_id = ? AND enabled = 1')
    .all(tenantId) as { agent_id: string }[]
  return rows.map(r => r.agent_id)
}

/** List tenant_ids this agent is enabled=1 for -- the inverse of
 *  getEnabledAgentsForTenant, used for the Agents screen's per-tenant
 *  visibility chips. An agent with no rows at all (e.g. a fleet-internal
 *  agent never opted into any tenant) returns an empty array. */
export function getTenantsForAgent(agentId: string): string[] {
  const rows = db
    .prepare('SELECT tenant_id FROM tenant_agent_availability WHERE agent_id = ? AND enabled = 1')
    .all(agentId) as { tenant_id: string }[]
  return rows.map(r => r.tenant_id)
}

// Schedules (SQL-backed, replaces file-based scheduled-tasks-io)
