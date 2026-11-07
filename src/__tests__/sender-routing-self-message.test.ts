// The fleet_agent self-message rule of the sender routing gate (judgeRoute), against the REAL gate: the route
// (POST /api/messages), the delivery gate and the verdict function, over a real in-memory database. Nothing in
// the decision path is mocked except the setting, the config constants and the agent lookups (neutral fixtures:
// main-a, agent-a, agent-d, tenant-x, ...). The table (sender-routing.ts) and the peer relation (team-trust.ts)
// are untouched: the from === to = false invariant of the wrap classification stays pinned in team-trust.test.ts
// ('returns false for a self-loop'), and the table cell for a non-peer pair stays pinned here too.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

let MODE: string | undefined
const KNOWN = new Set(['main-a', 'agent-d', 'agent-a', 'main-t', 'agent-t'])

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
  SYSTEM_SENDER_IDS: 'ext-sys',
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  isKnownAgent: (name: string) => KNOWN.has(name),
  listAgentNames: () => ['agent-d', 'agent-a', 'agent-t'],
}))
vi.mock('../web/agent-team.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-team.js')>()),
  // agent-a reports to agent-d: the one direct reportsTo pair of the fixture.
  readAgentTeam: (name: string) => ({
    role: 'member', reportsTo: name === 'agent-a' ? 'agent-d' : null, delegatesTo: [], autoDelegation: false,
  }),
}))

import { initDatabase, getDb, createAgentMessage, getAgentMessage } from '../db.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import {
  buildRoutingContext, gateDeliveryBatch, judgeRoute, type SenderIdentity,
} from '../web/sender-routing-wire.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  for (const [id, main] of [['default', 'main-a'], ['tenant-x', 'main-t']] as const) {
    db.prepare('INSERT OR REPLACE INTO tenants (id, display_name, created_at, main_agent_id) VALUES (?, ?, ?, ?)').run(id, id, now, main)
  }
  db.prepare('INSERT OR REPLACE INTO tenant_agent_availability (tenant_id, agent_id, enabled, updated_at) VALUES (?, ?, 1, ?)').run('default', 'agent-d', now)
  db.prepare('INSERT OR REPLACE INTO tenant_agent_availability (tenant_id, agent_id, enabled, updated_at) VALUES (?, ?, 1, ?)').run('default', 'agent-a', now)
  db.prepare('INSERT OR REPLACE INTO partner_senders (sender_id, tenant_id, display_name, created_by) VALUES (?, ?, ?, ?)').run('partner-bot', 'tenant-x', 'p', 'test')
})
beforeEach(() => { MODE = undefined })

const auditRows = () => (getDb().prepare("SELECT agent_id, entity_id, detail FROM agent_audit_log WHERE action = 'sender_route_checked' ORDER BY id").all() as { agent_id: string; entity_id: string | null; detail: string }[])
  .map((r) => ({ ...r, d: JSON.parse(r.detail) as Record<string, unknown> }))
const clearAudit = () => getDb().prepare("DELETE FROM agent_audit_log WHERE action = 'sender_route_checked'").run()
const count = () => (getDb().prepare('SELECT COUNT(*) AS c FROM agent_messages').get() as { c: number }).c

type Principal = { opts: Partial<RouteContext>; from: string }
const fleet = (agent: string): Principal => ({
  from: agent,
  opts: { role: 'fleet_agent', tokenAgentId: agent, auth: { kind: 'token', tokenName: agent } as RouteContext['auth'] },
})

async function post(p: Principal, to: string): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const buf = Buffer.from(JSON.stringify({ from: p.from, to, content: `note ${p.from} ${to}` }))
  const req = new EventEmitter() as any // eslint-disable-line @typescript-eslint/no-explicit-any
  req.method = 'POST'
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any } // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any // eslint-disable-line @typescript-eslint/no-explicit-any
  const url = new URL('http://localhost:3420/api/messages')
  const ctx = { req, res, path: url.pathname, method: 'POST', url, ...p.opts } as RouteContext
  await tryHandleMessages(ctx)
  return out
}

describe('POST /api/messages: a fleet agent writing to itself', () => {
  for (const mode of ['audit', 'enforce'] as const) {
    it(`${mode} mode: 200, one message written, audit row ok:true with no reason and denied:false`, async () => {
      MODE = mode
      clearAudit()
      const before = count()
      const out = await post(fleet('agent-a'), 'agent-a')
      expect(out.status).toBe(200)
      expect(count()).toBe(before + 1)
      const rows = auditRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].d).toMatchObject({
        stage: 'route', mode, lane: 'routed', senderClass: 'fleet_agent', from: 'agent-a', to: 'agent-a', ok: true, reason: null, denied: false,
      })
    })
  }

  it('the main agent writing to itself passes too (it is a fleet_agent of the fleet)', async () => {
    MODE = 'enforce'
    const out = await post(fleet('main-a'), 'main-a')
    expect(out.status).toBe(200)
  })

  it('a pair that is not a trusted peer is still refused in enforce mode (not_trusted_peer, 403, nothing written)', async () => {
    MODE = 'enforce'
    clearAudit()
    const before = count()
    const out = await post(fleet('agent-a'), 'agent-t')
    expect(out.status).toBe(403)
    expect(count()).toBe(before)
    expect(auditRows()[0].d).toMatchObject({ ok: false, reason: 'not_trusted_peer', denied: true })
  })

  it('a direct reportsTo pair is allowed in both directions at route level (the hierarchy needs no code, it is pinned)', async () => {
    MODE = 'enforce'
    expect((await post(fleet('agent-a'), 'agent-d')).status).toBe(200)
    expect((await post(fleet('agent-d'), 'agent-a')).status).toBe(200)
  })
})

describe('judgeRoute: the exception belongs to the fleet_agent class alone', () => {
  const id = (senderClass: SenderIdentity['senderClass'], senderId: string, tenantId: string | null = null): SenderIdentity => ({
    lane: 'routed', senderClass, senderId, tenantId,
  })

  it('a fleet_agent writing to its own name is ok in both modes, and the verdict carries no deny', async () => {
    const ctx = await buildRoutingContext()
    for (const mode of ['audit', 'enforce'] as const) {
      const v = judgeRoute(id('fleet_agent', 'agent-a'), 'agent-a', ctx, mode)
      expect(v.decision).toEqual({ ok: true })
      expect(v.deny).toBe(false)
    }
  })

  it('owner, partner sender, tenant user, federated and an unclassified sender get NO self-message pass', async () => {
    const ctx = await buildRoutingContext()
    // The owner name is the sender AND the recipient name: the table still asks for the owner main agent.
    expect(judgeRoute(id('owner', 'test-owner'), 'test-owner', ctx, 'enforce')).toMatchObject({ deny: true, decision: { ok: false, reason: 'target_not_owner_main_agent' } })
    expect(judgeRoute(id('partner_sender', 'partner-bot', 'tenant-x'), 'partner-bot', ctx, 'enforce')).toMatchObject({ deny: true, decision: { ok: false, reason: 'target_not_in_tenant' } })
    expect(judgeRoute(id('tenant_user', 'user-x', 'tenant-x'), 'user-x', ctx, 'enforce')).toMatchObject({ deny: true, decision: { ok: false, reason: 'target_not_tenant_main_agent' } })
    expect(judgeRoute(id('federated', 'peer/agent-x'), 'peer/agent-x', ctx, 'enforce').decision.ok).toBe(false)
    expect(judgeRoute(id('unknown_sender_class', 'agent-a'), 'agent-a', ctx, 'enforce')).toMatchObject({ deny: true, decision: { ok: false, reason: 'unknown_sender_class' } })
  })

  it('a non-peer fleet_agent pair is still not_trusted_peer', async () => {
    const ctx = await buildRoutingContext()
    expect(judgeRoute(id('fleet_agent', 'agent-a'), 'agent-t', ctx, 'enforce')).toMatchObject({ deny: true, decision: { ok: false, reason: 'not_trusted_peer' } })
  })

  it('an empty recipient is never a self-message, whatever the sender id is', async () => {
    const ctx = await buildRoutingContext()
    expect(judgeRoute(id('fleet_agent', ''), '', ctx, 'enforce').decision).toMatchObject({ ok: false, reason: 'empty_target' })
    expect(judgeRoute(id('fleet_agent', 'agent-a'), '::', ctx, 'enforce').decision.ok).toBe(false)
  })

  it('the recipient is sanitized before the comparison: a recipient with stray characters is the same name', async () => {
    const ctx = await buildRoutingContext()
    expect(judgeRoute(id('fleet_agent', 'agent-a'), ' agent-a\n', ctx, 'enforce').decision).toEqual({ ok: true })
  })

  it('the sender id is sanitized too, so an identity built by another path compares as the same name', async () => {
    const ctx = await buildRoutingContext()
    expect(judgeRoute(id('fleet_agent', 'agent-a '), 'agent-a', ctx, 'enforce').decision).toEqual({ ok: true })
  })

  it('the names are compared exactly after sanitizing: a case variant is a different name, not a self-message', async () => {
    const ctx = await buildRoutingContext()
    expect(judgeRoute(id('fleet_agent', 'agent-a'), 'Agent-A', ctx, 'enforce').decision.ok).toBe(false)
  })

  it('the system lane is untouched: always ok, regardless of the names', async () => {
    const ctx = await buildRoutingContext()
    const sys: SenderIdentity = { lane: 'system', senderClass: 'system', senderId: 'ext-sys', tenantId: null }
    expect(judgeRoute(sys, 'agent-t', ctx, 'enforce')).toMatchObject({ lane: 'system', deny: false, decision: { ok: true } })
  })
})

describe('the delivery gate: the same rule, from the stored row', () => {
  const row = async (from: string, to: string, tenant = 'default') => createAgentMessage(from, to, `c ${from} ${to}`, null, null, tenant)
  const statusOf = async (id: number) => (await getAgentMessage(id)) as { status: string; refused_reason: string | null }

  it('enforce mode: an agent-to-itself row is kept and stays open; an owner or partner self-row is refused', async () => {
    MODE = 'enforce'
    const self = await row('agent-a', 'agent-a')
    const ownerSelf = await row('test-owner', 'test-owner')
    const partnerSelf = await row('partner-bot', 'partner-bot', 'tenant-x')
    const kept = await gateDeliveryBatch([self, ownerSelf, partnerSelf])
    expect(kept.map((m) => m.id)).toEqual([self.id])
    expect((await statusOf(self.id)).status).toBe('pending')
    expect((await statusOf(ownerSelf.id)).refused_reason).toBe('sender_route_target_not_owner_main_agent')
    expect((await statusOf(partnerSelf.id)).refused_reason).toBe('sender_route_target_not_in_tenant')
  })

  it('a stored recipient with stray characters still matches the sender (the recipient is sanitized in the verdict)', async () => {
    MODE = 'enforce'
    const self = await row('agent-a', 'agent-a ')
    const kept = await gateDeliveryBatch([self])
    expect(kept.map((m) => m.id)).toEqual([self.id])
    expect((await statusOf(self.id)).status).toBe('pending')
  })

  it('a self-row writes no delivery audit row (an allowed routed message is audited by the route only)', async () => {
    MODE = 'enforce'
    clearAudit()
    const self = await row('agent-a', 'agent-a')
    await gateDeliveryBatch([self])
    expect(auditRows()).toHaveLength(0)
  })

  it('a non-peer pair row is refused as before', async () => {
    MODE = 'enforce'
    const deny = await row('agent-a', 'agent-t')
    expect(await gateDeliveryBatch([deny])).toEqual([])
    expect((await statusOf(deny.id)).refused_reason).toBe('sender_route_not_trusted_peer')
  })
})
