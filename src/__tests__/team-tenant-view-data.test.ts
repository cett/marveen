// The data side of GET /api/team/graph?view=tenants (buildTenantViews): the agents and team files are stubbed, the tenants and the
// availability rows are REAL (in-memory database, and PostgreSQL through useTestDb when it is on the ported list).
//
//   - an admin gets every enabled tenant, the global main agent as the centre of a tenant that has none of its own;
//   - a tenant role gets ONLY its own tenant (no other tenant's id or name), no global main node, no agent it may not see;
//   - an agent with no availability row at all is fleet-internal and belongs to `default`;
//   - a disabled tenant is not listed; the order of the picture is by name, not by directory order.
//
// Privacy: neutral fixtures only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'

const TEAMS: Record<string, { reportsTo: string | null; title?: string }> = {}
const RUNNING = new Set<string>()
let NAMES: string[] = []

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<object>()), MAIN_AGENT_ID: 'agent-main', currentBotName: () => 'Main' }))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listAgentNames: () => NAMES,
  readAgentDisplayName: (n: string) => n.toUpperCase(),
}))
vi.mock('../web/agent-team.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readAgentTeam: (n: string) => ({ role: 'member', reportsTo: TEAMS[n]?.reportsTo ?? null, delegatesTo: [], autoDelegation: false, trustFrom: [], ...(TEAMS[n]?.title ? { title: TEAMS[n].title } : {}) }),
}))
vi.mock('../web/agent-process.js', async (importOriginal) => ({ ...(await importOriginal<object>()), isAgentRunning: (n: string) => RUNNING.has(n) }))

import { setTenantAgentAvailability } from '../db/agents.js'
import { createTenant, updateTenant } from '../db/observability.js'
import { buildTenantViews, compareAgentsForView } from '../web/routes/team-tenant-view-data.js'

const { dbx } = useTestDb()

async function seed(): Promise<void> {
  // directory order is NOT the order of the picture: agent-b comes before agent-a on disk
  NAMES = ['agent-b', 'agent-a', 'agent-c', 'agent-d']
  for (const k of Object.keys(TEAMS)) delete TEAMS[k]
  Object.assign(TEAMS, {
    'agent-a': { reportsTo: 'agent-main', title: 'one' },
    'agent-b': { reportsTo: 'agent-a' },
    'agent-c': { reportsTo: null },
    'agent-d': { reportsTo: 'agent-main' },
  })
  RUNNING.clear(); RUNNING.add('agent-a'); RUNNING.add('agent-c')
  await createTenant('tenant-b', 'Tenant B')
  await updateTenant('tenant-b', { main_agent_id: 'agent-c' })
  // agent-a: default and tenant-b; agent-b: default (explicit); agent-c: tenant-b only; agent-d: no row at all (fleet-internal)
  await setTenantAgentAvailability('default', 'agent-a', true)
  await setTenantAgentAvailability('tenant-b', 'agent-a', true)
  await setTenantAgentAvailability('default', 'agent-b', true)
  await setTenantAgentAvailability('tenant-b', 'agent-c', true)
}

const ids = (v: { nodes: { id: string }[] }) => v.nodes.map((n) => n.id)
const view = async (role: 'admin' | 'agent', tenantId?: string | null) => (await buildTenantViews({ role, tenantId: tenantId ?? null })).tenants

describe('buildTenantViews as an admin', () => {
  beforeEach(seed)

  it('lists every enabled tenant, the global main agent is the centre of the tenant without its own', async () => {
    const tenants = await view('admin')
    expect(tenants.map((t) => t.id).sort()).toEqual(['default', 'tenant-b'])
    const d = tenants.find((t) => t.id === 'default')!
    expect(d.rootId).toBe('agent-main')
    // agent-d has no row at all: it is fleet-internal, so it is in `default`; agent-c is tenant-b only
    expect(ids(d)).toEqual(['agent-main', 'agent-a', 'agent-b', 'agent-d'])
    expect(d.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(['agent-a>agent-b', 'agent-main>agent-a', 'agent-main>agent-d'])
  })

  it('the tenant\'s own main agent is its centre; an agent in several tenants shows in each, with its title and state', async () => {
    const b = (await view('admin')).find((t) => t.id === 'tenant-b')!
    expect(b.rootId).toBe('agent-c')
    expect(ids(b)).toEqual(['agent-c', 'agent-a'])
    expect(b.nodes.find((n) => n.id === 'agent-a')).toEqual({ id: 'agent-a', label: 'AGENT-A', title: 'one', running: true })
    expect(b.nodes.find((n) => n.id === 'agent-c')).toMatchObject({ title: null, running: true })
    // agent-a reports to the global main agent, which is not in tenant-b: it hangs under the tenant's own centre
    expect(b.edges).toEqual([{ from: 'agent-c', to: 'agent-a' }])
  })

  it('the global main agent is reported as the main agent id; a stopped agent is running:false', async () => {
    const r = await buildTenantViews({ role: 'admin', tenantId: null })
    expect(r.mainAgentId).toBe('agent-main')
    expect(r.tenants.find((t) => t.id === 'default')!.nodes.find((n) => n.id === 'agent-b')!.running).toBe(false)
  })

  it('a disabled tenant is not listed', async () => {
    await updateTenant('tenant-b', { disabled: true })
    expect((await view('admin')).map((t) => t.id)).toEqual(['default'])
  })

  it('the order of the nodes is by display name, not the order of the directory', async () => {
    const d = (await view('admin')).find((t) => t.id === 'default')!
    expect(ids(d).slice(1)).toEqual(['agent-a', 'agent-b', 'agent-d'])
    expect(NAMES[0]).toBe('agent-b')
  })
})

describe('buildTenantViews as a tenant role (RBAC)', () => {
  beforeEach(seed)

  it('gets ONLY its own tenant, with no other tenant\'s id or name anywhere in the answer', async () => {
    const r = await buildTenantViews({ role: 'agent', tenantId: 'tenant-b' })
    expect(r.tenants.map((t) => t.id)).toEqual(['tenant-b'])
    const text = JSON.stringify(r)
    expect(text).not.toContain('Fleet')
    expect(text).not.toContain('"default"')
  })

  it('has no global main node, and the centre is the tenant\'s own main agent', async () => {
    const r = await buildTenantViews({ role: 'agent', tenantId: 'tenant-b' })
    expect(r.mainAgentId).toBeNull()
    expect(JSON.stringify(r)).not.toContain('agent-main')
    expect(r.tenants[0]?.rootId).toBe('agent-c')
    expect(ids(r.tenants[0]!)).toEqual(['agent-c', 'agent-a'])
  })

  it('never lists an agent its tenant may not see, and a hidden manager does not leak as a parent', async () => {
    const r = await buildTenantViews({ role: 'agent', tenantId: 'tenant-b' })
    for (const n of r.tenants[0]!.nodes) expect(['agent-c', 'agent-a']).toContain(n.id)
    for (const e of r.tenants[0]!.edges) { expect(['agent-c', 'agent-a']).toContain(e.from); expect(['agent-c', 'agent-a']).toContain(e.to) }
  })

  it('a tenant with no own main agent has no centre: the top-level members come without a parent edge', async () => {
    const r = await buildTenantViews({ role: 'agent', tenantId: 'default' })
    expect(r.tenants[0]?.rootId).toBeNull()
    expect(ids(r.tenants[0]!)).toEqual(['agent-a', 'agent-b'])
    expect(r.tenants[0]?.edges).toEqual([{ from: 'agent-a', to: 'agent-b' }])
  })

  it('a caller with no tenant id is scoped to `default`, not treated as an admin', async () => {
    const r = await buildTenantViews({ role: 'agent', tenantId: null })
    expect(r.tenants.map((t) => t.id)).toEqual(['default'])
    expect(r.mainAgentId).toBeNull()
  })
})

describe('compareAgentsForView', () => {
  it('orders by display name case-insensitively, then by id', () => {
    const list = [{ id: 'z', label: 'beta' }, { id: 'b', label: 'Alpha' }, { id: 'a', label: 'alpha' }]
    expect(list.sort(compareAgentsForView).map((x) => x.id)).toEqual(['a', 'b', 'z'])
  })
})
