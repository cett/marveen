// Phase T2 shadow counter through the real route handlers (the gate of web.ts in miniature, with the
// observer called where web.ts calls it) plus a source-level pin of the web.ts / skills.ts wiring.
// The evidence this file owns: the counter sees what the routes decide, and changes none of it.
//
// Privacy: neutral fixtures only (alpha / beta / shared / main-agent are test-local labels).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type http from 'node:http'
import { initDatabase, getDb, insertApiToken, createTenant, setTenantAgentAvailability } from '../db.js'
import { resolveAuth, resolveAgentIdHeader } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { tryHandleConversationLedger } from '../web/routes/conversation-ledger.js'
import { tryHandleDailyLog } from '../web/routes/daily-log.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import { tryHandleTokenShadow } from '../web/routes/token-shadow.js'
import { observeTokenUsage, recordTenantContextRefusal, resetTokenShadowForTests } from '../web/token-shadow.js'
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
const mint = (raw: string, agentId: string | null, role: 'fleet_agent' | 'admin' = 'fleet_agent') =>
  insertApiToken({ tokenHash: sha(raw), name: `${role}:${agentId ?? 'none'}`, role, tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId })

const HANDLERS: RouteHandler[] = [tryHandleConversationLedger, tryHandleDailyLog, tryHandleSkills, tryHandleTokenShadow]

async function request(rawToken: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.method = method
  req.headers = { ...(rawToken ? { authorization: `Bearer ${rawToken}` } : {}), ...headers }
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
  if (auth.kind === 'token' && auth.tenantContextMissing) {
    recordTenantContextRefusal(req, auth, method, url.pathname)
    out.status = 403; out.body = { error: 'forbidden', hint: 'no fresh tenant context' }; return out
  }
  const decision = checkPermission(auth, method, url.pathname)
  if (!decision.allowed) { out.status = decision.status; out.body = { error: 'denied', reason: decision.reason }; return out }
  const role = resolveRole(auth)
  const tokenAgentId = auth.kind === 'token' ? auth.agentId : undefined
  const ctx = {
    req, res, path: url.pathname, method, url, role, tenantId: resolveTenantId(auth), tokenAgentId,
    agentId: role === 'fleet_agent' && tokenAgentId ? tokenAgentId : resolveAgentIdHeader(req),
    auth: auth.kind === 'token' ? { kind: 'token', tokenName: auth.tokenName } : undefined,
  } as unknown as RouteContext
  observeTokenUsage(req, auth, method, url.pathname, url) // where web.ts calls it: after the gates, before dispatch
  for (const h of HANDLERS) if (await h(ctx)) return out
  out.status = 404
  return out
}

interface Row { category: string; method: string; route: string; caller: string; caller_source: string; target: string; count: number }
const rows = (category: string): Row[] =>
  (getDb().prepare('SELECT * FROM token_usage_shadow WHERE category = ? ORDER BY route, method, caller, target').all(category) as Row[])
const total = (category: string): number => rows(category).reduce((n, r) => n + r.count, 0)

const setContext = (agent: string, tenant: string, status: string) =>
  getDb().prepare('INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status, updated_at) VALUES (?, ?, ?, ?)').run(agent, tenant, status, NOW())

beforeEach(() => {
  initDatabase(':memory:')
  resetTokenShadowForTests()
  mint('tok-alpha', 'alpha')
  mint('tok-beta', 'beta')
  mint('tok-main-agent', 'main-agent', 'admin')
})

describe('the counter sees what the routes decide', () => {
  it('a fleet token on another agent\'s ledger: still a 403 (T1), and the attempt is counted', async () => {
    expect((await request('tok-alpha', 'GET', '/api/conversation-ledger/beta/recent')).status).toBe(403)
    expect((await request('tok-alpha', 'GET', '/api/conversation-ledger/alpha/recent')).status).toBe(200)
    expect(rows('agent_id_mismatch')).toEqual([expect.objectContaining({ route: '/api/conversation-ledger/:agent/recent', caller: 'alpha', caller_source: 'token', target: 'beta', count: 1 })])
  })

  it('the ledger batch with one foreign entry: refused as a whole, the foreign agent counted once', async () => {
    const turn = (agent: string, id: string) => ({ agent_id: agent, chat_id: '1', direction: 'in', message_id: id, text: 't', created_at: 1000 })
    const r = await request('tok-alpha', 'POST', '/api/conversation-ledger', { entries: [turn('alpha', 'm1'), turn('beta', 'm2')] })
    expect(r.status).toBe(403)
    expect(rows('agent_id_mismatch').map((x) => [x.target, x.count])).toEqual([['beta', 1]])
  })

  it('the shared file token with an X-Agent-Id: counted as shared use by a self-declared caller, and a foreign name on top', async () => {
    const r = await request('the-file-token', 'GET', '/api/daily-log?agent=beta', undefined, { 'x-agent-id': 'alpha' })
    expect(r.status).toBe(200) // the counter changes nothing: the shared token is still admin
    expect(rows('shared_token_use')).toEqual([expect.objectContaining({ route: '/api/daily-log', caller: 'alpha', caller_source: 'self_declared', count: 1 })])
    expect(rows('agent_id_mismatch')).toEqual([expect.objectContaining({ caller: 'alpha', caller_source: 'self_declared', target: 'beta' })])
  })

  describe('a shared agent (two tenants) with no fresh tenant context', () => {
    beforeEach(() => {
      createTenant('tenant-a', 'Tenant A')
      setTenantAgentAvailability('default', 'shared', true)
      setTenantAgentAvailability('tenant-a', 'shared', true)
      mint('tok-shared', 'shared')
    })

    it('its fleet token is refused 403 and the refusal is counted', async () => {
      expect((await request('tok-shared', 'GET', '/api/daily-log')).status).toBe(403)
      expect(rows('missing_tenant_context')).toEqual([expect.objectContaining({ route: '/api/daily-log', caller: 'shared', caller_source: 'token', count: 1 })])
    })

    it('the shared file token declaring it is counted as self-declared, and a fresh context or ?tenant= clears it', async () => {
      await request('the-file-token', 'GET', '/api/daily-log', undefined, { 'x-agent-id': 'shared' })
      await request('the-file-token', 'GET', '/api/daily-log?tenant=tenant-a', undefined, { 'x-agent-id': 'shared' })
      setContext('shared', 'tenant-a', 'bound')
      resetTokenShadowForTests() // the tenant-less answer is cached for 5 s; a counter may lag that long, a test must not
      await request('the-file-token', 'GET', '/api/daily-log', undefined, { 'x-agent-id': 'shared' })
      expect(rows('missing_tenant_context').map((r) => [r.caller, r.caller_source, r.count])).toEqual([['shared', 'self_declared', 1]])
    })
  })

  it('the admin read endpoint answers an admin token and is not counted', async () => {
    await request('the-file-token', 'GET', '/api/daily-log', undefined, { 'x-agent-id': 'alpha' })
    const r = await request('the-file-token', 'GET', '/api/token-shadow?days=1')
    expect(r.status).toBe(200)
    expect(r.body['totals']).toEqual([{ category: 'shared_token_use', count: 1 }])
    expect((await request('tok-alpha', 'GET', '/api/token-shadow')).status).toBe(403)
    expect(total('shared_token_use')).toBe(1)
  })
})

describe('fleet_skill_write_denied through the real skills route', () => {
  const sid = (id: string) => encodeURIComponent(id)
  const content = { content: '---\nname: s\ndescription: d\n---\nbody' }

  it('counts every refusal T1 makes, and nothing for a write it allows', async () => {
    expect((await request('tok-alpha', 'PUT', `/api/skills/sql/${sid('agent/beta/their-skill')}`, content)).status).toBe(403)
    expect((await request('tok-alpha', 'PUT', `/api/skills/sql/${sid('global/some-skill')}`, content)).status).toBe(403)
    expect((await request('tok-alpha', 'POST', '/api/skills/sql', { name: 'tenant skill', content: 'c' })).status).toBe(403)
    expect((await request('tok-alpha', 'DELETE', `/api/skills/sql/${sid('agent/beta/their-skill')}`)).status).toBe(403)
    expect((await request('tok-alpha', 'PUT', `/api/skills/sql/${sid('agent/alpha/my-skill')}`, content)).status).toBe(201)
    expect(rows('fleet_skill_write_denied').map((r) => [r.method, r.route, r.caller, r.target, r.count])).toEqual([
      ['POST', '/api/skills/sql', 'alpha', '', 1],
      ['DELETE', '/api/skills/sql/:id', 'alpha', 'beta', 1],
      ['PUT', '/api/skills/sql/:id', 'alpha', 'beta', 1],
      ['PUT', '/api/skills/sql/:id', 'alpha', 'global', 1],
    ])
  })

  it('the files route answers a readable but not writable (global) skill 404 and still counts the write attempt', async () => {
    await request('the-file-token', 'PUT', `/api/skills/sql/${sid('global/shared-skill')}`, content)
    const r = await request('tok-alpha', 'PUT', `/api/skills/sql/${sid('global/shared-skill')}/files/${sid('scripts/a.sh')}`, { content: 'echo' })
    expect(r.status).toBe(404)
    expect(rows('fleet_skill_write_denied').map((x) => [x.route, x.target])).toEqual([['/api/skills/sql/:id/files/:id', 'global']])
    // a read of the same file is not a write attempt
    await request('tok-alpha', 'GET', `/api/skills/sql/${sid('global/shared-skill')}/files`)
    expect(total('fleet_skill_write_denied')).toBe(1)
  })

  it('the admin token writing any skill is never counted', async () => {
    expect((await request('tok-main-agent', 'PUT', `/api/skills/sql/${sid('agent/beta/their-skill')}`, content)).status).toBe(201)
    expect(total('fleet_skill_write_denied')).toBe(0)
  })
})

describe('fail-safe through the real routes: a broken counter changes no answer', () => {
  it('with the counter table gone, the allowed and the refused requests answer exactly as before', async () => {
    const before = [
      await request('tok-alpha', 'GET', '/api/conversation-ledger/alpha/recent'),
      await request('tok-alpha', 'GET', '/api/conversation-ledger/beta/recent'),
      await request('the-file-token', 'GET', '/api/daily-log', undefined, { 'x-agent-id': 'alpha' }),
      await request('tok-alpha', 'PUT', `/api/skills/sql/${encodeURIComponent('agent/beta/x')}`, { content: 'c' }),
    ].map((r) => r.status)
    getDb().exec('DROP TABLE token_usage_shadow')
    resetTokenShadowForTests()
    const after = [
      await request('tok-alpha', 'GET', '/api/conversation-ledger/alpha/recent'),
      await request('tok-alpha', 'GET', '/api/conversation-ledger/beta/recent'),
      await request('the-file-token', 'GET', '/api/daily-log', undefined, { 'x-agent-id': 'alpha' }),
      await request('tok-alpha', 'PUT', `/api/skills/sql/${encodeURIComponent('agent/beta/x')}`, { content: 'c' }),
    ].map((r) => r.status)
    expect(before).toEqual([200, 403, 200, 403])
    expect(after).toEqual(before)
  })
})

describe('wiring in the production request pipeline (source level; booting the server writes dirs)', () => {
  const WEB = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
  const SKILLS = readFileSync(join(__dirname, '..', 'web', 'routes', 'skills.ts'), 'utf-8')
  const HELPERS = readFileSync(join(__dirname, '..', 'web', 'http-helpers.ts'), 'utf-8')

  it('web.ts observes once, after the RouteContext is built and before the dispatcher, for gated requests only', () => {
    expect(WEB.match(/\bobserveTokenUsage\(/g)?.length).toBe(1)
    const ctxAt = WEB.indexOf('const routeCtx: RouteContext')
    const observeAt = WEB.indexOf('observeTokenUsage(req, auth, method, path, url)')
    const dispatchAt = WEB.indexOf('dispatcher.dispatch(routeCtx)')
    expect(ctxAt).toBeGreaterThan(0)
    expect(observeAt).toBeGreaterThan(ctxAt)
    expect(dispatchAt).toBeGreaterThan(observeAt)
    expect(WEB).toMatch(/if \(requiresAuth\(path, method\)\) observeTokenUsage\(/)
  })

  it('web.ts counts the tenant-context refusal before it answers 403, and registers the admin route', () => {
    const refusalAt = WEB.indexOf('recordTenantContextRefusal(req, auth, method, path)')
    const forbiddenAt = WEB.indexOf("hint: 'No fresh tenant context for this shared agent'")
    expect(refusalAt).toBeGreaterThan(0)
    expect(refusalAt).toBeLessThan(forbiddenAt)
    expect(WEB).toMatch(/\.add\(tryHandleTokenShadow\)/)
  })

  it('skills.ts counts each of the four refusals', () => {
    expect(SKILLS.match(/countFleetSkillDenial\(/g)?.length).toBe(4)
  })

  it('readBody reports the finished body to the observer and survives a throwing one', () => {
    expect(HELPERS).toMatch(/requestBodyObserver\(req, body\)/)
    expect(HELPERS).toMatch(/try \{ requestBodyObserver\(req, body\) \} catch/)
  })
})
