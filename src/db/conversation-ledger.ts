// Read/write access to conversation_log, the per-agent transcript of channel
// turns that the ledger hooks (scripts/hooks/ledger-*.py) keep. The hooks used
// to open the database file themselves; they now go through
// /api/conversation-ledger, which calls these helpers.

import { dbx } from './facade.js'
import { runAs, D2_JOBS } from './context.js'
import { getServedTenantIds } from './agents.js'
import { getChannelBindingTenant, getServingTenant } from './tenant-channel-bindings.js'

export type LedgerDirection = 'in' | 'out'

/** Channel the ledger hooks see: they only run on Telegram turns. */
export const LEDGER_CHANNEL = 'telegram'

/** A shared agent serves two or more tenants: the one it coordinates as main agent plus the ones
 *  it is enabled for (getServedTenantIds, the same set agentBelongsToTenant uses). Counting only
 *  the availability rows missed a coordinator enabled for one more tenant. */
export async function isSharedLedgerAgent(agentId: string): Promise<boolean> {
  return (await getServedTenantIds(agentId)).length >= 2
}

export interface LedgerTurnInput {
  agent_id: string
  chat_id: string
  direction: LedgerDirection
  message_id?: string | null
  text?: string | null
  ts?: string | null
  /** Unix seconds. Defaults to now; a spooled entry carries its original time. */
  created_at?: number
}

export interface LedgerTurn {
  direction: LedgerDirection
  chat_id: string
  text: string | null
  ts: string | null
}

export interface LedgerOpenQuestion {
  chat_id: string
  message_id: string | null
  text: string | null
  ts: string | null
  created_at: number
}

export const LEDGER_RECENT_DEFAULT = 20
export const LEDGER_RECENT_MAX = 200

/** Idempotent on (agent_id, chat_id, direction, message_id): a repeat of the
 *  same inbound/outbound is ignored. A NULL message_id never conflicts (NULL
 *  != NULL in SQL). Returns true when a row was inserted. */
export async function logLedgerTurn(turn: LedgerTurnInput): Promise<boolean> {
  const createdAt = turn.created_at ?? Math.floor(Date.now() / 1000)
  const ts = turn.ts ?? (turn.direction === 'out' ? new Date(createdAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null)
  // The tenant comes from the chat's channel binding, resolved here and not taken from the caller
  // or from agent_tenant_context: the capture hook and the tenant-context hook both run on
  // UserPromptSubmit in no guaranteed order, so the context row may still hold the PREVIOUS prompt's
  // tenant. An unbound chat is NULL (unknown), not 'default'.
  // The binding lookup and the INSERT run as the named ledger-write system job (context.ts): the caller is a fleet agent token in
  // ITS tenant, while the row carries the tenant of the chat (another tenant, or NULL), which the tenant policy refuses to a tenant
  // context (42501, the turn lost) and whose binding it would not even show. The tenant is derived here; nothing the caller sends
  // reaches the stamp, and the policy stays as it is.
  const info = await runAs.system(D2_JOBS.ledgerWrite, async () => {
    const tenantId = await getChannelBindingTenant(turn.agent_id, LEDGER_CHANNEL, turn.chat_id)
    return dbx.run(`INSERT INTO conversation_log
       (agent_id, chat_id, direction, message_id, text, ts, created_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`, turn.agent_id, turn.chat_id, turn.direction, turn.message_id ?? null, turn.text ?? null, ts, createdAt, tenantId)
  })
  return info.changes > 0
}

/**
 * The tenant narrowing of a NON-shared agent's ledger read, as an SQL fragment that starts with ` AND` and its parameters: rows with
 * no tenant (an unbound chat) or stamped with a tenant the agent serves. An agent that serves no tenant at all sees the unbound rows
 * only (an empty IN list is not valid SQL, and "no tenant served" must not read as "every tenant").
 * The same text on both engines: SQLite has no row-level security, so there it is the only narrowing there is.
 */
function nonSharedTenantScope(served: readonly string[]): { sql: string; params: string[] } {
  if (served.length === 0) return { sql: ' AND tenant_id IS NULL', params: [] }
  return { sql: ` AND (tenant_id IS NULL OR tenant_id IN (${served.map(() => '?').join(', ')}))`, params: [...served] }
}

/**
 * The last `limit` turns for the agent, oldest-first.
 *
 * CONTRACT: the caller has already authorised `agentId` (the route: a registered agent, the caller's own token or an admin token).
 * These functions do not authorise anything themselves: they run in the named `ledger-read` system context, so a second caller that
 * passes an agent id it has not checked reads that agent's chats. Within that, the read is bounded to the agent's own rows and,
 * for a non-shared agent, to its unbound chats and the tenants it serves (a shared agent gets nothing here).
 */
export async function recentLedgerTurns(agentId: string, limit = LEDGER_RECENT_DEFAULT): Promise<LedgerTurn[]> {
  // The whole read runs as the named ledger-read system job (context.ts): the rows of a NON-shared agent include the ones of an
  // unbound chat (NULL tenant), which the tenant policy hides from an agent context, and "is this agent shared" needs the
  // availability rows of every tenant it serves. The route has authorised the agent (registered, own token) before this call, and
  // the statement stays filtered by agent_id.
  return runAs.system(D2_JOBS.ledgerRead, async () => {
    // Replay runs at SessionStart, when no prompt has set a tenant context yet. A shared agent would
    // hand one tenant's turns to a session that may serve the other, so it gets nothing.
    const served = await getServedTenantIds(agentId)
    if (served.length >= 2) return []
    // A NON-shared agent replays its unbound chats (NULL tenant) and the rows of the tenant it serves, never a row stamped with a
    // tenant it does not serve: inside this system context the tenant policy no longer narrows the read, so the statement does.
    const scope = nonSharedTenantScope(served)
    const rows = await dbx.all<LedgerTurn>(`SELECT direction, chat_id, text, ts FROM conversation_log
       WHERE agent_id = ?${scope.sql} ORDER BY created_at DESC, id DESC LIMIT ?`, agentId, ...scope.params, limit)
    return rows.reverse()
  })
}

/**
 * The most recent inbound with no later outbound, or null.
 *
 * A shared agent answers only from the rows of the tenant it is serving right now (a fresh
 * agent_tenant_context): without a context, or with a stale/unknown one, there is no answer rather
 * than a guess across tenants. Rows of other tenants (and unresolved NULL rows) are invisible to it. A non-shared agent answers from
 * its unbound chats and the tenant it serves.
 *
 * CONTRACT: the same as `recentLedgerTurns`: the caller has authorised `agentId` before calling.
 */
export async function openLedgerQuestion(agentId: string): Promise<LedgerOpenQuestion | null> {
  // Same named read job as recentLedgerTurns; the shared-agent tenant filter below stays in the SQL, so the context lifts the
  // policy only, it never widens what a shared agent is answered from.
  return runAs.system(D2_JOBS.ledgerRead, () => openLedgerQuestionUnscoped(agentId))
}

async function openLedgerQuestionUnscoped(agentId: string): Promise<LedgerOpenQuestion | null> {
  let tenantFilter: string
  const params: (string | number)[] = [agentId]
  const served = await getServedTenantIds(agentId)
  if (served.length >= 2) {
    const tenant = await getServingTenant(agentId)
    if (tenant === null) return null
    tenantFilter = ' AND tenant_id = ?'
    params.push(tenant)
  } else {
    // A non-shared agent: its unbound chats and the tenant it serves, in BOTH statements below (the inbound and the later outbound),
    // so a row of a tenant it does not serve neither answers nor closes a question.
    const scope = nonSharedTenantScope(served)
    tenantFilter = scope.sql
    params.push(...scope.params)
  }
  const row = await dbx.get<(LedgerOpenQuestion & { id: number })>(`SELECT chat_id, message_id, text, ts, created_at, id FROM conversation_log
       WHERE agent_id = ? AND direction = 'in'${tenantFilter}
       ORDER BY created_at DESC, id DESC LIMIT 1`, ...params)
  if (!row) return null
  const laterOut = await dbx.get(`SELECT 1 FROM conversation_log
       WHERE agent_id = ? AND direction = 'out'${tenantFilter}
         AND (created_at > ? OR (created_at = ? AND id > ?))
       LIMIT 1`, ...params, row.created_at, row.created_at, row.id)
  if (laterOut) return null
  const { id: _id, ...question } = row
  return question
}
