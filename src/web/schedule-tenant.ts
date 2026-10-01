import { MAIN_AGENT_ID } from '../config.js'
import { getTenantsForAgent, agentServesTenant, getServingTenant, resolveAgentTenant } from '../db.js'
import { listAgentNames } from './agent-config.js'

// The (tenant, agent) pair rule for scheduled tasks: a task owned by a tenant may only
// target an agent that serves that tenant, because the tenant-context hook binds the
// task's tenant to the agent's session when it fires.
//
//  - default tenant: the fleet main agent, any agent not enabled for a specific tenant
//    (the same "no enabled row -> default" reading as resolveAgentTenant), or an agent
//    explicitly enabled for default.
//  - any other tenant: its main agent or an agent enabled for it (agentServesTenant),
//    never the fleet main agent (it has no tenant hook, so no isolation), and never
//    `all` (a fan-out cannot be bound to one tenant).
export const DEFAULT_SCHEDULE_TENANT = 'default'
export const ALL_AGENTS = 'all'

/** Local agents a schedule may name: the fleet main agent plus the visible sub-agents. */
export function knownScheduleAgents(): string[] {
  return [MAIN_AGENT_ID, ...listAgentNames().filter(n => n !== MAIN_AGENT_ID)]
}

export function scheduleAgentServesTenant(agent: string, tenantId: string | null): boolean {
  const tenant = tenantId ?? DEFAULT_SCHEDULE_TENANT
  if (tenant === DEFAULT_SCHEDULE_TENANT) {
    if (agent === ALL_AGENTS) return true
    if (!knownScheduleAgents().includes(agent)) return false
    if (agent === MAIN_AGENT_ID) return true
    const enabledFor = getTenantsForAgent(agent)
    return enabledFor.length === 0 || enabledFor.includes(DEFAULT_SCHEDULE_TENANT)
  }
  if (agent === ALL_AGENTS || agent === MAIN_AGENT_ID) return false
  if (!knownScheduleAgents().includes(agent)) return false
  return agentServesTenant(agent, tenant)
}

/** Agent names offered for a tenant (all of them when no tenant is given). */
export function scheduleAgentNamesForTenant(tenantId: string | null): string[] {
  const names = knownScheduleAgents()
  return tenantId === null ? names : names.filter(n => scheduleAgentServesTenant(n, tenantId))
}

/**
 * The tenant a task proposed by `agentId` on the shared token belongs to: the tenant of the
 * request that agent is serving right now (its recorded context). Without a usable context the
 * agent's own tenant counts, but only when it has exactly one; a shared agent (enabled for
 * several tenants) with no context is ambiguous, so the answer is null and the caller must
 * refuse rather than file the task under a guess.
 */
export function creatorTenant(agentId: string): string | null {
  const serving = getServingTenant(agentId)
  if (serving) return serving
  const own = resolveAgentTenant(agentId)
  return own === '_multi_' ? null : own
}
