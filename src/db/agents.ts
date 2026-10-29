// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { randomUUID } from 'node:crypto'
import { writeAgentAuditLog } from './audit.js'
import { deactivatePlanForAgent } from './claude-plans.js'
import { db } from './connection.js'
import { dbx, type SqlOps } from './facade.js'
import { getDelegationTenant } from './tenant-channel-bindings.js'
import { KanbanCard } from './kanban.js'
import { Tenant, getTenantForMainAgent, COMPLETION_REPORT_PREFIX } from './observability.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { assertNoReservedMarker } from '../server-markers.js'

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

export async function countPlannedKanbanCards(): Promise<number> {
  const row = await dbx.get<{ n: number }>(HEARTBEAT_PLANNED_COUNT_SQL)
  return row?.n ?? 0
}

export async function getHeartbeatKanbanSummary(): Promise<HeartbeatKanbanSummary> {
  const urgent = await dbx.all<KanbanCard>("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND priority = 'urgent' AND status != 'done'")
  const in_progress = await dbx.all<KanbanCard>("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'in_progress'")
  const waiting = await dbx.all<KanbanCard>("SELECT * FROM kanban_cards WHERE archived_at IS NULL AND status = 'waiting'")
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

export async function countNewHotMemories(agentId: string): Promise<number> {
  const row = await dbx.get<{ n: number }>(HEARTBEAT_NEW_HOT_MEMORIES_SQL, agentId)
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
  // Optional, self-declared attributability tag (e.g. a
  // sub-agent's own task/branch name) -- NOT an authentication mechanism,
  // see the table-creation comment. Null for every caller that doesn't pass one.
  origin_note: string | null
  // Distributed trace context (message-router middleware).
  trace_id: string | null
  span_id: string | null
  parent_span_id: string | null
  tenant_id: string | null
  // Set alongside status='failed' when the executor
  // explicitly declined the task, rather than a delivery/execution error.
  refused_reason: string | null
  // First time the router found the target session
  // absent for this (still-pending) row. Not a status change.
  no_session_at: number | null
  // Free-form JSON text a delegator can attach to an assign:true
  // message to carry config/context the recipient needs to actually pick the
  // task up (no fixed schema enforced yet). Null for every caller that
  // doesn't pass one -- see the assign:true-without-envelope warn in
  // tryHandleMessages.
  envelope: string | null
}

export async function createAgentMessage(
  from: string,
  to: string,
  content: string,
  originNote?: string | null,
  traceCtx?: { trace_id: string; span_id: string; parent_span_id: string | null } | null,
  tenantId: string = 'default',
  envelope?: string | null,
  // true = `tenantId` is final, even when it is 'default': a reply that belongs to an existing message
  // (the [Eredmény] notice) must not pick up whatever tenant the executor happens to be serving now.
  pinTenant: boolean = false,
): Promise<AgentMessage> {
  // The one choke point of the JS writers: nobody but the server's own sender may open a line with a
  // server-only marker (the approval notices). Throws ReservedMarkerError; the HTTP routes check first
  // and answer 400, an internal caller's own try/catch logs it.
  assertNoReservedMarker(from, content)
  const now = Math.floor(Date.now() / 1000)
  // A delegation inherits the tenant of the request the sending agent is serving; an explicit non-default
  // tenant (partner sends) and messages for federated recipients are left as given.
  if (!pinTenant && tenantId === 'default' && !to.includes('/')) tenantId = await getDelegationTenant(from, now)
  const { id } = (await dbx.get('INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, origin_note, trace_id, span_id, parent_span_id, tenant_id, envelope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id', from, to, content, 'pending', now, originNote ?? null, traceCtx?.trace_id ?? null, traceCtx?.span_id ?? null, traceCtx?.parent_span_id ?? null, tenantId, envelope ?? null)) as { id: number }
  try {
    await writeAgentAuditLog({ agent_id: from, entity: 'message', action: 'create', entity_id: id, detail: { to, preview: content.slice(0, 80) } })
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
    refused_reason: null,
    no_session_at: null,
    envelope: envelope ?? null,
  }
}

export async function getPendingMessages(toAgent?: string, tenantId?: string): Promise<AgentMessage[]> {
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  if (toAgent) {
    return dbx.all<AgentMessage>(`SELECT * FROM agent_messages WHERE status = 'pending' AND to_agent = ?${tc} ORDER BY created_at ASC`, toAgent, ...tp)
  }
  return dbx.all<AgentMessage>(`SELECT * FROM agent_messages WHERE status = 'pending'${tc} ORDER BY created_at ASC`, ...tp)
}

// Status-guarded (pending only): the federation removal path bulk-fails
// pending rows CONCURRENTLY with an in-flight bridge send -- an unguarded
// UPDATE would flip such a row failed->delivered after the fact. If the row
// is no longer pending, this returns false and the caller must not record a
// result either.
export async function markMessageDelivered(id: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run("UPDATE agent_messages SET status = 'delivered', delivered_at = ? WHERE id = ? AND status = 'pending'", now, id)).changes > 0
}

// Per-agent backlog: how many messages are waiting, and how old the oldest one
// is. The queue only surfaces when somebody opens a pane and notices, which is
// how an 18-row backlog went unseen on 2026-07-27 and got mistaken for data
// loss. Age matters more than count: three messages from a minute ago is a busy
// agent working normally, one message from two hours ago is an agent that is
// never going to pick it up.
export type AgentBacklog = { agent: string; pending: number; oldestAgeSeconds: number }

export async function getPendingBacklogByAgent(): Promise<AgentBacklog[]> {
  const now = Math.floor(Date.now() / 1000)
  const rows = (await dbx.all(`SELECT to_agent AS agent, COUNT(*) AS pending, MIN(created_at) AS oldest
       FROM agent_messages
      WHERE status = 'pending'
      GROUP BY to_agent`)) as { agent: string; pending: number; oldest: number }[]
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
export async function closeMessagesWithoutDelivery(ids: number[], reason: string): Promise<number> {
  if (!ids.length) return 0
  const now = Math.floor(Date.now() / 1000)
  const note = `closed-without-delivery: ${reason}`
  return dbx.tx(async (tx) => {
    let n = 0
    for (const id of ids) {
      n += (await tx.run(
        `UPDATE agent_messages SET status = 'delivered', delivered_at = ?, result = ?
          WHERE id = ? AND status = 'pending'`,
        now, note, id,
      )).changes
    }
    return n
  })
}

// Supplementary result text WITHOUT a status change. The federation bridge
// records the peer-assigned id on delivered rows ("fed:<peer>:<remote id>")
// so a cross-system message can be traced without a schema migration.
export async function setMessageResult(id: number, result: string): Promise<boolean> {
  return (await dbx.run('UPDATE agent_messages SET result = ? WHERE id = ?', result, id)).changes > 0
}

// Bulk-fail PENDING federated (slash-qualified to_agent) messages -- the
// deterministic counterpart of the bridge's drip-fail on disable/removal.
// ONE statement (claimPendingForAgent idiom: no SELECT-then-UPDATE window).
// pending only: delivered/done/failed rows are conversation history.
// Per-peer scoping is a LIKE on '<peer>/%' with the peer id escaped, so '_' in
// a peer id is a literal ('te_dor' does not purge 'teodor'). lower() on both
// sides: system ids are case-insensitive, and rows written before the
// lowercase normalization may carry an uppercase prefix that must still be
// purged with its peer (ASCII-only lower() is fine -- the id charset is
// [a-zA-Z0-9_-]).
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => '\\' + c)
}

export async function failPendingFederatedMessages(peerId: string | undefined, reason: string): Promise<number[]> {
  const now = Math.floor(Date.now() / 1000)
  const rows = peerId === undefined
    ? (await dbx.all(`UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ?
           WHERE status = 'pending' AND to_agent LIKE '%/%'
         RETURNING id`, reason, now)) as Array<{ id: number }>
    : (await dbx.all(`UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ?
           WHERE status = 'pending' AND lower(to_agent) LIKE ? ESCAPE '\\'
         RETURNING id`, reason, now, escapeLike(peerId.toLowerCase()) + '/%')) as Array<{ id: number }>
  return rows.map((r) => r.id)
}

// Atomically CLAIM (pending -> delivered) the oldest `limit` pending messages
// for an agent, returning the claimed rows. A SINGLE `UPDATE ... WHERE
// status='pending' RETURNING` (NOT a SELECT-then-UPDATE) so two concurrent
// drains can never double-claim the same message (-> no ghost double-delivery).
// Backs the main-agent inbox PULL model: the main agent drains its own inbox at
// each turn (via the drain-inbox endpoint + UserPromptSubmit hook) instead of
// the router tmux-injecting into its perpetually-busy channel session.
export async function claimPendingForAgent(toAgent: string, limit: number): Promise<AgentMessage[]> {
  const now = Math.floor(Date.now() / 1000)
  const rows = await dbx.all<AgentMessage>(`UPDATE agent_messages SET status = 'delivered', delivered_at = ?
       WHERE id IN (
         SELECT id FROM agent_messages
         WHERE to_agent = ? AND status = 'pending'
         ORDER BY created_at ASC, id ASC
         LIMIT ?
       )
     RETURNING id, from_agent, to_agent, content, status, result, created_at, delivered_at, completed_at`, now, toAgent, limit)
  // RETURNING row order is unspecified; restore FIFO (created_at, then id as the
  // tiebreaker for same-second inserts) for delivery.
  return rows.sort((a, b) => (a.created_at - b.created_at) || (a.id - b.id))
}

export async function markMessageDone(id: number, result?: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  // COALESCE: some done-transitions skip the delivered step entirely (e.g. a
  // still-pending row marked done directly via PUT), so backfill delivered_at
  // only when it was never set -- don't clobber a real earlier delivery time.
  return (await dbx.run("UPDATE agent_messages SET status = 'done', result = ?, completed_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?", result ?? null, now, now, id)).changes > 0
}

export async function markMessageFailed(id: number, error?: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run("UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ? WHERE id = ?", error ?? null, now, id)).changes > 0
}

// The executor's explicit "I won't do this" callback
// (PUT .../messages/:id status="refused"). Stored as status='failed' (the
// CHECK constraint is untouched) PLUS refused_reason, so a refusal reads as a
// distinct case from a delivery/execution error without a schema-breaking
// status rename or a client-side migration for every existing status='failed'
// consumer.
export async function markMessageRefused(id: number, reason?: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run("UPDATE agent_messages SET status = 'failed', refused_reason = ?, result = ?, completed_at = ? WHERE id = ?", reason ?? null, reason ?? null, now, id)).changes > 0
}

// Close a message on behalf of its executor (PUT /api/messages/:id), compare-and-set: the single UPDATE only
// matches a row that is not closed yet, so a second close (a client retry after a timeout, a late duplicate
// callback) changes nothing and returns false instead of overwriting the first outcome. 'refused' is stored
// as status='failed' + refused_reason, like markMessageRefused. The done branch backfills delivered_at the
// same way markMessageDone does (a still-pending row closed directly). The router's own transitions keep
// using the unconditional markMessage* helpers above; they are not executor callbacks.
export async function closeOpenMessage(id: number, status: 'done' | 'failed' | 'refused', result?: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const text = result ?? null
  if (status === 'done') {
    return (await dbx.run("UPDATE agent_messages SET status = 'done', result = ?, completed_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ? AND status NOT IN ('done','failed')", text, now, now, id)).changes > 0
  }
  if (status === 'failed') {
    return (await dbx.run("UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ? WHERE id = ? AND status NOT IN ('done','failed')", text, now, id)).changes > 0
  }
  return (await dbx.run("UPDATE agent_messages SET status = 'failed', refused_reason = ?, result = ?, completed_at = ? WHERE id = ? AND status NOT IN ('done','failed')", text, text, now, id)).changes > 0
}

// Stamp the FIRST time the router finds the target
// session absent for a still-pending row -- not a status change (the row can
// still be delivered the moment the session reappears). COALESCE keeps the
// earliest timestamp even if this is called again after an intervening
// present period; the caller (message-router's routerNoSessionStamped Set)
// also avoids redundant calls while a single absence streak continues.
// status='pending' guard mirrors markMessageDelivered: a row a concurrent
// path already closed must not be touched.
export async function markMessageNoSession(id: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run("UPDATE agent_messages SET no_session_at = COALESCE(no_session_at, ?) WHERE id = ? AND status = 'pending'", now, id)).changes > 0
}

// Status-guarded fail for the federation bridge's terminal branches: it must
// only fire (and only bounce a failure notice) when THIS call actually closed
// a still-pending row. The unguarded markMessageFailed above would also
// "succeed" on a row a concurrent disable/removal purge already failed
// (result/completed_at change -> changes>0), producing a spurious second
// notice. The drain-inbox path deliberately keeps the unguarded variant (it
// fails an already-delivered row).
export async function markPendingFederatedFailed(id: number, error: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  return (await dbx.run("UPDATE agent_messages SET status = 'failed', result = ?, completed_at = ? WHERE id = ? AND status = 'pending'", error, now, id)).changes > 0
}

export async function listAgentMessages(limit = 50, tenantId?: string): Promise<AgentMessage[]> {
  if (tenantId) {
    return dbx.all<AgentMessage>('SELECT * FROM agent_messages WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?', tenantId, limit)
  }
  return dbx.all<AgentMessage>('SELECT * FROM agent_messages ORDER BY created_at DESC LIMIT ?', limit)
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
 *
 * Only messages that actually ask for a result count. Two kinds never get a
 * result back, so they stay 'delivered' for good and used to hold the gate
 * shut for the whole stale window (a status-report burst: 6 delivered reports
 * = a 122 minute block):
 *   - completion reports (COMPLETION_REPORT_PREFIX): the executor's own
 *     answer, nobody PUTs a result on an answer;
 *   - when `coordinatorAgentId` is given, an executor's messages TO the
 *     coordinator (status reports / replies -- work is delegated by the
 *     coordinator, never to it). The coordinator's own outbound is real
 *     delegation and still counts.
 */
export async function getDispatchedPendingStats(
  fromAgent: string,
  nowMs: number,
  staleCutoffMs: number,
  opts: { coordinatorAgentId?: string } = {},
): Promise<DispatchedPendingStats> {
  const cutoffEpoch = Math.floor((nowMs - staleCutoffMs) / 1000)
  const excludeReports = opts.coordinatorAgentId && opts.coordinatorAgentId !== fromAgent
  const awaiting = `from_agent = ? AND status IN ('pending','delivered')
         AND substr(content, 1, ${COMPLETION_REPORT_PREFIX.length}) <> ?${excludeReports ? ' AND to_agent <> ?' : ''}`
  const args = excludeReports
    ? [fromAgent, COMPLETION_REPORT_PREFIX, opts.coordinatorAgentId]
    : [fromAgent, COMPLETION_REPORT_PREFIX]
  const liveRow = (await dbx.get(`SELECT COUNT(*) AS cnt FROM agent_messages
       WHERE ${awaiting}
         AND CAST(created_at AS INTEGER) > ?`, ...args, cutoffEpoch)) as { cnt: number }
  const staleRow = (await dbx.get(`SELECT COUNT(*) AS cnt FROM agent_messages
       WHERE ${awaiting}
         AND CAST(created_at AS INTEGER) <= ?`, ...args, cutoffEpoch)) as { cnt: number }
  return {
    count:    liveRow?.cnt ?? 0,
    hasStale: (staleRow?.cnt ?? 0) > 0,
  }
}

/**
 * True when the agent's last inbound channel message has no later outbound
 * (unanswered question). Used by the context-restart gate.
 *
 * Agent-level and text-free on purpose: it reports a boolean for the agent as a whole, so for an
 * agent shared by several tenants an unanswered question of ANY tenant counts. The tenant filter
 * of the ledger reads (src/db/conversation-ledger.ts) guards what is shown to a session, not
 * this gate.
 *
 * With `opts`, an inbound older than staleCutoffMs no longer counts (same
 * cutoff as dispatched outbound): a question nobody answered for hours is
 * abandoned, not live work. Without it the ledger is the only clock, and an
 * agent whose channel logging stopped (last row months old) reads "open"
 * forever -- the gate then blocked for 160+ hours.
 */
export async function hasOpenInboundQuestion(
  agentId: string,
  opts?: { nowMs: number; staleCutoffMs: number },
): Promise<boolean> {
  const row = await dbx.get<{ id: number; created_at: number }>(`SELECT id, created_at FROM conversation_log
       WHERE agent_id = ? AND direction = 'in'
       ORDER BY created_at DESC, id DESC LIMIT 1`, agentId)
  if (!row) return false
  if (opts && row.created_at <= Math.floor((opts.nowMs - opts.staleCutoffMs) / 1000)) return false
  const laterOut = await dbx.get(`SELECT 1 FROM conversation_log
       WHERE agent_id = ? AND direction = 'out'
         AND (created_at > ? OR (created_at = ? AND id > ?))
       LIMIT 1`, agentId, row.created_at, row.created_at, row.id)
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
export async function getAgentConversation(agent: string, limit = 50, beforeId?: number, tenantId?: string): Promise<AgentMessage[]> {
  const cap = Math.min(Math.max(1, Math.floor(limit) || 1), AGENT_MESSAGE_LIMIT_CAP)
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  if (beforeId !== undefined && Number.isFinite(beforeId)) {
    return dbx.all<AgentMessage>(`SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) AND id < ?${tc} ORDER BY created_at DESC, id DESC LIMIT ?`, agent, agent, beforeId, ...tp, cap)
  }
  return dbx.all<AgentMessage>(`SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?)${tc} ORDER BY created_at DESC, id DESC LIMIT ?`, agent, agent, ...tp, cap)
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
export async function getAgentConversationThreads(tenantId?: string): Promise<AgentThread[]> {
  const tc = tenantId ? ' WHERE tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  const countTc = tenantId ? ' AND m.tenant_id = ?' : ''
  const parties = await dbx.all<{ agent: string; count: number }>(`
    WITH parties AS (
      SELECT from_agent AS agent FROM agent_messages${tc}
      UNION
      SELECT to_agent AS agent FROM agent_messages${tc}
    )
    SELECT p.agent AS agent,
      (SELECT COUNT(*) FROM agent_messages m WHERE (m.from_agent = p.agent OR m.to_agent = p.agent)${countTc}) AS count
    FROM parties p
  `, ...tp, ...tp, ...tp)

  const lastSql = tenantId
    ? 'SELECT * FROM agent_messages WHERE (from_agent = ? OR to_agent = ?) AND tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
    : 'SELECT * FROM agent_messages WHERE from_agent = ? OR to_agent = ? ORDER BY created_at DESC, id DESC LIMIT 1'

  const system = new Set<string>(CHAT_SYSTEM_AGENTS)
  const threads: AgentThread[] = []
  for (const p of parties) {
    if (!p.agent || system.has(p.agent)) continue
    const lastMessage = (tenantId
      ? await dbx.get<AgentMessage>(lastSql, p.agent, p.agent, tenantId)
      : await dbx.get<AgentMessage>(lastSql, p.agent, p.agent)) ?? null
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
  blocked_by: string | null
  blocked_reason: string | null
  resolved_by: string | null
}

export async function insertBlackboardHistory(entry: {
  agent_id: string
  task_ref: string | null
  status: string
  summary: string
  blocked_by?: string | null
  blocked_reason?: string | null
  resolved_by?: string | null
}, ops: SqlOps = dbx): Promise<void> {
  await ops.run('INSERT INTO fleet_blackboard_history (agent_id, task_ref, status, summary, tenant_id, blocked_by, blocked_reason, resolved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', entry.agent_id, entry.task_ref, entry.status, entry.summary, await resolveAgentTenant(entry.agent_id, ops),
    entry.blocked_by ?? null, entry.blocked_reason ?? null, entry.resolved_by ?? null,
  )
}

export async function listBlackboardHistory(opts: {
  agent_id?: string
  since?: number
  limit?: number
  tenantId?: string | null
} = {}): Promise<BlackboardHistoryRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200)
  const parts: string[] = []
  const params: (string | number)[] = []
  if (opts.agent_id) { parts.push('agent_id = ?'); params.push(opts.agent_id) }
  if (opts.since !== undefined) { parts.push('created_at >= ?'); params.push(opts.since) }
  if (opts.tenantId) { parts.push('tenant_id = ?'); params.push(opts.tenantId) }
  const where = parts.length ? 'WHERE ' + parts.join(' AND ') : ''
  params.push(limit)
  return dbx.all<BlackboardHistoryRow>(`SELECT id, agent_id, task_ref, status, summary, created_at, tenant_id, blocked_by, blocked_reason, resolved_by
     FROM fleet_blackboard_history ${where}
     ORDER BY created_at DESC LIMIT ?`, ...params)
}

export async function pruneBlackboardHistory(ttlDays = 30): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 86400
  return (await dbx.run('DELETE FROM fleet_blackboard_history WHERE created_at < ?', cutoff)).changes
}

// Both conversation_log (raw in/out Telegram/channel message log) and
// agent_messages (the inter-agent queue, including already-delivered/done/
// failed rows) had no automatic sweep -- unlike fleet_blackboard_history
// above they grew unbounded. Both use the shared MESSAGE_LOG_RETENTION_DAYS
// setting (default 90 days) since they are the two halves of the same
// "raw message history" concern; a message still 'pending' past the window
// is treated the same as a delivered one, matching every other prune
// function's age-only cutoff (no status carve-out).
export async function pruneConversationLog(): Promise<number> {
  const retentionDays = Number(getEffectiveSettingValue('MESSAGE_LOG_RETENTION_DAYS'))
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400
  return (await dbx.run('DELETE FROM conversation_log WHERE created_at < ?', cutoff)).changes
}

export async function pruneAgentMessages(): Promise<number> {
  const retentionDays = Number(getEffectiveSettingValue('MESSAGE_LOG_RETENTION_DAYS'))
  const cutoff = Math.floor(Date.now() / 1000) - retentionDays * 86400
  return (await dbx.run('DELETE FROM agent_messages WHERE created_at < ?', cutoff)).changes
}

// Mark fleet_blackboard 'active'/'assigned' rows as 'stale' when they have
// not been updated for longer than the applicable threshold. 'active' rows
// use the per-agent tier threshold (thresholdsByAgent/defaultThresholdSec);
// 'assigned' rows (delegated but never picked up) use the flat
// assignedThresholdSec instead, since a not-yet-started task has no tier of
// its own. 'active' rows of the agents in skipActiveAgentIds are left alone
// (their scheduled run is still in flight and the runner closes the row).
// Returns how many rows were marked. Called by the blackboard-stale-sweeper on
// a background interval.
export async function markBlackboardStale(
  thresholdsByAgent: Record<string, number>,
  defaultThresholdSec: number,
  assignedThresholdSec: number,
  nowSec = Math.floor(Date.now() / 1000),
  skipActiveAgentIds: ReadonlySet<string> = new Set(),
): Promise<number> {
  const rows = (await dbx.all(`SELECT id, agent_id, task_ref, summary, updated_at, status FROM fleet_blackboard WHERE status IN ('active', 'assigned')`)) as { id: string; agent_id: string; task_ref: string | null; summary: string; updated_at: number; status: string }[]
  let marked = 0
  for (const row of rows) {
    // An agent whose scheduled run is still in flight owns its active row: the
    // runner closes it. (An 'assigned' row is not started work, so it is not exempt.)
    if (row.status === 'active' && skipActiveAgentIds.has(row.agent_id)) continue
    const threshold = row.status === 'assigned' ? assignedThresholdSec : (thresholdsByAgent[row.agent_id] ?? defaultThresholdSec)
    if (nowSec - row.updated_at > threshold) {
      // Compare-and-set on the row as it was read: an agent that posted (or closed its row) since the SELECT
      // keeps its post, the sweep neither overwrites it nor records a stale entry or drops the plan binding.
      const res = await dbx.run(`UPDATE fleet_blackboard SET status = 'stale', updated_at = ? WHERE id = ? AND status = ? AND updated_at = ?`, nowSec, row.id, row.status, row.updated_at)
      if (res.changes === 0) continue
      await insertBlackboardHistory({ agent_id: row.agent_id, task_ref: row.task_ref, status: 'stale', summary: row.summary })
      // #886: a blackboard row going stale means the agent behind it is
      // presumed dead -- drop any plan binding with it (design section 3A),
      // rather than let it look "active" forever.
      try { await deactivatePlanForAgent(row.agent_id) } catch { /* best-effort, never blocks the sweep */ }
      marked++
    }
  }
  return marked
}

export async function getAgentTier(agentId: string): Promise<string> {
  const row = await dbx.get<{ tier: string }>('SELECT tier FROM agent_blackboard_tier WHERE agent_id = ?', agentId)
  return row?.tier ?? 'default'
}

export async function getActiveBlackboardAgentIds(): Promise<string[]> {
  const rows = (await dbx.all("SELECT DISTINCT agent_id FROM fleet_blackboard WHERE status IN ('active', 'assigned')")) as { agent_id: string }[]
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
  blocked_by: string | null
  blocked_reason: string | null
}

export async function findBlackboardRowByAgent(agent_id: string): Promise<BlackboardRow | undefined> {
  return dbx.get<BlackboardRow>('SELECT * FROM fleet_blackboard WHERE agent_id = ?', agent_id)
}

// Resolve which tenant a blackboard row for agent_id belongs to, derived from
// tenant_agent_availability (deny-by-default opt-in matrix -- only enabled=1
// rows count as a real assignment; a disabled row means the agent is NOT
// available to that tenant, see 0026_tenant_agent_availability.sql).
//   0 enabled rows -> fleet agent, 'default'
//   1 enabled row  -> that tenant
//   2+ enabled rows -> '_multi_' sentinel: never matches a real ctx.tenantId,
//     so the row is admin-only visible (see tryHandleBlackboard tenant filter).
export async function resolveAgentTenant(agent_id: string, ops: SqlOps = dbx): Promise<string> {
  const rows = (await ops.all('SELECT tenant_id FROM tenant_agent_availability WHERE agent_id = ? AND enabled = 1', agent_id)) as { tenant_id: string }[]
  if (rows.length === 0) return 'default'
  if (rows.length === 1) return rows[0]!.tenant_id
  return '_multi_'
}

// Upsert a fleet blackboard row for agent_id, writing a history entry only
// when the status, summary, or task_ref actually changes.
//
// blocked_by/blocked_reason are live-state fields: they only ever end up
// non-null on the row when the resulting status is 'blocked' (falling back
// to the previous value when the caller doesn't pass a new one while staying
// blocked), and are force-cleared to null the moment status moves away from
// 'blocked' -- a done/active row has no live block to describe. resolved_by
// is never stored on the live row; it is only carried into the history
// entry, and only on the actual blocked -> non-blocked transition.
export async function upsertBlackboard(
  agent_id: string,
  data: BlackboardUpsertData,
): Promise<BlackboardRow> {
  const { row, changed } = await dbx.tx(async (tx) => writeBlackboardRow(tx, agent_id, data), { mode: 'immediate' })
  // #886: an agent reporting itself 'done' no longer has a live claim on its
  // plan binding either (design section 3A). Only on an actual transition,
  // same as the history write -- a repeated no-op 'done' upsert must
  // not matter here. After the commit: best-effort, never inside the lock.
  if (changed && row.status === 'done') {
    try { await deactivatePlanForAgent(row.agent_id) } catch { /* best-effort */ }
  }
  return row
}

interface BlackboardUpsertData {
  task_ref?: string | null
  status?: string
  summary: string
  blocked_by?: string | null
  blocked_reason?: string | null
  resolved_by?: string | null
}

// The read, the write and the history entry are ONE transaction: two overlapped first posts of the same agent
// used to read "no row", pick two ids, and the loser's `SELECT ... WHERE id = ?` found nothing. The
// transaction lock puts the second call behind the first, so it sees the first one's row and updates it.
async function writeBlackboardRow(
  tx: SqlOps,
  agent_id: string,
  data: BlackboardUpsertData,
): Promise<{ row: BlackboardRow; changed: boolean }> {
  const existing = await tx.get<BlackboardRow>('SELECT * FROM fleet_blackboard WHERE agent_id = ?', agent_id)
  const id = existing?.id ?? randomUUID().replace(/-/g, '').slice(0, 8)
  const tenant_id = await resolveAgentTenant(agent_id, tx)
  const status = data.status ?? 'active'
  const blockedBy = status === 'blocked' ? (data.blocked_by ?? existing?.blocked_by ?? null) : null
  const blockedReason = status === 'blocked' ? (data.blocked_reason ?? existing?.blocked_reason ?? null) : null
  await tx.run(`
    INSERT INTO fleet_blackboard (id, agent_id, task_ref, status, summary, updated_at, tenant_id, blocked_by, blocked_reason)
    VALUES (?, ?, ?, ?, ?, unixepoch(), ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      task_ref       = excluded.task_ref,
      status         = excluded.status,
      summary        = excluded.summary,
      updated_at     = unixepoch(),
      tenant_id      = excluded.tenant_id,
      blocked_by     = excluded.blocked_by,
      blocked_reason = excluded.blocked_reason
  `, id, agent_id, data.task_ref ?? null, status, data.summary, tenant_id, blockedBy, blockedReason)
  const row = (await tx.get('SELECT * FROM fleet_blackboard WHERE agent_id = ?', agent_id)) as BlackboardRow
  const changed = !existing ||
    existing.status !== row.status ||
    existing.summary !== row.summary ||
    (existing.task_ref ?? null) !== (row.task_ref ?? null) ||
    (existing.blocked_by ?? null) !== (row.blocked_by ?? null) ||
    (existing.blocked_reason ?? null) !== (row.blocked_reason ?? null)
  if (changed) {
    const resolving = existing?.status === 'blocked' && row.status !== 'blocked'
    await insertBlackboardHistory({
      agent_id: row.agent_id, task_ref: row.task_ref, status: row.status, summary: row.summary,
      blocked_by: row.blocked_by, blocked_reason: row.blocked_reason,
      resolved_by: resolving ? (data.resolved_by ?? null) : null,
    }, tx)
  }
  return { row, changed }
}

// ── Tenant-agent availability (deny-by-default opt-in matrix) ─────────────────

export interface TenantAgentAvailability {
  tenant_id: string
  agent_id: string
  enabled: 0 | 1
  updated_at: number
}

/** List all availability rows for a tenant (enabled + disabled). */
export async function listTenantAgentAvailability(tenantId: string): Promise<TenantAgentAvailability[]> {
  return dbx.all<TenantAgentAvailability>('SELECT tenant_id, agent_id, enabled, updated_at FROM tenant_agent_availability WHERE tenant_id = ? ORDER BY agent_id', tenantId)
}

/** Upsert a (tenant, agent) availability row. Returns the new row. */
export async function setTenantAgentAvailability(tenantId: string, agentId: string, enabled: boolean): Promise<TenantAgentAvailability> {
  const now = Math.floor(Date.now() / 1000)
  // The availability row and the context delete are one step: a disabled agent never keeps its use-time context.
  return dbx.tx(async (tx) => {
    await tx.run(`
      INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(tenant_id, agent_id) DO UPDATE SET
        enabled    = excluded.enabled,
        updated_at = excluded.updated_at
    `, tenantId, agentId, enabled ? 1 : 0, now)
    // Disabling the agent for the tenant ends its use-time context for that tenant at once (the skill gate
    // fails closed until the agent's next prompt re-resolves the source).
    if (!enabled) await tx.run('DELETE FROM agent_tenant_context WHERE agent_id = ? AND tenant_id = ?', agentId, tenantId)
    return (await tx.get('SELECT tenant_id, agent_id, enabled, updated_at FROM tenant_agent_availability WHERE tenant_id = ? AND agent_id = ?', tenantId, agentId)) as TenantAgentAvailability
  })
}

/** Check if an agent is explicitly enabled for a tenant. */
export async function isTenantAgentEnabled(tenantId: string, agentId: string): Promise<boolean> {
  const row = await dbx.get<{ enabled: number }>('SELECT enabled FROM tenant_agent_availability WHERE tenant_id = ? AND agent_id = ?', tenantId, agentId)
  return row?.enabled === 1
}

/** List agent_ids explicitly enabled=1 for a tenant (deny-by-default: agents
 *  with no row, or enabled=0, are not returned). */
export async function getEnabledAgentsForTenant(tenantId: string): Promise<string[]> {
  const rows = (await dbx.all('SELECT agent_id FROM tenant_agent_availability WHERE tenant_id = ? AND enabled = 1', tenantId)) as { agent_id: string }[]
  return rows.map(r => r.agent_id)
}

/** List tenant_ids this agent is enabled=1 for -- the inverse of
 *  getEnabledAgentsForTenant, used for the Agents screen's per-tenant
 *  visibility chips. An agent with no rows at all (e.g. a fleet-internal
 *  agent never opted into any tenant) returns an empty array. */
export async function getTenantsForAgent(agentId: string): Promise<string[]> {
  const rows = (await dbx.all('SELECT tenant_id FROM tenant_agent_availability WHERE agent_id = ? AND enabled = 1', agentId)) as { tenant_id: string }[]
  return rows.map(r => r.tenant_id)
}

/** Resolves the single tenant that "owns" an agent for RBAC purposes
 *  (agent_settings, group 3/#985): the tenant this agent coordinates
 *  (getTenantForMainAgent) if any, else the first tenant it is enabled for
 *  (getTenantsForAgent), else 'default' for a fleet-internal agent with no
 *  tenant association at all. Used by the agent_settings one-time file
 *  importer (db/index.ts) to stamp a tenant_id on rows carried over from the
 *  pre-tenant JSON side-cars -- same source of truth as agentBelongsToTenant
 *  below, so an imported row's tenant_id always matches what the write-check
 *  itself would compute for that agent. */
export async function resolveAgentOwningTenantId(agentId: string): Promise<string> {
  const primary = await getTenantForMainAgent(agentId)
  if (primary) return primary.id
  return (await getTenantsForAgent(agentId))[0] ?? 'default'
}

/** Boot-only twin of resolveAgentOwningTenantId for the one-time agent_settings file import (db/index.ts), which
 *  runs before initDatabase returns and cannot await. Same two lookups on the raw handle, in the same order, so an
 *  imported row is stamped with the tenant the asynchronous resolver would pick -- keep the two in step. */
// @boot-sync-twin
export function resolveAgentOwningTenantIdSync(agentId: string): string {
  const main = db.prepare('SELECT id FROM tenants WHERE main_agent_id = ? AND disabled_at IS NULL').get(agentId) as { id: string } | undefined
  if (main) return main.id
  const row = db.prepare('SELECT tenant_id FROM tenant_agent_availability WHERE agent_id = ? AND enabled = 1').get(agentId) as { tenant_id: string } | undefined
  return row?.tenant_id ?? 'default'
}

/** Whether `tenantId` may manage (read/write) agentId's per-agent settings
 *  (agent_settings, group 3/#985) -- true if it is the agent's coordinated
 *  tenant OR one of the tenants the agent is enabled for. Unlike
 *  resolveAgentOwningTenantId (single tenant, used to stamp a new row), an
 *  agent can be enabled for more than one tenant, and any of them may
 *  manage it -- admin bypasses this check entirely (see agents-process.ts). */
export async function agentBelongsToTenant(agentId: string, tenantId: string): Promise<boolean> {
  return (await getServedTenantIds(agentId)).includes(tenantId)
}

/** Every tenant the agent serves: the tenant it coordinates as main agent (getTenantForMainAgent)
 *  plus the tenants it is enabled for (getTenantsForAgent), each once. The one definition behind
 *  agentBelongsToTenant and the "shared agent" rule of the conversation ledger (an agent serving
 *  two or more tenants), so a coordinator that is also enabled for a second tenant counts as
 *  shared everywhere. */
export async function getServedTenantIds(agentId: string): Promise<string[]> {
  const primary = await getTenantForMainAgent(agentId)
  const ids = await getTenantsForAgent(agentId)
  return primary && !ids.includes(primary.id) ? [primary.id, ...ids] : ids
}

// Schedules (SQL-backed, replaces file-based scheduled-tasks-io)

// ── Blackboard reads/updates used by routes/blackboard.ts ────────────

/** Newest rows first; tenantId null = unfiltered (admin), a string narrows to that tenant. */
export async function listBlackboardRows(limit: number, tenantId: string | null = null): Promise<BlackboardRow[]> {
  return tenantId !== null
    ? await dbx.all<BlackboardRow>('SELECT * FROM fleet_blackboard WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?', tenantId, limit)
    : await dbx.all<BlackboardRow>('SELECT * FROM fleet_blackboard ORDER BY updated_at DESC LIMIT ?', limit)
}

export async function getBlackboardRowById(id: string): Promise<BlackboardRow | undefined> {
  return dbx.get<BlackboardRow>('SELECT * FROM fleet_blackboard WHERE id = ?', id)
}

export async function blackboardRowExistsForAgent(agentId: string): Promise<boolean> {
  return !!await dbx.get('SELECT 1 FROM fleet_blackboard WHERE agent_id = ?', agentId)
}

/** Latest outbound inter-agent message per sender, for the given agents, after `sinceSec`. */
export async function getLastOutboundMessageTimes(agentIds: string[], sinceSec: number): Promise<{ agent_id: string; last_msg_at: number }[]> {
  const placeholders = agentIds.map(() => '?').join(',')
  return (await dbx.all(`SELECT from_agent AS agent_id, MAX(created_at) AS last_msg_at
         FROM agent_messages
        WHERE from_agent IN (${placeholders})
          AND created_at > ?
        GROUP BY from_agent`, ...agentIds, sinceSec)) as { agent_id: string; last_msg_at: number }[]
}

/** Latest recorded state change per agent, from the history table. */
export async function getLastBlackboardChangeTimes(agentIds: string[]): Promise<{ agent_id: string; last_changed_at: number }[]> {
  const placeholders = agentIds.map(() => '?').join(',')
  return (await dbx.all(`SELECT agent_id, MAX(created_at) AS last_changed_at
         FROM fleet_blackboard_history
        WHERE agent_id IN (${placeholders})
        GROUP BY agent_id`, ...agentIds)) as { agent_id: string; last_changed_at: number }[]
}

export async function updateBlackboardRowById(
  id: string,
  fields: { status: string; summary: string; task_ref: string | null | undefined; blocked_by: string | null; blocked_reason: string | null },
): Promise<void> {
  await dbx.run(`
    UPDATE fleet_blackboard SET status = ?, summary = ?, task_ref = ?, blocked_by = ?, blocked_reason = ?, updated_at = unixepoch() WHERE id = ?
  `, fields.status, fields.summary, fields.task_ref, fields.blocked_by, fields.blocked_reason, id)
}
