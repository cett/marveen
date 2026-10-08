// Read/write access to conversation_log, the per-agent transcript of channel
// turns that the ledger hooks (scripts/hooks/ledger-*.py) keep. The hooks used
// to open the database file themselves; they now go through
// /api/conversation-ledger, which calls these helpers.

import { db } from './connection.js'
import { getChannelBindingTenant, getServingTenant } from './tenant-channel-bindings.js'

export type LedgerDirection = 'in' | 'out'

/** Channel the ledger hooks see: they only run on Telegram turns. */
export const LEDGER_CHANNEL = 'telegram'

/** A shared agent serves two or more tenants (enabled tenant_agent_availability rows). */
export function isSharedLedgerAgent(agentId: string): boolean {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM tenant_agent_availability WHERE agent_id = ? AND enabled = 1')
    .get(agentId) as { n: number }
  return row.n >= 2
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
export function logLedgerTurn(turn: LedgerTurnInput): boolean {
  const createdAt = turn.created_at ?? Math.floor(Date.now() / 1000)
  const ts = turn.ts ?? (turn.direction === 'out' ? new Date(createdAt * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : null)
  // The tenant comes from the chat's channel binding, resolved here and not taken from the caller
  // or from agent_tenant_context: the capture hook and the tenant-context hook both run on
  // UserPromptSubmit in no guaranteed order, so the context row may still hold the PREVIOUS prompt's
  // tenant. An unbound chat is NULL (unknown), not 'default'.
  const tenantId = getChannelBindingTenant(turn.agent_id, LEDGER_CHANNEL, turn.chat_id)
  const info = db.prepare(
    `INSERT INTO conversation_log
       (agent_id, chat_id, direction, message_id, text, ts, created_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(turn.agent_id, turn.chat_id, turn.direction, turn.message_id ?? null, turn.text ?? null, ts, createdAt, tenantId)
  return info.changes > 0
}

/** The last `limit` turns for the agent, oldest-first. */
export function recentLedgerTurns(agentId: string, limit = LEDGER_RECENT_DEFAULT): LedgerTurn[] {
  // Replay runs at SessionStart, when no prompt has set a tenant context yet. A shared agent would
  // hand one tenant's turns to a session that may serve the other, so it gets nothing.
  if (isSharedLedgerAgent(agentId)) return []
  const rows = db.prepare(
    `SELECT direction, chat_id, text, ts FROM conversation_log
       WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(agentId, limit) as LedgerTurn[]
  return rows.reverse()
}

/**
 * The most recent inbound with no later outbound, or null.
 *
 * A shared agent answers only from the rows of the tenant it is serving right now (a fresh
 * agent_tenant_context): without a context, or with a stale/unknown one, there is no answer rather
 * than a guess across tenants. Rows of other tenants (and unresolved NULL rows) are invisible to it.
 */
export function openLedgerQuestion(agentId: string): LedgerOpenQuestion | null {
  let tenantFilter = ''
  const params: (string | number)[] = [agentId]
  if (isSharedLedgerAgent(agentId)) {
    const tenant = getServingTenant(agentId)
    if (tenant === null) return null
    tenantFilter = ' AND tenant_id = ?'
    params.push(tenant)
  }
  const row = db.prepare(
    `SELECT chat_id, message_id, text, ts, created_at, id FROM conversation_log
       WHERE agent_id = ? AND direction = 'in'${tenantFilter}
       ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(...params) as (LedgerOpenQuestion & { id: number }) | undefined
  if (!row) return null
  const laterOut = db.prepare(
    `SELECT 1 FROM conversation_log
       WHERE agent_id = ? AND direction = 'out'${tenantFilter}
         AND (created_at > ? OR (created_at = ? AND id > ?))
       LIMIT 1`,
  ).get(...params, row.created_at, row.created_at, row.id)
  if (laterOut) return null
  const { id: _id, ...question } = row
  return question
}
