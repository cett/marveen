import { MAX_SKILL_FILE_BYTES } from '../../skill-files.js'
import { syncCompanionFile, syncSkillContent, syncTenantSkill, type SkillSyncResult } from '../../skill-sync.js'
import { RequestBodyTooLargeError, readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// POST /api/skill-sync - the write-back half of scripts/hooks/skill-sql-sync.py
// (see src/skill-sync.ts). Not in the RBAC table, so admin-only.
//   {kind:'skill',     skill_id, content}
//   {kind:'tenant',    header_id, agent_id, dir_name, content}
//   {kind:'companion', skill_id, rel_path, content_base64, mode?, tenant_agent?}

type Body = Record<string, unknown>

function text(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
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
    return reply(syncSkillContent(body['skill_id'], body['content']))
  }

  if (body['kind'] === 'tenant') {
    if (!text(body['header_id'])) return need('header_id')
    if (!text(body['agent_id'])) return need('agent_id')
    if (!text(body['dir_name'])) return need('dir_name')
    if (typeof body['content'] !== 'string') return need('content')
    return reply(syncTenantSkill(body['header_id'], body['agent_id'], body['dir_name'], body['content']))
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
    return reply(syncCompanionFile(body['skill_id'], body['rel_path'], Buffer.from(b64, 'base64'), mode as number | undefined, (agent as string | null | undefined) ?? null))
  }

  json(res, { error: 'invalid_value', field: 'kind', hint: "kind must be 'skill', 'tenant' or 'companion'" }, 400)
  return true
}
