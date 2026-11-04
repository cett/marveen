// The sender routing table, cell by cell. Fake context objects only (privacy: no real agent or tenant names).
import { describe, it, expect } from 'vitest'
import { isRouteAllowed, type RoutingContext, type RouteRequest, type RouteRefusal } from '../web/sender-routing.js'

const OWNER_MAIN = 'main-a'
const TENANTS: Record<string, { main: string | null; agents: string[] }> = {
  'tenant-1': { main: 'main-t1', agents: ['main-t1', 'helper-t1'] },
  'tenant-2': { main: 'main-t2', agents: ['main-t2', 'helper-t2'] },
  'tenant-nomain': { main: null, agents: ['lonely'] },
  // A tenant whose main agent is NOT in its enabled-agent list: the main-agent line of the partner route is the only way in.
  'tenant-3': { main: 'main-t3', agents: ['helper-t3'] },
}
// Trusted pairs of the fleet (symmetric, as isTrustedPeer is): the owner's main agent trusts every fleet agent.
const TRUSTED = new Set(['fleet-x>fleet-y', 'fleet-y>fleet-x', 'fleet-x>main-a', 'main-a>fleet-x'])

const ADVERTISED = ['fleet-x', 'fleet-y', 'helper-shared', 'heartbeat', 'helper-t2']

const ctx: RoutingContext = {
  ownerMainAgentId: OWNER_MAIN,
  tenantMainAgentId: (t) => TENANTS[t]?.main,
  tenantAgentIds: (t) => new Set(TENANTS[t]?.agents ?? []),
  isTrustedPeer: (from, to) => TRUSTED.has(`${from}>${to}`),
  // What the manifest advertises (catalogAgentNames). Two entries are advertised BY MISTAKE on purpose: a
  // coordinator and an agent of a non-default tenant; the module must still refuse them.
  advertisedAgentIds: () => ADVERTISED,
  excludedAgentIds: new Set(['heartbeat', 'telegram-coordinator', 'channel-coordinator']),
  isNonDefaultTenantAgent: (id) => Object.values(TENANTS).some((t) => t.main === id || t.agents.includes(id)),
}

const TARGETS = ['main-a', 'main-t1', 'helper-t1', 'main-t2', 'helper-t2', 'lonely', 'fleet-x', 'fleet-y', 'helper-shared',
  'heartbeat', 'telegram-coordinator', 'channel-coordinator', 'stranger']

function allowedTargets(base: Omit<RouteRequest, 'toAgent'>): string[] {
  return TARGETS.filter((to) => isRouteAllowed({ ...base, toAgent: to }, ctx).ok)
}

describe('isRouteAllowed: the allowed targets of each sender class (full matrix)', () => {
  it('owner: only the owner main agent', () => {
    expect(allowedTargets({ senderClass: 'owner', senderId: 'owner-1', tenantId: 'default' })).toEqual(['main-a'])
  })

  it('tenant_user: only the main agent of the user\'s own tenant', () => {
    expect(allowedTargets({ senderClass: 'tenant_user', senderId: 'user-1', tenantId: 'tenant-1' })).toEqual(['main-t1'])
    expect(allowedTargets({ senderClass: 'tenant_user', senderId: 'user-2', tenantId: 'tenant-2' })).toEqual(['main-t2'])
  })

  it('tenant_user: not even an enabled helper of the own tenant, and never the owner main agent', () => {
    const base = { senderClass: 'tenant_user', senderId: 'user-1', tenantId: 'tenant-1' }
    expect(isRouteAllowed({ ...base, toAgent: 'helper-t1' }, ctx)).toEqual({ ok: false, reason: 'target_not_tenant_main_agent' })
    expect(isRouteAllowed({ ...base, toAgent: 'main-a' }, ctx)).toEqual({ ok: false, reason: 'target_not_tenant_main_agent' })
  })

  it('partner_sender: the main agent or an enabled agent of the partner tenant, nothing of another tenant', () => {
    expect(allowedTargets({ senderClass: 'partner_sender', senderId: 'p-1', tenantId: 'tenant-1' })).toEqual(['main-t1', 'helper-t1'])
    expect(allowedTargets({ senderClass: 'partner_sender', senderId: 'p-2', tenantId: 'tenant-2' })).toEqual(['main-t2', 'helper-t2'])
  })

  it('partner_sender: a tenant whose main agent is not in its agent list still reaches its main agent (and its helper), nothing else', () => {
    const base = { senderClass: 'partner_sender', senderId: 'p-3', tenantId: 'tenant-3' }
    expect(isRouteAllowed({ ...base, toAgent: 'main-t3' }, ctx)).toEqual({ ok: true })
    expect(isRouteAllowed({ ...base, toAgent: 'helper-t3' }, ctx)).toEqual({ ok: true })
    for (const to of ['main-t1', 'helper-t1', 'main-a', 'stranger']) {
      expect(isRouteAllowed({ ...base, toAgent: to }, ctx)).toEqual({ ok: false, reason: 'target_not_in_tenant' })
    }
    // the same tenant as a tenant_user: only the main agent
    expect(isRouteAllowed({ ...base, senderClass: 'tenant_user', toAgent: 'main-t3' }, ctx)).toEqual({ ok: true })
    expect(isRouteAllowed({ ...base, senderClass: 'tenant_user', toAgent: 'helper-t3' }, ctx).ok).toBe(false)
  })

  it('fleet_agent: exactly the trusted-peer pairs', () => {
    expect(allowedTargets({ senderClass: 'fleet_agent', senderId: 'fleet-x', tenantId: 'default' })).toEqual(['main-a', 'fleet-y'])
    expect(allowedTargets({ senderClass: 'fleet_agent', senderId: 'fleet-z', tenantId: 'default' })).toEqual([])
  })

  it('federated: the owner main agent and the advertised agents, minus coordinators and non-default tenants', () => {
    expect(allowedTargets({ senderClass: 'federated', senderId: 'peer/agent', tenantId: null }))
      .toEqual(['main-a', 'fleet-x', 'fleet-y', 'helper-shared'])
  })
})

describe('isRouteAllowed: federated target (owner decision A)', () => {
  const fed = { senderClass: 'federated', senderId: 'peer/agent', tenantId: null }

  it('every agent the manifest advertises is routable, except what the exclusions remove; nothing else is', () => {
    const clean = ADVERTISED.filter((a) => !['heartbeat', 'telegram-coordinator', 'channel-coordinator'].includes(a) && !ctx.isNonDefaultTenantAgent(a))
    const routable = [...clean, 'main-a']
    for (const to of [...TARGETS, ...ADVERTISED]) {
      expect(isRouteAllowed({ ...fed, toAgent: to }, ctx).ok, to).toBe(routable.includes(to))
    }
  })

  it('a coordinator is refused even when it is advertised', () => {
    expect(isRouteAllowed({ ...fed, toAgent: 'heartbeat' }, ctx)).toEqual({ ok: false, reason: 'federated_target_is_coordinator' })
    expect(isRouteAllowed({ ...fed, toAgent: 'telegram-coordinator' }, ctx)).toEqual({ ok: false, reason: 'federated_target_is_coordinator' })
  })

  it('an agent of a non-default tenant is refused even when it is advertised (and its main agent too)', () => {
    expect(isRouteAllowed({ ...fed, toAgent: 'helper-t2' }, ctx)).toEqual({ ok: false, reason: 'federated_target_in_other_tenant' })
    expect(isRouteAllowed({ ...fed, toAgent: 'main-t1' }, ctx)).toEqual({ ok: false, reason: 'federated_target_in_other_tenant' })
  })

  it('the exclusions win over the owner main agent role (a misconfigured context cannot open a hole)', () => {
    const odd: RoutingContext = { ...ctx, ownerMainAgentId: 'heartbeat' }
    expect(isRouteAllowed({ ...fed, toAgent: 'heartbeat' }, odd).ok).toBe(false)
    const odd2: RoutingContext = { ...ctx, isNonDefaultTenantAgent: (id) => id === 'main-a' }
    expect(isRouteAllowed({ ...fed, toAgent: 'main-a' }, odd2).ok).toBe(false)
  })

  it('an unknown or unadvertised agent is refused', () => {
    expect(isRouteAllowed({ ...fed, toAgent: 'stranger' }, ctx)).toEqual({ ok: false, reason: 'federated_target_not_advertised' })
  })

  // The module compares names exactly: a variant of an advertised or excluded name is a DIFFERENT name and is
  // not routed on the strength of the original (the caller hands over the name in the form the router delivers).
  it.each([
    'Fleet-X', 'FLEET-X', 'fleet-x ', ' fleet-x', 'fleet-x\n', 'fleet-x​', 'fleet‐x', 'fleet-x/..', '@fleet-x', 'fleet-x\u0000',
  ])('a variant %j of an advertised agent is refused', (variant) => {
    expect(isRouteAllowed({ ...fed, toAgent: variant }, ctx)).toEqual({ ok: false, reason: 'federated_target_not_advertised' })
  })
  it.each([
    'Heartbeat', 'HEARTBEAT', 'heartbeat ', 'heartbeat​', '@telegram-coordinator', 'Telegram-Coordinator', 'channel-coordinator\n',
  ])('a variant %j of an excluded coordinator is refused', (variant) => {
    expect(isRouteAllowed({ ...fed, toAgent: variant }, ctx).ok).toBe(false)
  })
  it('a variant is refused even for the owner main agent', () => {
    for (const variant of ['Main-A', 'main-a ', '@main-a']) expect(isRouteAllowed({ ...fed, toAgent: variant }, ctx).ok, variant).toBe(false)
  })

  it('the advertised list is read at decision time (one source, no copy)', () => {
    let list: string[] = ['fleet-x']
    const live: RoutingContext = { ...ctx, advertisedAgentIds: () => list }
    expect(isRouteAllowed({ ...fed, toAgent: 'fleet-y' }, live).ok).toBe(false)
    list = ['fleet-x', 'fleet-y']
    expect(isRouteAllowed({ ...fed, toAgent: 'fleet-y' }, live).ok).toBe(true)
  })
})

describe('isRouteAllowed: default-deny', () => {
  it.each(['', 'admin', 'Owner', 'OWNER', 'system', 'toString', '__proto__', 'constructor', 'hasOwnProperty'])(
    'sender class %j is refused for every target',
    (senderClass) => {
      for (const to of TARGETS) {
        expect(isRouteAllowed({ senderClass, senderId: 'x', tenantId: 'tenant-1', toAgent: to }, ctx)).toEqual({ ok: false, reason: 'unknown_sender_class' })
      }
    },
  )

  it('a non-string sender class is refused', () => {
    for (const bad of [undefined, null, 0, {}, ['owner']]) {
      const r = isRouteAllowed({ senderClass: bad as unknown as string, senderId: 'x', tenantId: 'tenant-1', toAgent: 'main-a' }, ctx)
      expect(r).toEqual({ ok: false, reason: 'unknown_sender_class' })
    }
  })

  it('an empty or non-string target is refused for every class', () => {
    for (const senderClass of ['owner', 'tenant_user', 'partner_sender', 'fleet_agent', 'federated']) {
      for (const to of ['', undefined as unknown as string, null as unknown as string]) {
        expect(isRouteAllowed({ senderClass, senderId: 'fleet-x', tenantId: 'tenant-1', toAgent: to }, ctx)).toEqual({ ok: false, reason: 'empty_target' })
      }
    }
  })

  it('agent ids are compared exactly: another case or a stray space is another agent', () => {
    const owner = { senderClass: 'owner', senderId: 'o', tenantId: 'default' }
    for (const to of ['Main-A', 'MAIN-A', 'main-a ', ' main-a', 'main-a\n']) {
      expect(isRouteAllowed({ ...owner, toAgent: to }, ctx).ok).toBe(false)
    }
    expect(isRouteAllowed({ senderClass: 'tenant_user', senderId: 'u', tenantId: 'tenant-1', toAgent: 'Main-T1' }, ctx).ok).toBe(false)
  })
})

describe('isRouteAllowed: tenant data', () => {
  it.each(['tenant_user', 'partner_sender'])('%s without a tenant is refused', (senderClass) => {
    for (const tenantId of [null, undefined, '']) {
      expect(isRouteAllowed({ senderClass, senderId: 'u', tenantId, toAgent: 'main-t1' }, ctx)).toEqual({ ok: false, reason: 'tenant_unknown' })
    }
  })

  it('tenant_user of a tenant without a main agent reaches nothing (not the owner main agent either)', () => {
    for (const to of TARGETS) {
      expect(isRouteAllowed({ senderClass: 'tenant_user', senderId: 'u', tenantId: 'tenant-nomain', toAgent: to }, ctx))
        .toEqual({ ok: false, reason: 'tenant_has_no_main_agent' })
    }
  })

  it('tenant_user of a tenant that does not exist reaches nothing', () => {
    for (const to of TARGETS) {
      expect(isRouteAllowed({ senderClass: 'tenant_user', senderId: 'u', tenantId: 'tenant-ghost', toAgent: to }, ctx).ok).toBe(false)
    }
  })

  it('partner_sender of a tenant without a main agent still reaches that tenant\'s enabled agents only', () => {
    expect(allowedTargets({ senderClass: 'partner_sender', senderId: 'p', tenantId: 'tenant-nomain' })).toEqual(['lonely'])
  })

  it('accepts the tenant agent list as an array too', () => {
    const arrayCtx: RoutingContext = { ...ctx, tenantAgentIds: (t) => TENANTS[t]?.agents ?? [] }
    expect(isRouteAllowed({ senderClass: 'partner_sender', senderId: 'p', tenantId: 'tenant-1', toAgent: 'helper-t1' }, arrayCtx).ok).toBe(true)
    expect(isRouteAllowed({ senderClass: 'partner_sender', senderId: 'p', tenantId: 'tenant-1', toAgent: 'helper-t2' }, arrayCtx).ok).toBe(false)
  })
})

describe('isRouteAllowed: refusal reasons are specific (they go into the audit row)', () => {
  const reasonOf = (req: RouteRequest): RouteRefusal | 'ok' => {
    const d = isRouteAllowed(req, ctx)
    return d.ok ? 'ok' : d.reason
  }

  it('names the cell that refused', () => {
    expect(reasonOf({ senderClass: 'owner', senderId: 'o', tenantId: 'default', toAgent: 'main-t1' })).toBe('target_not_owner_main_agent')
    expect(reasonOf({ senderClass: 'partner_sender', senderId: 'p', tenantId: 'tenant-1', toAgent: 'main-t2' })).toBe('target_not_in_tenant')
    expect(reasonOf({ senderClass: 'fleet_agent', senderId: 'fleet-z', tenantId: 'default', toAgent: 'main-a' })).toBe('not_trusted_peer')
    expect(reasonOf({ senderClass: 'federated', senderId: 'peer/agent', tenantId: null, toAgent: 'stranger' })).toBe('federated_target_not_advertised')
  })
})
