// The per-tenant derivation of the org chart (src/web/team-tenant-view.ts): pure, so every rule is a cell here.
//
//   - the members of a tenant are the agents enabled for it; the centre is the tenant's own main agent, else the global one;
//   - the parent of a member is its nearest ancestor on the global reportsTo chain that is a member or the centre, else the centre;
//   - an agent in several tenants appears in each; the global main agent is a centre, never a member by availability;
//   - no centre at all (a tenant role has no global main node) leaves the top-level members without a parent edge;
//   - the derivation never invents a manager: every edge is an ancestor relation of the global tree.
//
// Privacy: neutral fixtures only (agent-a ..., tenant-a ...).
import { describe, it, expect } from 'vitest'
import { deriveTenantViews, type TenantViewAgent } from '../web/team-tenant-view.js'

const agent = (id: string, reportsTo: string | null = null, extra: Partial<TenantViewAgent> = {}): TenantViewAgent =>
  ({ id, label: id.toUpperCase(), title: null, reportsTo, running: true, ...extra })
const member = (map: Record<string, string[]>): ReadonlyMap<string, readonly string[]> => new Map(Object.entries(map))
const only = (views: ReturnType<typeof deriveTenantViews>, id: string) => {
  const v = views.find((x) => x.id === id)
  if (!v) throw new Error('no view ' + id)
  return v
}
const edgeKeys = (v: { edges: { from: string; to: string }[] }) => v.edges.map((e) => `${e.from}>${e.to}`).sort()

describe('the centre of a tenant', () => {
  const agents = [agent('main'), agent('agent-a', 'main'), agent('agent-b', 'main'), agent('agent-c', 'main')]
  const tenantIdsOf = member({ main: [], 'agent-a': ['t1'], 'agent-b': ['t1', 't2'], 'agent-c': ['t2'] })

  it('is the tenant\'s own main agent when it is a known agent (and that agent is no member node twice)', () => {
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'T1', mainAgentId: 'agent-a' }], tenantIdsOf, globalMainId: 'main' }), 't1')
    expect(v.rootId).toBe('agent-a')
    expect(v.nodes.map((n) => n.id)).toEqual(['agent-a', 'agent-b'])
    expect(edgeKeys(v)).toEqual(['agent-a>agent-b'])
  })

  it('is the global main agent when the tenant has none of its own', () => {
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'T1', mainAgentId: null }], tenantIdsOf, globalMainId: 'main' }), 't1')
    expect(v.rootId).toBe('main')
    expect(edgeKeys(v)).toEqual(['main>agent-a', 'main>agent-b'])
  })

  it('falls back to the global main agent when the named main agent is not a known agent (a stale id)', () => {
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'T1', mainAgentId: 'gone' }], tenantIdsOf, globalMainId: 'main' }), 't1')
    expect(v.rootId).toBe('main')
  })

  it('is none when there is no own main agent and no global main (a tenant role): top-level members have no parent edge', () => {
    const visible = [agent('agent-a'), agent('agent-b', 'agent-a'), agent('agent-c')]
    const v = only(deriveTenantViews({ agents: visible, tenants: [{ id: 't1', name: 'T1', mainAgentId: null }], tenantIdsOf: member({ 'agent-a': ['t1'], 'agent-b': ['t1'], 'agent-c': ['t1'] }), globalMainId: null }), 't1')
    expect(v.rootId).toBeNull()
    expect(edgeKeys(v)).toEqual(['agent-a>agent-b'])
    expect(v.nodes.map((n) => n.id)).toEqual(['agent-a', 'agent-b', 'agent-c'])
  })

  it('a tenant with no members still has its centre', () => {
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 'empty', name: 'E', mainAgentId: null }], tenantIdsOf, globalMainId: 'main' }), 'empty')
    expect(v.nodes.map((n) => n.id)).toEqual(['main'])
    expect(v.edges).toEqual([])
  })
})

describe('the parent of a member', () => {
  it('is the nearest ancestor that is a member: a manager outside the tenant is skipped (path compression)', () => {
    // main > lead (not in t1) > agent-a (t1) > agent-b (t1): agent-a hangs under the centre, agent-b under agent-a
    const agents = [agent('main'), agent('lead', 'main'), agent('agent-a', 'lead'), agent('agent-b', 'agent-a')]
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'T1', mainAgentId: null }], tenantIdsOf: member({ lead: ['t2'], 'agent-a': ['t1'], 'agent-b': ['t1'] }), globalMainId: 'main' }), 't1')
    expect(edgeKeys(v)).toEqual(['agent-a>agent-b', 'main>agent-a'])
    expect(v.nodes.map((n) => n.id)).not.toContain('lead')
  })

  it('skips several levels outside the tenant to the first member above', () => {
    const agents = [agent('main'), agent('agent-a', 'main'), agent('x', 'agent-a'), agent('y', 'x'), agent('agent-b', 'y')]
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'T1', mainAgentId: null }], tenantIdsOf: member({ 'agent-a': ['t1'], x: ['t2'], y: ['t2'], 'agent-b': ['t1'] }), globalMainId: 'main' }), 't1')
    expect(edgeKeys(v)).toEqual(['agent-a>agent-b', 'main>agent-a'])
  })

  it('an agent with no reportsTo hangs under the centre', () => {
    const agents = [agent('main'), agent('agent-a', null)]
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'T1', mainAgentId: null }], tenantIdsOf: member({ 'agent-a': ['t1'] }), globalMainId: 'main' }), 't1')
    expect(edgeKeys(v)).toEqual(['main>agent-a'])
  })

  it('reaching the tenant\'s own centre on the way up stops there (a manager above the centre is not used)', () => {
    // main > agent-c (centre of t1) > agent-a: agent-a hangs under agent-c; the main agent is not in t1 at all
    const agents = [agent('main'), agent('agent-c', 'main'), agent('agent-a', 'agent-c')]
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'T1', mainAgentId: 'agent-c' }], tenantIdsOf: member({ 'agent-c': ['t1'], 'agent-a': ['t1'] }), globalMainId: 'main' }), 't1')
    expect(v.rootId).toBe('agent-c')
    expect(edgeKeys(v)).toEqual(['agent-c>agent-a'])
    expect(v.nodes.map((n) => n.id)).not.toContain('main')
  })

  it('a member whose chain runs through the centre is still a child of it, and the centre has no parent edge', () => {
    const agents = [agent('main'), agent('agent-c', 'main'), agent('agent-a', 'main')]
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'T1', mainAgentId: 'agent-c' }], tenantIdsOf: member({ 'agent-c': ['t1'], 'agent-a': ['t1'] }), globalMainId: 'main' }), 't1')
    expect(edgeKeys(v)).toEqual(['agent-c>agent-a'])
    expect(v.edges.some((e) => e.to === 'agent-c')).toBe(false)
  })

  it('a reporting cycle cannot hang the derivation (the walk ends, the agent falls back to the centre)', () => {
    const agents = [agent('main'), agent('agent-a', 'agent-b'), agent('agent-b', 'agent-a')]
    const views = deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'T1', mainAgentId: null }], tenantIdsOf: member({ 'agent-a': ['t1'] }), globalMainId: 'main' })
    expect(edgeKeys(only(views, 't1'))).toEqual(['main>agent-a'])
  })
})

describe('membership', () => {
  const agents = [agent('main'), agent('agent-a', 'main'), agent('agent-b', 'main')]

  it('an agent in several tenants appears in each of them, with the same title and state', () => {
    const shared = [agent('main'), agent('agent-a', 'main', { title: 'one', running: false }), agent('agent-b', 'main')]
    const views = deriveTenantViews({
      agents: shared,
      tenants: [{ id: 't1', name: 'T1', mainAgentId: null }, { id: 't2', name: 'T2', mainAgentId: null }],
      tenantIdsOf: member({ 'agent-a': ['t1', 't2'], 'agent-b': ['t2'] }), globalMainId: 'main',
    })
    const a1 = only(views, 't1').nodes.find((n) => n.id === 'agent-a')
    const a2 = only(views, 't2').nodes.find((n) => n.id === 'agent-a')
    expect(a1).toEqual({ id: 'agent-a', label: 'AGENT-A', title: 'one', running: false })
    expect(a2).toEqual(a1)
    expect(only(views, 't1').nodes.map((n) => n.id)).toEqual(['main', 'agent-a'])
  })

  it('the global main agent is never a member by availability: another tenant\'s list naming it adds no second node', () => {
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'T1', mainAgentId: null }], tenantIdsOf: member({ main: ['t1'], 'agent-a': ['t1'] }), globalMainId: 'main' }), 't1')
    expect(v.nodes.filter((n) => n.id === 'main')).toHaveLength(1)
  })

  it('the global main agent stays out of a tenant that has its OWN centre, even when an availability row names it', () => {
    const own = [agent('main'), agent('agent-c', 'main'), agent('agent-a', 'agent-c')]
    const v = only(deriveTenantViews({ agents: own, tenants: [{ id: 't1', name: 'T1', mainAgentId: 'agent-c' }], tenantIdsOf: member({ main: ['t1'], 'agent-c': ['t1'], 'agent-a': ['t1'] }), globalMainId: 'main' }), 't1')
    expect(v.nodes.map((n) => n.id)).toEqual(['agent-c', 'agent-a'])
  })

  it('an agent with no tenant list at all is in no tenant here (the caller applies the fleet-internal => default rule)', () => {
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 'default', name: 'D', mainAgentId: null }], tenantIdsOf: member({}), globalMainId: 'main' }), 'default')
    expect(v.nodes.map((n) => n.id)).toEqual(['main'])
  })
})

describe('the shape of the answer', () => {
  it('the order of the nodes is the order of the agents given, the ids and names of the tenants are carried', () => {
    const agents = [agent('main'), agent('agent-b', 'main'), agent('agent-a', 'main')]
    const views = deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'Tenant One', mainAgentId: null }], tenantIdsOf: member({ 'agent-a': ['t1'], 'agent-b': ['t1'] }), globalMainId: 'main' })
    expect(views).toHaveLength(1)
    expect(views[0]?.name).toBe('Tenant One')
    expect(views[0]?.nodes.map((n) => n.id)).toEqual(['main', 'agent-b', 'agent-a'])
  })

  it('the centre comes first even when it sorts after the members', () => {
    const agents = [agent('agent-a', 'agent-z'), agent('agent-z')]
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'T1', mainAgentId: 'agent-z' }], tenantIdsOf: member({ 'agent-a': ['t1'], 'agent-z': ['t1'] }), globalMainId: null }), 't1')
    expect(v.nodes.map((n) => n.id)).toEqual(['agent-z', 'agent-a'])
  })

  it('every non-centre node has exactly one parent edge when there is a centre (a connected tree)', () => {
    const agents = [agent('main'), agent('agent-a', 'main'), agent('agent-b', 'agent-a'), agent('agent-c', 'zzz')]
    const v = only(deriveTenantViews({ agents, tenants: [{ id: 't1', name: 'T1', mainAgentId: null }], tenantIdsOf: member({ 'agent-a': ['t1'], 'agent-b': ['t1'], 'agent-c': ['t1'] }), globalMainId: 'main' }), 't1')
    for (const n of v.nodes) {
      const parents = v.edges.filter((e) => e.to === n.id)
      expect(parents).toHaveLength(n.id === v.rootId ? 0 : 1)
    }
  })

  it('no tenants in, no views out', () => {
    expect(deriveTenantViews({ agents: [], tenants: [], tenantIdsOf: member({}), globalMainId: null })).toEqual([])
  })
})
