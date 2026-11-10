// The tenant rule of the trust graph (a non-default tenant's main agent and the agents enabled for it are mutual
// trusted peers), as the sender routing sees it: ONE snapshot of the tenant tables, from which the routing decision
// (routingContextFrom) and the framing predicate (tenantPeerFrom, handed out by the delivery gate) are derived.
// Real in-memory database, real tenant tables; the agent registry and the team config are faked.
// All fixtures are neutral: no real agent, tenant or user names.
//
//   tenant-x: main tx-main, enabled: ag-1, ag-2, shared, tw-main, unreg (not a registered agent), and ag-off (DISABLED)
//   tenant-y: main ty-main, enabled: ag-3, shared
//   tenant-w: main tw-main (an agent that is the main agent of one tenant and enabled in another)
//   default : main main-a, enabled: ag-d1, ag-d2

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

let MODE: string | undefined
const KNOWN = new Set(['main-a', 'tx-main', 'ty-main', 'tw-main', 'ag-1', 'ag-2', 'ag-3', 'shared', 'ag-off', 'ag-d1', 'ag-d2', 'solo'])

vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) => (key === 'SENDER_ROUTING_MODE' ? (MODE ?? 'audit') : actual.getEffectiveSettingValue(key)),
  }
})
vi.mock('../config.js', async (orig) => ({
  ...(await orig<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-a',
  OWNER_NAME: 'test-owner',
  SYSTEM_SENDER_IDS: '',
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  isKnownAgent: (name: string) => KNOWN.has(name),
  listAgentNames: () => [...KNOWN],
}))
vi.mock('../web/agent-team.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-team.js')>()),
  readAgentTeam: () => ({ role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false }),
}))

import { initDatabase, getDb, createAgentMessage, getAgentMessage } from '../db.js'
import * as dbAgents from '../db/agents.js'
import * as dbObservability from '../db/observability.js'
import { isRouteAllowed } from '../web/sender-routing.js'
import {
  buildRoutingContext, gateDeliveryBatch, isTrustedPeerWith, openDeliveryGate, readTenantSnapshot, routingContextFrom, tenantPeerFrom,
} from '../web/sender-routing-wire.js'

const avail = (tenant: string, agent: string, enabled = 1) => getDb()
  .prepare('INSERT OR REPLACE INTO tenant_agent_availability (tenant_id, agent_id, enabled, updated_at) VALUES (?, ?, ?, 1)').run(tenant, agent, enabled)

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  const db = getDb()
  for (const [id, main] of [['default', 'main-a'], ['tenant-x', 'tx-main'], ['tenant-y', 'ty-main'], ['tenant-w', 'tw-main']] as const) {
    db.prepare('INSERT OR REPLACE INTO tenants (id, display_name, created_at, main_agent_id) VALUES (?, ?, 1, ?)').run(id, id, main)
  }
  for (const a of ['ag-1', 'ag-2', 'shared', 'tw-main', 'unreg']) avail('tenant-x', a)
  avail('tenant-x', 'ag-off', 0)
  for (const a of ['ag-3', 'shared']) avail('tenant-y', a)
  for (const a of ['ag-d1', 'ag-d2']) avail('default', a)
})
beforeEach(() => { MODE = undefined })

// [a, b, peers by the tenant rule]. Every row is checked in BOTH orders.
const PAIRS: ReadonlyArray<readonly [string, string, boolean, string]> = [
  ['tx-main', 'ag-1', true, 'main agent and an enabled agent'],
  ['tx-main', 'ag-2', true, 'main agent and another enabled agent'],
  ['ty-main', 'ag-3', true, 'the same in another tenant'],
  ['tx-main', 'shared', true, 'a shared agent, first tenant'],
  ['ty-main', 'shared', true, 'a shared agent, second tenant'],
  ['tx-main', 'tw-main', true, 'main agent of one tenant, enabled in another: peer of the other tenant main agent'],
  ['tx-main', 'unreg', true, 'the tenant tables know the name, the agent registry does not (the trust graph guard refuses it, see the routing block)'],
  ['ag-1', 'ag-2', false, 'two plain agents of one tenant'],
  ['ag-1', 'shared', false, 'a plain agent and a shared one: no transitivity'],
  ['ag-1', 'ag-3', false, 'agents of two tenants'],
  ['tx-main', 'ty-main', false, 'the main agents of two tenants'],
  ['tx-main', 'ag-3', false, 'a main agent and an agent enabled only for another tenant'],
  ['ty-main', 'ag-1', false, 'the same the other way'],
  ['ty-main', 'tw-main', false, 'tw-main is enabled only in tenant-x, not in tenant-y'],
  ['tw-main', 'ag-1', false, 'tw-main is a main agent of tenant-w, whose agent list is empty, not a peer of tenant-x agents'],
  ['tx-main', 'ag-off', false, 'a DISABLED availability row does not count'],
  ['tx-main', 'solo', false, 'an agent in no tenant'],
  ['tx-main', 'ghost', false, 'a name the tenant tables do not know'],
  ['tx-main', 'ag-d1', false, 'an agent enabled only for the default tenant'],
  ['main-a', 'ag-d1', false, 'the default tenant adds no tenant rule (its main agent is the implicit peer through the main shortcut)'],
  ['ag-d1', 'ag-d2', false, 'two plain agents of the default tenant'],
  ['tx-main', 'tx-main', false, 'a self-loop'],
  ['tx-main', '', false, 'an empty name'],
  ['Tx-Main', 'ag-1', false, 'a variant spelling only fails to match'],
]

describe('tenantPeerFrom over a snapshot read from the real tenant tables', () => {
  for (const [a, b, expected, why] of PAIRS) {
    it(`${a} / ${b}: ${expected ? 'peers' : 'not peers'} (${why})`, async () => {
      const peer = tenantPeerFrom(await readTenantSnapshot())
      expect(peer(a, b)).toBe(expected)
      expect(peer(b, a)).toBe(expected)
    })
  }

  it('a re-read sees a change: enabling the disabled row, and disabling an enabled one', async () => {
    avail('tenant-x', 'ag-off', 1)
    avail('tenant-x', 'ag-2', 0)
    try {
      const peer = tenantPeerFrom(await readTenantSnapshot())
      expect(peer('tx-main', 'ag-off')).toBe(true)
      expect(peer('tx-main', 'ag-2')).toBe(false)
    } finally {
      avail('tenant-x', 'ag-off', 0)
      avail('tenant-x', 'ag-2', 1)
    }
  })
})

describe('the routing decision (a fleet agent, judged by the table)', () => {
  const route = (ctx: Awaited<ReturnType<typeof buildRoutingContext>>, from: string, to: string) =>
    isRouteAllowed({ senderClass: 'fleet_agent', senderId: from, tenantId: null, toAgent: to }, ctx)

  // An empty name is refused earlier still (empty_target, pinned in sender-routing.test.ts), so it has no cell here.
  for (const [a, b, expected, why] of PAIRS.filter(([x, y]) => x !== '' && y !== '')) {
    // pairs with an unknown or self end are refused by the trust graph's own guards, whatever the tenant tables say
    const known = KNOWN.has(a) && KNOWN.has(b) && a !== b
    // the default-tenant main agent is a peer of every known agent through the main shortcut, not through the tenant rule
    const viaMain = a === 'main-a' || b === 'main-a'
    const allowed = known && (expected || viaMain)
    it(`${a} -> ${b}: ${allowed ? 'allowed' : 'not_trusted_peer'} (${why})`, async () => {
      const ctx = await buildRoutingContext()
      for (const [from, to] of [[a, b], [b, a]] as const) {
        expect(route(ctx, from, to)).toEqual(allowed ? { ok: true } : { ok: false, reason: 'not_trusted_peer' })
      }
    })
  }

  it('the tenant isolation of the routing table is untouched: a tenant user and a partner still reach only their own main agent / agents', async () => {
    const ctx = await buildRoutingContext()
    expect(isRouteAllowed({ senderClass: 'tenant_user', senderId: 'u', tenantId: 'tenant-x', toAgent: 'ag-1' }, ctx)).toEqual({ ok: false, reason: 'target_not_tenant_main_agent' })
    expect(isRouteAllowed({ senderClass: 'partner_sender', senderId: 'p', tenantId: 'tenant-x', toAgent: 'ag-3' }, ctx)).toEqual({ ok: false, reason: 'target_not_in_tenant' })
    expect(isRouteAllowed({ senderClass: 'federated', senderId: 'peer/a', tenantId: null, toAgent: 'ag-1' }, ctx)).toEqual({ ok: false, reason: 'federated_target_in_other_tenant' })
  })

  it('the context and the predicate come from the same snapshot: the same snapshot object gives the same answer', async () => {
    const snapshot = await readTenantSnapshot()
    const ctx = routingContextFrom(snapshot)
    const peer = tenantPeerFrom(snapshot)
    const framing = isTrustedPeerWith(peer)
    for (const [a, b] of PAIRS) {
      expect(ctx.isTrustedPeer(a, b), `${a} / ${b}`).toBe(framing(a, b))
      expect(ctx.isTrustedPeer(b, a), `${b} / ${a}`).toBe(framing(b, a))
    }
  })
})

describe('the delivery gate hands the framing the predicate of the snapshot it judges from', () => {
  for (const mode of ['audit', 'enforce'] as const) {
    it(`${mode}: tenantPeer answers every pair as the rule does`, async () => {
      MODE = mode
      const gate = await openDeliveryGate()
      expect(gate.open).toBe(true)
      if (!gate.open) return
      for (const [a, b, expected, why] of PAIRS) {
        expect(gate.tenantPeer(a, b), `${a} / ${b} (${why})`).toBe(expected)
        expect(gate.tenantPeer(b, a), `${b} / ${a} (${why})`).toBe(expected)
      }
    })

    it(`${mode}, snapshot unreadable: ${mode === 'enforce' ? 'the gate is closed (nothing is judged or delivered)' : 'a pass-through gate whose tenantPeer is false for every pair (stricter framing)'}`, async () => {
      MODE = mode
      const spy = vi.spyOn(dbObservability, 'listTenants').mockRejectedValue(new Error('db down'))
      try {
        const gate = await openDeliveryGate()
        if (mode === 'enforce') {
          expect(gate.open).toBe(false)
          return
        }
        expect(gate.open).toBe(true)
        if (!gate.open) return
        for (const [a, b] of PAIRS) expect(gate.tenantPeer(a, b), `${a} / ${b}`).toBe(false)
        const batch = [{ id: 1, from_agent: 'ag-1', to_agent: 'ag-2' }]
        expect(await gate.judge(batch)).toEqual(batch)
      } finally {
        spy.mockRestore()
      }
    })

    it(`${mode}, availability table unreadable: the same as an unreadable tenants table`, async () => {
      MODE = mode
      const spy = vi.spyOn(dbAgents, 'listEnabledAgentAvailability').mockRejectedValue(new Error('db down'))
      try {
        const gate = await openDeliveryGate()
        expect(gate.open).toBe(mode === 'audit')
        if (gate.open) expect(gate.tenantPeer('tx-main', 'ag-1')).toBe(false)
      } finally {
        spy.mockRestore()
      }
    })
  }

  it('opening the gate reads each tenant table ONCE, and neither the judgement nor the predicate reads again', async () => {
    const tenants = vi.spyOn(dbObservability, 'listTenants')
    const availability = vi.spyOn(dbAgents, 'listEnabledAgentAvailability')
    try {
      MODE = 'enforce'
      const gate = await openDeliveryGate()
      expect(gate.open).toBe(true)
      if (!gate.open) return
      await gate.judge([{ id: 1, from_agent: 'tx-main', to_agent: 'ag-1' }, { id: 2, from_agent: 'ag-1', to_agent: 'ag-2' }])
      for (const [a, b] of PAIRS) gate.tenantPeer(a, b)
      expect(tenants).toHaveBeenCalledTimes(1)
      expect(availability).toHaveBeenCalledTimes(1)
    } finally {
      tenants.mockRestore()
      availability.mockRestore()
    }
  })

  it('enforce, stored rows: a main agent / enabled agent pair is delivered, a pair the rule does not cover is refused', async () => {
    MODE = 'enforce'
    const mk = (from: string, to: string) => createAgentMessage(from, to, `c ${from} ${to}`, null, null, 'default')
    const ok1 = await mk('tx-main', 'ag-1')
    const ok2 = await mk('ag-1', 'tx-main')
    const ok3 = await mk('shared', 'ty-main')
    const no1 = await mk('ag-1', 'ag-2')
    const no2 = await mk('tx-main', 'ag-3')
    const no3 = await mk('ty-main', 'tx-main')
    const kept = await gateDeliveryBatch([ok1, ok2, ok3, no1, no2, no3])
    expect(kept.map((m) => m.id)).toEqual([ok1.id, ok2.id, ok3.id])
    for (const m of [no1, no2, no3]) {
      const stored = (await getAgentMessage(m.id)) as { status: string; refused_reason: string | null }
      expect(stored).toMatchObject({ status: 'failed', refused_reason: 'sender_route_not_trusted_peer' })
    }
  })
})
