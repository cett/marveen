// The sender routing rule wired into POST /api/messages and the delivery gate, against a real in-memory
// database. The decision table itself is pinned cell by cell in sender-routing.test.ts; this file pins what
// the wiring adds: the mode switch (code default audit, unknown value audit), the sender class worked out
// from the principal, the system lane, the audit rows, the refusal at delivery time and the one-read context.
// All fixtures are neutral (main-a, agent-d, tenant-x, ...): no real agent, tenant or user names.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

let MODE: string | undefined
const KNOWN = new Set(['main-a', 'agent-d', 'agent-a', 'agent-u', 'main-t', 'agent-t', 'agent-p'])

vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) => {
      if (key !== 'SENDER_ROUTING_MODE') return actual.getEffectiveSettingValue(key)
      if (MODE === '__throw__') throw new Error('setting unreadable')
      return MODE ?? 'audit'
    },
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
  listAgentNames: () => ['agent-d', 'agent-a', 'agent-t', 'heartbeat'],
}))
vi.mock('../web/agent-team.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-team.js')>()),
  readAgentTeam: () => ({ role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false }),
}))

import { getSettingDefinition } from '../config-registry.js'
import { initDatabase, getDb, createAgentMessage, getAgentMessage } from '../db.js'
import { COORDINATOR_AGENT_ID } from '../channel-coordinator/ingest.js'
import * as dbAgents from '../db/agents.js'
import * as dbObservability from '../db/observability.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { buildRoutingContext, classifyDeliverySender, classifyRouteSender, gateDeliveryBatch, getSenderRoutingMode } from '../web/sender-routing-wire.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  for (const [id, main] of [['default', 'main-a'], ['tenant-x', 'main-t'], ['partner-1', 'agent-p']] as const) {
    db.prepare('INSERT OR REPLACE INTO tenants (id, display_name, created_at, main_agent_id) VALUES (?, ?, ?, ?)').run(id, id, now, main)
  }
  db.prepare('INSERT OR REPLACE INTO tenant_agent_availability (tenant_id, agent_id, enabled, updated_at) VALUES (?, ?, 1, ?)').run('tenant-x', 'agent-t', now)
  db.prepare('INSERT OR REPLACE INTO tenant_agent_availability (tenant_id, agent_id, enabled, updated_at) VALUES (?, ?, 1, ?)').run('default', 'agent-d', now)
  db.prepare('INSERT OR REPLACE INTO partner_senders (sender_id, tenant_id, display_name, created_by) VALUES (?, ?, ?, ?)').run('partner-bot', 'tenant-x', 'p', 'test')
})
beforeEach(() => { MODE = undefined })

const count = () => (getDb().prepare('SELECT COUNT(*) AS c FROM agent_messages').get() as { c: number }).c
const auditRows = () => (getDb().prepare("SELECT agent_id, entity_id, detail FROM agent_audit_log WHERE action = 'sender_route_checked' ORDER BY id").all() as { agent_id: string; entity_id: string | null; detail: string }[])
  .map((r) => ({ ...r, d: JSON.parse(r.detail) as Record<string, unknown> }))
const clearAudit = () => getDb().prepare("DELETE FROM agent_audit_log WHERE action = 'sender_route_checked'").run()

type Principal = { name: string; opts: Partial<RouteContext>; from: string }
const PRINCIPALS: Record<string, Principal> = {
  owner: { name: 'owner', from: 'test-owner', opts: { role: 'admin', auth: { kind: 'session', user: 'op' } as RouteContext['auth'] } },
  fleet: { name: 'fleet', from: 'agent-a', opts: { role: 'fleet_agent', tokenAgentId: 'agent-a', auth: { kind: 'token', tokenName: 'agent-a' } as RouteContext['auth'] } },
  partner: { name: 'partner', from: 'partner-bot', opts: { role: 'viewer', tenantId: 'tenant-x', auth: { kind: 'token', tokenName: 'px' } as RouteContext['auth'] } },
  sharedTokenAgent: { name: 'sharedTokenAgent', from: 'agent-a', opts: { role: 'admin', auth: { kind: 'token' } as RouteContext['auth'] } },
  system: { name: 'system', from: 'ext-sys', opts: { role: 'admin', auth: { kind: 'token' } as RouteContext['auth'] } },
}
const TARGETS = ['main-a', 'agent-d', 'main-t', 'agent-t', 'agent-p'] as const

async function post(p: Principal, to: string): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const buf = Buffer.from(JSON.stringify({ from: p.from, to, content: `hello ${p.name} ${to}` }))
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

// Which cells the table allows (the rest is refused in enforce mode).
const ALLOWED: Record<string, readonly string[]> = {
  owner: ['main-a'],
  fleet: ['main-a'],              // the main agent is an implicit trusted peer of every fleet agent
  partner: ['main-t', 'agent-t'], // the partner tenant's main agent and its enabled agent
  sharedTokenAgent: [],           // a bearer that cannot be pinned to one agent: no class from a claimed `from`
  system: TARGETS,                // the system lane never meets the table
}

describe('the mode switch', () => {
  it('the code default is audit, and so is every value that is not exactly enforce', () => {
    for (const v of [undefined, '', 'audit', 'AUDIT', 'enforced', 'on', '1', 'true', 'shadow', 'enforce!', '__throw__']) {
      MODE = v
      expect(getSenderRoutingMode(), String(v)).toBe('audit')
    }
    MODE = 'enforce'
    expect(getSenderRoutingMode()).toBe('enforce')
    MODE = ' Enforce '
    expect(getSenderRoutingMode()).toBe('enforce')
  })
})

describe('the registry entry', () => {
  it('SENDER_ROUTING_MODE is registered with the code default audit and exactly the two values', () => {
    const def = getSettingDefinition('SENDER_ROUTING_MODE')
    expect(def).toBeDefined()
    expect(def!.default).toBe('audit')
    expect(def!.valueSet).toEqual(['audit', 'enforce'])
    expect(def!.requiresRestart).toBe(false)
  })
})

describe('POST /api/messages, audit mode: the answer of every cell is the one it always was', () => {
  for (const key of Object.keys(PRINCIPALS)) {
    for (const to of TARGETS) {
      it(`${key} -> ${to}: 200 and one message written, whatever the table says`, async () => {
        MODE = 'audit'
        const before = count()
        const out = await post(PRINCIPALS[key], to)
        expect(out.status).toBe(200)
        expect(count()).toBe(before + 1)
      })
    }
  }
  it('an unknown recipient is the 400 it was, before any routing verdict', async () => {
    MODE = 'enforce'
    clearAudit()
    const before = count()
    const out = await post(PRINCIPALS.owner, 'nope-x')
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(count()).toBe(before)
    expect(auditRows()).toHaveLength(0)
  })
  it('audit mode writes a sender_route_checked row per message with class, lane, reason and denied=false', async () => {
    MODE = 'audit'
    clearAudit()
    await post(PRINCIPALS.owner, 'agent-d')
    const rows = auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].d).toMatchObject({ stage: 'route', mode: 'audit', lane: 'routed', senderClass: 'owner', to: 'agent-d', ok: false, reason: 'target_not_owner_main_agent', denied: false })
  })
})

describe('POST /api/messages, enforce mode', () => {
  for (const key of Object.keys(PRINCIPALS)) {
    for (const to of TARGETS) {
      const allowed = ALLOWED[key].includes(to)
      it(`${key} -> ${to}: ${allowed ? 'allowed, unchanged' : '403, nothing written, audited as denied'}`, async () => {
        MODE = 'enforce'
        clearAudit()
        const before = count()
        const out = await post(PRINCIPALS[key], to)
        if (allowed) {
          expect(out.status).toBe(200)
          expect(count()).toBe(before + 1)
          expect(auditRows()[0].d.denied).toBe(false)
        } else {
          expect(out.status).toBe(403)
          expect(out.body).toEqual({ error: 'forbidden', code: 'sender_route_denied', hint: 'target not permitted for this sender' })
          expect(count()).toBe(before)
          const row = auditRows()[0]
          expect(row.d.denied).toBe(true)
          expect(typeof row.d.reason).toBe('string')
        }
      })
    }
  }
  it('the refusal body never says who is allowed and carries no reason', async () => {
    MODE = 'enforce'
    const out = await post(PRINCIPALS.owner, 'agent-d')
    const text = JSON.stringify(out.body)
    for (const leak of ['main-a', 'agent-d', 'target_not_owner_main_agent', 'owner']) expect(text).not.toContain(leak)
  })
  it('enforce mode with a context that cannot be read: 500, nothing written; audit mode lets the message through', async () => {
    const spy = vi.spyOn(dbObservability, 'listTenants').mockRejectedValue(new Error('db down'))
    const before = count()
    MODE = 'enforce'
    const denied = await post(PRINCIPALS.owner, 'main-a')
    expect(denied.status).toBe(500)
    expect(denied.body.error).toBe('internal_error')
    expect(count()).toBe(before)
    MODE = 'audit'
    expect((await post(PRINCIPALS.owner, 'agent-d')).status).toBe(200)
    expect(count()).toBe(before + 1)
    spy.mockRestore()
  })
  it('the system lane passes in enforce mode and is audited as lane system', async () => {
    MODE = 'enforce'
    clearAudit()
    expect((await post(PRINCIPALS.system, 'agent-d')).status).toBe(200)
    expect(auditRows()[0].d).toMatchObject({ lane: 'system', senderClass: 'system', denied: false })
  })
    it('the class comes from the principal: a forged owner or agent name on a partner token does not raise it', async () => {
    MODE = 'enforce'
    // a partner token claiming to be the owner or a fleet agent is stopped by the partner allowlist (403) before routing
    expect((await post({ name: 'x', from: 'test-owner', opts: PRINCIPALS.partner.opts }, 'main-a')).status).toBe(403)
    expect((await post({ name: 'y', from: 'agent-a', opts: PRINCIPALS.partner.opts }, 'main-a')).status).toBe(403)
  })
  it('a fleet_agent token is pinned to its own agent whatever the body says', async () => {
    MODE = 'enforce'
    const out = await post({ name: 'z', from: 'main-a', opts: PRINCIPALS.fleet.opts }, 'main-t')
    expect(out.status).toBe(403) // from differs from the agent of the token (existing guard)
  })
})

describe('the sender class from the principal (pure)', () => {
  const base = { role: 'admin', authKind: 'token', tenantId: null, tokenAgentId: null, boundAgent: null, safeFrom: 'x', isPartnerTenant: false }
  it('each rule, and the default-deny at the end', () => {
    expect(classifyRouteSender({ ...base, safeFrom: 'test-owner' }).senderClass).toBe('owner')
    expect(classifyRouteSender({ ...base, safeFrom: 'scheduler' })).toMatchObject({ lane: 'system', senderClass: 'system' })
    expect(classifyRouteSender({ ...base, safeFrom: 'agent-a', boundAgent: 'agent-a' })).toMatchObject({ senderClass: 'fleet_agent', senderId: 'agent-a' })
    expect(classifyRouteSender({ ...base, safeFrom: 'agent-d', boundAgent: 'agent-a' }).senderClass).toBe('unknown_sender_class')
    expect(classifyRouteSender({ ...base, safeFrom: 'agent-a' }).senderClass).toBe('unknown_sender_class')
    expect(classifyRouteSender({ ...base, role: 'fleet_agent', tokenAgentId: 'agent-a', safeFrom: 'whatever' })).toMatchObject({ senderClass: 'fleet_agent', senderId: 'agent-a' })
    expect(classifyRouteSender({ ...base, role: 'viewer', tenantId: 'tenant-x', isPartnerTenant: true, safeFrom: 'partner-bot' })).toMatchObject({ senderClass: 'partner_sender', tenantId: 'tenant-x' })
    // a tenant-bound caller the partner allowlist did not accept has no path: no class
    expect(classifyRouteSender({ ...base, role: 'viewer', tenantId: 'tenant-x', isPartnerTenant: false, safeFrom: 'someone' }).senderClass).toBe('unknown_sender_class')
    expect(classifyRouteSender({ ...base, role: 'viewer', safeFrom: 'test-owner' }).senderClass).toBe('unknown_sender_class')
  })
})

describe('the delivery gate (router tick, reconnect backlog, inbox pull) on stored rows', () => {
  const row = async (from: string, to: string, tenant = 'default') => createAgentMessage(from, to, `c ${from} ${to}`, null, null, tenant)
  const statusOf = async (id: number) => (await getAgentMessage(id)) as { status: string; refused_reason: string | null }

  it('audit mode returns every message and refuses nothing, but audits what the route cannot have audited', async () => {
    MODE = 'audit'
    clearAudit()
    const a = await row('test-owner', 'agent-d')
    const b = await row('peer/agent-x', 'main-t')
    const kept = await gateDeliveryBatch([a, b])
    expect(kept.map((m) => m.id)).toEqual([a.id, b.id])
    expect((await statusOf(a.id)).status).toBe('pending')
    expect((await statusOf(b.id)).status).toBe('pending')
    const rows = auditRows()
    expect(rows.map((r) => r.entity_id)).toEqual([String(a.id), String(b.id)])
    expect(rows.every((r) => r.d.stage === 'delivery' && r.d.denied === false)).toBe(true)
  })

  it('enforce mode closes a refused row as refused (status failed, refused_reason sender_route_*) and keeps the rest', async () => {
    MODE = 'enforce'
    const deny = await row('test-owner', 'agent-d')
    const ok = await row('test-owner', 'main-a')
    const kept = await gateDeliveryBatch([deny, ok])
    expect(kept.map((m) => m.id)).toEqual([ok.id])
    const closed = await statusOf(deny.id)
    expect(closed.status).toBe('failed')
    expect(closed.refused_reason).toBe('sender_route_target_not_owner_main_agent')
    expect((await statusOf(ok.id)).status).toBe('pending')
  })

  it('the channel coordinator (a direct insert that never passes the route) and platform senders pass in enforce mode, lane system', async () => {
    MODE = 'enforce'
    clearAudit()
    const c = await row(COORDINATOR_AGENT_ID, 'main-a')
    const s = await row('scheduler', 'agent-d')
    const e = await row('ext-sys', 'agent-t')
    const kept = await gateDeliveryBatch([c, s, e])
    expect(kept).toHaveLength(3)
    expect(auditRows().every((r) => r.d.lane === 'system' && r.d.denied === false)).toBe(true)
  })

  it('a federated row: the owner main agent and an advertised agent pass; another tenant, a coordinator and an unadvertised agent are refused', async () => {
    MODE = 'enforce'
    const okMain = await row('peer/a', 'main-a')
    const okAdv = await row('peer/a', 'agent-d')
    const otherTenant = await row('peer/a', 'main-t')
    const coordinator = await row('peer/a', 'heartbeat')
    const unadvertised = await row('peer/a', 'agent-u')
    const kept = await gateDeliveryBatch([okMain, okAdv, otherTenant, coordinator, unadvertised])
    expect(kept.map((m) => m.id)).toEqual([okMain.id, okAdv.id])
    expect((await statusOf(otherTenant.id)).refused_reason).toBe('sender_route_federated_target_in_other_tenant')
    expect((await statusOf(coordinator.id)).refused_reason).toBe('sender_route_federated_target_is_coordinator')
    expect((await statusOf(unadvertised.id)).refused_reason).toBe('sender_route_federated_target_not_advertised')
  })

  it('a partner row (non-default tenant, sender not an agent) reaches its own tenant only', async () => {
    MODE = 'enforce'
    const ok = await row('partner-bot', 'main-t', 'tenant-x')
    const deny = await row('partner-bot', 'main-a', 'tenant-x')
    expect((await gateDeliveryBatch([ok, deny])).map((m) => m.id)).toEqual([ok.id])
  })

  it('a message that stays pending is audited once, not on every tick', async () => {
    MODE = 'audit'
    clearAudit()
    const m = await row('test-owner', 'agent-d')
    await gateDeliveryBatch([m])
    await gateDeliveryBatch([m])
    await gateDeliveryBatch([m])
    expect(auditRows().filter((r) => r.entity_id === String(m.id))).toHaveLength(1)
  })

  it('classification from the row: slash is federated, empty is unknown, an unregistered non-tenant sender is unknown', () => {
    expect(classifyDeliverySender({ from_agent: 'peer/a' }).senderClass).toBe('federated')
    expect(classifyDeliverySender({ from_agent: '!!!' }).senderClass).toBe('unknown_sender_class')
    expect(classifyDeliverySender({ from_agent: 'stranger', tenant_id: 'default' }).senderClass).toBe('unknown_sender_class')
    expect(classifyDeliverySender({ from_agent: 'agent-a' }).senderClass).toBe('fleet_agent')
  })

  it('the context is built from ONE read of each tenant table, and the decisions after it touch no database', async () => {
    const tenants = vi.spyOn(dbObservability, 'listTenants')
    const avail = vi.spyOn(dbAgents, 'listEnabledAgentAvailability')
    MODE = 'enforce'
    const batch = await Promise.all(Array.from({ length: 8 }, (_, i) => row('test-owner', i % 2 ? 'agent-d' : 'main-a')))
    tenants.mockClear()
    avail.mockClear()
    await gateDeliveryBatch(batch)
    expect(tenants).toHaveBeenCalledTimes(1)
    expect(avail).toHaveBeenCalledTimes(1)
    tenants.mockRestore()
    avail.mockRestore()
  })

  it('when the context cannot be read: audit returns the batch untouched, enforce returns nothing and leaves the rows pending', async () => {
    const spy = vi.spyOn(dbObservability, 'listTenants').mockRejectedValue(new Error('db down'))
    const m = await row('test-owner', 'agent-d')
    MODE = 'audit'
    expect((await gateDeliveryBatch([m])).map((x) => x.id)).toEqual([m.id])
    MODE = 'enforce'
    expect(await gateDeliveryBatch([m])).toEqual([])
    expect((await statusOf(m.id)).status).toBe('pending')
    spy.mockRestore()
  })

  it('an empty batch costs no read at all', async () => {
    const tenants = vi.spyOn(dbObservability, 'listTenants')
    expect(await gateDeliveryBatch([])).toEqual([])
    expect(tenants).not.toHaveBeenCalled()
    tenants.mockRestore()
  })
})

describe('the routing context from the tenant tables', () => {
  it('owner main agent, tenant main agents, enabled agents, and the other-tenant set (a shared agent stays reachable)', async () => {
    const ctx = await buildRoutingContext()
    expect(ctx.ownerMainAgentId).toBe('main-a')
    expect(ctx.tenantMainAgentId('tenant-x')).toBe('main-t')
    expect([...ctx.tenantAgentIds('tenant-x')]).toEqual(['agent-t'])
    expect(ctx.isNonDefaultTenantAgent('main-t')).toBe(true)
    expect(ctx.isNonDefaultTenantAgent('agent-t')).toBe(true)
    expect(ctx.isNonDefaultTenantAgent('agent-d')).toBe(false)
    expect(ctx.isNonDefaultTenantAgent('main-a')).toBe(false)
    getDb().prepare('INSERT OR REPLACE INTO tenant_agent_availability (tenant_id, agent_id, enabled, updated_at) VALUES (?, ?, 1, 1)').run('tenant-x', 'agent-d')
    expect((await buildRoutingContext()).isNonDefaultTenantAgent('agent-d')).toBe(false)
    getDb().prepare("DELETE FROM tenant_agent_availability WHERE tenant_id = 'tenant-x' AND agent_id = 'agent-d'").run()
  })
})
