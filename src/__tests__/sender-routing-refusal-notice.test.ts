// The notice to the sender of a message the DELIVERY gate refused, against the REAL gate and a real in-memory
// database: the verdict, the compare-and-set refusal and the notice row are the production code. Only the setting,
// the config constants and the agent lookups are mocked. Neutral fixtures (main-a, agent-a, agent-d, tenant-x, ...).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'

let MODE: string | undefined
const KNOWN = new Set(['main-a', 'agent-d', 'agent-a', 'main-t', 'agent-t'])

vi.mock('../settings-store.js', async (orig) => {
  const actual = await orig<typeof import('../settings-store.js')>()
  return {
    ...actual,
    getEffectiveSettingValue: (key: string) => (key === 'SENDER_ROUTING_MODE' ? (MODE ?? 'enforce') : actual.getEffectiveSettingValue(key)),
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
  readAgentTeam: () => ({ role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false }),
}))

import { initDatabase, getDb, createAgentMessage, getAgentMessage, closeOpenMessage } from '../db.js'
import { COORDINATOR_AGENT_ID } from '../channel-coordinator/ingest.js'
import {
  REFUSAL_NOTICES_PER_MINUTE, gateDeliveryBatch, resetRefusalNoticeWindows, shouldNotifyRefusedSender, type SenderIdentity,
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
  db.prepare('INSERT OR REPLACE INTO partner_senders (sender_id, tenant_id, display_name, created_by) VALUES (?, ?, ?, ?)').run('partner-bot', 'tenant-x', 'p', 'test')
})
beforeEach(() => {
  MODE = undefined
  resetRefusalNoticeWindows()
  getDb().exec('DELETE FROM agent_messages')
})
afterEach(() => { vi.useRealTimers() })

interface Msg { id: number; from_agent: string; to_agent: string; content: string; status: string; tenant_id: string }
const row = (from: string, to: string, content = 'hello', tenant = 'default') => createAgentMessage(from, to, content, null, null, tenant)
const notices = () => getDb().prepare("SELECT id, from_agent, to_agent, content, status, tenant_id FROM agent_messages WHERE from_agent = 'system' ORDER BY id").all() as Msg[]
const statusOf = async (id: number) => (await getAgentMessage(id)) as { status: string; refused_reason: string | null }

describe('a refused delivery tells its sender, once', () => {
  it('a local agent whose message was refused gets exactly one notice from `system`, with the fixed general text', async () => {
    const m = await row('agent-a', 'agent-d')
    expect(await gateDeliveryBatch([m])).toEqual([])
    expect((await statusOf(m.id)).refused_reason).toBe('sender_route_not_trusted_peer')
    const n = notices()
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ from_agent: 'system', to_agent: 'agent-a', status: 'pending', tenant_id: 'default' })
    expect(n[0].content).toBe(`[Eredmény] msg_id:${m.id} status:failed\n\nkézbesítés tiltva (küldő-szabály)`)
  })

  it('the notice carries no reason, no rule name and not the recipient', async () => {
    await gateDeliveryBatch([await row('agent-a', 'agent-d')])
    const text = notices()[0].content
    for (const leak of ['not_trusted_peer', 'sender_route', 'agent-d', 'trusted', 'allowed']) expect(text, leak).not.toContain(leak)
  })

  it('the notice itself passes the enforce gate (it is not the refused pair reversed)', async () => {
    await gateDeliveryBatch([await row('agent-a', 'agent-d')])
    const [n] = notices()
    const kept = await gateDeliveryBatch([n])
    expect(kept.map((k) => k.id)).toEqual([n.id])
    expect((await statusOf(n.id)).status).toBe('pending')
    expect(notices()).toHaveLength(1) // and it made no notice of its own
  })

  it('the same refused row judged again on a later tick gives no second notice', async () => {
    const m = await row('agent-a', 'agent-d')
    await gateDeliveryBatch([m])
    await gateDeliveryBatch([m])
    await gateDeliveryBatch([m])
    expect(notices()).toHaveLength(1)
  })

  it('a row closed in the meantime keeps its outcome and its sender hears nothing from the gate', async () => {
    const m = await row('agent-a', 'agent-d')
    expect(await closeOpenMessage(m.id, 'done', 'handled elsewhere')).toBe(true)
    expect(await gateDeliveryBatch([m])).toEqual([])
    expect((await statusOf(m.id)).status).toBe('done')
    expect(notices()).toHaveLength(0)
  })

  it('audit mode refuses nothing and says nothing', async () => {
    MODE = 'audit'
    const m = await row('agent-a', 'agent-d')
    expect((await gateDeliveryBatch([m])).map((k) => k.id)).toEqual([m.id])
    expect(notices()).toHaveLength(0)
  })

  it('an allowed message makes no notice', async () => {
    const m = await row('agent-a', 'main-a')
    await gateDeliveryBatch([m])
    expect(notices()).toHaveLength(0)
  })

  it('the notice keeps the tenant of the refused message', async () => {
    const m = await row('agent-t', 'agent-d', 'hello', 'tenant-x')
    expect(await gateDeliveryBatch([m])).toEqual([])
    const n = notices()
    expect(n).toHaveLength(1)
    expect(n[0]).toMatchObject({ to_agent: 'agent-t', tenant_id: 'tenant-x' })
  })
})

describe('who is NOT told', () => {
  it('the owner, a partner sender, a federated sender, an unregistered sender: refused, no notice', async () => {
    const rows = [
      await row('test-owner', 'agent-d'),
      await row('partner-bot', 'agent-d', 'hello', 'tenant-x'),
      await row('peer/agent-x', COORDINATOR_AGENT_ID),
      await row('ghost-x', 'agent-d'),
    ]
    expect(await gateDeliveryBatch(rows)).toEqual([])
    for (const r of rows) expect((await statusOf(r.id)).status, r.from_agent).toBe('failed')
    expect(notices()).toHaveLength(0)
  })

  it('a message that is itself a completion report is refused but starts no notice (no loop)', async () => {
    const m = await row('agent-a', 'agent-d', '[Eredmény] msg_id:1 status:done\n\nresult')
    expect(await gateDeliveryBatch([m])).toEqual([])
    expect((await statusOf(m.id)).status).toBe('failed')
    expect(notices()).toHaveLength(0)
  })

  it('shouldNotifyRefusedSender: not a self-message, not the system lane, not a non-fleet class, not a report', () => {
    const fleet: SenderIdentity = { lane: 'routed', senderClass: 'fleet_agent', senderId: 'agent-a', tenantId: null }
    expect(shouldNotifyRefusedSender(fleet, 'agent-d', 'hi')).toBe(true)
    expect(shouldNotifyRefusedSender(fleet, 'agent-a', 'hi')).toBe(false)
    expect(shouldNotifyRefusedSender(fleet, 'agent-d', '[Eredmény] x')).toBe(false)
    expect(shouldNotifyRefusedSender({ ...fleet, senderId: 'ghost-x' }, 'agent-d', 'hi')).toBe(false)
    expect(shouldNotifyRefusedSender({ ...fleet, lane: 'system', senderClass: 'system' }, 'agent-d', 'hi')).toBe(false)
    expect(shouldNotifyRefusedSender({ ...fleet, senderClass: 'owner' }, 'agent-d', 'hi')).toBe(false)
    expect(shouldNotifyRefusedSender({ ...fleet, senderClass: 'federated' }, 'agent-d', 'hi')).toBe(false)
  })
})

describe('the noise guard', () => {
  it(`at most ${REFUSAL_NOTICES_PER_MINUTE} notices per sender in a minute, then ONE summary, then none; a new minute starts over`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const rows = []
    for (let i = 0; i < REFUSAL_NOTICES_PER_MINUTE + 4; i++) rows.push(await row('agent-a', 'agent-d', `m${i}`))
    await gateDeliveryBatch(rows)
    const n = notices()
    expect(n).toHaveLength(REFUSAL_NOTICES_PER_MINUTE + 1)
    expect(n.slice(0, REFUSAL_NOTICES_PER_MINUTE).every((x) => /^\[Eredmény\] msg_id:\d+ status:failed/.test(x.content))).toBe(true)
    const summary = n[REFUSAL_NOTICES_PER_MINUTE]
    expect(summary.content.startsWith('[Eredmény] status:failed')).toBe(true) // still a completion report: it cannot start a notice
    expect(summary.content).not.toContain('msg_id')
    // every refused message was still refused
    for (const r of rows) expect((await statusOf(r.id)).status).toBe('failed')

    vi.setSystemTime(new Date('2030-01-01T00:01:01Z'))
    await gateDeliveryBatch([await row('agent-a', 'agent-d', 'later')])
    expect(notices()).toHaveLength(REFUSAL_NOTICES_PER_MINUTE + 2)
  })

  it('the limit is per sender: a second sender is not silenced by the first', async () => {
    const a = []
    for (let i = 0; i < REFUSAL_NOTICES_PER_MINUTE + 2; i++) a.push(await row('agent-a', 'agent-d', `a${i}`))
    await gateDeliveryBatch(a)
    await gateDeliveryBatch([await row('agent-t', 'agent-d', 'other')])
    expect(notices().filter((x) => x.to_agent === 'agent-t')).toHaveLength(1)
  })
})
