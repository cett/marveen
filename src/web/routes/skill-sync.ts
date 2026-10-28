import { MAX_SKILL_FILE_BYTES } from '../../skill-files.js'
import { syncCompanionFile, syncSkillContent, syncTenantSkill, type SkillSyncResult } from '../../skill-sync.js'
import { RequestBodyTooLargeError, readBody, json } from '../http-helpers.js'
import { recordFleetSkillWriteDenied } from '../token-shadow.js'
import type { RouteContext } from './types.js'

// POST /api/skill-sync - the write-back half of scripts/hooks/skill-sql-sync.py
// (see src/skill-sync.ts). The hook runs in an agent's session and sends the agent's OWN token, so the
// endpoint is reachable with skills:write (admin and fleet_agent). A fleet_agent token gets the same
// narrowing as PUT /api/skills/sql/:id: it writes back only the skills of its own agent
// ("agent/<token agent>/<name>", SKILL.md or a companion file). A global skill, another agent's skill
// and a tenant-level skill (a generated tenant copy, a tenant companion) are other agents' input, so
// those stay admin work and answer 403.
//   {kind:'skill',     skill_id, content}
//   {kind:'tenant',    header_id, agent_id, dir_name, content}
//   {kind:'companion', skill_id, rel_path, content_base64, mode?, tenant_agent?}

type Body = Record<string, unknown>

function text(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** True for "agent/<agentId>/<name>" with exactly three plain segments. */
function isOwnAgentSkillId(skillId: string, agentId: string | undefined): boolean {
  if (!agentId) return false
  const parts = skillId.split('/')
  return parts.length === 3 && parts[0] === 'agent' && parts[1] === agentId && parts[2] !== ''
}

export async function tryHandleSkillSync(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== '/api/skill-sync' || method !== 'POST') return false

  let raw: Buffer
  try {
    raw = await readBody(req, { maxBytes: Math.ceil(MAX_SKILL_FILE_BYTES * 4 / 3) + 8192 })
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) { json(res, { error: 'limit_exceeded', hint: 'Payload too large' }, 413); return true }
    throw err
  }
  let body: Body
  try {
    const data = JSON.parse(raw.toString()) as unknown
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object')
    body = data as Body
  } catch {
    json(res, { error: 'parse_error', hint: 'Body must be a JSON object' }, 400)
    return true
  }

  // A fleet_agent token writes back only the skills of its own agent (see the header comment).
  const fleetAgent = ctx.role === 'fleet_agent'
  const refuseFleet = async (skillId: string): Promise<true> => {
    await recordFleetSkillWriteDenied(req, ctx.tokenAgentId, method, path, skillId)
    json(res, { error: 'forbidden', hint: 'A fleet agent token writes back its own agent skills only (agent/<name>/<skill>)' }, 403)
    return true
  }
  const claimed = (v: unknown): string => (typeof v === 'string' ? v : '')

  const need = (field: string): true => {
    json(res, { error: 'required', field, hint: `${field} is required` }, 400)
    return true
  }
  const reply = (r: SkillSyncResult): true => {
    if (!r.ok) json(res, { error: 'invalid_value', hint: r.message }, 400)
    else json(res, r)
    return true
  }

  if (body['kind'] === 'skill') {
    if (!text(body['skill_id'])) return need('skill_id')
    if (typeof body['content'] !== 'string') return need('content')
    if (fleetAgent && !isOwnAgentSkillId(body['skill_id'], ctx.tokenAgentId)) return refuseFleet(body['skill_id'])
    return reply(await syncSkillContent(body['skill_id'], body['content']))
  }

  if (body['kind'] === 'tenant') {
    if (!text(body['header_id'])) return need('header_id')
    if (!text(body['agent_id'])) return need('agent_id')
    if (!text(body['dir_name'])) return need('dir_name')
    if (typeof body['content'] !== 'string') return need('content')
    if (fleetAgent) return refuseFleet(body['header_id'])
    return reply(await syncTenantSkill(body['header_id'], body['agent_id'], body['dir_name'], body['content']))
  }

  if (body['kind'] === 'companion') {
    if (!text(body['skill_id'])) return need('skill_id')
    if (!text(body['rel_path'])) return need('rel_path')
    const b64 = body['content_base64']
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return need('content_base64')
    const mode = body['mode']
    if (mode !== undefined && (typeof mode !== 'number' || !Number.isInteger(mode))) {
      json(res, { error: 'invalid_value', field: 'mode', hint: 'mode must be an integer (permission bits)' }, 400)
      return true
    }
    const agent = body['tenant_agent']
    if (agent !== undefined && agent !== null && !text(agent)) {
      json(res, { error: 'invalid_value', field: 'tenant_agent', hint: 'tenant_agent must be a string when given' }, 400)
      return true
    }
    if (fleetAgent && (!isOwnAgentSkillId(body['skill_id'], ctx.tokenAgentId) || (agent !== undefined && agent !== null))) {
      return refuseFleet(claimed(body['skill_id']))
    }
    return reply(await syncCompanionFile(body['skill_id'], body['rel_path'], Buffer.from(b64, 'base64'), mode as number | undefined, (agent as string | null | undefined) ?? null))
  }

  json(res, { error: 'invalid_value', field: 'kind', hint: "kind must be 'skill', 'tenant' or 'companion'" }, 400)
  return true
}
