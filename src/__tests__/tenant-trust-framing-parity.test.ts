// The tenant rule of the trust graph on the REAL delivery path: the real message router tick, the real delivery gate
// (real tenant tables in an in-memory database), the real classification and the real wrapping. Only the tmux layer
// is faked (a session that is always there and always ready; the prompt that would be typed into it is captured).
//
// Parity: for every pair, the routing verdict (enforce: delivered or refused) and the framing (audit: <trusted-peer>
// or <untrusted>) answer the same. A pair the rule covers is delivered AND framed as a trusted peer; a pair it does
// not cover is refused (not_trusted_peer) in enforce mode AND framed as untrusted in audit mode. All names are neutral.
//
//   tenant-x: main tx-main, enabled: ag-1, ag-2, shared, tw-main, and ag-off (DISABLED)
//   tenant-y: main ty-main, enabled: ag-3, shared
//   tenant-w: main tw-main
//   default : main main-a, enabled: ag-d1, ag-d2

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

let MODE: string | undefined
const KNOWN = new Set(['main-a', 'tx-main', 'ty-main', 'tw-main', 'ag-1', 'ag-2', 'ag-3', 'shared', 'ag-off', 'ag-d1', 'ag-d2', 'solo'])
const sent: Array<{ session: string; text: string }> = []

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
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  isKnownAgent: (name: string) => KNOWN.has(name),
  listAgentNames: () => [...KNOWN],
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
}))
vi.mock('../web/agent-team.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-team.js')>()),
  readAgentTeam: () => ({ role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false }),
}))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: () => true,
  clearStaleParkedInput: () => false,
  sendPromptToSession: (session: string, text: string) => { sent.push({ session, text }); return Promise.resolve(undefined) },
  sessionExistsOnHost: () => true,
}))
vi.mock('../web/voice-directive.js', () => ({ resolveAgentChannelStateDir: () => '/tmp/none' }))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))

import { initDatabase, getDb, createAgentMessage, getAgentMessage } from '../db.js'
import * as dbObservability from '../db/observability.js'
import { runMessageRouterTick } from '../web/message-router.js'

const avail = (tenant: string, agent: string, enabled = 1) => getDb()
  .prepare('INSERT OR REPLACE INTO tenant_agent_availability (tenant_id, agent_id, enabled, updated_at) VALUES (?, ?, ?, 1)').run(tenant, agent, enabled)

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  const db = getDb()
  for (const [id, main] of [['default', 'main-a'], ['tenant-x', 'tx-main'], ['tenant-y', 'ty-main'], ['tenant-w', 'tw-main']] as const) {
    db.prepare('INSERT OR REPLACE INTO tenants (id, display_name, created_at, main_agent_id) VALUES (?, ?, 1, ?)').run(id, id, main)
  }
  for (const a of ['ag-1', 'ag-2', 'shared', 'tw-main']) avail('tenant-x', a)
  avail('tenant-x', 'ag-off', 0)
  for (const a of ['ag-3', 'shared']) avail('tenant-y', a)
  for (const a of ['ag-d1', 'ag-d2']) avail('default', a)
})
beforeEach(() => {
  MODE = undefined
  sent.length = 0
  getDb().prepare('DELETE FROM agent_messages').run()
})

// [from, to, covered by the tenant rule]. The recipients are sub-agents: the main agent takes the pull path, not the router.
const PAIRS: ReadonlyArray<readonly [string, string, boolean]> = [
  ['tx-main', 'ag-1', true],
  ['ag-1', 'tx-main', true],
  ['ag-2', 'tx-main', true],
  ['shared', 'tx-main', true],
  ['shared', 'ty-main', true],
  ['ty-main', 'shared', true],
  ['tx-main', 'tw-main', true],
  ['tw-main', 'tx-main', true],
  ['ag-1', 'ag-2', false],
  ['ag-1', 'ag-3', false],
  ['ag-1', 'shared', false],
  ['tx-main', 'ag-3', false],
  ['ty-main', 'ag-1', false],
  ['tx-main', 'ty-main', false],
  ['ty-main', 'tw-main', false],
  ['tx-main', 'ag-off', false],
  ['tx-main', 'solo', false],
  ['ag-d1', 'ag-d2', false],
]

async function deliverAll(): Promise<Array<{ id: number; from: string; to: string; covered: boolean }>> {
  const rows = []
  for (const [from, to, covered] of PAIRS) {
    const m = await createAgentMessage(from, to, `payload ${from} to ${to}`, null, null, 'default')
    rows.push({ id: m.id, from, to, covered })
  }
  await runMessageRouterTick()
  return rows
}

/** The frame the prompt of message `id` was typed with: trusted, untrusted, or null when it was not typed at all. */
function frameOf(id: number, from: string): 'trusted' | 'untrusted' | null {
  const hit = sent.find((s) => s.text.includes(`msg_id:${id}`))
  if (!hit) return null
  if (hit.text.includes(`<trusted-peer source="agent:${from}">`)) return 'trusted'
  if (hit.text.includes(`<untrusted source="agent:${from}">`)) return 'untrusted'
  throw new Error(`message ${id} was typed without a recognisable frame`)
}

describe('the router, the gate and the framing agree on every pair (real tenant tables)', () => {
  it('audit: every message is delivered; a pair the tenant rule covers is framed <trusted-peer>, any other <untrusted>', async () => {
    MODE = 'audit'
    const rows = await deliverAll()
    for (const r of rows) {
      expect(frameOf(r.id, r.from), `${r.from} -> ${r.to}`).toBe(r.covered ? 'trusted' : 'untrusted')
    }
  })

  it('enforce: a pair the tenant rule covers is delivered, framed <trusted-peer>; any other is refused (not_trusted_peer) and never typed', async () => {
    MODE = 'enforce'
    const rows = await deliverAll()
    for (const r of rows) {
      const stored = (await getAgentMessage(r.id)) as { status: string; refused_reason: string | null }
      if (r.covered) {
        expect(frameOf(r.id, r.from), `${r.from} -> ${r.to}`).toBe('trusted')
        expect(stored.status, `${r.from} -> ${r.to}`).toBe('delivered')
      } else {
        expect(frameOf(r.id, r.from), `${r.from} -> ${r.to}`).toBeNull()
        expect(stored, `${r.from} -> ${r.to}`).toMatchObject({ status: 'failed', refused_reason: 'sender_route_not_trusted_peer' })
      }
    }
  })

  it('parity: the pairs delivered under enforce are exactly the pairs framed as trusted under audit', async () => {
    MODE = 'audit'
    const audit = await deliverAll()
    const trustedInAudit = audit.filter((r) => frameOf(r.id, r.from) === 'trusted').map((r) => `${r.from}>${r.to}`).sort()
    sent.length = 0
    getDb().prepare('DELETE FROM agent_messages').run()
    MODE = 'enforce'
    const enforce = await deliverAll()
    const deliveredInEnforce = enforce.filter((r) => frameOf(r.id, r.from) !== null).map((r) => `${r.from}>${r.to}`).sort()
    expect(deliveredInEnforce).toEqual(trustedInAudit)
    expect(trustedInAudit.length).toBe(PAIRS.filter(([, , covered]) => covered).length)
  })

  it('audit, tenant tables unreadable: the message is still delivered (audit withholds nothing) and framed by the older rules alone, so a tenant pair is <untrusted>', async () => {
    MODE = 'audit'
    const m = await createAgentMessage('tx-main', 'ag-1', 'blind tick', null, null, 'default')
    const spy = vi.spyOn(dbObservability, 'listTenants').mockRejectedValue(new Error('db down'))
    try {
      await runMessageRouterTick()
    } finally {
      spy.mockRestore()
    }
    expect(frameOf(m.id, 'tx-main')).toBe('untrusted')
    expect(((await getAgentMessage(m.id)) as { status: string }).status).toBe('delivered')
  })

  it('enforce, tenant tables unreadable: nothing is typed, the row stays pending and is delivered, trusted, once the tables are readable', async () => {
    MODE = 'enforce'
    const m = await createAgentMessage('tx-main', 'ag-1', 'blind tick', null, null, 'default')
    const spy = vi.spyOn(dbObservability, 'listTenants').mockRejectedValue(new Error('db down'))
    try {
      await runMessageRouterTick()
    } finally {
      spy.mockRestore()
    }
    expect(frameOf(m.id, 'tx-main')).toBeNull()
    expect(((await getAgentMessage(m.id)) as { status: string }).status).toBe('pending')
    await runMessageRouterTick()
    expect(frameOf(m.id, 'tx-main')).toBe('trusted')
  })

  it('a change of the tenant tables is picked up by the next tick, for the routing and the framing alike', async () => {
    avail('tenant-x', 'ag-off', 1)
    try {
      MODE = 'audit'
      const m = await createAgentMessage('tx-main', 'ag-off', 'now enabled', null, null, 'default')
      await runMessageRouterTick()
      expect(frameOf(m.id, 'tx-main')).toBe('trusted')
    } finally {
      avail('tenant-x', 'ag-off', 0)
    }
    sent.length = 0
    const again = await createAgentMessage('tx-main', 'ag-off', 'disabled again', null, null, 'default')
    await runMessageRouterTick()
    expect(frameOf(again.id, 'tx-main')).toBe('untrusted')
  })
})
