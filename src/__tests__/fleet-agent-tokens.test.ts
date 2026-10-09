// Per-agent API tokens (api_tokens.agent_id, the fleet_agent role), end to end through the pieces the
// web gate chains: resolveAuth -> the tenant-context refusal -> checkPermission (enforce) -> route.
// The evidence test of the phase: agent A's token against agent B's ledger is a 403.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type http from 'node:http'
import {
  initDatabase, getDb, createTenant, setTenantAgentAvailability, insertApiToken, revokeApiToken,
  logLedgerTurn, recentLedgerTurns, getDailyLog, listApiTokenRows,
} from '../db.js'
import { resolveAuth } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { tryHandleConversationLedger } from '../web/routes/conversation-ledger.js'
import { tryHandleAgentState } from '../web/routes/agent-state.js'
import { tryHandleAgentTaskState } from '../web/routes/agent-taskstate.js'
import { tryHandleDailyLog } from '../web/routes/daily-log.js'
import { tryHandleSpans } from '../web/routes/spans.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { tryHandleAdminTokens } from '../web/routes/tokens.js'
import type { RouteContext, RouteHandler } from '../web/routes/types.js'

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['rick', 'boo', 'solo', 'shared'],
  isKnownAgent: (n: string) => ['rick', 'boo', 'solo', 'shared', 'jarvis'].includes(n),
}))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'jarvis' }))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = () => Math.floor(Date.now() / 1000)

function mint(raw: string, agentId: string | null, role: 'fleet_agent' | 'admin' = 'fleet_agent', over: { expiresAt?: number | null } = {}): number {
  return insertApiToken({ tokenHash: sha(raw), name: `${role}:${agentId ?? 'none'}`, role, tenantId: 'default', createdAt: NOW() - 10, expiresAt: over.expiresAt ?? null, agentId }).id
}

const HANDLERS: RouteHandler[] = [
  tryHandleConversationLedger, tryHandleAgentState, tryHandleAgentTaskState, tryHandleDailyLog,
  tryHandleSpans, tryHandleMessages, tryHandleApprovals, tryHandleAdminTokens,
]

// The gate of web.ts in miniature: same calls, same order.
async function request(rawToken: string | null, method: string, path: string, body?: unknown) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.method = method
  req.headers = rawToken ? { authorization: `Bearer ${rawToken}` } : {}
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) {
      if (!b) return
      try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) } catch { /* not JSON */ }
    },
  } as unknown as http.ServerResponse
  const url = new URL(`http://localhost:3420${path}`)
  const auth = resolveAuth(req, url, url.pathname, method, 'the-file-token', true)
  if (auth.kind === 'none') { out.status = 401; return out }
  if (auth.kind === 'token' && auth.tenantContextMissing) { out.status = 403; out.body = { error: 'forbidden', hint: 'no fresh tenant context' }; return out }
  const decision = checkPermission(auth, method, url.pathname)
  if (!decision.allowed) { out.status = decision.status; out.body = { error: 'denied', reason: decision.reason }; return out }
  const role = resolveRole(auth)
  const tokenAgentId = auth.kind === 'token' ? auth.agentId : undefined
  const ctx = {
    req, res, path: url.pathname, method, url, role, tenantId: resolveTenantId(auth), tokenAgentId,
    agentId: role === 'fleet_agent' && tokenAgentId ? tokenAgentId : undefined,
    auth: auth.kind === 'token' ? { kind: 'token', tokenName: auth.tokenName } : undefined,
  } as unknown as RouteContext
  for (const h of HANDLERS) if (await h(ctx)) return out
  out.status = 404
  return out
}

const setContext = (agent: string, tenant: string, status: string, ageSeconds = 0) =>
  getDb().prepare('INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status, updated_at) VALUES (?, ?, ?, ?)')
    .run(agent, tenant, status, NOW() - ageSeconds)

const turn = (agent: string, id: string) => ({ agent_id: agent, chat_id: '1', direction: 'in' as const, message_id: id, text: `t-${id}`, created_at: 1000 })

beforeEach(() => {
  initDatabase(':memory:')
  mint('tok-rick', 'rick')
  mint('tok-boo', 'boo')
  mint('tok-jarvis', 'jarvis', 'admin')
})

describe('resolveAuth with a fleet_agent token', () => {
  it('names the agent and the role, and derives the tenant instead of reading it from the token', () => {
    const req = { headers: { authorization: 'Bearer tok-rick' } } as unknown as http.IncomingMessage
    const auth = resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'file', true)
    expect(auth).toMatchObject({ kind: 'token', role: 'fleet_agent', agentId: 'rick', tenantId: 'default' })
  })

  it('refuses a revoked token without falling back to the file token or to admin', () => {
    const id = mint('tok-gone', 'rick')
    revokeApiToken(id, NOW())
    const req = { headers: { authorization: 'Bearer tok-gone' } } as unknown as http.IncomingMessage
    expect(resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'file', true)).toEqual({ kind: 'none' })
  })

  it('refuses an expired token', () => {
    mint('tok-old', 'rick', 'fleet_agent', { expiresAt: NOW() - 5 })
    const req = { headers: { authorization: 'Bearer tok-old' } } as unknown as http.IncomingMessage
    expect(resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'file', true)).toEqual({ kind: 'none' })
  })

  it('a named admin token carries the agent id as a label and stays admin', () => {
    const req = { headers: { authorization: 'Bearer tok-jarvis' } } as unknown as http.IncomingMessage
    expect(resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'file', true)).toMatchObject({ kind: 'token', role: 'admin', agentId: 'jarvis' })
  })

  it('the shared file token keeps working and names no agent', () => {
    const req = { headers: { authorization: 'Bearer the-file-token' } } as unknown as http.IncomingMessage
    const auth = resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'the-file-token', true)
    expect(auth).toEqual({ kind: 'token' })
  })
})

describe('conversation ledger: the identity comes from the token', () => {
  beforeEach(() => {
    logLedgerTurn(turn('boo', 'b1'))
    logLedgerTurn(turn('rick', 'r1'))
  })

  it("agent A's token against agent B's ledger is a 403 (read)", async () => {
    const r = await request('tok-rick', 'GET', '/api/conversation-ledger/boo/recent')
    expect(r.status).toBe(403)
    expect(JSON.stringify(r.body)).not.toContain('t-b1')
  })

  it("agent A's token against agent B's open-question is a 403", async () => {
    expect((await request('tok-rick', 'GET', '/api/conversation-ledger/boo/open-question')).status).toBe(403)
  })

  it('a foreign id is a 403 even when that agent does not exist (no existence oracle)', async () => {
    expect((await request('tok-rick', 'GET', '/api/conversation-ledger/ghost/recent')).status).toBe(403)
  })

  it("agent A's token cannot write a turn under B's name, and nothing is stored", async () => {
    const r = await request('tok-rick', 'POST', '/api/conversation-ledger', turn('boo', 'forged'))
    expect(r.status).toBe(403)
    expect(recentLedgerTurns('boo', 50).map(t => t.text)).toEqual(['t-b1'])
  })

  it('one foreign entry refuses the whole batch', async () => {
    const r = await request('tok-rick', 'POST', '/api/conversation-ledger', { entries: [turn('rick', 'r2'), turn('boo', 'forged')] })
    expect(r.status).toBe(403)
    expect(recentLedgerTurns('rick', 50).map(t => t.text)).toEqual(['t-r1'])
  })

  it('the token reads and writes its own ledger', async () => {
    expect((await request('tok-rick', 'POST', '/api/conversation-ledger', turn('rick', 'r2'))).status).toBe(200)
    const r = await request('tok-rick', 'GET', '/api/conversation-ledger/rick/recent')
    expect(r.status).toBe(200)
    expect((r.body['turns'] as { text: string }[]).map(t => t.text).sort()).toEqual(['t-r1', 't-r2'])
  })

  it('the main agent admin token and the file token may name any agent', async () => {
    expect((await request('tok-jarvis', 'GET', '/api/conversation-ledger/boo/recent')).status).toBe(200)
    expect((await request('tok-jarvis', 'POST', '/api/conversation-ledger', turn('rick', 'by-admin'))).status).toBe(200)
    expect((await request('the-file-token', 'GET', '/api/conversation-ledger/boo/recent')).status).toBe(200)
  })

  it('no token at all is a 401', async () => {
    expect((await request(null, 'GET', '/api/conversation-ledger/rick/recent')).status).toBe(401)
  })
})

describe('other own-agent endpoints', () => {
  it('agent state and task state: own yes, foreign 403', async () => {
    expect((await request('tok-rick', 'PUT', '/api/agent-state/rick/gate_run_state', { value: { a: 1 } })).status).toBe(200)
    expect((await request('tok-rick', 'GET', '/api/agent-state/rick/gate_run_state')).status).toBe(200)
    expect((await request('tok-rick', 'GET', '/api/agent-state/boo/gate_run_state')).status).toBe(403)
    expect((await request('tok-rick', 'PUT', '/api/agent-state/boo/gate_run_state', { value: 1 })).status).toBe(403)
    expect((await request('tok-rick', 'POST', '/api/agent-taskstate/rick', { summary: 's' })).status).toBe(200)
    expect((await request('tok-rick', 'GET', '/api/agent-taskstate/boo/replay')).status).toBe(403)
    expect((await request('tok-rick', 'POST', '/api/agent-taskstate/boo/consume')).status).toBe(403)
    expect((await request('tok-rick', 'DELETE', '/api/agent-taskstate/boo')).status).toBe(403)
  })

  it('daily log: an omitted agent_id is the token agent, not the main agent; a foreign one is 403', async () => {
    expect((await request('tok-rick', 'POST', '/api/daily-log', { content: 'from rick' })).status).toBe(200)
    const date = new Date().toISOString().split('T')[0]!
    expect(getDailyLog('rick', date).map(e => e.content)).toEqual(['from rick'])
    expect(getDailyLog('jarvis', date)).toEqual([])
    expect((await request('tok-rick', 'POST', '/api/daily-log', { agent_id: 'boo', content: 'forged' })).status).toBe(403)
    expect((await request('tok-rick', 'GET', '/api/daily-log?agent=boo')).status).toBe(403)
    expect((await request('tok-rick', 'GET', '/api/daily-log')).status).toBe(200)
  })

  it('spans: own agent only, and another agent span cannot be closed or overwritten', async () => {
    const open = (agent: string, span: string) => request('tok-boo', 'POST', '/api/spans', { trace_id: 't', span_id: span, agent_id: agent, operation: 'op', start_ms: 1 })
    expect((await open('boo', 's1')).status).toBe(200)
    expect((await open('rick', 's2')).status).toBe(403)
    expect((await request('tok-rick', 'POST', '/api/spans', { trace_id: 't', span_id: 's1', end_ms: 5 })).status).toBe(403)
    expect((await request('tok-rick', 'POST', '/api/spans', { trace_id: 't', span_id: 's1', agent_id: 'rick', operation: 'x', start_ms: 1 })).status).toBe(403)
    expect((await request('tok-boo', 'POST', '/api/spans', { trace_id: 't', span_id: 's1', end_ms: 5 })).status).toBe(200)
  })

  it('messages: the sender is the token agent; an omitted from is filled in, a forged one is 403', async () => {
    const ok = await request('tok-rick', 'POST', '/api/messages', { to: 'boo', content: 'hello' })
    expect(ok.status).toBe(200)
    const row = getDb().prepare('SELECT from_agent FROM agent_messages ORDER BY id DESC LIMIT 1').get() as { from_agent: string }
    expect(row.from_agent).toBe('rick')
    expect((await request('tok-rick', 'POST', '/api/messages', { from: 'rick', to: 'boo', content: 'hi' })).status).toBe(200)
    const forged = await request('tok-rick', 'POST', '/api/messages', { from: 'boo', to: 'jarvis', content: 'forged' })
    expect(forged.status).toBe(403)
    expect((await request('the-file-token', 'POST', '/api/messages', { from: 'boo', to: 'rick', content: 'admin may' })).status).toBe(200)
  })

  it('approvals: a fleet agent asks as itself and cannot resolve', async () => {
    const asked = await request('tok-rick', 'POST', '/api/approvals', { agent_id: 'rick', category: 'c', action_description: 'd' })
    expect(asked.status).toBe(201)
    expect((await request('tok-rick', 'POST', '/api/approvals', { agent_id: 'boo', category: 'c', action_description: 'd' })).status).toBe(403)
    expect((await request('tok-rick', 'GET', `/api/approvals/${asked.body['id']}`)).status).toBe(200)
    expect((await request('tok-rick', 'PATCH', `/api/approvals/${asked.body['id']}`, { status: 'approved', resolved_by: 'rick' })).status).toBe(403)
    expect((await request('tok-boo', 'PATCH', `/api/approvals/${asked.body['id']}`, { status: 'approved', resolved_by: 'boo' })).status).toBe(403)
    expect((await request('the-file-token', 'PATCH', `/api/approvals/${asked.body['id']}`, { status: 'approved', resolved_by: 'jarvis' })).status).toBe(200)
  })
})

describe('what a fleet_agent token cannot reach at all', () => {
  const denied: [string, string][] = [
    ['POST', '/api/agents/boo/stop'], ['POST', '/api/agents/boo/restart'], ['POST', '/api/agents'],
    ['GET', '/api/admin/tokens'], ['POST', '/api/admin/tokens'], ['GET', '/api/vault'],
    ['POST', '/api/schedules/x/activate'], ['GET', '/api/hook-audit'], ['GET', '/api/skills/sql/x/access'],
    ['PUT', '/api/skills/sql/x/access/t1'], ['GET', '/api/messages'], ['GET', '/api/agents/export-all'],
    ['GET', '/api/rbac/shadow-log'], ['POST', '/api/egress-allowlist'], ['GET', '/api/federation/manifest'],
  ]
  it.each(denied)('%s %s is a 403', async (method, path) => {
    expect((await request('tok-rick', method, path, method === 'GET' ? undefined : {})).status).toBe(403)
  })

  it('and what the matrix grants it is reachable', () => {
    const auth = { kind: 'token' as const, role: 'fleet_agent' as const, tenantId: 'default', agentId: 'rick' }
    for (const [m, p] of [
      ['GET', '/api/memories'], ['POST', '/api/memories'], ['GET', '/api/kanban'], ['POST', '/api/blackboard'],
      ['POST', '/api/messages'], ['POST', '/api/approvals'], ['GET', '/api/schedules'], ['POST', '/api/hook-audit'],
      ['POST', '/api/spans'], ['POST', '/api/skill-usage'], ['POST', '/api/tool-log'], ['GET', '/api/autonomy'],
      ['GET', '/api/egress-allowlist'], ['GET', '/api/voice/directive'], ['PUT', '/api/skills/sql/x'], ['GET', '/api/artifacts'],
    ] as const) {
      expect(checkPermission(auth, m, p).allowed, `${m} ${p}`).toBe(true)
    }
  })
})

describe('a shared agent has no tenant on the token: the serving context decides, and none means no', () => {
  beforeEach(() => {
    createTenant('acme', 'Acme')
    setTenantAgentAvailability('default', 'shared', true)
    setTenantAgentAvailability('acme', 'shared', true)
    mint('tok-shared', 'shared')
    logLedgerTurn(turn('shared', 's1'))
  })

  it('is refused (403) without a tenant context, even on its own ledger', async () => {
    expect((await request('tok-shared', 'GET', '/api/conversation-ledger/shared/recent')).status).toBe(403)
  })

  it('is refused with a stale context', async () => {
    setContext('shared', 'acme', 'bound', 13 * 3600)
    expect((await request('tok-shared', 'GET', '/api/conversation-ledger/shared/recent')).status).toBe(403)
  })

  it('is refused with an unknown or conflicting context', async () => {
    setContext('shared', '', 'unknown')
    expect((await request('tok-shared', 'GET', '/api/conversation-ledger/shared/recent')).status).toBe(403)
    setContext('shared', '', 'conflict')
    expect((await request('tok-shared', 'GET', '/api/conversation-ledger/shared/recent')).status).toBe(403)
  })

  it('works with a fresh context and takes the tenant from it', async () => {
    setContext('shared', 'acme', 'bound')
    const req = { headers: { authorization: 'Bearer tok-shared' } } as unknown as http.IncomingMessage
    expect(resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'file', true)).toMatchObject({ role: 'fleet_agent', tenantId: 'acme', agentId: 'shared' })
    expect((await request('tok-shared', 'GET', '/api/conversation-ledger/shared/recent')).status).toBe(200)
  })

  it('an agent that serves one tenant needs no context', async () => {
    setTenantAgentAvailability('acme', 'solo', true)
    mint('tok-solo', 'solo')
    const req = { headers: { authorization: 'Bearer tok-solo' } } as unknown as http.IncomingMessage
    expect(resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'file', true)).toMatchObject({ tenantId: 'acme' })
  })

  it('checkPermission itself denies the missing-context token (not only the web gate)', () => {
    const d = checkPermission({ kind: 'token', role: 'fleet_agent', agentId: 'shared', tenantContextMissing: true }, 'GET', '/api/memories')
    expect(d).toMatchObject({ allowed: false, status: 403 })
  })
})

describe('token management with agent_id', () => {
  const admin = (body: unknown) => request('the-file-token', 'POST', '/api/admin/tokens', body)

  it('creates a fleet_agent token for a known agent, with the neutral tenant, and the raw token works once', async () => {
    const r = await admin({ name: 'fleet-agent:boo-2', role: 'fleet_agent', agent_id: 'boo', tenant_id: 'acme' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ role: 'fleet_agent', agent_id: 'boo', tenant_id: 'default' })
    const raw = r.body['token'] as string
    expect((await request(raw, 'GET', '/api/conversation-ledger/boo/recent')).status).toBe(200)
    expect((await request(raw, 'GET', '/api/conversation-ledger/rick/recent')).status).toBe(403)
    const listed = await request('the-file-token', 'GET', '/api/admin/tokens')
    expect(JSON.stringify(listed.body)).not.toContain(raw)
  })

  it('refuses a fleet_agent token without an agent, with an unknown agent, or a bad agent id', async () => {
    expect((await admin({ name: 'n', role: 'fleet_agent' })).status).toBe(400)
    expect((await admin({ name: 'n', role: 'fleet_agent', agent_id: 'nobody' })).status).toBe(404)
    expect((await admin({ name: 'n', role: 'fleet_agent', agent_id: '../x' })).status).toBe(400)
  })

  it('an agent_id on a tenant-user role is refused; on admin it is a label', async () => {
    expect((await admin({ name: 'n', role: 'viewer', agent_id: 'boo' })).status).toBe(400)
    expect((await admin({ name: 'main', role: 'admin', agent_id: 'jarvis' })).status).toBe(201)
  })

  it('a fleet_agent token cannot mint tokens', async () => {
    expect((await request('tok-rick', 'POST', '/api/admin/tokens', { name: 'x', role: 'admin' })).status).toBe(403)
  })

  it('rotation keeps the agent: the old token stops, the new one is the same agent', async () => {
    const id = (listApiTokenRows().find(r => r.agent_id === 'rick'))!.id
    const rotated = await request('the-file-token', 'POST', `/api/admin/tokens/${id}/rotate`, {})
    expect(rotated.status).toBe(200)
    expect(rotated.body).toMatchObject({ agent_id: 'rick', role: 'fleet_agent' })
    expect((await request('tok-rick', 'GET', '/api/conversation-ledger/rick/recent')).status).toBe(401)
    expect((await request(rotated.body['token'] as string, 'GET', '/api/conversation-ledger/rick/recent')).status).toBe(200)
  })

  it('revoking stops a token at the next request', async () => {
    const id = (listApiTokenRows().find(r => r.agent_id === 'boo'))!.id
    expect((await request('tok-boo', 'GET', '/api/conversation-ledger/boo/recent')).status).toBe(200)
    expect((await request('the-file-token', 'DELETE', `/api/admin/tokens/${id}/revoke`)).status).toBe(200)
    expect((await request('tok-boo', 'GET', '/api/conversation-ledger/boo/recent')).status).toBe(401)
  })
})
