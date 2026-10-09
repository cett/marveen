// Phase T2 shadow counter (migration 0079, web/token-shadow.ts, GET /api/token-shadow).
// Real DB (migrations applied to :memory:), real recorder, real route handler, real readBody.
// The counter only MEASURES: the fail-safe tests below pin that a counter fault never reaches a request.
//
// Privacy: neutral fixtures only (agent-a, agent-b, agent-shared, agent-main, tenant-a).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import {
  initDatabase, getDb, upsertBlackboard, createKanbanCard, saveAgentMemory, upsertSchedule,
} from '../db.js'
import type { AuthResult } from '../web/auth-gate.js'
import { checkPermission } from '../web/authz.js'
import { readBody } from '../web/http-helpers.js'
import { tryHandleTokenShadow } from '../web/routes/token-shadow.js'
import type { RouteContext } from '../web/routes/types.js'
import {
  MAX_ROWS_PER_DAY, RETENTION_DAYS, TOKEN_SHADOW_CATEGORIES,
  classifyClient, cleanAgentId, collectBodyAgents, identityHits, normalizeRoute, observeRequestBody,
  observeTokenUsage, recordFleetSkillWriteDenied, recordTenantContextRefusal, recordTokenShadow,
  resetTokenShadowForTests, resolveShadowCaller, skillOwnerTarget, stripApiVersion, windowStartDay,
} from '../web/token-shadow.js'

// The shared agent is the one with no tenant to act in; every other agent has one.
vi.mock('../db/write-tenant.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/write-tenant.js')>()),
  resolveWriteTenant: (agentId: string | null | undefined) => (!agentId || agentId === 'agent-shared' ? null : 'default'),
}))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'agent-main' }))

const MAIN = 'agent-main'

const sharedAuth: AuthResult = { kind: 'token' } // the file token before it is enrolled in api_tokens
const enrolledSharedAuth: AuthResult = { kind: 'token', role: 'admin', tenantId: 'default', tokenName: 'dashboard' } // what it resolves as once enrolled
const fleetAuth = (agent: string): AuthResult => ({ kind: 'token', role: 'fleet_agent', tenantId: 'default', tokenName: `fleet_agent:${agent}`, agentId: agent })
const mainAdminAuth: AuthResult = { kind: 'token', role: 'admin', tokenName: `admin:${MAIN}`, agentId: MAIN }
const operatorAuth: AuthResult = { kind: 'token', role: 'admin', tokenName: 'operator' }
const sessionAuth: AuthResult = { kind: 'session', user: 'user-a', role: 'admin' }

function fakeReq(headers: Record<string, string> = {}, body?: unknown): http.IncomingMessage {
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.headers = headers
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  ;(req as unknown as { __body: Buffer }).__body = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  return req
}
/** Delivers the body the way the socket would, through the real readBody. */
async function drain(req: http.IncomingMessage): Promise<Buffer> {
  const p = readBody(req)
  setImmediate(() => { req.emit('data', (req as unknown as { __body: Buffer }).__body); req.emit('end') })
  return p
}

function observe(auth: AuthResult, method: string, pathWithQuery: string, headers: Record<string, string> = {}, body?: unknown) {
  const req = fakeReq(headers, body)
  const url = new URL(`http://localhost:3420${pathWithQuery}`)
  observeTokenUsage(req, auth, method, url.pathname, url)
  return req
}

interface Row { day: string; category: string; method: string; route: string; caller: string; caller_source: string; client: string; target: string; count: number }
const rows = (category?: string): Row[] =>
  (getDb().prepare('SELECT * FROM token_usage_shadow ORDER BY category, route, method, caller, target').all() as Row[])
    .filter((r) => !category || r.category === category)
const total = (category: string): number => rows(category).reduce((n, r) => n + r.count, 0)

beforeEach(() => {
  initDatabase(':memory:')
  resetTokenShadowForTests()
})
afterEach(() => { vi.restoreAllMocks() })

describe('pure helpers', () => {
  it('strips the api version prefix only at a segment boundary', () => {
    expect(stripApiVersion('/api/v1/kanban')).toBe('/api/kanban')
    expect(stripApiVersion('/api/v1')).toBe('/api')
    expect(stripApiVersion('/api/v10/kanban')).toBe('/api/v10/kanban')
    expect(stripApiVersion('/api/kanban')).toBe('/api/kanban')
  })

  it('cleans an agent id into a counter key', () => {
    expect(cleanAgentId('Agent-A')).toBe('agent-a')
    expect(cleanAgentId('  agent_b ')).toBe('agent_b')
    expect(cleanAgentId('')).toBe('')
    expect(cleanAgentId(undefined)).toBe('')
    expect(cleanAgentId('a b')).toBe('_invalid')
    expect(cleanAgentId('a/../b')).toBe('_invalid')
    expect(cleanAgentId('-agent')).toBe('_invalid')
    expect(cleanAgentId('x'.repeat(49))).toBe('_invalid')
    expect(cleanAgentId('x'.repeat(48))).toBe('x'.repeat(48))
  })

  it.each([
    [undefined, 'none'], ['', 'none'], ['curl/8.4.0', 'curl'], ['python-requests/2.31', 'python'],
    ['Python-urllib/3.12', 'python'], ['node', 'node'], ['undici', 'node'],
    ['Mozilla/5.0 (Macintosh) Chrome/120', 'browser'], ['weird-agent/1', 'other'],
  ])('classifies the user agent %s as %s', (ua, want) => {
    expect(classifyClient(ua)).toBe(want)
  })

  it('normalises routes into low-cardinality templates', () => {
    expect(normalizeRoute('/api/conversation-ledger/agent-a/recent')).toBe('/api/conversation-ledger/:agent/recent')
    expect(normalizeRoute('/api/v1/conversation-ledger/agent-b/open-question')).toBe('/api/conversation-ledger/:agent/open-question')
    expect(normalizeRoute('/api/agent-state/agent-a/some-key')).toBe('/api/agent-state/:agent/some-key')
    expect(normalizeRoute('/api/agent-taskstate/agent-a/replay?source=x')).toBe('/api/agent-taskstate/:agent/replay')
    expect(normalizeRoute('/api/memories/12345')).toBe('/api/memories/:id')
    expect(normalizeRoute('/api/memories/stale')).toBe('/api/memories/:id') // a watched param position; the id-ness is not judged for memories
    expect(normalizeRoute('/api/kanban/242e55bc')).toBe('/api/kanban/:id')
    expect(normalizeRoute('/api/kanban/labels')).toBe('/api/kanban/labels')
    expect(normalizeRoute('/api/kanban/242e55bc/comments')).toBe('/api/kanban/:id/comments')
    expect(normalizeRoute('/api/blackboard/history')).toBe('/api/blackboard/history')
    expect(normalizeRoute('/api/blackboard/b4cda374')).toBe('/api/blackboard/:id')
    expect(normalizeRoute('/api/schedules/nightly-backup/run')).toBe('/api/schedules/:name/run')
    expect(normalizeRoute('/api/schedules/tick-status')).toBe('/api/schedules/tick-status')
    expect(normalizeRoute('/api/skills/sql/agent%2Fagent-a%2Fskill-x')).toBe('/api/skills/sql/:id')
    expect(normalizeRoute('/api/skills/sql/agent%2Fagent-a%2Fskill-x/files/a.txt')).toBe('/api/skills/sql/:id/files/a.txt')
  })

  it('bounds the depth and the length of an unknown route and templates odd segments', () => {
    expect(normalizeRoute('/api/a/b/c/d/e/f/g/h')).toBe('/api/a/b/c/d/e')
    expect(normalizeRoute('/api/x/12345678')).toBe('/api/x/:id')
    expect(normalizeRoute('/api/x/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab')).toBe('/api/x/:id')
    expect(normalizeRoute('/api/x/we!rd')).toBe('/api/x/:id')
    expect(normalizeRoute(`/api/${'y'.repeat(300)}`).length).toBeLessThanOrEqual(120)
  })

  it('names the window start day', () => {
    const now = Date.UTC(2026, 9, 9, 12, 0, 0) / 1000
    expect(windowStartDay(now, 1)).toBe('2026-10-09')
    expect(windowStartDay(now, 7)).toBe('2026-10-03')
    expect(windowStartDay(now, 90)).toBe('2026-07-12')
  })

  it('reads the skill owner label of a skill id', () => {
    expect(skillOwnerTarget('agent/Agent-B/skill-x')).toBe('agent-b')
    expect(skillOwnerTarget('global/skill-x')).toBe('global')
    expect(skillOwnerTarget('tenant-a-skill')).toBe('')
    expect(skillOwnerTarget('')).toBe('')
  })
})

describe('resolveShadowCaller', () => {
  it('a fleet_agent token is its agent, from the token', () => {
    expect(resolveShadowCaller(fleetAuth('agent-a'), 'agent-b')).toEqual({ caller: 'agent-a', source: 'token', shared: false, fleetAgent: true })
  })
  it('the main agent named admin token is an identity, not a fleet_agent and not the shared token', () => {
    expect(resolveShadowCaller(mainAdminAuth, undefined)).toEqual({ caller: MAIN, source: 'token', shared: false, fleetAgent: false })
  })
  it('the shared token enrolled in api_tokens (named dashboard, no agent) is the shared token too', () => {
    expect(resolveShadowCaller(enrolledSharedAuth, 'agent-a')).toEqual({ caller: 'agent-a', source: 'self_declared', shared: true, fleetAgent: false })
    expect(resolveShadowCaller({ ...enrolledSharedAuth, agentId: 'agent-a' }, undefined)).toMatchObject({ shared: false, source: 'token' }) // a name does not outrank an agent
  })
  it('the shared file token takes the X-Agent-Id header as a self-declaration', () => {
    expect(resolveShadowCaller(sharedAuth, 'agent-a')).toEqual({ caller: 'agent-a', source: 'self_declared', shared: true, fleetAgent: false })
    expect(resolveShadowCaller(sharedAuth, undefined)).toEqual({ caller: '', source: 'none', shared: true, fleetAgent: false })
    expect(resolveShadowCaller(sharedAuth, 'not valid!')).toEqual({ caller: '_invalid', source: 'self_declared', shared: true, fleetAgent: false })
  })
  it('a registered token that names no agent, a session, a device and a peer are not watched', () => {
    expect(resolveShadowCaller(operatorAuth, 'agent-a')).toBeNull()
    expect(resolveShadowCaller(sessionAuth, 'agent-a')).toBeNull()
    expect(resolveShadowCaller({ kind: 'device', device: 'device-a', deviceId: 1 }, 'agent-a')).toBeNull()
    expect(resolveShadowCaller({ kind: 'federation', peer: 'peer-a' }, 'agent-a')).toBeNull()
    expect(resolveShadowCaller({ kind: 'none' }, 'agent-a')).toBeNull()
  })
})

describe('identityHits', () => {
  const base = { caller: 'agent-a', mainAgentId: MAIN }
  it('own endpoints are agent_id_mismatch, unscoped ones foreign_row_access', () => {
    expect(identityHits({ ...base, kind: 'own', targets: ['agent-b'] })).toEqual([{ category: 'agent_id_mismatch', target: 'agent-b' }])
    expect(identityHits({ ...base, kind: 'unscoped', targets: ['agent-b'] })).toEqual([{ category: 'foreign_row_access', target: 'agent-b' }])
  })
  it('the caller\'s own id (any case), blanks and repeats are not hits', () => {
    expect(identityHits({ ...base, kind: 'own', targets: ['agent-a', 'AGENT-A', '', ' ', 'agent-b', 'Agent-B'] })).toEqual([{ category: 'agent_id_mismatch', target: 'agent-b' }])
  })
  it('no caller or the main agent as caller never hits', () => {
    expect(identityHits({ kind: 'own', caller: '', mainAgentId: MAIN, targets: ['agent-b'] })).toEqual([])
    expect(identityHits({ kind: 'own', caller: MAIN, mainAgentId: MAIN, targets: ['agent-b'] })).toEqual([])
    expect(identityHits({ kind: 'own', caller: MAIN, mainAgentId: ` ${MAIN.toUpperCase()} `, targets: ['agent-b'] })).toEqual([])
  })
  it('a malformed target is counted as _invalid, not dropped', () => {
    expect(identityHits({ ...base, kind: 'own', targets: ['b a d'] })).toEqual([{ category: 'agent_id_mismatch', target: '_invalid' }])
  })
})

describe('collectBodyAgents', () => {
  it('reads top-level keys and the objects of top-level arrays', () => {
    expect(collectBodyAgents({ agent_id: 'agent-b' }, ['agent_id'])).toEqual(['agent-b'])
    expect(collectBodyAgents({ entries: [{ agent_id: 'agent-b' }, { agent_id: 'agent-c' }, { other: 1 }] }, ['agent_id']).sort()).toEqual(['agent-b', 'agent-c'])
    expect(collectBodyAgents([{ agent_id: 'agent-b' }], ['agent_id'])).toEqual(['agent-b'])
  })
  it('ignores non-string, blank and nested-deeper values, and honours the key list', () => {
    expect(collectBodyAgents({ agent_id: 5, agent: ' ', nested: { agent_id: 'agent-b' } }, ['agent_id', 'agent'])).toEqual([])
    expect(collectBodyAgents({ from: 'agent-b', agent_id: 'agent-c' }, ['from'])).toEqual(['agent-b'])
    expect(collectBodyAgents('text', ['agent_id'])).toEqual([])
    expect(collectBodyAgents(null, ['agent_id'])).toEqual([])
  })
  it('looks at no more than 200 elements of an array', () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({ agent_id: i < 200 ? 'agent-a' : 'agent-late' }))
    expect(collectBodyAgents({ entries }, ['agent_id'])).toEqual(['agent-a'])
  })
})

describe('shared_token_use', () => {
  it('counts the shared token per route template and caller, a self-declaration marked as such', () => {
    observe(sharedAuth, 'GET', '/api/kanban', { 'x-agent-id': 'agent-a', 'user-agent': 'curl/8.4' })
    observe(sharedAuth, 'GET', '/api/kanban?status=done', { 'x-agent-id': 'Agent-A', 'user-agent': 'curl/8.4' })
    observe(sharedAuth, 'GET', '/api/kanban/242e55bc', { 'x-agent-id': 'agent-a' })
    observe(sharedAuth, 'GET', '/api/kanban', {})
    expect(rows('shared_token_use').map((r) => [r.route, r.caller, r.caller_source, r.client, r.count])).toEqual([
      ['/api/kanban', '', 'none', 'none', 1],
      ['/api/kanban', 'agent-a', 'self_declared', 'curl', 2],
      ['/api/kanban/:id', 'agent-a', 'self_declared', 'none', 1],
    ])
  })

  it('counts the enrolled shared token the same way', () => {
    observe(enrolledSharedAuth, 'GET', '/api/kanban', { 'x-agent-id': 'agent-a' })
    expect(rows('shared_token_use').map((r) => [r.caller, r.caller_source, r.count])).toEqual([['agent-a', 'self_declared', 1]])
  })

  it('does not count the other credentials, the main-agent token, the operator token or a fleet token', () => {
    observe(operatorAuth, 'GET', '/api/kanban')
    observe(sessionAuth, 'GET', '/api/kanban')
    observe(mainAdminAuth, 'GET', '/api/kanban')
    observe(fleetAuth('agent-a'), 'GET', '/api/kanban')
    expect(total('shared_token_use')).toBe(0)
  })

  it('does not count its own admin read (reading the counter must not move it)', () => {
    observe(sharedAuth, 'GET', '/api/token-shadow?days=3', { 'x-agent-id': 'agent-a' })
    observe(sharedAuth, 'GET', '/api/v1/token-shadow')
    expect(rows()).toEqual([])
  })

  it('the canonical and the legacy path spelling are one route', () => {
    observe(sharedAuth, 'GET', '/api/v1/kanban', { 'x-agent-id': 'agent-a' })
    observe(sharedAuth, 'GET', '/api/kanban', { 'x-agent-id': 'agent-a' })
    expect(rows('shared_token_use')).toHaveLength(1)
    expect(total('shared_token_use')).toBe(2)
  })
})

describe('agent_id_mismatch (own-scoped endpoints, first the ledger)', () => {
  it('a fleet token of agent-a naming agent-b in the path', () => {
    observe(fleetAuth('agent-a'), 'GET', '/api/conversation-ledger/agent-b/recent')
    expect(rows('agent_id_mismatch').map((r) => [r.route, r.caller, r.caller_source, r.target, r.count]))
      .toEqual([['/api/conversation-ledger/:agent/recent', 'agent-a', 'token', 'agent-b', 1]])
  })
  it('naming itself is not a mismatch', () => {
    observe(fleetAuth('agent-a'), 'GET', '/api/conversation-ledger/agent-a/recent')
    observe(fleetAuth('agent-a'), 'GET', '/api/daily-log?agent=agent-a')
    expect(total('agent_id_mismatch')).toBe(0)
  })
  it('a shared-token caller declaring agent-a and naming agent-b is a mismatch with a self_declared caller', () => {
    observe(sharedAuth, 'GET', '/api/daily-log?agent=agent-b', { 'x-agent-id': 'agent-a' })
    expect(rows('agent_id_mismatch').map((r) => [r.caller, r.caller_source, r.target])).toEqual([['agent-a', 'self_declared', 'agent-b']])
  })
  it('the main agent, with either credential, acts across agents without a hit', () => {
    observe(mainAdminAuth, 'GET', '/api/conversation-ledger/agent-b/recent')
    observe(sharedAuth, 'GET', '/api/conversation-ledger/agent-b/recent', { 'x-agent-id': MAIN })
    expect(total('agent_id_mismatch')).toBe(0)
  })
  it('a shared-token request that declares nobody has no caller to be a mismatch of', () => {
    observe(sharedAuth, 'GET', '/api/conversation-ledger/agent-b/recent')
    expect(total('agent_id_mismatch')).toBe(0)
  })
  it('the ledger batch body: every entry is looked at, a repeat of one agent counts once', async () => {
    const req = observe(fleetAuth('agent-a'), 'POST', '/api/conversation-ledger', {}, {
      entries: [{ agent_id: 'agent-a' }, { agent_id: 'agent-b' }, { agent_id: 'agent-b' }, { agent_id: 'agent-c' }],
    })
    expect(total('agent_id_mismatch')).toBe(0) // nothing is known before the body is read
    await drain(req)
    expect(rows('agent_id_mismatch').map((r) => [r.target, r.count])).toEqual([['agent-b', 1], ['agent-c', 1]])
  })
  it('messages: the from of the sender', async () => {
    const req = observe(fleetAuth('agent-a'), 'POST', '/api/messages', {}, { from: 'agent-b', to: 'agent-c', content: 'x' })
    await drain(req)
    expect(rows('agent_id_mismatch').map((r) => [r.route, r.target])).toEqual([['/api/messages', 'agent-b']]) // `to` is a recipient, not an identity
  })
  it('a name in both the query and the body is counted once per request', async () => {
    const req = observe(fleetAuth('agent-a'), 'POST', '/api/daily-log?agent=agent-b', {}, { agent_id: 'agent-b' })
    await drain(req)
    expect(total('agent_id_mismatch')).toBe(1)
  })
})

describe('foreign_row_access (endpoints reachable by permission only)', () => {
  it('blackboard: the body names another agent row, and the id of another agent row', async () => {
    const own = upsertBlackboard('agent-a', { summary: 's' })
    const foreign = upsertBlackboard('agent-b', { summary: 's' })
    await drain(observe(fleetAuth('agent-a'), 'POST', '/api/blackboard', {}, { agent_id: 'agent-b', summary: 'x' }))
    await drain(observe(fleetAuth('agent-a'), 'PATCH', `/api/blackboard/${foreign.id}`, {}, { status: 'done' }))
    observe(fleetAuth('agent-a'), 'PATCH', `/api/blackboard/${own.id}`)
    observe(fleetAuth('agent-a'), 'GET', '/api/blackboard/history?agent_id=agent-b')
    expect(rows('foreign_row_access').map((r) => [r.method, r.route, r.target, r.count])).toEqual([
      ['POST', '/api/blackboard', 'agent-b', 1],
      ['PATCH', '/api/blackboard/:id', 'agent-b', 1],
      ['GET', '/api/blackboard/history', 'agent-b', 1],
    ])
  })
  it('memories: a write that claims another agent, and a row owned by another agent', async () => {
    const mine = saveAgentMemory('agent-a', 'c1', 'warm').id
    const theirs = saveAgentMemory('agent-b', 'c2', 'warm').id
    await drain(observe(fleetAuth('agent-a'), 'POST', '/api/memories', {}, { agent_id: 'agent-b', content: 'x' }))
    await drain(observe(fleetAuth('agent-a'), 'PUT', `/api/memories/${theirs}`, {}, { content: 'y' }))
    observe(fleetAuth('agent-a'), 'DELETE', `/api/memories/${mine}`)
    observe(fleetAuth('agent-a'), 'GET', '/api/memories?agent=agent-b')
    expect(rows('foreign_row_access').map((r) => [r.method, r.route, r.target, r.count])).toEqual([
      ['GET', '/api/memories', 'agent-b', 1],
      ['POST', '/api/memories', 'agent-b', 1],
      ['PUT', '/api/memories/:id', 'agent-b', 1],
    ])
  })
  it('kanban: the card assignee and the assignee filter', () => {
    createKanbanCard({ id: 'card-own', title: 't', assignee: 'agent-a' })
    createKanbanCard({ id: 'card-foreign', title: 't', assignee: 'agent-b' })
    observe(fleetAuth('agent-a'), 'PATCH', '/api/kanban/card-own')
    observe(fleetAuth('agent-a'), 'PATCH', '/api/kanban/card-foreign')
    observe(fleetAuth('agent-a'), 'GET', '/api/kanban?assignee=agent-b')
    observe(fleetAuth('agent-a'), 'GET', '/api/kanban/labels')
    expect(rows('foreign_row_access').map((r) => [r.method, r.route, r.target])).toEqual([
      ['GET', '/api/kanban', 'agent-b'],
      ['PATCH', '/api/kanban/:id', 'agent-b'],
    ])
  })
  it('schedules: the owner of the task a name addresses, and the agent of a new one', async () => {
    const task = { prompt: 'p', description: 'd', schedule: '* * * * *', type: 'task' as const, enabled: true, tenant_id: null, skip_if_busy: false, force_send: false }
    upsertSchedule('task-own', { ...task, agent: 'agent-a' })
    upsertSchedule('task-foreign', { ...task, agent: 'agent-b' })
    observe(fleetAuth('agent-a'), 'PUT', '/api/schedules/task-own')
    observe(fleetAuth('agent-a'), 'DELETE', '/api/schedules/task-foreign')
    observe(fleetAuth('agent-a'), 'GET', '/api/schedules/tick-status')
    await drain(observe(fleetAuth('agent-a'), 'POST', '/api/schedules', {}, { name: 'n', agent: 'agent-c' }))
    expect(rows('foreign_row_access').map((r) => [r.method, r.route, r.target])).toEqual([
      ['POST', '/api/schedules', 'agent-c'],
      ['DELETE', '/api/schedules/:name', 'agent-b'],
    ])
  })
  it('a shared-token request is held to the same rule, by its self-declared caller', () => {
    createKanbanCard({ id: 'card-foreign', title: 't', assignee: 'agent-b' })
    observe(sharedAuth, 'PATCH', '/api/kanban/card-foreign', { 'x-agent-id': 'agent-a' })
    expect(rows('foreign_row_access').map((r) => [r.caller, r.caller_source, r.target])).toEqual([['agent-a', 'self_declared', 'agent-b']])
  })
  it('a row that does not exist, or has no owner, is not a hit', () => {
    createKanbanCard({ id: 'card-nobody', title: 't' })
    observe(fleetAuth('agent-a'), 'PATCH', '/api/kanban/card-missing')
    observe(fleetAuth('agent-a'), 'PATCH', '/api/kanban/card-nobody')
    observe(fleetAuth('agent-a'), 'PUT', '/api/memories/999999')
    expect(total('foreign_row_access')).toBe(0)
  })
  it('a failing row-owner lookup is swallowed and the rest of the request is still counted', () => {
    getDb().exec('DROP TABLE kanban_cards')
    expect(() => observe(sharedAuth, 'PATCH', '/api/kanban/card-x', { 'x-agent-id': 'agent-a' })).not.toThrow()
    expect(total('shared_token_use')).toBe(1)
  })
})

describe('unscoped_read', () => {
  it('the main agent lists across agents by design and is never counted', () => {
    observe(mainAdminAuth, 'GET', '/api/memories')
    observe(sharedAuth, 'GET', '/api/workspace', { 'x-agent-id': MAIN })
    expect(total('unscoped_read')).toBe(0)
  })

  it('a listing of memories or workspace documents with no agent filter reads across agents', () => {
    observe(fleetAuth('agent-a'), 'GET', '/api/memories')
    observe(fleetAuth('agent-a'), 'GET', '/api/workspace?q=x')
    observe(fleetAuth('agent-a'), 'GET', '/api/memories?agent=agent-a')
    observe(fleetAuth('agent-a'), 'GET', '/api/memories/search?agent=agent-a')
    observe(fleetAuth('agent-a'), 'POST', '/api/memories') // a write is not a listing
    observe(fleetAuth('agent-a'), 'GET', '/api/blackboard') // visible to all by design: not counted
    expect(rows('unscoped_read').map((r) => [r.route, r.target, r.count])).toEqual([['/api/memories', '*', 1], ['/api/workspace', '*', 1]])
  })
})

describe('tenant context', () => {
  it('a fleet token refused for a shared agent with no tenant context is counted by the web gate', () => {
    recordTenantContextRefusal(fakeReq({ 'user-agent': 'node' }), { kind: 'token', role: 'fleet_agent', tokenName: 'fleet_agent:agent-shared', agentId: 'agent-shared', tenantContextMissing: true }, 'GET', '/api/memories')
    expect(rows('missing_tenant_context').map((r) => [r.route, r.caller, r.caller_source, r.client, r.count])).toEqual([['/api/memories', 'agent-shared', 'token', 'node', 1]])
  })
  it('the refusal counter ignores a credential that is not a token naming an agent', () => {
    recordTenantContextRefusal(fakeReq(), sharedAuth, 'GET', '/api/memories')
    recordTenantContextRefusal(fakeReq(), sessionAuth, 'GET', '/api/memories')
    expect(total('missing_tenant_context')).toBe(0)
  })
  it('a shared-token request declaring a shared agent without ?tenant= is counted, with it or for another agent it is not', () => {
    observe(sharedAuth, 'GET', '/api/kanban', { 'x-agent-id': 'agent-shared' })
    observe(sharedAuth, 'GET', '/api/kanban?tenant=tenant-a', { 'x-agent-id': 'agent-shared' })
    observe(sharedAuth, 'GET', '/api/kanban', { 'x-agent-id': 'agent-a' })
    observe(sharedAuth, 'GET', '/api/kanban', {})
    expect(rows('missing_tenant_context').map((r) => [r.caller, r.caller_source, r.count])).toEqual([['agent-shared', 'self_declared', 1]])
  })
  it('GET /api/memories of a shared agent without a tenant, from the shared token and from a fleet token', () => {
    observe(sharedAuth, 'GET', '/api/memories?agent=agent-shared', { 'x-agent-id': MAIN })
    observe(fleetAuth('agent-a'), 'GET', '/api/memories?agent_id=agent-shared')
    observe(sharedAuth, 'GET', '/api/memories?agent=agent-shared&tenant=tenant-a')
    observe(sharedAuth, 'GET', '/api/memories?agent=agent-a')
    observe(sharedAuth, 'POST', '/api/memories?agent=agent-shared')
    observe(mainAdminAuth, 'GET', '/api/memories?agent=agent-shared') // an admin token has a tenant of its own to scope by
    expect(rows('shared_agent_memories_no_tenant').map((r) => [r.caller, r.caller_source, r.target])).toEqual([
      ['agent-a', 'token', 'agent-shared'],
      [MAIN, 'self_declared', 'agent-shared'],
    ])
  })
})

describe('fleet_skill_write_denied', () => {
  it('counts a refused skill write by the owner of the skill, empty for its own', () => {
    recordFleetSkillWriteDenied(fakeReq(), 'agent-a', 'PUT', '/api/skills/sql/agent%2Fagent-b%2Fx', 'agent/agent-b/x')
    recordFleetSkillWriteDenied(fakeReq(), 'agent-a', 'PUT', '/api/skills/sql/global%2Fy', 'global/y')
    recordFleetSkillWriteDenied(fakeReq(), 'agent-a', 'POST', '/api/skills/sql', '')
    recordFleetSkillWriteDenied(fakeReq(), 'agent-a', 'DELETE', '/api/skills/sql/agent%2Fagent-a%2Fz', 'agent/agent-a/z')
    expect(rows('fleet_skill_write_denied').map((r) => [r.method, r.route, r.caller, r.caller_source, r.target])).toEqual([
      ['POST', '/api/skills/sql', 'agent-a', 'token', ''],
      ['DELETE', '/api/skills/sql/:id', 'agent-a', 'token', ''],
      ['PUT', '/api/skills/sql/:id', 'agent-a', 'token', 'agent-b'],
      ['PUT', '/api/skills/sql/:id', 'agent-a', 'token', 'global'],
    ])
  })
  it('a call without a token agent counts nothing', () => {
    recordFleetSkillWriteDenied(fakeReq(), undefined, 'PUT', '/api/skills/sql/x', 'x')
    expect(rows()).toEqual([])
  })
})

describe('the writer', () => {
  const base = { method: 'GET', route: '/api/kanban', client: 'curl', caller: 'agent-a', callerSource: 'self_declared' as const }
  const T0 = Date.UTC(2026, 9, 9, 12, 0, 0) / 1000

  it('upserts one row per shape with a counter and the last timestamp', () => {
    recordTokenShadow(base, { category: 'shared_token_use', target: '' }, T0)
    recordTokenShadow(base, { category: 'shared_token_use', target: '' }, T0 + 5)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({ day: '2026-10-09', count: 2 })
    expect((getDb().prepare('SELECT last_ts FROM token_usage_shadow').get() as { last_ts: number }).last_ts).toBe(T0 + 5)
  })

  it('splits on the UTC day boundary', () => {
    const midnight = Date.UTC(2026, 9, 10, 0, 0, 0) / 1000
    recordTokenShadow(base, { category: 'shared_token_use', target: '' }, midnight - 1)
    recordTokenShadow(base, { category: 'shared_token_use', target: '' }, midnight)
    expect(rows().map((r) => [r.day, r.count])).toEqual([['2026-10-09', 1], ['2026-10-10', 1]])
  })

  it('folds shapes beyond the daily cap into one overflow row and loses no hit', () => {
    for (let i = 0; i < MAX_ROWS_PER_DAY + 50; i++) {
      recordTokenShadow({ ...base, caller: `agent-${i}` }, { category: 'shared_token_use', target: '' }, T0)
    }
    const all = rows()
    expect(all.length).toBe(MAX_ROWS_PER_DAY + 1) // the cap, plus the one overflow row
    expect(all.find((r) => r.route === '_overflow')).toMatchObject({ category: 'shared_token_use', caller: '_overflow', count: 50 })
    expect(all.reduce((n, r) => n + r.count, 0)).toBe(MAX_ROWS_PER_DAY + 50)
    // A shape already in the table keeps counting under its own key after the cap is reached.
    recordTokenShadow({ ...base, caller: 'agent-0' }, { category: 'shared_token_use', target: '' }, T0)
    expect(all.length).toBe(rows().length)
    expect(rows().find((r) => r.caller === 'agent-0')?.count).toBe(2)
  })

  it('the cap survives a process restart (the day state is rebuilt from the table)', () => {
    for (let i = 0; i < MAX_ROWS_PER_DAY; i++) recordTokenShadow({ ...base, caller: `agent-${i}` }, { category: 'shared_token_use', target: '' }, T0)
    resetTokenShadowForTests()
    recordTokenShadow({ ...base, caller: 'agent-new' }, { category: 'shared_token_use', target: '' }, T0)
    recordTokenShadow({ ...base, caller: 'agent-1' }, { category: 'shared_token_use', target: '' }, T0)
    expect(rows().find((r) => r.caller === 'agent-new')).toBeUndefined()
    expect(rows().find((r) => r.route === '_overflow')?.count).toBe(1)
    expect(rows().find((r) => r.caller === 'agent-1')?.count).toBe(2)
  })

  it('prunes days beyond the retention window, at most once an hour', () => {
    const old = Date.UTC(2026, 9, 9, 12, 0, 0) / 1000 - (RETENTION_DAYS + 1) * 86400
    const keep = Date.UTC(2026, 9, 9, 12, 0, 0) / 1000 - (RETENTION_DAYS - 1) * 86400
    recordTokenShadow(base, { category: 'shared_token_use', target: '' }, old) // sets the throttle at `old`
    recordTokenShadow(base, { category: 'shared_token_use', target: '' }, keep)
    expect(rows().map((r) => r.day)).toEqual([new Date(old * 1000).toISOString().slice(0, 10), new Date(keep * 1000).toISOString().slice(0, 10)].sort())
    recordTokenShadow(base, { category: 'shared_token_use', target: '' }, T0) // an hour+ later: prune runs
    expect(rows().map((r) => r.day).sort()).toEqual([new Date(keep * 1000).toISOString().slice(0, 10), '2026-10-09'].sort())
  })

  it('the table rejects an unknown caller source', () => {
    expect(() => getDb().prepare(
      `INSERT INTO token_usage_shadow (day, category, method, route, caller_source, last_ts) VALUES ('2026-10-09', 'c', 'GET', '/r', 'bogus', 1)`,
    ).run()).toThrow()
  })
})

describe('fail-safe: the counter never reaches a request', () => {
  it('a missing table makes the recorder return false, not throw, and the observer neither', async () => {
    getDb().exec('DROP TABLE token_usage_shadow')
    resetTokenShadowForTests()
    expect(recordTokenShadow({ method: 'GET', route: '/r', client: 'none', caller: 'agent-a', callerSource: 'token' }, { category: 'shared_token_use', target: '' })).toBe(false)
    const req = observe(sharedAuth, 'POST', '/api/daily-log?agent=agent-b', { 'x-agent-id': 'agent-a' }, { agent_id: 'agent-c' })
    expect(await drain(req)).toEqual(Buffer.from(JSON.stringify({ agent_id: 'agent-c' }))) // the handler still gets its body, untouched
  })

  it('readBody hands the body over unchanged even when the observer throws', async () => {
    const req = fakeReq({}, { a: 1 })
    const spy = vi.spyOn(getDb(), 'prepare').mockImplementation(() => { throw new Error('boom') })
    ;(await import('../web/http-helpers.js')).setRequestBodyObserver(() => { throw new Error('observer boom') })
    try {
      expect(await drain(req)).toEqual(Buffer.from('{"a":1}'))
    } finally {
      spy.mockRestore()
      const mod = await import('../web/token-shadow.js')
      ;(await import('../web/http-helpers.js')).setRequestBodyObserver((r, b) => mod.observeRequestBody(r, b))
    }
  })

  it('a body that is not JSON, empty, or too large counts nothing and raises nothing', async () => {
    for (const body of ['not json', '', '{"agent_id":"' + 'x'.repeat(300 * 1024) + '"}']) {
      const req = observe(fleetAuth('agent-a'), 'POST', '/api/daily-log', {}, body)
      await drain(req)
    }
    expect(total('agent_id_mismatch')).toBe(0)
  })

  it('observeRequestBody on a request nobody registered is a no-op', () => {
    expect(() => observeRequestBody(fakeReq(), Buffer.from('{"agent_id":"agent-b"}'))).not.toThrow()
    expect(rows()).toEqual([])
  })

  it('a GET is never registered for a body read', async () => {
    const req = observe(fleetAuth('agent-a'), 'GET', '/api/daily-log')
    await drain(req)
    expect(rows()).toEqual([])
  })
})

describe('GET /api/token-shadow', () => {
  const T = Math.floor(Date.now() / 1000)
  const base = { method: 'GET', route: '/api/kanban', client: 'curl', caller: 'agent-a', callerSource: 'self_declared' as const }

  async function get(role: string | undefined, query = '', method = 'GET') {
    const out: { status: number; body: Record<string, unknown> | null; handled: boolean } = { status: 0, body: null, handled: false }
    const res = {
      writeHead(s: number) { out.status = s },
      setHeader() {},
      end(b?: string) { if (b) out.body = JSON.parse(b) },
    } as unknown as http.ServerResponse
    const url = new URL(`http://localhost:3420/api/token-shadow${query}`)
    out.handled = await tryHandleTokenShadow({ req: fakeReq(), res, path: url.pathname, method, url, role } as unknown as RouteContext)
    return out
  }

  beforeEach(() => {
    recordTokenShadow(base, { category: 'shared_token_use', target: '' }, T)
    recordTokenShadow(base, { category: 'shared_token_use', target: '' }, T)
    recordTokenShadow({ ...base, route: '/api/conversation-ledger/:agent/recent', callerSource: 'token' }, { category: 'agent_id_mismatch', target: 'agent-b' }, T)
    recordTokenShadow({ ...base, caller: 'agent-c', route: '/api/odd_route' }, { category: 'shared_token_use', target: '' }, T - 3 * 86400)
  })

  it('is admin-only: every other role is a 403 and sees nothing', async () => {
    for (const role of ['fleet_agent', 'agent', 'read_only', 'viewer', undefined]) {
      const r = await get(role)
      expect(r.status).toBe(403)
      expect(r.body).toEqual({ error: 'forbidden', hint: expect.any(String) })
    }
  })

  it('gives the admin the totals per category and the rows of the window', async () => {
    const r = await get('admin', '?days=2')
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ days: 2, totals: [{ category: 'shared_token_use', count: 2 }, { category: 'agent_id_mismatch', count: 1 }] })
    expect((r.body!.rows as Row[]).map((x) => [x.category, x.route, x.count])).toEqual([
      ['shared_token_use', '/api/kanban', 2],
      ['agent_id_mismatch', '/api/conversation-ledger/:agent/recent', 1],
    ])
  })

  it('the window is in days, the default is 7 and a wider one reaches older rows', async () => {
    expect(((await get('admin', '?days=4')).body!.rows as Row[]).some((x) => x.caller === 'agent-c')).toBe(true)
    expect(((await get('admin', '?days=3')).body!.rows as Row[]).some((x) => x.caller === 'agent-c')).toBe(false)
    expect((await get('admin')).body).toMatchObject({ days: 7 })
  })

  it('filters by category, caller and a literal route substring', async () => {
    expect(((await get('admin', '?category=agent_id_mismatch')).body!.rows as Row[])).toHaveLength(1)
    expect(((await get('admin', '?caller=agent-c&days=5')).body!.rows as Row[]).map((x) => x.caller)).toEqual(['agent-c'])
    expect(((await get('admin', '?route=ledger')).body!.rows as Row[])).toHaveLength(1)
    expect(((await get('admin', '?route=_')).body!.rows as Row[]).map((x) => x.route)).toEqual(['/api/odd_route'])
    // '_' and '%' are literals in a route filter, not LIKE wildcards
    expect(((await get('admin', '?route=%25&days=5')).body!.rows as Row[])).toEqual([])
    expect(((await get('admin', '?route=a_i&days=5')).body!.rows as Row[])).toEqual([])
    expect(((await get('admin', '?route=%5C&days=5')).body!.rows as Row[])).toEqual([]) // a backslash is a literal too, not an escape
  })

  it('limits the rows, newest day then busiest shape first', async () => {
    const r = await get('admin', '?limit=1&days=5')
    expect(r.body!.rows as Row[]).toHaveLength(1)
    expect((r.body!.rows as Row[])[0]).toMatchObject({ route: '/api/kanban', count: 2 })
    expect((r.body!.totals as unknown[]).length).toBe(2) // the totals cover the window, not the page
  })

  it.each([['days=0'], ['days=91'], ['days=x'], ['days=-1'], ['days=1.5'], ['limit=0'], ['limit=1001'], ['limit=x'], ['category=nope']])('rejects %s with 400', async (q) => {
    const r = await get('admin', `?${q}`)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'invalid_value' })
  })

  it('answers only GET on its own path', async () => {
    expect((await get('admin', '', 'POST')).handled).toBe(false)
    const res = { writeHead() {}, setHeader() {}, end() {} } as unknown as http.ServerResponse
    const url = new URL('http://localhost:3420/api/token-shadow/x')
    expect(await tryHandleTokenShadow({ req: fakeReq(), res, path: url.pathname, method: 'GET', url, role: 'admin' } as unknown as RouteContext)).toBe(false)
  })

  it('lists every category the observer can write', () => {
    expect([...TOKEN_SHADOW_CATEGORIES].sort()).toEqual([
      'agent_id_mismatch', 'fleet_skill_write_denied', 'foreign_row_access', 'missing_tenant_context',
      'shared_agent_memories_no_tenant', 'shared_token_use', 'unscoped_read',
    ])
  })
})

describe('RBAC: the endpoint is admin:all, so no fleet_agent and no tenant user reaches it', () => {
  it('a fleet token is refused by the gate in enforce mode, an admin token is let in', () => {
    expect(checkPermission(fleetAuth('agent-a'), 'GET', '/api/token-shadow').allowed).toBe(false)
    expect(checkPermission(fleetAuth('agent-a'), 'GET', '/api/v1/token-shadow').allowed).toBe(false)
    expect(checkPermission(operatorAuth, 'GET', '/api/token-shadow').allowed).toBe(true)
    expect(checkPermission(sessionAuth, 'GET', '/api/token-shadow').allowed).toBe(true)
    expect(checkPermission({ kind: 'session', user: 'user-a', role: 'viewer' }, 'GET', '/api/token-shadow').allowed).toBe(false)
  })
})
