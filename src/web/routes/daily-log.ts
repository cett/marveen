import { appendDailyLog, getDailyLog, getDailyLogDates, resolveAgentTenant } from '../../db.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { actingAgentId, callerMayActAs } from '../fleet-agent-identity.js'
import { detectHomoglyphs, formatHomoglyphWarning } from '../../homoglyph.js'
import type { RouteContext } from './types.js'

// Tenant-IDOR guard: daily_logs has no tenant_id
// column of its own (it's agent_id-keyed), so scope it the same way
// blackboard.ts does -- resolve the target agent's tenant via the
// tenant_agent_availability opt-in matrix and compare against the caller's.
// Admin (including every fleet agent on the shared dashboard-token bearer,
// which maps to role='admin' for backward-compat) is unrestricted, matching
// every other tenant-scoped route in this codebase.
function tenantBlocked(ctx: RouteContext, agentId: string): boolean {
  // A fleet_agent token is held to its own agent instead: the log of its own agent is its own in
  // whichever tenant it is serving, and no other agent's log is reachable.
  if (ctx.role === 'fleet_agent') return !callerMayActAs(ctx, agentId)
  if (ctx.role === 'admin') return false
  const callerTenant = ctx.tenantId ?? 'default'
  return resolveAgentTenant(agentId) !== callerTenant
}

export async function tryHandleDailyLog(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/daily-log' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as { agent_id?: string; content: string }
    if (!data.content?.trim()) { json(res, { error: 'required', field: 'content', hint: 'Content required' }, 400); return true }
    const agentId = actingAgentId(ctx, data.agent_id, MAIN_AGENT_ID)
    if (tenantBlocked(ctx, agentId)) { json(res, { error: 'forbidden', hint: 'agent not in your tenant' }, 403); return true }
    appendDailyLog(agentId, data.content.trim())
    // Warn-only homoglyph check (GATEHOMOGLIFSWEEP816) -- see memories.ts.
    const homoglyphs = detectHomoglyphs(data.content)
    if (homoglyphs.length > 0) {
      const warning = formatHomoglyphWarning(homoglyphs)
      logger.warn({ agent: agentId }, `daily-log entry saved with ${warning}`)
      json(res, { ok: true, homoglyph_warning: warning })
      return true
    }
    json(res, { ok: true })
    return true
  }

  if (path === '/api/daily-log' && method === 'GET') {
    const agent = actingAgentId(ctx, url.searchParams.get('agent'), MAIN_AGENT_ID)
    if (tenantBlocked(ctx, agent)) { json(res, { error: 'forbidden', hint: 'agent not in your tenant' }, 403); return true }
    const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0]
    json(res, getDailyLog(agent, date))
    return true
  }

  if (path === '/api/daily-log/dates' && method === 'GET') {
    const agent = actingAgentId(ctx, url.searchParams.get('agent'), MAIN_AGENT_ID)
    if (tenantBlocked(ctx, agent)) { json(res, { error: 'forbidden', hint: 'agent not in your tenant' }, 403); return true }
    json(res, getDailyLogDates(agent))
    return true
  }

  return false
}
