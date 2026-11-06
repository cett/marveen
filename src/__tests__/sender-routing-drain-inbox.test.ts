// The main-agent inbox pull (POST /api/agents/:name/drain-inbox) with the sender routing rule, against a real
// in-memory database and the real route: the claim flips a row to 'delivered', so a verdict that cannot be given
// (enforce mode, routing context unreadable) must not follow a claim. The gate is opened BEFORE the claim; without
// that, the claimed rows stayed 'delivered' and never reached the agent. All fixtures are neutral names.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

let MODE: string | undefined
const KNOWN = new Set(['main-a', 'agent-d'])

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
}))
vi.mock('../web/agent-config.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-config.js')>()),
  isKnownAgent: (name: string) => KNOWN.has(name),
  listAgentNames: () => ['agent-d'],
}))
vi.mock('../web/agent-team.js', async (orig) => ({
  ...(await orig<typeof import('../web/agent-team.js')>()),
  readAgentTeam: () => ({ role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false }),
}))

import { initDatabase, getDb, createAgentMessage, getAgentMessage } from '../db.js'
import * as dbObservability from '../db/observability.js'
import { tryHandleAgentsProcess } from '../web/routes/agents-process.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare('INSERT OR REPLACE INTO tenants (id, display_name, created_at, main_agent_id) VALUES (?, ?, ?, ?)').run('default', 'default', now, 'main-a')
  getDb().prepare('INSERT OR REPLACE INTO tenant_agent_availability (tenant_id, agent_id, enabled, updated_at) VALUES (?, ?, 1, ?)').run('default', 'agent-d', now)
})
beforeEach(() => {
  MODE = undefined
  // every test starts from an empty inbox: rows a former test left over must not be claimed
  getDb().prepare("DELETE FROM agent_messages WHERE to_agent = 'main-a'").run()
})

interface Drain { status: number; body: { count: number; text: string } }
async function drain(): Promise<Drain> {
  const em = new EventEmitter()
  Object.assign(em, { headers: {}, method: 'POST', url: '/api/agents/main-a/drain-inbox' })
  setImmediate(() => { em.emit('end') })
  let status = 200
  let raw = ''
  const res = { writeHead: (c: number) => { status = c }, setHeader: () => {}, end: (d?: string) => { raw = d ?? '' } }
  const ctx = {
    req: em as unknown as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path: '/api/agents/main-a/drain-inbox',
    method: 'POST',
    url: new URL('http://localhost/api/agents/main-a/drain-inbox'),
    auth: { kind: 'token' },
  } as unknown as RouteContext
  expect(await tryHandleAgentsProcess(ctx)).toBe(true)
  return { status, body: JSON.parse(raw) }
}
const statusOf = async (id: number) => (await getAgentMessage(id)) as { status: string; refused_reason: string | null }

describe('drain-inbox with the sender routing rule', () => {
  it('enforce + unreadable context: nothing is claimed, the allowed row stays pending, and it is shown once the context is readable again', async () => {
    const allowed = await createAgentMessage('test-owner', 'main-a', 'allowed row text')
    MODE = 'enforce'
    const spy = vi.spyOn(dbObservability, 'listTenants').mockRejectedValue(new Error('db down'))
    const blind = await drain()
    expect(blind.status).toBe(200)
    expect(blind.body).toEqual({ count: 0, text: '' })
    expect((await statusOf(allowed.id)).status).toBe('pending')
    spy.mockRestore()
    const sighted = await drain()
    expect(sighted.body.count).toBe(1)
    expect(sighted.body.text).toContain('allowed row text')
    expect((await statusOf(allowed.id)).status).toBe('delivered')
    expect((await drain()).body.count).toBe(0)
  })

  it('audit + unreadable context: the claimed row is still shown (audit never withholds a message)', async () => {
    const row = await createAgentMessage('test-owner', 'main-a', 'audit mode row text')
    MODE = 'audit'
    const spy = vi.spyOn(dbObservability, 'listTenants').mockRejectedValue(new Error('db down'))
    const out = await drain()
    spy.mockRestore()
    expect(out.body.count).toBe(1)
    expect(out.body.text).toContain('audit mode row text')
    expect((await statusOf(row.id)).status).toBe('delivered')
  })

  it('enforce + readable context: an allowed row is shown, a refused one (unknown sender) is closed and not shown', async () => {
    const allowed = await createAgentMessage('test-owner', 'main-a', 'visible text')
    const refused = await createAgentMessage('unlisted-sender', 'main-a', 'hidden text')
    MODE = 'enforce'
    const out = await drain()
    expect(out.body.count).toBe(1)
    expect(out.body.text).toContain('visible text')
    expect(out.body.text).not.toContain('hidden text')
    expect((await statusOf(allowed.id)).status).toBe('delivered')
    const closed = await statusOf(refused.id)
    expect(closed.status).toBe('failed')
    expect(closed.refused_reason).toBe('sender_route_unknown_sender_class')
  })

  it('an empty inbox in enforce mode with a readable context is an empty drain', async () => {
    MODE = 'enforce'
    expect((await drain()).body).toEqual({ count: 0, text: '' })
  })
})
