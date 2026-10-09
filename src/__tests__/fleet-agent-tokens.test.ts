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
import { tryHandleHookAudit } from '../web/routes/hook-audit.js'
import { tryHandleSkillUsage } from '../web/routes/skill-usage.js'
import { tryHandleToolLog } from '../web/routes/tool-log.js'
import { tryHandleArtifacts } from '../web/routes/artifacts.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import type { RouteContext, RouteHandler } from '../web/routes/types.js'

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['alpha', 'beta', 'solo', 'shared'],
  isKnownAgent: (n: string) => ['alpha', 'beta', 'solo', 'shared', 'main-agent'].includes(n),
}))
// The skill routes mirror every write to <project>/agents/<name>/.claude/skills on disk: keep the test off the real tree.
vi.mock('../web/skill-regen.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/skill-regen.js')>()),
  regenSingleSkillFile: () => ({ written: false, reason: 'test' }),
  removeGeneratedSkillFile: () => {},
  removeGeneratedCompanionFile: () => {},
}))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-agent' }))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = () => Math.floor(Date.now() / 1000)

function mint(raw: string, agentId: string | null, role: 'fleet_agent' | 'admin' = 'fleet_agent', over: { expiresAt?: number | null } = {}): number {
  return insertApiToken({ tokenHash: sha(raw), name: `${role}:${agentId ?? 'none'}`, role, tenantId: 'default', createdAt: NOW() - 10, expiresAt: over.expiresAt ?? null, agentId }).id
}

const HANDLERS: RouteHandler[] = [
  tryHandleConversationLedger, tryHandleAgentState, tryHandleAgentTaskState, tryHandleDailyLog,
  tryHandleSpans, tryHandleMessages, tryHandleApprovals, tryHandleAdminTokens, tryHandleHookAudit,
  tryHandleSkillUsage, tryHandleToolLog, tryHandleArtifacts, tryHandleSkills,
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
  mint('tok-alpha', 'alpha')
  mint('tok-beta', 'beta')
  mint('tok-main-agent', 'main-agent', 'admin')
})

describe('resolveAuth with a fleet_agent token', () => {
  it('names the agent and the role, and derives the tenant instead of reading it from the token', () => {
    const req = { headers: { authorization: 'Bearer tok-alpha' } } as unknown as http.IncomingMessage
    const auth = resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'file', true)
    expect(auth).toMatchObject({ kind: 'token', role: 'fleet_agent', agentId: 'alpha', tenantId: 'default' })
  })

  it('refuses a revoked token without falling back to the file token or to admin', () => {
    const id = mint('tok-gone', 'alpha')
    revokeApiToken(id, NOW())
    const req = { headers: { authorization: 'Bearer tok-gone' } } as unknown as http.IncomingMessage
    expect(resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'file', true)).toEqual({ kind: 'none' })
  })

  it('refuses an expired token', () => {
    mint('tok-old', 'alpha', 'fleet_agent', { expiresAt: NOW() - 5 })
    const req = { headers: { authorization: 'Bearer tok-old' } } as unknown as http.IncomingMessage
    expect(resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'file', true)).toEqual({ kind: 'none' })
  })

  it('a named admin token carries the agent id as a label and stays admin', () => {
    const req = { headers: { authorization: 'Bearer tok-main-agent' } } as unknown as http.IncomingMessage
    expect(resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'file', true)).toMatchObject({ kind: 'token', role: 'admin', agentId: 'main-agent' })
  })

  it('the shared file token keeps working and names no agent', () => {
    const req = { headers: { authorization: 'Bearer the-file-token' } } as unknown as http.IncomingMessage
    const auth = resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'the-file-token', true)
    expect(auth).toEqual({ kind: 'token' })
  })
})

describe('conversation ledger: the identity comes from the token', () => {
  beforeEach(() => {
    logLedgerTurn(turn('beta', 'b1'))
    logLedgerTurn(turn('alpha', 'r1'))
  })

  it("agent A's token against agent B's ledger is a 403 (read)", async () => {
    const r = await request('tok-alpha', 'GET', '/api/conversation-ledger/beta/recent')
    expect(r.status).toBe(403)
    expect(JSON.stringify(r.body)).not.toContain('t-b1')
  })

  it("agent A's token against agent B's open-question is a 403", async () => {
    expect((await request('tok-alpha', 'GET', '/api/conversation-ledger/beta/open-question')).status).toBe(403)
  })

  it('a foreign id is a 403 even when that agent does not exist (no existence oracle)', async () => {
    expect((await request('tok-alpha', 'GET', '/api/conversation-ledger/ghost/recent')).status).toBe(403)
  })

  it("agent A's token cannot write a turn under B's name, and nothing is stored", async () => {
    const r = await request('tok-alpha', 'POST', '/api/conversation-ledger', turn('beta', 'forged'))
    expect(r.status).toBe(403)
    expect(recentLedgerTurns('beta', 50).map(t => t.text)).toEqual(['t-b1'])
  })

  it('one foreign entry refuses the whole batch', async () => {
    const r = await request('tok-alpha', 'POST', '/api/conversation-ledger', { entries: [turn('alpha', 'r2'), turn('beta', 'forged')] })
    expect(r.status).toBe(403)
    expect(recentLedgerTurns('alpha', 50).map(t => t.text)).toEqual(['t-r1'])
  })

  it('the token reads and writes its own ledger', async () => {
    expect((await request('tok-alpha', 'POST', '/api/conversation-ledger', turn('alpha', 'r2'))).status).toBe(200)
    const r = await request('tok-alpha', 'GET', '/api/conversation-ledger/alpha/recent')
    expect(r.status).toBe(200)
    expect((r.body['turns'] as { text: string }[]).map(t => t.text).sort()).toEqual(['t-r1', 't-r2'])
  })

  it('the main agent admin token and the file token may name any agent', async () => {
    expect((await request('tok-main-agent', 'GET', '/api/conversation-ledger/beta/recent')).status).toBe(200)
    expect((await request('tok-main-agent', 'POST', '/api/conversation-ledger', turn('alpha', 'by-admin'))).status).toBe(200)
    expect((await request('the-file-token', 'GET', '/api/conversation-ledger/beta/recent')).status).toBe(200)
  })

  it('no token at all is a 401', async () => {
    expect((await request(null, 'GET', '/api/conversation-ledger/alpha/recent')).status).toBe(401)
  })
})

describe('other own-agent endpoints', () => {
  it('agent state and task state: own yes, foreign 403', async () => {
    expect((await request('tok-alpha', 'PUT', '/api/agent-state/alpha/gate_run_state', { value: { a: 1 } })).status).toBe(200)
    expect((await request('tok-alpha', 'GET', '/api/agent-state/alpha/gate_run_state')).status).toBe(200)
    expect((await request('tok-alpha', 'GET', '/api/agent-state/beta/gate_run_state')).status).toBe(403)
    expect((await request('tok-alpha', 'PUT', '/api/agent-state/beta/gate_run_state', { value: 1 })).status).toBe(403)
    expect((await request('tok-alpha', 'POST', '/api/agent-taskstate/alpha', { summary: 's' })).status).toBe(200)
    expect((await request('tok-alpha', 'GET', '/api/agent-taskstate/beta/replay')).status).toBe(403)
    expect((await request('tok-alpha', 'POST', '/api/agent-taskstate/beta/consume')).status).toBe(403)
    expect((await request('tok-alpha', 'DELETE', '/api/agent-taskstate/beta')).status).toBe(403)
  })

  it('daily log: an omitted agent_id is the token agent, not the main agent; a foreign one is 403', async () => {
    expect((await request('tok-alpha', 'POST', '/api/daily-log', { content: 'from alpha' })).status).toBe(200)
    const date = new Date().toISOString().split('T')[0]!
    expect(getDailyLog('alpha', date).map(e => e.content)).toEqual(['from alpha'])
    expect(getDailyLog('main-agent', date)).toEqual([])
    expect((await request('tok-alpha', 'POST', '/api/daily-log', { agent_id: 'beta', content: 'forged' })).status).toBe(403)
    expect((await request('tok-alpha', 'GET', '/api/daily-log?agent=beta')).status).toBe(403)
    expect((await request('tok-alpha', 'GET', '/api/daily-log')).status).toBe(200)
  })

  it('spans: own agent only, and another agent span cannot be closed or overwritten', async () => {
    const open = (agent: string, span: string) => request('tok-beta', 'POST', '/api/spans', { trace_id: 't', span_id: span, agent_id: agent, operation: 'op', start_ms: 1 })
    expect((await open('beta', 's1')).status).toBe(200)
    expect((await open('alpha', 's2')).status).toBe(403)
    expect((await request('tok-alpha', 'POST', '/api/spans', { trace_id: 't', span_id: 's1', end_ms: 5 })).status).toBe(403)
    expect((await request('tok-alpha', 'POST', '/api/spans', { trace_id: 't', span_id: 's1', agent_id: 'alpha', operation: 'x', start_ms: 1 })).status).toBe(403)
    expect((await request('tok-beta', 'POST', '/api/spans', { trace_id: 't', span_id: 's1', end_ms: 5 })).status).toBe(200)
  })

  it('messages: the sender is the token agent; an omitted from is filled in, a forged one is 403', async () => {
    const ok = await request('tok-alpha', 'POST', '/api/messages', { to: 'beta', content: 'hello' })
    expect(ok.status).toBe(200)
    const row = getDb().prepare('SELECT from_agent FROM agent_messages ORDER BY id DESC LIMIT 1').get() as { from_agent: string }
    expect(row.from_agent).toBe('alpha')
    expect((await request('tok-alpha', 'POST', '/api/messages', { from: 'alpha', to: 'beta', content: 'hi' })).status).toBe(200)
    const forged = await request('tok-alpha', 'POST', '/api/messages', { from: 'beta', to: 'main-agent', content: 'forged' })
    expect(forged.status).toBe(403)
    expect((await request('the-file-token', 'POST', '/api/messages', { from: 'beta', to: 'alpha', content: 'admin may' })).status).toBe(200)
  })

  it('approvals: a fleet agent asks as itself and cannot resolve', async () => {
    const asked = await request('tok-alpha', 'POST', '/api/approvals', { agent_id: 'alpha', category: 'c', action_description: 'd' })
    expect(asked.status).toBe(201)
    expect((await request('tok-alpha', 'POST', '/api/approvals', { agent_id: 'beta', category: 'c', action_description: 'd' })).status).toBe(403)
    expect((await request('tok-alpha', 'GET', `/api/approvals/${asked.body['id']}`)).status).toBe(200)
    expect((await request('tok-alpha', 'PATCH', `/api/approvals/${asked.body['id']}`, { status: 'approved', resolved_by: 'alpha' })).status).toBe(403)
    expect((await request('tok-beta', 'PATCH', `/api/approvals/${asked.body['id']}`, { status: 'approved', resolved_by: 'beta' })).status).toBe(403)
    expect((await request('the-file-token', 'PATCH', `/api/approvals/${asked.body['id']}`, { status: 'approved', resolved_by: 'main-agent' })).status).toBe(200)
  })
})

describe('what a fleet_agent token cannot reach at all', () => {
  const denied: [string, string][] = [
    ['POST', '/api/agents/beta/stop'], ['POST', '/api/agents/beta/restart'], ['POST', '/api/agents'],
    ['GET', '/api/admin/tokens'], ['POST', '/api/admin/tokens'], ['GET', '/api/vault'],
    ['POST', '/api/schedules/x/activate'], ['GET', '/api/hook-audit'], ['GET', '/api/skills/sql/x/access'],
    ['PUT', '/api/skills/sql/x/access/t1'], ['GET', '/api/messages'], ['GET', '/api/agents/export-all'],
    ['GET', '/api/rbac/shadow-log'], ['POST', '/api/egress-allowlist'], ['GET', '/api/federation/manifest'],
  ]
  it.each(denied)('%s %s is a 403', async (method, path) => {
    expect((await request('tok-alpha', method, path, method === 'GET' ? undefined : {})).status).toBe(403)
  })

  it('and what the matrix grants it is reachable', () => {
    const auth = { kind: 'token' as const, role: 'fleet_agent' as const, tenantId: 'default', agentId: 'alpha' }
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
    const r = await admin({ name: 'fleet-agent:beta-2', role: 'fleet_agent', agent_id: 'beta', tenant_id: 'acme' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ role: 'fleet_agent', agent_id: 'beta', tenant_id: 'default' })
    const raw = r.body['token'] as string
    expect((await request(raw, 'GET', '/api/conversation-ledger/beta/recent')).status).toBe(200)
    expect((await request(raw, 'GET', '/api/conversation-ledger/alpha/recent')).status).toBe(403)
    const listed = await request('the-file-token', 'GET', '/api/admin/tokens')
    expect(JSON.stringify(listed.body)).not.toContain(raw)
  })

  it('refuses a fleet_agent token without an agent, with an unknown agent, or a bad agent id', async () => {
    expect((await admin({ name: 'n', role: 'fleet_agent' })).status).toBe(400)
    expect((await admin({ name: 'n', role: 'fleet_agent', agent_id: 'nobody' })).status).toBe(404)
    expect((await admin({ name: 'n', role: 'fleet_agent', agent_id: '../x' })).status).toBe(400)
  })

  it('an agent_id on a tenant-user role is refused; on admin it is a label', async () => {
    expect((await admin({ name: 'n', role: 'viewer', agent_id: 'beta' })).status).toBe(400)
    expect((await admin({ name: 'main', role: 'admin', agent_id: 'main-agent' })).status).toBe(201)
  })

  it('a fleet_agent token cannot mint tokens', async () => {
    expect((await request('tok-alpha', 'POST', '/api/admin/tokens', { name: 'x', role: 'admin' })).status).toBe(403)
  })

  it('rotation keeps the agent: the old token stops, the new one is the same agent', async () => {
    const id = (listApiTokenRows().find(r => r.agent_id === 'alpha'))!.id
    const rotated = await request('the-file-token', 'POST', `/api/admin/tokens/${id}/rotate`, {})
    expect(rotated.status).toBe(200)
    expect(rotated.body).toMatchObject({ agent_id: 'alpha', role: 'fleet_agent' })
    expect((await request('tok-alpha', 'GET', '/api/conversation-ledger/alpha/recent')).status).toBe(401)
    expect((await request(rotated.body['token'] as string, 'GET', '/api/conversation-ledger/alpha/recent')).status).toBe(200)
  })

  it('revoking stops a token at the next request', async () => {
    const id = (listApiTokenRows().find(r => r.agent_id === 'beta'))!.id
    expect((await request('tok-beta', 'GET', '/api/conversation-ledger/beta/recent')).status).toBe(200)
    expect((await request('the-file-token', 'DELETE', `/api/admin/tokens/${id}/revoke`)).status).toBe(200)
    expect((await request('tok-beta', 'GET', '/api/conversation-ledger/beta/recent')).status).toBe(401)
  })
})

describe('telemetry, artifacts and skills hold a fleet_agent to its own agent', () => {
  it('hook-audit, tool-log and skill-usage: own and omitted agent_id pass, a foreign one is a 403 and nothing is stored', async () => {
    const audit = (agent?: string) => request('tok-alpha', 'POST', '/api/hook-audit', { hook_type: 'PreToolUse', verdict: 'allow', ...(agent ? { agent_id: agent } : {}) })
    expect((await audit('alpha')).status).toBe(200)
    expect((await audit()).status).toBe(200)
    expect((await audit('beta')).status).toBe(403)
    const rows = getDb().prepare('SELECT agent_id FROM hook_audit_log').all() as { agent_id: string | null }[]
    expect(rows.map(r => r.agent_id)).toEqual(['alpha', 'alpha'])
    const tool = (agent: string) => request('tok-alpha', 'POST', '/api/tool-log', { session_id: 's', tool_name: 'Bash', agent_id: agent })
    expect((await tool('alpha')).status).toBe(200)
    expect((await tool('beta')).status).toBe(403)
    const usage = (agent: string) => request('tok-alpha', 'POST', '/api/skill-usage', { agent_id: agent, skill_name: 'x', trigger_type: 'tool_call' })
    expect((await usage('alpha')).status).toBe(200)
    expect((await usage('beta')).status).toBe(403)
  })

  it('artifacts: own agent only, and another agent cloud artifact cannot be taken over', async () => {
    const make = (token: string, agent: string, extra: object = {}) =>
      request(token, 'POST', '/api/artifacts', { agent_id: agent, title: 't', kind: 'markdown', content: 'c', ...extra })
    expect((await make('tok-alpha', 'alpha')).status).toBe(201)
    expect((await make('tok-alpha', 'beta')).status).toBe(403)
    expect((await make('tok-beta', 'beta', { cloud_url: 'https://claude.ai/artifact/x', source: 'cloud:artifact' })).status).toBe(201)
    expect((await make('tok-alpha', 'alpha', { cloud_url: 'https://claude.ai/artifact/x', source: 'cloud:artifact' })).status).toBe(403)
  })

  it('approvals: the list and a single read show only the own requests', async () => {
    const mine = await request('tok-alpha', 'POST', '/api/approvals', { agent_id: 'alpha', category: 'c', action_description: 'mine' })
    const theirs = await request('tok-beta', 'POST', '/api/approvals', { agent_id: 'beta', category: 'c', action_description: 'theirs' })
    const list = await request('tok-alpha', 'GET', '/api/approvals')
    expect((list.body['items'] as { id: string }[]).map(i => i.id)).toEqual([mine.body['id']])
    expect(list.body['oldest_pending']).toBeNull()
    expect((await request('tok-alpha', 'GET', '/api/approvals?agent=beta')).status).toBe(403)
    expect((await request('tok-alpha', 'GET', `/api/approvals/${theirs.body['id']}`)).status).toBe(404)
    expect((await request('the-file-token', 'GET', `/api/approvals/${theirs.body['id']}`)).status).toBe(200)
  })

  it('skills: only the own agent skills are writable; global, other agents and tenant skills are not', async () => {
    const put = (token: string, id: string) => request(token, 'PUT', `/api/skills/sql/${encodeURIComponent(id)}`, { content: '---\nname: s\ndescription: d\n---\nbody' })
    expect((await put('tok-alpha', 'agent/alpha/my-skill')).status).toBe(201)
    expect((await put('tok-alpha', 'agent/alpha/my-skill')).status).toBe(200)
    expect((await put('tok-alpha', 'agent/beta/their-skill')).status).toBe(403)
    expect((await put('tok-alpha', 'global/shared-skill')).status).toBe(403)
    expect((await request('tok-alpha', 'POST', '/api/skills/sql', { name: 'tenant skill', content: 'c' })).status).toBe(403)
    expect((await request('tok-alpha', 'DELETE', `/api/skills/sql/${encodeURIComponent('agent/beta/their-skill')}`)).status).toBe(403)
    expect((await request('tok-alpha', 'GET', `/api/skills/sql/${encodeURIComponent('agent/alpha/my-skill')}`)).status).toBe(200)
    expect((await request('tok-alpha', 'PUT', `/api/skills/sql/${encodeURIComponent('agent/alpha/my-skill')}/files/${encodeURIComponent('scripts/a.sh')}`, { content: 'echo' })).status).toBe(201)
    await put('the-file-token', 'agent/beta/their-skill')
    expect((await request('tok-alpha', 'PUT', `/api/skills/sql/${encodeURIComponent('agent/beta/their-skill')}/files/${encodeURIComponent('scripts/a.sh')}`, { content: 'echo' })).status).toBe(404)
    expect((await request('tok-alpha', 'DELETE', `/api/skills/sql/${encodeURIComponent('agent/alpha/my-skill')}`)).status).toBe(200)
  })
})
