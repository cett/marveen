// T4-7: TOKEN_IDENTITY_MODE=enforce. The classification the token shadow counter records (a non-main
// agent caller naming another agent) is, in enforce mode, a 403. These tests drive the same two calls
// web.ts chains (observeTokenUsage, then identityRefusal) over synthetic requests, and pin the web.ts
// wiring and the shadow default at source level.
//
// Privacy: neutral fixtures only (alpha / beta / main-agent are test-local labels).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type http from 'node:http'
import { initDatabase, insertApiToken, saveAgentMemory, getDb } from '../db.js'
import { resolveAuth } from '../web/auth-gate.js'
import { answerIdentityRefusal, identityRefusal, inspectBodyAgents, observeTokenUsage, resetTokenShadowForTests } from '../web/token-shadow.js'
import { readBody, RequestBodyTooLargeError } from '../web/http-helpers.js'

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-agent' }))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = () => Math.floor(Date.now() / 1000)
const mint = async (raw: string, agentId: string | null, role: 'fleet_agent' | 'admin' = 'fleet_agent') =>
  insertApiToken({ tokenHash: sha(raw), name: `${role}:${agentId ?? 'none'}`, role, tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId })

const SHARED = 'the-file-token'

interface Sent { req: http.IncomingMessage; refusal: Awaited<ReturnType<typeof identityRefusal>> }

/** What web.ts does for a gated request, minus the routes: auth, observe, then the enforce check. */
async function send(
  as: 'alpha' | 'main' | 'shared' | { sharedAs: string },
  method: string,
  path: string,
  body?: unknown | Buffer,
): Promise<Sent> {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.method = method
  const headers: Record<string, string> = {}
  if (as === 'alpha') headers.authorization = 'Bearer tok-alpha'
  else if (as === 'main') headers.authorization = 'Bearer tok-main'
  else {
    headers.authorization = `Bearer ${SHARED}`
    if (typeof as === 'object') headers['x-agent-id'] = as.sharedAs
  }
  req.headers = headers
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const url = new URL(`http://localhost:3420${path}`)
  const auth = await resolveAuth(req, url, url.pathname, method, SHARED, true)
  observeTokenUsage(req, auth, method, url.pathname, url)
  return { req, refusal: await identityRefusal(req) }
}

beforeEach(async () => {
  initDatabase(':memory:')
  resetTokenShadowForTests()
  await mint('tok-alpha', 'alpha')
  await mint('tok-main', 'main-agent', 'admin')
})

describe('enforce: the path and the query', () => {
  it('refuses a fleet_agent token that reads another agent on a per-agent endpoint', async () => {
    const { refusal } = await send('alpha', 'GET', '/api/daily-log?agent=beta')
    expect(refusal).toMatchObject({ caller: 'alpha', target: 'beta', category: 'agent_id_mismatch' })
  })

  it('refuses the agent in the path (ledger, agent state)', async () => {
    expect((await send('alpha', 'GET', '/api/conversation-ledger/beta/recent')).refusal?.target).toBe('beta')
    expect((await send('alpha', 'PUT', '/api/agent-state/beta/k', { v: 1 })).refusal?.target).toBe('beta')
  })

  it('lets a request through that names only the caller, or nobody', async () => {
    expect((await send('alpha', 'GET', '/api/daily-log?agent=alpha')).refusal).toBeNull()
    expect((await send('alpha', 'GET', '/api/daily-log')).refusal).toBeNull()
  })

  it('never refuses the main agent, which acts across agents by design', async () => {
    expect((await send('main', 'GET', '/api/daily-log?agent=beta')).refusal).toBeNull()
    expect((await send('main', 'POST', '/api/messages', { from: 'beta', to: 'alpha', content: 'x' })).refusal).toBeNull()
  })

  it('refuses a shared-token request that declares an agent and names another one', async () => {
    const { refusal } = await send({ sharedAs: 'alpha' }, 'GET', '/api/daily-log?agent=beta')
    expect(refusal).toMatchObject({ caller: 'alpha', target: 'beta' })
  })

  it('cannot see a caller in a shared-token request that declares nobody (only T4-5 closes that)', async () => {
    expect((await send('shared', 'GET', '/api/daily-log?agent=beta')).refusal).toBeNull()
  })

  it('does not trust a declaration that names the main agent as a way to act as anyone', async () => {
    // The main agent is exempt because it is the coordinator; a shared-token request declaring it is
    // the main agent's own call. This pins that the exemption is by caller, not by what is named.
    expect((await send({ sharedAs: 'main-agent' }, 'GET', '/api/daily-log?agent=beta')).refusal).toBeNull()
    expect((await send({ sharedAs: 'alpha' }, 'GET', '/api/daily-log?agent=main-agent')).refusal?.target).toBe('main-agent')
  })
})

describe('enforce: the inter-agent sender', () => {
  it('refuses a shared-token message whose `from` is not the declared agent', async () => {
    const { refusal } = await send({ sharedAs: 'alpha' }, 'POST', '/api/messages', { from: 'beta', to: 'main-agent', content: 'x' })
    expect(refusal).toMatchObject({ caller: 'alpha', target: 'beta' })
  })

  it('lets a message from the declared agent through', async () => {
    expect((await send({ sharedAs: 'alpha' }, 'POST', '/api/messages', { from: 'alpha', to: 'main-agent', content: 'x' })).refusal).toBeNull()
  })
})

describe('enforce: the body', () => {
  it('refuses a body that names another agent, and leaves the body readable for the route', async () => {
    const payload = { agent_id: 'beta', content: 'x' }
    const { req, refusal } = await send('alpha', 'POST', '/api/daily-log', payload)
    expect(refusal?.target).toBe('beta')
    expect(JSON.parse((await readBody(req)).toString())).toEqual(payload)
  })

  it('hands the route the same bytes when nothing is refused', async () => {
    const payload = { agent_id: 'alpha', content: 'x' }
    const { req, refusal } = await send('alpha', 'POST', '/api/daily-log', payload)
    expect(refusal).toBeNull()
    expect(JSON.parse((await readBody(req)).toString())).toEqual(payload)
  })

  it('sees a foreign agent past the 200th entry of a batch', async () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({ agent_id: i === 250 ? 'beta' : 'alpha', message_id: String(i) }))
    expect((await send('alpha', 'POST', '/api/conversation-ledger', { entries })).refusal?.target).toBe('beta')
  })

  it('sees a foreign agent in a body larger than the counter reads', async () => {
    const big = JSON.stringify({ agent_id: 'beta', pad: 'x'.repeat(400 * 1024) })
    expect((await send('alpha', 'POST', '/api/daily-log', Buffer.from(big))).refusal?.target).toBe('beta')
  })

  it('leaves a body that is not JSON to the route', async () => {
    expect((await send('alpha', 'POST', '/api/daily-log', Buffer.from('{not json'))).refusal).toBeNull()
  })

  it('keeps the size limit of the route that reads the body second', async () => {
    const { req } = await send('alpha', 'POST', '/api/daily-log', { agent_id: 'alpha', pad: 'x'.repeat(2000) })
    await expect(readBody(req, { maxBytes: 100 })).rejects.toBeInstanceOf(RequestBodyTooLargeError)
  })
})

describe('enforce: a body value a route might coerce into an agent id', () => {
  it.each([[['beta']], [5], [{ id: 'beta' }], [true]])('refuses %j under agent_id as not-a-string', async (value) => {
    const { refusal } = await send('alpha', 'POST', '/api/daily-log', { agent_id: value, content: 'x' })
    expect(refusal).toMatchObject({ caller: 'alpha', target: '_invalid' })
  })

  it('treats null, an absent key and an empty string as naming nobody', () => {
    expect(inspectBodyAgents({ agent_id: null, content: 'x' }, ['agent_id'])).toEqual({ named: [], odd: false })
    expect(inspectBodyAgents({ content: 'x' }, ['agent_id'])).toEqual({ named: [], odd: false })
    expect(inspectBodyAgents({ agent_id: '  ' }, ['agent_id'])).toEqual({ named: [], odd: false })
  })

  it('finds a non-string and a name inside a batch, with no cap on the entries', () => {
    const entries = Array.from({ length: 500 }, (_, i) => (i === 450 ? { agent_id: 7 } : i === 480 ? { agent_id: 'beta' } : { agent_id: 'alpha' }))
    expect(inspectBodyAgents({ entries }, ['agent_id'])).toEqual({ named: ['alpha', 'beta'], odd: true })
  })
})

describe('enforce: a route that acts as the main agent when no agent is named', () => {
  it('memories: a write naming nobody is the main agent\'s memory, so it is refused (token and shared token alike)', async () => {
    expect((await send('alpha', 'POST', '/api/memories', { content: 'x' })).refusal).toMatchObject({ caller: 'alpha', target: 'main-agent' })
    expect((await send({ sharedAs: 'alpha' }, 'POST', '/api/memories', { content: 'x' })).refusal?.target).toBe('main-agent')
    expect((await send('alpha', 'POST', '/api/memories', { agent_id: 'alpha', content: 'x' })).refusal).toBeNull()
  })

  it('memories import: the same, although the path has a segment after the prefix', async () => {
    expect((await send('alpha', 'POST', '/api/memories/import', { chunks: ['x'] })).refusal?.target).toBe('main-agent')
    expect((await send('alpha', 'POST', '/api/memories/import', { agent_id: 'alpha', chunks: ['x'] })).refusal).toBeNull()
  })

  it('memories: a write takes its agent from the body only, so a query naming the caller does not help', async () => {
    expect((await send('alpha', 'POST', '/api/memories?agent=alpha', { content: 'x' })).refusal?.target).toBe('main-agent')
    expect((await send('alpha', 'POST', '/api/memories?agent_id=alpha', { content: 'x' })).refusal?.target).toBe('main-agent')
  })

  it('only the one field the route reads counts: another spelling, or a batch entry, does not', async () => {
    expect((await send('alpha', 'POST', '/api/memories', { agent: 'alpha', content: 'x' })).refusal?.target).toBe('main-agent')
    expect((await send('alpha', 'POST', '/api/memories', { content: 'x', entries: [{ agent_id: 'alpha' }] })).refusal?.target).toBe('main-agent')
    expect((await send('alpha', 'POST', '/api/schedules', { name: 'n', agent_id: 'alpha' })).refusal?.target).toBe('main-agent')
    expect((await send('alpha', 'POST', '/api/schedules', { name: 'n', agent: 'alpha' })).refusal).toBeNull()
  })

  it('a body that is not an object names nobody', async () => {
    expect((await send('alpha', 'POST', '/api/memories', [{ agent_id: 'alpha' }])).refusal?.target).toBe('main-agent')
  })

  it('daily log read: the query key the route reads is `agent`, not `agent_id`', async () => {
    expect((await send({ sharedAs: 'alpha' }, 'GET', '/api/daily-log?agent=alpha')).refusal).toBeNull()
    expect((await send({ sharedAs: 'alpha' }, 'GET', '/api/daily-log?agent_id=alpha')).refusal?.target).toBe('main-agent')
  })

  it('daily log: the shared token falls back to the main agent, a fleet_agent token to itself', async () => {
    expect((await send({ sharedAs: 'alpha' }, 'GET', '/api/daily-log')).refusal?.target).toBe('main-agent')
    expect((await send({ sharedAs: 'alpha' }, 'POST', '/api/daily-log', { content: 'x' })).refusal?.target).toBe('main-agent')
    expect((await send('alpha', 'GET', '/api/daily-log')).refusal).toBeNull()
    expect((await send('alpha', 'POST', '/api/daily-log', { content: 'x' })).refusal).toBeNull()
  })

  it('schedules: creating a task naming no agent is refused, listing them is not', async () => {
    expect((await send('alpha', 'POST', '/api/schedules', { name: 'n', prompt: 'p' })).refusal?.target).toBe('main-agent')
    expect((await send('alpha', 'GET', '/api/schedules')).refusal).toBeNull()
  })

  it('never reaches the main agent\'s own calls', async () => {
    expect((await send('main', 'POST', '/api/memories', { content: 'x' })).refusal).toBeNull()
  })
})

describe('enforce: which endpoints refuse what (T0 matrix)', () => {
  it('memories: naming another agent is refused on a read too, except for the shared tier', async () => {
    expect((await send('alpha', 'GET', '/api/memories?agent=beta')).refusal?.target).toBe('beta')
    expect((await send('alpha', 'GET', '/api/memories?agent_id=beta&category=warm')).refusal?.target).toBe('beta')
    expect((await send('alpha', 'GET', '/api/memories?agent=beta&category=shared')).refusal).toBeNull()
    expect((await send('alpha', 'GET', '/api/memories?agent=beta&tier=shared')).refusal).toBeNull()
    expect((await send('alpha', 'GET', '/api/memories?agent=alpha')).refusal).toBeNull()
    expect((await send('alpha', 'POST', '/api/memories', { agent_id: 'beta', content: 'x' })).refusal?.target).toBe('beta')
    // the shared tier is read-only for another agent: a write is refused whatever it says
    expect((await send('alpha', 'POST', '/api/memories?category=shared', { agent_id: 'beta', content: 'x' })).refusal?.target).toBe('beta')
  })

  it('memories: a shared row by id is readable, another agent\'s private row and its sub-routes are not', async () => {
    const shared = saveAgentMemory('beta', 'for all', 'shared').id
    const priv = saveAgentMemory('beta', 'private', 'warm').id
    expect((await send('alpha', 'GET', `/api/memories/${shared}`)).refusal).toBeNull()
    expect((await send('alpha', 'GET', `/api/memories/${priv}`)).refusal?.target).toBe('beta')
    expect((await send('alpha', 'GET', `/api/memories/${shared}/detail`)).refusal?.target).toBe('beta')
    expect((await send('alpha', 'GET', '/api/memories/graph?agent=beta&category=shared')).refusal?.target).toBe('beta')
    expect((await send('alpha', 'DELETE', `/api/memories/${shared}`)).refusal?.target).toBe('beta')
  })

  it('the agent resources addressed by name: another agent is refused, the list and the own name are not', async () => {
    for (const p of ['/api/agents/beta', '/api/agents/beta/security', '/api/agents/beta/conversation', '/api/agents/beta/team',
      '/api/agents/beta/channels/telegram/allowed', '/api/agents/beta/channels/telegram/pending', '/api/agents/beta/channels/telegram/invites']) {
      expect((await send('alpha', 'GET', p)).refusal?.target, p).toBe('beta')
    }
    expect((await send('alpha', 'PUT', '/api/agents/beta/team', { role: 'member' })).refusal?.target).toBe('beta')
    expect((await send('alpha', 'GET', '/api/agents')).refusal).toBeNull()
    expect((await send('alpha', 'GET', '/api/agents/activity')).refusal).toBeNull()
    expect((await send('alpha', 'GET', '/api/agents/alpha')).refusal).toBeNull()
    expect((await send('alpha', 'GET', '/api/agents/alpha/channels/telegram/allowed')).refusal).toBeNull()
    expect((await send('alpha', 'GET', '/api/agents/Beta/status')).refusal?.target).toBe('beta')
    expect((await send('main', 'GET', '/api/agents/beta/security')).refusal).toBeNull()
  })

  it('recall: naming another agent is refused', async () => {
    expect((await send('alpha', 'GET', '/api/recall?agent=beta&q=x')).refusal?.target).toBe('beta')
    expect((await send('alpha', 'GET', '/api/recall?agent=alpha&q=x')).refusal).toBeNull()
    expect((await send('alpha', 'GET', '/api/recall?q=x')).refusal).toBeNull() // names nobody: the route scopes it to alpha
  })

  it('workspace: a write naming another agent is refused, a read is not', async () => {
    expect((await send('alpha', 'GET', '/api/workspace?agent=beta')).refusal).toBeNull()
    expect((await send('alpha', 'POST', '/api/workspace', { agent_id: 'beta', doc_key: 'k' })).refusal?.target).toBe('beta')
  })

  it('blackboard: writing another agent\'s row is refused, reading it is not', async () => {
    expect((await send('alpha', 'GET', '/api/blackboard?agent_id=beta')).refusal).toBeNull()
    expect((await send('alpha', 'POST', '/api/blackboard', { agent_id: 'beta', status: 'active', summary: 's' })).refusal?.target).toBe('beta')
  })

  it('schedules: naming another agent is refused on a read too', async () => {
    expect((await send('alpha', 'GET', '/api/schedules?agent=beta')).refusal?.target).toBe('beta')
  })

  it('kanban is scoped by tenant, not by agent: assigning to another agent is never refused here', async () => {
    expect((await send('alpha', 'POST', '/api/kanban', { title: 't', assignee: 'beta' })).refusal).toBeNull()
    expect((await send('alpha', 'GET', '/api/kanban?assignee=beta')).refusal).toBeNull()
  })
})

describe('identity_refused: every refusal is counted', () => {
  async function answered(path: string, method = 'GET', body?: unknown): Promise<{ refused: boolean; status: number }> {
    const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
    const req = new EventEmitter() as unknown as http.IncomingMessage
    req.method = method
    req.headers = { authorization: 'Bearer tok-alpha', 'user-agent': 'curl/8' }
    ;(req as unknown as { destroy: () => void }).destroy = () => {}
    setImmediate(() => { req.emit('data', buf); req.emit('end') })
    const url = new URL(`http://localhost:3420${path}`)
    observeTokenUsage(req, await resolveAuth(req, url, url.pathname, method, SHARED, true), method, url.pathname, url)
    const out = { status: 0 }
    const res = { writeHead(code: number) { out.status = code }, setHeader() {}, end() {} } as unknown as http.ServerResponse
    return { refused: await answerIdentityRefusal(req, res), status: out.status }
  }
  const refusedRows = () => (getDb().prepare("SELECT method, route, caller, caller_source, client, target, count FROM token_usage_shadow WHERE category = 'identity_refused' ORDER BY route, method").all() as
    Array<{ method: string; route: string; caller: string; caller_source: string; client: string; target: string; count: number }>)

  it('a refusal decided from the path or query is 403 and one identity_refused row', async () => {
    expect(await answered('/api/daily-log?agent=beta')).toEqual({ refused: true, status: 403 })
    expect(refusedRows()).toEqual([{ method: 'GET', route: '/api/daily-log', caller: 'alpha', caller_source: 'token', client: 'curl', target: 'beta', count: 1 }])
  })

  it('a refusal decided from the body (read by the gate) is counted with the same shape', async () => {
    expect(await answered('/api/memories', 'POST', { agent_id: 'beta', content: 'x' })).toEqual({ refused: true, status: 403 })
    expect(refusedRows()).toEqual([{ method: 'POST', route: '/api/memories', caller: 'alpha', caller_source: 'token', client: 'curl', target: 'beta', count: 1 }])
  })

  it('a request that is let through leaves no identity_refused row', async () => {
    expect(await answered('/api/daily-log?agent=alpha')).toEqual({ refused: false, status: 0 })
    expect(await answered('/api/memories?agent=beta&category=shared')).toEqual({ refused: false, status: 0 })
    expect(await answered('/api/workspace?agent=beta')).toEqual({ refused: false, status: 0 })
    expect(refusedRows()).toEqual([])
  })

  it('what enforce lets through is foreign_row_read, what it refuses is foreign_row_access', async () => {
    await answered('/api/workspace?agent=beta')
    await answered('/api/memories?agent=beta')
    const cats = getDb().prepare("SELECT category, route FROM token_usage_shadow WHERE category IN ('foreign_row_read', 'foreign_row_access') ORDER BY category").all()
    expect(cats).toEqual([
      { category: 'foreign_row_access', route: '/api/memories' },
      { category: 'foreign_row_read', route: '/api/workspace' },
    ])
  })
})

describe('the switch and its wiring', () => {
  const WEB_SRC = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
  const CONFIG_SRC = readFileSync(join(__dirname, '..', 'config.ts'), 'utf-8')

  it('defaults to shadow: only the exact value "enforce" turns it on', () => {
    expect(CONFIG_SRC).toMatch(/export const TOKEN_IDENTITY_MODE: 'shadow' \| 'enforce' =/)
    expect(CONFIG_SRC).toMatch(/\?\? 'shadow'\)\.trim\(\)\.toLowerCase\(\) === 'enforce'/)
  })

  it('web.ts runs the identity gate only in enforce mode, after the counter and before dispatch', () => {
    expect(WEB_SRC.match(/\banswerIdentityRefusal\(/g)?.length).toBe(1)
    const observeAt = WEB_SRC.indexOf('observeTokenUsage(req, auth, method, path, url)')
    const guardAt = WEB_SRC.indexOf("if (TOKEN_IDENTITY_MODE === 'enforce' && requiresAuth(path, method))")
    const refuseAt = WEB_SRC.indexOf('answerIdentityRefusal(req, res)')
    const dispatchAt = WEB_SRC.indexOf('await dispatcher.dispatch(routeCtx)')
    expect(observeAt).toBeGreaterThan(-1)
    expect(guardAt).toBeGreaterThan(observeAt)
    expect(refuseAt).toBeGreaterThan(guardAt)
    expect(dispatchAt).toBeGreaterThan(refuseAt)
  })

  it('web.ts hands the switch to the routes through the context, the only way a route learns of it', () => {
    expect(WEB_SRC).toContain("identityEnforced: TOKEN_IDENTITY_MODE === 'enforce'")
  })
})
