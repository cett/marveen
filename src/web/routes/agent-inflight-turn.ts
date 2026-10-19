import {
  INFLIGHT_HEAD_MAX,
  beginInflightTurn,
  consumeInflightTurn,
  endInflightTurn,
  inflightReplay,
} from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import { denyForeignAgent } from '../fleet-agent-identity.js'
import { isRegisteredLedgerAgent } from './conversation-ledger.js'
import type { RouteContext } from './types.js'

// /api/agent-inflight-turn - the "turn in flight" journal behind the interrupted-turn hooks (5aa63510 W3).
//  POST /api/agent-inflight-turn/:agent/begin    <- UserPromptSubmit hook: {prompt_head, prompt_hash}
//  POST /api/agent-inflight-turn/:agent/end      <- Stop hook: the turn finished, drop the row
//  GET  /api/agent-inflight-turn/:agent/replay   <- SessionStart hook: ?source=startup|resume|clear, does NOT consume
//  POST /api/agent-inflight-turn/:agent/consume  <- SessionStart hook, AFTER it printed: {turn_id}
// RBAC: agent-state:read/write (admin and fleet_agent). The agent in the path is the caller's claim: a
// fleet_agent token may only name itself (403 otherwise, nothing read or written), the admin tokens any
// registered agent. The hooks are thin clients; the decision and the text live in db/agent-inflight-turns.ts.

const AGENT_ID_RE = /^[^\x00-\x1f/\\]{1,128}$/
const HASH_RE = /^[0-9a-f]{8,64}$/
const TURN_ID_RE = /^[0-9a-f]{16}$/

function bad(ctx: RouteContext, field: string, hint: string): true {
  json(ctx.res, { error: 'invalid_value', field, hint }, 400)
  return true
}

export async function tryHandleAgentInflightTurn(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx
  const match = path.match(/^\/api\/agent-inflight-turn\/([^/]+)\/(begin|end|replay|consume)$/)
  if (!match) return false
  const action = match[2]!
  if ((action === 'replay') !== (method === 'GET') || (action !== 'replay' && method !== 'POST')) return false

  let agentId: string
  try {
    agentId = decodeURIComponent(match[1]!)
  } catch {
    return bad(ctx, 'agent', 'Malformed percent-encoding in path')
  }
  if (!AGENT_ID_RE.test(agentId)) return bad(ctx, 'agent', 'agent must be a plain agent name')
  // Before the registered-agent check, so a foreign id is a 403 whether or not that agent exists.
  if (denyForeignAgent(ctx, agentId)) return true
  if (!isRegisteredLedgerAgent(agentId)) return bad(ctx, 'agent', 'agent is not a registered agent')

  if (action === 'replay') {
    json(res, inflightReplay(agentId, url.searchParams.get('source') ?? ''))
    return true
  }

  if (action === 'end') {
    json(res, { ok: true, removed: endInflightTurn(agentId) })
    return true
  }

  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse((await readBody(req)).toString())
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    data = parsed as Record<string, unknown>
  } catch {
    json(res, { error: 'parse_error', hint: 'Body must be a JSON object' }, 400)
    return true
  }

  if (action === 'consume') {
    const turnId = data['turn_id']
    if (typeof turnId !== 'string' || !TURN_ID_RE.test(turnId)) return bad(ctx, 'turn_id', 'turn_id must be the 16 hex characters replay returned')
    json(res, { ok: true, consumed: consumeInflightTurn(agentId, turnId) })
    return true
  }

  // begin
  const head = data['prompt_head']
  const hash = data['prompt_hash']
  if (typeof head !== 'string') return bad(ctx, 'prompt_head', 'prompt_head must be a string')
  if (head.length > INFLIGHT_HEAD_MAX) return bad(ctx, 'prompt_head', `prompt_head must be at most ${INFLIGHT_HEAD_MAX} characters`)
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) return bad(ctx, 'prompt_hash', 'prompt_hash must be 8-64 lowercase hex characters')
  const turn = beginInflightTurn(agentId, { head, prompt_hash: hash })
  json(res, { ok: true, turn_id: turn.turn_id, source: turn.source, msg_id: turn.msg_id })
  return true
}
