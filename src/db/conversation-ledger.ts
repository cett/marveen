// Read/write access to conversation_log, the per-agent transcript of channel
// turns that the ledger hooks (scripts/hooks/ledger-*.py) keep. The hooks used
// to open the database file themselves; they now go through
// /api/conversation-ledger, which calls these helpers.

import { db } from './connection.js'

export type LedgerDirection = 'in' | 'out'

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
  const info = db.prepare(
    `INSERT INTO conversation_log
       (agent_id, chat_id, direction, message_id, text, ts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
  ).run(turn.agent_id, turn.chat_id, turn.direction, turn.message_id ?? null, turn.text ?? null, ts, createdAt)
  return info.changes > 0
}

/** The last `limit` turns for the agent, oldest-first. */
export function recentLedgerTurns(agentId: string, limit = LEDGER_RECENT_DEFAULT): LedgerTurn[] {
  const rows = db.prepare(
    `SELECT direction, chat_id, text, ts FROM conversation_log
       WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(agentId, limit) as LedgerTurn[]
  return rows.reverse()
}

/** The most recent inbound with no later outbound, or null. */
export function openLedgerQuestion(agentId: string): LedgerOpenQuestion | null {
  const row = db.prepare(
    `SELECT chat_id, message_id, text, ts, created_at, id FROM conversation_log
       WHERE agent_id = ? AND direction = 'in'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(agentId) as (LedgerOpenQuestion & { id: number }) | undefined
  if (!row) return null
  const laterOut = db.prepare(
    `SELECT 1 FROM conversation_log
       WHERE agent_id = ? AND direction = 'out'
         AND (created_at > ? OR (created_at = ? AND id > ?))
       LIMIT 1`,
  ).get(agentId, row.created_at, row.created_at, row.id)
  if (laterOut) return null
  const { id: _id, ...question } = row
  return question
}
