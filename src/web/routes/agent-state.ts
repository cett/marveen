import { AGENT_STATE_KEYS, getAgentState, setAgentState, type AgentStateKey } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import { denyForeignAgent } from '../fleet-agent-identity.js'
import type { RouteContext } from './types.js'

// Internal read/write of per-agent runtime state (agent_state table), for the
// scheduled scripts that used to open the database file themselves
// (blackboard-hygiene.py, the kanban-audit pre-check). The key set is closed:
// a typo or an unrelated caller cannot create rows under arbitrary keys.
// RBAC: agent-state:read/write (admin and fleet_agent); a fleet_agent reaches only its own agent.

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const KEYS = new Set<string>(AGENT_STATE_KEYS)

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export async function tryHandleAgentState(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  const match = path.match(/^\/api\/agent-state\/([^/]+)\/([^/]+)$/)
  if (!match || (method !== 'GET' && method !== 'PUT')) return false

  const agentId = decodeURIComponent(match[1]!)
  const key = decodeURIComponent(match[2]!)
  if (!AGENT_ID_RE.test(agentId)) {
    json(res, { error: 'invalid_value', field: 'agent_id', hint: 'agent_id must be a plain agent name' }, 400)
    return true
  }
  if (denyForeignAgent(ctx, agentId)) return true
  if (!KEYS.has(key)) {
    json(res, { error: 'invalid_value', field: 'state_key', hint: `state_key must be one of ${[...KEYS].join(', ')}` }, 400)
    return true
  }

  if (method === 'GET') {
    const row = getAgentState(agentId, key as AgentStateKey)
    if (!row) {
      json(res, { error: 'not_found', hint: 'No state stored for this agent and key' }, 404)
      return true
    }
    json(res, { agent_id: row.agent_id, state_key: row.state_key, value: parseValue(row.state_value), updated_at: row.updated_at })
    return true
  }

  const body = await readBody(req)
  let data: { value?: unknown }
  try {
    data = JSON.parse(body.toString()) as { value?: unknown }
  } catch {
    json(res, { error: 'parse_error', hint: 'Body must be a JSON object with a "value" field' }, 400)
    return true
  }
  if (data === null || typeof data !== 'object' || !('value' in data) || data.value === undefined || data.value === null) {
    json(res, { error: 'required', field: 'value', hint: 'Body must carry a non-null "value"' }, 400)
    return true
  }
  setAgentState(agentId, key as AgentStateKey, data.value)
  json(res, { ok: true })
  return true
}
