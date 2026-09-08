import { insertHookAuditLog, listHookAuditLog, pruneHookAuditLog } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const VALID_HOOK_TYPES = new Set(['PreToolUse', 'PostToolUse', 'PreCompact', 'Stop'])
const VALID_VERDICTS = new Set(['allow', 'deny', 'defer'])

export async function tryHandleHookAudit(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/hook-audit -- record a hook verdict (called by hook scripts)
  if (path === '/api/hook-audit' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      agent_id?: string
      hook_type?: string
      verdict?: string
      tool_name?: string
      content_hash?: string
      reason?: string
      session_id?: string
    }
    if (!data.hook_type || !VALID_HOOK_TYPES.has(data.hook_type)) {
      json(res, { error: 'invalid_value', field: 'hook_type', hint: 'hook_type must be one of PreToolUse, PostToolUse, PreCompact, Stop' }, 400)
      return true
    }
    if (!data.verdict || !VALID_VERDICTS.has(data.verdict)) {
      json(res, { error: 'invalid_value', field: 'verdict', hint: 'verdict must be one of allow, deny, defer' }, 400)
      return true
    }
    insertHookAuditLog({
      agent_id: data.agent_id ?? null,
      hook_type: data.hook_type,
      verdict: data.verdict,
      tool_name: data.tool_name ?? null,
      content_hash: data.content_hash ?? null,
      reason: data.reason ?? null,
      session_id: data.session_id ?? null,
    })
    json(res, { ok: true })
    return true
  }

  // GET /api/hook-audit -- dashboard query (?since=3600&verdict=deny&agent=X&limit=200)
  if (path === '/api/hook-audit' && method === 'GET') {
    const since = url.searchParams.get('since')
    const verdict = url.searchParams.get('verdict') ?? undefined
    const agent = url.searchParams.get('agent') ?? undefined
    const limit = url.searchParams.get('limit')
    if (verdict && !VALID_VERDICTS.has(verdict)) {
      json(res, { error: 'invalid_value', field: 'verdict', hint: 'verdict must be one of allow, deny, defer' }, 400)
      return true
    }
    const entries = listHookAuditLog({
      sinceSecs: since ? parseInt(since, 10) : undefined,
      verdict,
      agent_id: agent,
      limit: limit ? parseInt(limit, 10) : undefined,
    })
    json(res, { entries, total: entries.length })
    return true
  }

  // POST /api/hook-audit/prune -- cleanup old entries
  if (path === '/api/hook-audit/prune' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString() || '{}') as { older_than_secs?: number }
    pruneHookAuditLog(data.older_than_secs ?? 30 * 86400)
    json(res, { ok: true })
    return true
  }

  return false
}
