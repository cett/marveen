import {
  LEDGER_RECENT_DEFAULT,
  LEDGER_RECENT_MAX,
  logLedgerTurn,
  openLedgerQuestion,
  recentLedgerTurns,
  type LedgerTurnInput,
} from '../../db.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { listAgentNames } from '../agent-config.js'
import { readBody, json } from '../http-helpers.js'
import { callerMayActAs, denyForeignAgent } from '../fleet-agent-identity.js'
import type { RouteContext } from './types.js'

// /api/conversation-ledger - the channel-turn transcript behind the ledger
// hooks (capture, outbound, replay, live-drain). The hooks are thin clients;
// reads and writes are idempotent so a retry or a spool flush is harmless.
// RBAC: ledger:read/write, held by admin and fleet_agent. The agent id in the path or in an entry is
// the caller's claim; a fleet_agent token may only claim its own (403 otherwise, nothing written),
// the admin tokens of the main agent and the operator may name any agent.

const MAX_BATCH = 500
const AGENT_ID_RE = /^[^\x00-\x1f/\\]{1,128}$/

/** Only a registered agent (the main agent or an entry of the agent list) owns a ledger. An
 *  unknown cwd used to leave junk agent ids behind (a directory name taken as an identity). */
export function isRegisteredLedgerAgent(agentId: string): boolean {
  return agentId === MAIN_AGENT_ID || listAgentNames().includes(agentId)
}

function bad(ctx: RouteContext, field: string, hint: string): true {
  json(ctx.res, { error: 'invalid_value', field, hint }, 400)
  return true
}

/** Validates one ledger entry (request body or spool line); a string is the error. */
export function parseLedgerEntry(raw: unknown): LedgerTurnInput | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'entry must be an object'
  const e = raw as Record<string, unknown>
  if (typeof e['agent_id'] !== 'string' || !AGENT_ID_RE.test(e['agent_id'])) return 'agent_id must be a plain agent name'
  if (!isRegisteredLedgerAgent(e['agent_id'])) return 'agent_id is not a registered agent'
  if (typeof e['chat_id'] !== 'string' || !e['chat_id']) return 'chat_id must be a non-empty string'
  if (e['direction'] !== 'in' && e['direction'] !== 'out') return "direction must be 'in' or 'out'"
  for (const f of ['message_id', 'text', 'ts'] as const) {
    if (e[f] !== undefined && e[f] !== null && typeof e[f] !== 'string') return `${f} must be a string when given`
  }
  const createdAt = e['created_at']
  if (createdAt !== undefined && createdAt !== null) {
    if (typeof createdAt !== 'number' || !Number.isInteger(createdAt) || createdAt < 0) return 'created_at must be unix seconds'
  }
  return {
    agent_id: e['agent_id'],
    chat_id: e['chat_id'],
    direction: e['direction'],
    message_id: (e['message_id'] as string | null | undefined) ?? null,
    text: (e['text'] as string | null | undefined) ?? null,
    ts: (e['ts'] as string | null | undefined) ?? null,
    created_at: (createdAt as number | null | undefined) ?? undefined,
  }
}

export async function tryHandleConversationLedger(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/conversation-ledger - one entry, or {entries: [...]} (a spool flush).
  if (path === '/api/conversation-ledger' && method === 'POST') {
    let data: unknown
    try {
      data = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'parse_error', hint: 'Body must be a JSON object' }, 400)
      return true
    }
    const list = data !== null && typeof data === 'object' && Array.isArray((data as { entries?: unknown }).entries)
      ? (data as { entries: unknown[] }).entries
      : [data]
    if (list.length === 0 || list.length > MAX_BATCH) return bad(ctx, 'entries', `entries must hold 1-${MAX_BATCH} items`)
    const turns: LedgerTurnInput[] = []
    for (const raw of list) {
      const turn = parseLedgerEntry(raw)
      if (typeof turn === 'string') return bad(ctx, 'entries', turn)
      turns.push(turn)
    }
    // All or nothing: one foreign entry in a batch refuses the whole batch before anything is stored.
    if (turns.some(t => !callerMayActAs(ctx, t.agent_id))) {
      json(res, { error: 'forbidden', hint: 'A fleet agent token may only act as its own agent' }, 403)
      return true
    }
    let inserted = 0
    for (const turn of turns) if (logLedgerTurn(turn)) inserted++
    json(res, { ok: true, received: turns.length, inserted })
    return true
  }

  const match = path.match(/^\/api\/conversation-ledger\/([^/]+)\/(recent|open-question)$/)
  if (!match || method !== 'GET') return false
  let agentId: string
  try {
    agentId = decodeURIComponent(match[1]!)
  } catch {
    return bad(ctx, 'agent_id', 'Malformed percent-encoding in path')
  }
  if (!AGENT_ID_RE.test(agentId)) return bad(ctx, 'agent_id', 'agent_id must be a plain agent name')
  // Before the registered-agent check, so a foreign id is a 403 whether or not that agent exists.
  if (denyForeignAgent(ctx, agentId)) return true
  if (!isRegisteredLedgerAgent(agentId)) return bad(ctx, 'agent_id', 'agent_id is not a registered agent')

  if (match[2] === 'recent') {
    const raw = url.searchParams.get('limit')
    const limit = raw === null ? LEDGER_RECENT_DEFAULT : Number(raw)
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_RECENT_MAX) {
      return bad(ctx, 'limit', `limit must be an integer between 1 and ${LEDGER_RECENT_MAX}`)
    }
    json(res, { turns: recentLedgerTurns(agentId, limit) })
    return true
  }

  json(res, { open_question: openLedgerQuestion(agentId) })
  return true
}
