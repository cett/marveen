// POST /api/messages: the sender of an agent-bound admin token's message is the agent the token names.
// An omitted or blank `from` is filled in; under TOKEN_IDENTITY_MODE=enforce a different `from` is refused with
// 403 sender_token_mismatch (not rewritten) and counted as identity_refused; in shadow mode it passes and the
// existing `declared_from` audit row records the claim. Exempt: the platform senders, the principals that cannot
// be bound to one agent, and the refusals that come first (reserved sender, coordinator id, qualified id).
// Real handler, real in-memory database; only the set of registered agents and two config values are replaced.
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
import { resetTokenShadowForTests } from '../web/token-shadow.js'
import { tryHandleMessages } from '../web/routes/messages.js'

interface Caller {
  role?: RouteContext['role']
  auth?: RouteContext['auth']
  tokenAgentId?: string
  tenantId?: string | null
}

const BOUND_ADMIN: Caller = { role: 'admin', auth: { kind: 'token', tokenName: 'main-agent:agent-a' }, tokenAgentId: 'agent-a' }
const OTHER_BOUND_ADMIN: Caller = { role: 'admin', auth: { kind: 'token', tokenName: 'main-agent:agent-b' }, tokenAgentId: 'agent-b' }
const OPERATOR_TOKEN: Caller = { role: 'admin', auth: { kind: 'token', tokenName: 'operator' } }
const SHARED_TOKEN: Caller = { role: 'admin', auth: { kind: 'token' } }
const SESSION: Caller = { role: 'admin', auth: { kind: 'session', user: 'person-a' } }
const FLEET_AGENT_B: Caller = { role: 'fleet_agent', auth: { kind: 'token', tokenName: 'fleet_agent:agent-b' }, tokenAgentId: 'agent-b' }

async function post(caller: Caller, body: Record<string, unknown>, enforced: boolean): Promise<{ status: number; body: any }> {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as any
  req.method = 'POST'
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL('http://localhost:3420/api/messages')
  const ctx = {
    req, res, path: url.pathname, method: 'POST', url,
    role: caller.role, auth: caller.auth, tokenAgentId: caller.tokenAgentId, agentId: caller.tokenAgentId,
    tenantId: caller.tenantId ?? null, identityEnforced: enforced,
  } as unknown as RouteContext
  expect(await tryHandleMessages(ctx)).toBe(true)
  return out
}

const stored = () => db.prepare('SELECT from_agent, to_agent FROM agent_messages ORDER BY id').all() as Array<{ from_agent: string; to_agent: string }>
const declaredRows = () =>
  (db.prepare("SELECT agent_id, detail FROM agent_audit_log WHERE entity = 'message' AND detail LIKE '%declared_from%' ORDER BY id").all() as Array<{ agent_id: string; detail: string }>)
    .map((r) => ({ agent_id: r.agent_id, ...JSON.parse(r.detail) }))
const refusedRows = () =>
  db.prepare("SELECT category, caller, target, route, method FROM token_usage_shadow WHERE category = 'identity_refused'").all() as Array<Record<string, string>>

const ENFORCE = true
const SHADOW = false

beforeEach(() => {
  initDatabase(':memory:')
  resetTokenShadowForTests()
})

describe('an agent-bound admin token: from omitted or blank', () => {
  it.each([['enforce', ENFORCE], ['shadow', SHADOW]])('is filled with the agent of the token (%s)', async (_mode, enforced) => {
    expect((await post(BOUND_ADMIN, { to: 'agent-b', content: 'hello' }, enforced)).status).toBe(200)
    expect((await post(BOUND_ADMIN, { from: '   ', to: 'agent-c', content: 'hello' }, enforced)).status).toBe(200)
    expect((await post(BOUND_ADMIN, { from: null, to: 'agent-b', content: 'again' }, enforced)).status).toBe(200)
    expect(stored().map((m) => m.from_agent)).toEqual(['agent-a', 'agent-a', 'agent-a'])
    expect(declaredRows()).toEqual([])
  })
})

describe('an agent-bound admin token under enforce', () => {
  it('refuses a different from with 403 sender_token_mismatch and stores nothing', async () => {
    const r = await post(BOUND_ADMIN, { from: 'agent-b', to: 'agent-c', content: 'as someone else' }, ENFORCE)
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ error: 'forbidden', code: 'sender_token_mismatch' })
    expect(stored()).toEqual([])
    expect(declaredRows()).toEqual([])
  })

  it('refuses a from that is not a registered agent the same way, not with the 404 of the sender check', async () => {
    const r = await post(BOUND_ADMIN, { from: 'ghost', to: 'agent-b', content: 'x' }, ENFORCE)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('sender_token_mismatch')
  })

  it('refuses another spelling of the token agent (the comparison is exact, as in the audit)', async () => {
    const r = await post(BOUND_ADMIN, { from: 'Agent-A', to: 'agent-b', content: 'x' }, ENFORCE)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('sender_token_mismatch')
  })

  it('refuses a token of a sub-agent that claims the main agent too', async () => {
    const r = await post(OTHER_BOUND_ADMIN, { from: 'agent-a', to: 'agent-c', content: 'x' }, ENFORCE)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('sender_token_mismatch')
    expect(stored()).toEqual([])
  })

  it('counts the refusal as identity_refused with the claimed sender as target', async () => {
    await post(BOUND_ADMIN, { from: 'agent-b', to: 'agent-c', content: 'x' }, ENFORCE)
    expect(refusedRows()).toEqual([{ category: 'identity_refused', caller: 'agent-a', target: 'agent-b', route: '/api/messages', method: 'POST' }])
  })

  it('control: the token\'s own agent as from is accepted', async () => {
    expect((await post(BOUND_ADMIN, { from: 'agent-a', to: 'agent-b', content: 'mine' }, ENFORCE)).status).toBe(200)
    expect(stored()).toEqual([{ from_agent: 'agent-a', to_agent: 'agent-b' }])
    expect(refusedRows()).toEqual([])
  })

  it.each([['scheduler'], ['neighbour-x']])('lets the platform sender %s through', async (platform) => {
    expect((await post(BOUND_ADMIN, { from: platform, to: 'agent-b', content: 'tick' }, ENFORCE)).status).toBe(200)
    expect(stored()).toEqual([{ from_agent: platform, to_agent: 'agent-b' }])
    expect(declaredRows()).toEqual([])
  })

  it('keeps the first-class refusals ahead of the mismatch: reserved sender, coordinator id, qualified id', async () => {
    const sys = await post(BOUND_ADMIN, { from: 'system', to: 'agent-b', content: 'x' }, ENFORCE)
    expect(sys.status).toBe(403)
    expect(sys.body.code).toBe('reserved_sender')
    const coord = await post(BOUND_ADMIN, { from: 'telegram-coordinator', to: 'agent-b', content: 'x' }, ENFORCE)
    expect(coord.status).toBe(403)
    expect(coord.body.code).toBeUndefined()
    const qualified = await post(BOUND_ADMIN, { from: 'peer/agent-x', to: 'agent-b', content: 'x' }, ENFORCE)
    expect(qualified.status).toBe(403)
    expect(qualified.body.error).toBe('sender_not_in_allowlist')
    expect(refusedRows()).toEqual([])
  })

  it('leaves a partner tenant token on its allowlist path', async () => {
    const r = await post({ ...BOUND_ADMIN, tenantId: 'partner-1' }, { from: 'agent-b', to: 'agent-c', content: 'x' }, ENFORCE)
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('sender_not_in_allowlist')
    expect(refusedRows()).toEqual([])
  })
})

describe('an agent-bound admin token in shadow mode', () => {
  it('lets a different from through and records it as declared_from (existing behaviour)', async () => {
    const r = await post(BOUND_ADMIN, { from: 'agent-b', to: 'agent-c', content: 'as someone else' }, SHADOW)
    expect(r.status).toBe(200)
    expect(stored()).toEqual([{ from_agent: 'agent-b', to_agent: 'agent-c' }])
    expect(declaredRows()).toMatchObject([{ agent_id: 'agent-a', declared_from: 'agent-b', to: 'agent-c' }])
    expect(refusedRows()).toEqual([])
  })
})

describe('the principals that cannot be bound to one agent', () => {
  it.each([['operator token', OPERATOR_TOKEN], ['shared token', SHARED_TOKEN], ['dashboard session', SESSION]])(
    '%s may post as any registered sender under enforce',
    async (_name, caller) => {
      expect((await post(caller, { from: 'agent-b', to: 'agent-c', content: 'x' }, ENFORCE)).status).toBe(200)
      expect(stored()).toEqual([{ from_agent: 'agent-b', to_agent: 'agent-c' }])
      expect(declaredRows()).toEqual([])
      expect(refusedRows()).toEqual([])
    },
  )

  it('an unbound caller that omits from still gets the 400 (nothing to fill it with)', async () => {
    const r = await post(OPERATOR_TOKEN, { to: 'agent-c', content: 'x' }, ENFORCE)
    expect(r.status).toBe(400)
    expect(stored()).toEqual([])
  })
})

describe('a fleet_agent token (unchanged)', () => {
  it('is refused for a different from and filled when from is omitted, in either mode', async () => {
    for (const enforced of [ENFORCE, SHADOW]) {
      const refused = await post(FLEET_AGENT_B, { from: 'agent-c', to: 'agent-a', content: 'x' }, enforced)
      expect(refused.status).toBe(403)
      expect(refused.body.code).toBeUndefined()
    }
    expect((await post(FLEET_AGENT_B, { to: 'agent-a', content: 'x' }, SHADOW)).status).toBe(200)
    expect(stored()).toEqual([{ from_agent: 'agent-b', to_agent: 'agent-a' }])
  })
})
