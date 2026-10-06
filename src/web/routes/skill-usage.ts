import { logSkillUsage, getSkillUsageRows, getSkillUsageStats, getSkillUsageSummary } from '../../db.js'
import { SKILL_USAGE_SOURCES, type SkillUsageSource } from '../../db/audit.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

export async function tryHandleSkillUsage(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/skill-usage -- record a skill usage event (from PostToolUse hook)
  if (path === '/api/skill-usage' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      agent_id: string
      skill_name: string
      trigger_type: 'tool_call' | 'skill_read'
      session_id?: string | null
      source?: SkillUsageSource | null
    }
    if (!data.agent_id || !data.skill_name || !data.trigger_type) {
      json(res, { error: 'required', hint: 'agent_id, skill_name and trigger_type required' }, 400)
      return true
    }
    if (data.trigger_type !== 'tool_call' && data.trigger_type !== 'skill_read') {
      json(res, { error: 'invalid_value', field: 'trigger_type', hint: 'trigger_type must be tool_call or skill_read' }, 400)
      return true
    }
    // source is optional: an old hook (not yet restarted) does not send it. When present it must be a
    // known value AND agree with trigger_type, so the legacy value derived from trigger_type stays coherent.
    if (data.source !== undefined && data.source !== null) {
      const expectedTrigger = Object.hasOwn(SKILL_USAGE_SOURCES, data.source) ? SKILL_USAGE_SOURCES[data.source] : undefined
      if (!expectedTrigger) {
        json(res, { error: 'invalid_value', field: 'source', hint: `source must be one of ${Object.keys(SKILL_USAGE_SOURCES).join(', ')}` }, 400)
        return true
      }
      if (expectedTrigger !== data.trigger_type) {
        json(res, { error: 'invalid_value', field: 'source', hint: `source ${data.source} requires trigger_type ${expectedTrigger}` }, 400)
        return true
      }
    }
    logSkillUsage(data.agent_id, data.skill_name, data.trigger_type, data.session_id, data.source)
    json(res, { ok: true })
    return true
  }

  // GET /api/skill-usage/summary -- per-skill last_used_at + 30d/90d/all-time counts
  if (path === '/api/skill-usage/summary' && method === 'GET') {
    json(res, getSkillUsageSummary())
    return true
  }

  // GET /api/skill-usage/stats -- aggregated counts per skill (for dream-engine health)
  if (path === '/api/skill-usage/stats' && method === 'GET') {
    const since = url.searchParams.get('since') ? parseInt(url.searchParams.get('since')!) : undefined
    json(res, getSkillUsageStats(since))
    return true
  }

  // GET /api/skill-usage -- recent usage rows (with optional filters)
  if (path === '/api/skill-usage' && method === 'GET') {
    const since = url.searchParams.get('since') ? parseInt(url.searchParams.get('since')!) : undefined
    const agentId = url.searchParams.get('agent_id') ?? undefined
    const skillName = url.searchParams.get('skill_name') ?? undefined
    const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!) : 500
    json(res, getSkillUsageRows({ since, agentId, skillName, limit }))
    return true
  }

  return false
}
