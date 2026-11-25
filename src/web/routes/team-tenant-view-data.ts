// Data side of GET /api/team/graph?view=tenants: reads the agents, their team files, the tenants and the availability rows
// for ONE caller and hands them to the pure derivation (src/web/team-tenant-view.ts). RBAC lives here, in the one place that
// already enforces it for the old graph: an admin sees every enabled tenant and the global main agent; a tenant role sees
// the agents its tenant may see, ONLY its own tenant (no other tenant's id or name), and no global main node.
import { MAIN_AGENT_ID, currentBotName } from '../../config.js'
import { getTenant, listTenants } from '../../db/observability.js'
import { listEnabledAgentAvailability } from '../../db/agents.js'
import { listAgentNames, readAgentDisplayName } from '../agent-config.js'
import { readAgentTeam } from '../agent-team.js'
import { isAgentRunning } from '../agent-process.js'
import { deriveTenantViews, type TenantView, type TenantViewAgent, type TenantViewTenantInput } from '../team-tenant-view.js'
import { visibleAgentSet, isAdminCaller } from './agent-tenant-scope.js'
import type { RouteContext } from './types.js'

/** The stable order of the picture: by display name (case-insensitive), then id. Not the directory order of the disk. */
export function compareAgentsForView(a: { id: string; label: string }, b: { id: string; label: string }): number {
  const la = a.label.toLowerCase()
  const lb = b.label.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export async function buildTenantViews(ctx: Pick<RouteContext, 'role' | 'tenantId'>): Promise<{ tenants: TenantView[]; mainAgentId: string | null }> {
  const visible = await visibleAgentSet(ctx)
  const admin = isAdminCaller(ctx)

  const agents: TenantViewAgent[] = []
  for (const id of listAgentNames()) {
    if (visible !== null && !visible.has(id)) continue
    const team = readAgentTeam(id)
    agents.push({
      id,
      label: readAgentDisplayName(id),
      title: team.title ?? null,
      reportsTo: visible === null || (team.reportsTo && visible.has(team.reportsTo)) ? team.reportsTo : null,
      running: isAgentRunning(id),
    })
  }
  agents.sort(compareAgentsForView)
  // the global main agent is the centre of a tenant that has no main agent of its own; a tenant role never gets it
  const globalMainId = admin ? MAIN_AGENT_ID : null
  if (admin) agents.unshift({ id: MAIN_AGENT_ID, label: currentBotName(), title: null, reportsTo: null, running: true })

  // membership: the enabled availability rows; an agent with no row at all is fleet-internal and belongs to `default`
  const tenantIdsOf = new Map<string, string[]>()
  for (const row of await listEnabledAgentAvailability()) {
    const list = tenantIdsOf.get(row.agent_id)
    if (list) list.push(row.tenant_id)
    else tenantIdsOf.set(row.agent_id, [row.tenant_id])
  }
  for (const a of agents) if (!tenantIdsOf.has(a.id)) tenantIdsOf.set(a.id, ['default'])

  const tenants: TenantViewTenantInput[] = []
  if (admin) {
    for (const t of await listTenants()) tenants.push({ id: t.id, name: t.display_name, mainAgentId: t.main_agent_id })
  } else {
    const own = ctx.tenantId ?? 'default'
    const t = await getTenant(own)
    if (t && t.disabled_at === null) tenants.push({ id: t.id, name: t.display_name, mainAgentId: t.main_agent_id })
  }
  return { tenants: deriveTenantViews({ agents, tenants, tenantIdsOf, globalMainId }), mainAgentId: globalMainId }
}
