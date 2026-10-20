// An agent-bound admin token (the main agent's) may post as any registered sender, as before; when the
// `from` it declares is not the agent its token names, the audit row of the message carries it as
// `declared_from`. Platform senders, the operator's token, a session and the shared token leave no such
// row. Real in-memory database; only the set of registered agents is replaced.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const KNOWN = vi.hoisted(() => new Set(['agent-a', 'agent-b', 'agent-c', 'scheduler', 'neighbour-x']))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'agent-a',
  SYSTEM_SENDER_IDS: 'neighbour-x',
}))

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  isKnownAgent: (name: string) => KNOWN.has(name),
}))

import { initDatabase } from '../db.js'
import { db } from '../db/connection.js'
import { tryHandleMessages, declaredFromOfAgentBoundAdmin } from '../web/routes/messages.js'

interface Caller {
  role?: RouteContext['role']
  auth?: RouteContext['auth']
  tokenAgentId?: string
}

const MAIN_TOKEN: Caller = { role: 'admin', auth: { kind: 'token', tokenName: 'main-agent:agent-a' }, tokenAgentId: 'agent-a' }
const OPERATOR_TOKEN: Caller = { role: 'admin', auth: { kind: 'token', tokenName: 'operator' } }
const SHARED_TOKEN: Caller = { role: 'admin', auth: { kind: 'token' } }
const SESSION: Caller = { role: 'admin', auth: { kind: 'session', user: 'person-a' } }
const AGENT_B_TOKEN: Caller = { role: 'fleet_agent', auth: { kind: 'token', tokenName: 'fleet_agent:agent-b' }, tokenAgentId: 'agent-b' }

async function post(caller: Caller, body: Record<string, unknown>): Promise<number> {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as any
  req.method = 'POST'
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200 }
  const res = { writeHead(s: number) { out.status = s }, end() {} } as any
  const url = new URL('http://localhost:3420/api/messages')
  const ctx = {
    req, res, path: url.pathname, method: 'POST', url,
    role: caller.role, auth: caller.auth, tokenAgentId: caller.tokenAgentId, agentId: caller.tokenAgentId,
  } as unknown as RouteContext
  expect(await tryHandleMessages(ctx)).toBe(true)
  return out.status
}

const declaredRows = () =>
  (db.prepare("SELECT agent_id, detail FROM agent_audit_log WHERE entity = 'message' AND detail LIKE '%declared_from%' ORDER BY id").all() as Array<{ agent_id: string; detail: string }>)
    .map((r) => ({ agent_id: r.agent_id, ...JSON.parse(r.detail) }))

beforeEach(() => {
  initDatabase(':memory:')
})

describe('declaredFromOfAgentBoundAdmin', () => {
  it('is the declared sender when it is not the agent the token names', () => {
    expect(declaredFromOfAgentBoundAdmin(MAIN_TOKEN, 'agent-b')).toBe('agent-b')
    expect(declaredFromOfAgentBoundAdmin(MAIN_TOKEN, ' agent-c ')).toBe('agent-c')
  })
  it('is null for the token\'s own agent, also with the whitespace the sender id is normalised from', () => {
    expect(declaredFromOfAgentBoundAdmin(MAIN_TOKEN, 'agent-a')).toBeNull()
    expect(declaredFromOfAgentBoundAdmin(MAIN_TOKEN, ' agent-a ')).toBeNull()
  })
  it('a spelling that is not the token\'s agent id is recorded, not guessed to be it', () => {
    expect(declaredFromOfAgentBoundAdmin(MAIN_TOKEN, 'Agent-A')).toBe('Agent-A')
  })
  it('is null for the platform senders and the configured system senders', () => {
    expect(declaredFromOfAgentBoundAdmin(MAIN_TOKEN, 'scheduler')).toBeNull()
    expect(declaredFromOfAgentBoundAdmin(MAIN_TOKEN, 'system')).toBeNull()
    expect(declaredFromOfAgentBoundAdmin(MAIN_TOKEN, 'neighbour-x')).toBeNull()
  })
  it('is null for every principal that is not an agent-bound token', () => {
    for (const caller of [OPERATOR_TOKEN, SHARED_TOKEN, SESSION, AGENT_B_TOKEN]) {
      expect(declaredFromOfAgentBoundAdmin(caller, 'agent-c')).toBeNull()
    }
  })
})

describe('POST /api/messages by an agent-bound admin token', () => {
  it('posting as another registered agent is allowed, as before, and leaves a declared_from audit row', async () => {
    expect(await post(MAIN_TOKEN, { from: 'agent-b', to: 'agent-c', content: 'hello' })).toBe(200)
    const rows = declaredRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'agent-a', declared_from: 'agent-b', to: 'agent-c', principal: 'main-agent:agent-a', principalSource: 'token' })
  })

  it('posting as itself or as a platform sender leaves none', async () => {
    expect(await post(MAIN_TOKEN, { from: 'agent-a', to: 'agent-c', content: 'own' })).toBe(200)
    expect(await post(MAIN_TOKEN, { from: 'scheduler', to: 'agent-c', content: 'tick' })).toBe(200)
    expect(await post(MAIN_TOKEN, { from: 'neighbour-x', to: 'agent-c', content: 'ext' })).toBe(200)
    expect(declaredRows()).toEqual([])
  })

  it('the operator\'s token, a session and the shared token post as anyone without the row', async () => {
    for (const caller of [OPERATOR_TOKEN, SESSION, SHARED_TOKEN]) {
      expect(await post(caller, { from: 'agent-b', to: 'agent-c', content: 'x' })).toBe(200)
    }
    expect(declaredRows()).toEqual([])
  })

  it('a fleet_agent is still pinned to its own sender and leaves no row', async () => {
    expect(await post(AGENT_B_TOKEN, { from: 'agent-c', to: 'agent-a', content: 'x' })).toBe(403)
    expect(await post(AGENT_B_TOKEN, { to: 'agent-c', content: 'x' })).toBe(200)
    expect(declaredRows()).toEqual([])
  })
})
