// Per-tenant org-chart trees, derived from the one global reporting tree (GET /api/team/graph?view=tenants).
//
// There is ONE `reportsTo` per agent (global, not per tenant), and tenant membership is a separate fact
// (tenant_agent_availability). A tenant's picture is therefore DERIVED, never stored: no per-tenant hierarchy, so it can
// never invent a manager that the global tree does not have.
//
// Rules (plan orgchart-radial, sections 3.1 and 9):
//   - members of tenant T: the agents enabled for T. An agent with no availability row at all is fleet-internal and belongs
//     to `default` (the caller builds `tenantIdsOf` with that rule, this module only reads it).
//   - centre (root) of T: the tenant's own main agent (tenants.main_agent_id) when it names a known agent, else the global
//     main agent, else none (a tenant-role caller gets no global main node).
//   - parent of a member in T: its nearest ancestor (walking `reportsTo` upward) that is a member of T or the root; a member
//     with no such ancestor hangs under the root; with no root it is a top-level node (the layout then spreads the top-level
//     nodes around an empty centre).
//   - an agent in several tenants appears in each of them.
//   - the order of the nodes is the order of `agents` (the caller sorts it, so the picture is stable between requests).
//
// Pure: no I/O, no clock, no randomness. RBAC is NOT decided here: the caller passes only the agents and tenants the
// caller may see (a tenant role gets its own tenant and no other tenant's name).

export interface TenantViewAgent {
  id: string
  label: string
  /** one word, null when none is set */
  title: string | null
  reportsTo: string | null
  running: boolean
}

export interface TenantViewTenantInput {
  id: string
  name: string
  mainAgentId: string | null
}

export interface TenantViewNode {
  id: string
  label: string
  title: string | null
  running: boolean
}

export interface TenantView {
  id: string
  name: string
  /** the centre agent, null when the tenant has none (top-level nodes then have no parent edge) */
  rootId: string | null
  nodes: TenantViewNode[]
  edges: { from: string; to: string }[]
}

export interface TenantViewInput {
  /** every agent the caller may see, in the stable order of the picture; includes the global main agent for an admin */
  agents: TenantViewAgent[]
  tenants: TenantViewTenantInput[]
  /** agent id -> the tenants it is a member of (already with the fleet-internal => default rule applied) */
  tenantIdsOf: ReadonlyMap<string, readonly string[]>
  /** the global main agent when the caller may see it, else null */
  globalMainId: string | null
}

export function deriveTenantViews(input: TenantViewInput): TenantView[] {
  const byId = new Map(input.agents.map((a) => [a.id, a]))
  return input.tenants.map((tenant) => deriveOne(tenant, input, byId))
}

function deriveOne(tenant: TenantViewTenantInput, input: TenantViewInput, byId: Map<string, TenantViewAgent>): TenantView {
  const members = new Set<string>()
  for (const a of input.agents) {
    if (a.id === input.globalMainId) continue // the global main agent is a centre, never a member by availability
    if ((input.tenantIdsOf.get(a.id) ?? []).includes(tenant.id)) members.add(a.id)
  }

  // the tenant's own main agent when it is a known agent, else the global main agent, else none
  const ownMain = tenant.mainAgentId && byId.has(tenant.mainAgentId) ? tenant.mainAgentId : null
  const rootId = ownMain ?? (input.globalMainId && byId.has(input.globalMainId) ? input.globalMainId : null)
  if (rootId) members.delete(rootId)

  // nearest ancestor in the tenant (a member or the root); the visited set stops a cycle the server should never have saved
  const parentOf = (id: string): string | null => {
    const seen = new Set<string>([id])
    let cur = byId.get(id)?.reportsTo ?? null
    while (cur && !seen.has(cur)) {
      if (cur === rootId || members.has(cur)) return cur
      seen.add(cur)
      cur = byId.get(cur)?.reportsTo ?? null
    }
    return rootId
  }

  // the centre first, then the members in the order given
  const order = [
    ...input.agents.filter((a) => a.id === rootId),
    ...input.agents.filter((a) => a.id !== rootId && members.has(a.id)),
  ]
  const nodes: TenantViewNode[] = order.map((a) => ({ id: a.id, label: a.label, title: a.title, running: a.running }))
  const edges: { from: string; to: string }[] = []
  for (const a of order) {
    if (a.id === rootId) continue
    const p = parentOf(a.id)
    if (p) edges.push({ from: p, to: a.id })
  }
  return { id: tenant.id, name: tenant.name, rootId, nodes, edges }
}
