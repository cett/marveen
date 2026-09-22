import { appendDailyLog, getDailyLog, getDailyLogDates, resolveAgentTenant } from '../../db.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Tenant-IDOR guard (kanban 45d7a63a item 1A): daily_logs has no tenant_id
// column of its own (it's agent_id-keyed), so scope it the same way
// blackboard.ts does -- resolve the target agent's tenant via the
// tenant_agent_availability opt-in matrix and compare against the caller's.
// Admin (including every fleet agent on the shared dashboard-token bearer,
// which maps to role='admin' for backward-compat) is unrestricted, matching
// every other tenant-scoped route in this codebase.
function tenantBlocked(ctx: RouteContext, agentId: string): boolean {
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
    const agentId = data.agent_id || MAIN_AGENT_ID
    if (tenantBlocked(ctx, agentId)) { json(res, { error: 'forbidden', hint: 'agent not in your tenant' }, 403); return true }
    appendDailyLog(agentId, data.content.trim())
    json(res, { ok: true })
    return true
  }

  if (path === '/api/daily-log' && method === 'GET') {
    const agent = url.searchParams.get('agent') || MAIN_AGENT_ID
    if (tenantBlocked(ctx, agent)) { json(res, { error: 'forbidden', hint: 'agent not in your tenant' }, 403); return true }
    const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0]
    json(res, getDailyLog(agent, date))
    return true
  }

  if (path === '/api/daily-log/dates' && method === 'GET') {
    const agent = url.searchParams.get('agent') || MAIN_AGENT_ID
    if (tenantBlocked(ctx, agent)) { json(res, { error: 'forbidden', hint: 'agent not in your tenant' }, 403); return true }
    json(res, getDailyLogDates(agent))
    return true
  }

  return false
}
