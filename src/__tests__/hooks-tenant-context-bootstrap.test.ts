// A shared agent with NO fresh tenant context may call exactly two hook routes (POST /api/hooks/tenant-facts, PUT
// /api/hooks/tenant-context): they are how the PostgreSQL-mode tenant hook RECORDS the context, and refusing them left the agent
// unable to ever record its first one (every prompt exit 2). Everything else stays refused (403).
//
// The chain is the pieces web.ts chains, REAL ones, in web.ts's order: normalizePath -> resolveAuth -> the missing-context refusal
// (its exact condition, with the shared predicate) -> checkPermission (enforce) -> the route. Real in-memory database, no mocks.
// Neutral fixtures only (agent-shared, agent-solo, tenant-x, tenant-y, tenant-z).
//
// What each group pins (the mutant a removed or widened guard would give is named; the QA gates run them):
//   - POSITIVE: no context -> facts 200, context PUT 200 (also on the /api/v1 alias, also from a stale context), and the recorded
//     context makes the very next call of the agent work
//   - NEGATIVE: every other route, and every other method / path shape of the two, is still 403.
//     Widening the predicate to a prefix, or to any method, turns these red
//   - the skill-gate route: 403 without a context (the correct fail-closed answer, the hook then denies the tenant-skill call)
//   - WHO: only the fleet_agent role gets in (RBAC rows), the shared file token names no agent (403), the caller is the token's agent
//   - SERVES: the PUT still refuses a tenant the agent does not serve (the server-side check is untouched)
//   - OWN ROWS: with no context the facts are still only the caller's own rows
//   - one predicate, used by web.ts and checkPermission, and the route never reads the request's (default) tenant
import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type http from 'node:http'
import { dbx, insertApiToken, createTenant, setTenantAgentAvailability } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'
import { requiresAuth, resolveAuth } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { normalizePath } from '../web/routes/versioning.js'
import { isTenantContextBootstrapRoute } from '../web/tenant-context-bootstrap.js'
import { tryHandleHooksTenant } from '../web/routes/hooks-tenant.js'
import type { RouteContext } from '../web/routes/types.js'

useTestDb()

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = () => Math.floor(Date.now() / 1000)
const FILE_TOKEN = 'the-file-token'

async function mint(raw: string, role: 'fleet_agent' | 'agent' | 'viewer' | 'admin', agentId: string | null): Promise<void> {
  await insertApiToken({ tokenHash: sha(raw), name: `${role}:${raw}`, role, tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId })
}

/** The chain of web.ts for one request. Returns the status and the decoded body. */
async function request(rawToken: string | null, method: string, rawPath: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.method = method
  req.headers = rawToken ? { authorization: `Bearer ${rawToken}` } : {}
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) { if (b) { const s = Buffer.isBuffer(b) ? b.toString('utf-8') : b; try { out.body = JSON.parse(s) } catch { out.body = s } } },
  } as unknown as http.ServerResponse
  const url = new URL(`http://localhost:3420${rawPath}`)
  const { path } = normalizePath(url.pathname)
  const auth = await resolveAuth(req, url, path, method, FILE_TOKEN, true)
  if (requiresAuth(path, method) && auth.kind === 'none') { out.status = 401; return out }
  // the refusal of web.ts, with the condition it has
  if (requiresAuth(path, method) && auth.kind === 'token' && auth.tenantContextMissing && !isTenantContextBootstrapRoute(method, path)) {
    out.status = 403; out.body = { error: 'forbidden', hint: 'No fresh tenant context for this shared agent' }; return out
  }
  const decision = checkPermission(auth, method, path)
  if (!decision.allowed) { out.status = decision.status; out.body = { error: 'denied', reason: decision.reason }; return out }
  const role = resolveRole(auth)
  const tokenAgentId = auth.kind === 'token' ? auth.agentId : undefined
  const ctx = { req, res, path, method, url, role, tenantId: resolveTenantId(auth), tokenAgentId } as unknown as RouteContext
  // The body is delivered only NOW, when the route is about to read it. Scheduled at the top (as the SQLite-only tests do) the
  // events are gone before the handler attaches its listeners as soon as an await before it takes a real round trip, which
  // it does on PostgreSQL (resolveAuth): the handler then waits for a body that never comes and the cell times out.
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  if (await tryHandleHooksTenant(ctx)) return out
  out.status = 404
  return out
}

const setContext = (agent: string, tenant: string, status: string, ageSeconds = 0) =>
  dbx.run('INSERT INTO agent_tenant_context (agent_id, tenant_id, status, source, session_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET tenant_id = excluded.tenant_id, status = excluded.status, updated_at = excluded.updated_at',
    agent, tenant, status, 'seed', '', NOW() - ageSeconds)

const contextRow = (agent: string) => dbx.get<{ status: string; tenant_id: string; session_id: string }>('SELECT status, tenant_id, session_id FROM agent_tenant_context WHERE agent_id = ?', agent)

const FACTS = '/api/hooks/tenant-facts'
const CONTEXT = '/api/hooks/tenant-context'
const GATE = '/api/hooks/skill-gate'
const channel = (id: string) => [{ kind: 'channel', channel: 'telegram', external_id: id }]

beforeEach(async () => {
  await createTenant('tenant-x', 'Tenant X')
  await createTenant('tenant-y', 'Tenant Y')
  await createTenant('tenant-z', 'Tenant Z')
  // agent-shared serves TWO tenants (a shared agent), agent-solo one, tenant-z is served by nobody
  await setTenantAgentAvailability('tenant-x', 'agent-shared', true)
  await setTenantAgentAvailability('tenant-y', 'agent-shared', true)
  await setTenantAgentAvailability('tenant-x', 'agent-solo', true)
  await mint('tok-shared', 'fleet_agent', 'agent-shared')
  await mint('tok-solo', 'fleet_agent', 'agent-solo')
  await mint('tok-role-agent', 'agent', null)
  await mint('tok-viewer', 'viewer', null)
  await mint('tok-admin-label', 'admin', 'agent-shared')
  const now = 1700000000
  await dbx.run('INSERT INTO tenant_channel_bindings (agent_id, channel, external_id, tenant_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'agent-shared', 'telegram', '111', 'tenant-x', 't', now, now)
  await dbx.run('INSERT INTO tenant_channel_bindings (agent_id, channel, external_id, tenant_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'agent-solo', 'telegram', '222', 'tenant-x', 't', now, now)
  await dbx.run("INSERT INTO agent_messages (id, from_agent, to_agent, content, status, created_at, tenant_id) VALUES (10, 'agent-b', 'agent-solo', 'x', 'done', ?, 'tenant-x')", now)
})

describe('the premise: without the exception a shared agent with no context is locked out', () => {
  it('has no context row and is refused on an ordinary route', async () => {
    expect(await contextRow('agent-shared')).toBeUndefined()
    expect((await request('tok-shared', 'GET', '/api/memories')).status).toBe(403)
  })
})

describe('POSITIVE: the two routes that record the context', () => {
  it('tenant-facts answers 200 without a context, on /api/ and on the /api/v1 alias', async () => {
    for (const p of [FACTS, '/api/v1/hooks/tenant-facts']) {
      const r = await request('tok-shared', 'POST', p, { sources: channel('111') })
      expect(r.status, p).toBe(200)
      expect(r.body).toMatchObject({ sources: [{ kind: 'channel', binding: 'tenant-x' }] })
    }
  })

  it('tenant-context PUT answers 200 without a context, on both spellings, and the row is the caller\'s own', async () => {
    for (const p of [CONTEXT, '/api/v1/hooks/tenant-context']) {
      const r = await request('tok-shared', 'PUT', p, { status: 'bound', tenant_id: 'tenant-x', source: 'test', session_id: 's1' })
      expect(r.status, p).toBe(200)
    }
    expect(await contextRow('agent-shared')).toMatchObject({ status: 'bound', tenant_id: 'tenant-x' })
  })

  it('records the default and the unknown context too (what the hook writes for a plain prompt and for a refusal)', async () => {
    expect((await request('tok-shared', 'PUT', CONTEXT, { status: 'default', tenant_id: 'default', source: 'plain' })).status).toBe(200)
    expect((await request('tok-shared', 'PUT', CONTEXT, { status: 'unknown', tenant_id: '', source: 'hook-error' })).status).toBe(200)
    expect(await contextRow('agent-shared')).toMatchObject({ status: 'unknown', tenant_id: '' })
  })

  it('a stale or an unknown context is recovered the same way', async () => {
    await setContext('agent-shared', 'tenant-x', 'bound', 13 * 3600)
    expect((await request('tok-shared', 'GET', '/api/memories')).status).toBe(403)
    expect((await request('tok-shared', 'POST', FACTS, { sources: [] })).status).toBe(200)
    expect((await request('tok-shared', 'PUT', CONTEXT, { status: 'bound', tenant_id: 'tenant-y', source: 'test' })).status).toBe(200)
    await setContext('agent-shared', '', 'unknown')
    expect((await request('tok-shared', 'PUT', CONTEXT, { status: 'bound', tenant_id: 'tenant-x', source: 'test' })).status).toBe(200)
  })

  it('the recorded context is what lifts the refusal for the next call, with the tenant of that context', async () => {
    expect((await request('tok-shared', 'GET', GATE.replace('skill-gate', 'tenant-context'))).status).toBe(403)
    await request('tok-shared', 'PUT', CONTEXT, { status: 'bound', tenant_id: 'tenant-y', source: 'test' })
    const req = { headers: { authorization: 'Bearer tok-shared' } } as unknown as http.IncomingMessage
    expect(await resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', FILE_TOKEN, true)).toMatchObject({ role: 'fleet_agent', agentId: 'agent-shared', tenantId: 'tenant-y' })
    expect((await request('tok-shared', 'POST', GATE, { targets: [] })).status).toBe(200)
  })

  it('an agent that serves one tenant never needed the exception and still works', async () => {
    expect((await request('tok-solo', 'POST', FACTS, { sources: channel('222') })).status).toBe(200)
    expect((await request('tok-solo', 'PUT', CONTEXT, { status: 'bound', tenant_id: 'tenant-x', source: 'test' })).status).toBe(200)
  })
})

describe('NEGATIVE: everything else stays refused for a shared agent with no context', () => {
  it('skill-gate is 403 (the hook then denies the tenant-skill call: the correct fail-closed answer)', async () => {
    for (const p of [GATE, '/api/v1/hooks/skill-gate']) {
      const r = await request('tok-shared', 'POST', p, { targets: [{ kind: 'skill', value: 'tenant-x-demo', folded: 'tenant-x-demo' }] })
      expect(r.status, p).toBe(403)
      expect(r.body).toMatchObject({ hint: expect.stringContaining('tenant context') })
    }
  })

  it('an unknown or stale context does not open skill-gate either', async () => {
    await setContext('agent-shared', '', 'unknown')
    expect((await request('tok-shared', 'POST', GATE, { targets: [] })).status).toBe(403)
    await setContext('agent-shared', 'tenant-x', 'bound', 13 * 3600)
    expect((await request('tok-shared', 'POST', GATE, { targets: [] })).status).toBe(403)
  })

  it('other routes, reads and writes, are 403', async () => {
    for (const [m, p] of [['GET', '/api/memories'], ['POST', '/api/memories'], ['GET', '/api/blackboard'], ['POST', '/api/messages'], ['GET', '/api/conversation-ledger/agent-shared/recent']] as const) {
      expect((await request('tok-shared', m, p, m === 'GET' ? undefined : {})).status, `${m} ${p}`).toBe(403)
    }
  })

  it('the other methods on the two paths are 403 (a GET of the context row, a POST of the context, a PUT of the facts)', async () => {
    for (const [m, p] of [['GET', CONTEXT], ['POST', CONTEXT], ['DELETE', CONTEXT], ['GET', FACTS], ['PUT', FACTS], ['DELETE', FACTS], ['PATCH', CONTEXT]] as const) {
      expect((await request('tok-shared', m, p, {})).status, `${m} ${p}`).toBe(403)
    }
  })

  it('a path that only STARTS like the route, or ends differently, is 403 (an exact match, never a prefix)', async () => {
    for (const [m, p] of [
      ['POST', `${FACTS}/`], ['PUT', `${CONTEXT}/`], ['POST', `${FACTS}/extra`], ['PUT', `${CONTEXT}/extra`],
      ['POST', `${FACTS}-x`], ['PUT', `${CONTEXT}x`], ['POST', '/api/hooks/'], ['POST', '/api/hooks'], ['PUT', '/api/hooks/tenant'],
      ['POST', '/api/v1/hooks/tenant-facts/'], ['PUT', '/api/v1/hooks/tenant-context/extra'],
    ] as const) {
      expect((await request('tok-shared', m, p, {})).status, `${m} ${p}`).toBe(403)
    }
  })

  it('a query string does not change the decision (it is not part of the path)', async () => {
    expect((await request('tok-shared', 'POST', `${FACTS}?agent_id=agent-solo`, { sources: [] })).status).toBe(200)
    expect((await request('tok-shared', 'GET', '/api/memories?path=/api/hooks/tenant-facts')).status).toBe(403)
  })
})

describe('WHO: only the fleet_agent role, and only for itself', () => {
  it('other token roles are refused on the exempt routes (the RBAC rows are admin and fleet_agent only)', async () => {
    for (const tok of ['tok-role-agent', 'tok-viewer']) {
      expect((await request(tok, 'POST', FACTS, { sources: [] })).status, tok).toBe(403)
      expect((await request(tok, 'PUT', CONTEXT, { status: 'unknown', tenant_id: '', source: 'x' })).status, tok).toBe(403)
    }
  })

  it('the shared file token names no agent: the route says 403 and nothing is written', async () => {
    expect((await request(FILE_TOKEN, 'POST', FACTS, { sources: [] })).status).toBe(403)
    expect((await request(FILE_TOKEN, 'PUT', CONTEXT, { status: 'unknown', tenant_id: '', source: 'x' })).status).toBe(403)
    expect(await contextRow('agent-shared')).toBeUndefined()
  })

  it('no credential is 401, a bad one is 401', async () => {
    expect((await request(null, 'PUT', CONTEXT, { status: 'unknown', tenant_id: '', source: 'x' })).status).toBe(401)
    expect((await request('not-a-token', 'POST', FACTS, { sources: [] })).status).toBe(401)
  })

  it('the agent is the token\'s: an agent_id in the body writes nothing for another agent', async () => {
    const r = await request('tok-shared', 'PUT', CONTEXT, { agent_id: 'agent-solo', status: 'bound', tenant_id: 'tenant-x', source: 'test' })
    expect(r.status).toBe(200)
    expect(await contextRow('agent-solo')).toBeUndefined()
    expect(await contextRow('agent-shared')).toMatchObject({ tenant_id: 'tenant-x' })
  })
})

describe('SERVES: the server still refuses a tenant the agent does not serve', () => {
  it('a bound context for a tenant nobody enabled is 403 and nothing is written', async () => {
    const r = await request('tok-shared', 'PUT', CONTEXT, { status: 'bound', tenant_id: 'tenant-z', source: 'test' })
    expect(r.status).toBe(403)
    expect(await contextRow('agent-shared')).toBeUndefined()
  })

  it('a default context that names another tenant, and a bound one that names default, are 403', async () => {
    expect((await request('tok-shared', 'PUT', CONTEXT, { status: 'default', tenant_id: 'tenant-x', source: 'test' })).status).toBe(403)
    expect((await request('tok-shared', 'PUT', CONTEXT, { status: 'bound', tenant_id: 'default', source: 'test' })).status).toBe(403)
    expect(await contextRow('agent-shared')).toBeUndefined()
  })

  it('an agent cannot be bound to a tenant ONLY another agent serves', async () => {
    await createTenant('tenant-w', 'Tenant W')
    await setTenantAgentAvailability('tenant-w', 'agent-solo', true)
    expect((await request('tok-shared', 'PUT', CONTEXT, { status: 'bound', tenant_id: 'tenant-w', source: 'test' })).status).toBe(403)
  })
})

describe('OWN ROWS: with no context the facts are still only the caller\'s own', () => {
  it('another agent\'s binding and message read as not there', async () => {
    const r = await request('tok-shared', 'POST', FACTS, { sources: [...channel('222'), { kind: 'message', msg_id: 10 }] })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ sources: [{ kind: 'channel', binding: null }, { kind: 'message', message: null }] })
    expect(JSON.stringify(r.body)).not.toContain('agent-solo')
  })

  it('a source the caller owns is answered, and a tenant it does not serve is marked not served', async () => {
    await dbx.run("INSERT INTO tenant_channel_bindings (agent_id, channel, external_id, tenant_id, created_by, created_at, updated_at) VALUES ('agent-shared', 'telegram', '333', 'tenant-z', 't', 1, 1)")
    const r = await request('tok-shared', 'POST', FACTS, { sources: channel('333') })
    expect(r.body).toMatchObject({ sources: [{ binding: 'tenant-z' }], serves: { 'tenant-z': false } })
  })

  it('the answer has no field beyond the ones it had (no new field for the exception)', async () => {
    const r = await request('tok-shared', 'POST', FACTS, { sources: channel('111') })
    expect(Object.keys(r.body as object).sort()).toEqual(['serves', 'sources'])
    expect(Object.keys((r.body as { sources: object[] }).sources[0]!).sort()).toEqual(['binding', 'kind'])
  })
})

describe('one predicate, exact method and path, on the path the gates see', () => {
  it('the truth table', () => {
    expect(isTenantContextBootstrapRoute('POST', '/api/hooks/tenant-facts')).toBe(true)
    expect(isTenantContextBootstrapRoute('PUT', '/api/hooks/tenant-context')).toBe(true)
    for (const [m, p] of [
      ['GET', '/api/hooks/tenant-facts'], ['PUT', '/api/hooks/tenant-facts'], ['POST', '/api/hooks/tenant-context'], ['GET', '/api/hooks/tenant-context'],
      ['POST', '/api/hooks/skill-gate'], ['PUT', '/api/hooks/skill-gate'], ['POST', '/api/hooks/tenant-facts/'], ['POST', '/api/hooks/tenant-facts/x'],
      ['POST', '/api/hooks/tenant-factsx'], ['POST', '/API/hooks/tenant-facts'], ['POST', '/api/v1/hooks/tenant-facts'], ['post', '/api/hooks/tenant-facts'],
      ['POST', ''], ['PUT', '/api/hooks/tenant-context?x=1'],
    ] as const) {
      expect(isTenantContextBootstrapRoute(m, p), `${m} ${p}`).toBe(false)
    }
  })

  it('fed with the normalised path of web.ts, the /api/v1 alias is the same route', () => {
    const norm = (raw: string) => normalizePath(new URL(`http://x${raw}`).pathname).path
    expect(isTenantContextBootstrapRoute('POST', norm('/api/v1/hooks/tenant-facts'))).toBe(true)
    expect(isTenantContextBootstrapRoute('PUT', norm('/api/v1/hooks/tenant-context?a=b'))).toBe(true)
    expect(isTenantContextBootstrapRoute('POST', norm('/api/v1/hooks/tenant-facts/'))).toBe(false)
    expect(isTenantContextBootstrapRoute('POST', norm('/api/v1/hooks/skill-gate'))).toBe(false)
  })

  it('checkPermission lets only the two through for a missing-context fleet token (and still asks the RBAC table)', () => {
    const shared = { kind: 'token', role: 'fleet_agent', agentId: 'agent-shared', tenantContextMissing: true } as const
    expect(checkPermission(shared, 'POST', '/api/hooks/tenant-facts')).toMatchObject({ allowed: true })
    expect(checkPermission(shared, 'PUT', '/api/hooks/tenant-context')).toMatchObject({ allowed: true })
    for (const [m, p] of [['POST', '/api/hooks/skill-gate'], ['GET', '/api/hooks/tenant-context'], ['GET', '/api/memories'], ['POST', '/api/hooks/tenant-facts/']] as const) {
      expect(checkPermission(shared, m, p), `${m} ${p}`).toMatchObject({ allowed: false, status: 403 })
    }
    // the exception skips ONLY the missing-context refusal: a role the table does not give hook-gate is still denied
    expect(checkPermission({ ...shared, role: 'viewer' }, 'POST', '/api/hooks/tenant-facts')).toMatchObject({ allowed: false })
  })

  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf-8')

  it('web.ts and authz.ts both refuse a missing context through the SAME predicate, before the RBAC gate', () => {
    const web = read('web.ts')
    expect(web).toMatch(/auth\.tenantContextMissing && !isTenantContextBootstrapRoute\(method, path\)/)
    expect(web.indexOf('isTenantContextBootstrapRoute(method, path)')).toBeLessThan(web.indexOf('runRbacGate(auth'))
    expect(read('web', 'authz.ts')).toMatch(/auth\.tenantContextMissing && !isTenantContextBootstrapRoute\(method, path\)/)
    // the exception does not write the refusal counter: the refusal block of web.ts is the only caller
    expect(web.match(/recordTenantContextRefusal\(/g)).toHaveLength(1)
  })

  it('the hook routes never read the request\'s tenant: an exempt call runs with the default one', () => {
    expect(read('web', 'routes', 'hooks-tenant.ts')).not.toMatch(/ctx\.tenantId|tenantId\s*[,}]\s*=\s*ctx|\{[^}]*\btenantId\b[^}]*\}\s*=\s*ctx/)
  })
})
