import { insertHookAuditLog, listHookAuditLog, pruneHookAuditLog } from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const VALID_HOOK_TYPES = new Set(['PreToolUse', 'PostToolUse', 'PreCompact', 'Stop'])
// 'handoff' (added for the context watchdog's proactive-compaction phase):
// a PostToolUse row meaning "a rolling HANDOFF summary was injected", not a
// tool-call gate verdict -- distinct from allow/deny/defer, which describe
// whether a tool call itself was let through.
const VALID_VERDICTS = new Set(['allow', 'deny', 'defer', 'handoff'])
// trigger_source (migration 0038) names which context-protection layer
// produced a handoff/PreCompact row -- optional, only set by the hook
// scripts that write it (context-watchdog.py, and formerly compact-monitor.sh).
const VALID_TRIGGER_SOURCES = new Set(['watchdog', 'compact-monitor'])

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
      trigger_source?: string
    }
    if (!data.hook_type || !VALID_HOOK_TYPES.has(data.hook_type)) {
      json(res, { error: 'invalid_value', field: 'hook_type', hint: 'hook_type must be one of PreToolUse, PostToolUse, PreCompact, Stop' }, 400)
      return true
    }
    if (!data.verdict || !VALID_VERDICTS.has(data.verdict)) {
      json(res, { error: 'invalid_value', field: 'verdict', hint: 'verdict must be one of allow, deny, defer' }, 400)
      return true
    }
    if (data.trigger_source && !VALID_TRIGGER_SOURCES.has(data.trigger_source)) {
      json(res, { error: 'invalid_value', field: 'trigger_source', hint: 'trigger_source must be one of watchdog, compact-monitor' }, 400)
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
      trigger_source: data.trigger_source ?? null,
    })
    json(res, { ok: true })
    return true
  }

  // GET /api/hook-audit -- dashboard query (?since=3600&verdict=deny&agent=X&trigger_source=watchdog&limit=200)
  if (path === '/api/hook-audit' && method === 'GET') {
    const since = url.searchParams.get('since')
    const verdict = url.searchParams.get('verdict') ?? undefined
    const agent = url.searchParams.get('agent') ?? undefined
    const triggerSource = url.searchParams.get('trigger_source') ?? undefined
    const limit = url.searchParams.get('limit')
    if (verdict && !VALID_VERDICTS.has(verdict)) {
      json(res, { error: 'invalid_value', field: 'verdict', hint: 'verdict must be one of allow, deny, defer' }, 400)
      return true
    }
    if (triggerSource && !VALID_TRIGGER_SOURCES.has(triggerSource)) {
      json(res, { error: 'invalid_value', field: 'trigger_source', hint: 'trigger_source must be one of watchdog, compact-monitor' }, 400)
      return true
    }
    const entries = listHookAuditLog({
      sinceSecs: since ? parseInt(since, 10) : undefined,
      verdict,
      agent_id: agent,
      trigger_source: triggerSource,
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
