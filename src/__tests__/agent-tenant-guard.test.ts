// Front-door tenant guard for GET /api/agents/<name>[/...] (see
// routes/agent-tenant-guard.ts): every per-agent read answers 404 for an agent
// the caller's tenant has not been given, before any sub-resource handler runs.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/agent-config.js', () => ({
  isKnownAgent: vi.fn().mockImplementation((n: string) => ['member-a', 'hidden-agent', 'main-agent'].includes(n)),
}))
vi.mock('../db.js', () => ({
  getEnabledAgentsForTenant: vi.fn().mockReturnValue([]),
  isTenantAgentEnabled: vi.fn().mockImplementation((t: string, a: string) => t === 'acme' && a === 'member-a'),
}))

import { tryGuardAgentTenantReads } from '../web/routes/agent-tenant-guard.js'
import { isTenantAgentEnabled } from '../db.js'

function run(path: string, opts: { method?: string; role?: RouteContext['role']; tenantId?: RouteContext['tenantId'] }) {
  let code = 0
  let body = ''
  const res = { writeHead: (c: number) => { code = c }, end: (d?: string) => { body = d ?? '' } }
  const ctx = {
    req: {} as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path,
    method: opts.method ?? 'GET',
    url: new URL(`http://localhost${path}`),
    role: opts.role,
    tenantId: opts.tenantId,
  } as RouteContext
  return tryGuardAgentTenantReads(ctx).then(handled => ({ handled, code, body }))
}

const SUBS = ['', '/team', '/conversation', '/pane/stream', '/status', '/security', '/skills', '/channel-requests',
  '/channel/health', '/capabilities', '/voice-config', '/export', '/avatar']

describe('tryGuardAgentTenantReads', () => {
  beforeEach(() => { vi.mocked(isTenantAgentEnabled).mockClear() })

  for (const sub of SUBS) {
    it(`non-admin: GET /api/agents/hidden-agent${sub} is a 404 for a tenant that does not have it`, async () => {
      const r = await run(`/api/agents/hidden-agent${sub}`, { role: 'agent', tenantId: 'acme' })
      expect(r.handled).toBe(true)
      expect(r.code).toBe(404)
      expect(JSON.parse(r.body)).toEqual({ error: 'not_found', field: 'name' })
    })

    it(`non-admin: GET /api/agents/member-a${sub} passes through for their own tenant's agent`, async () => {
      const r = await run(`/api/agents/member-a${sub}`, { role: 'agent', tenantId: 'acme' })
      expect(r.handled).toBe(false)
      expect(r.code).toBe(0)
    })
  }

  it('the main agent is hidden from a tenant role too (it is in no tenant list)', async () => {
    for (const sub of ['/conversation', '/pane/stream', '/skills']) {
      const r = await run(`/api/agents/main-agent${sub}`, { role: 'agent', tenantId: 'acme' })
      expect(r.code).toBe(404)
    }
  })

  it('admin is never filtered', async () => {
    const r = await run('/api/agents/hidden-agent/conversation', { role: 'admin', tenantId: null })
    expect(r.handled).toBe(false)
    expect(isTenantAgentEnabled).not.toHaveBeenCalled()
  })

  it('a non-admin with tenantId null is checked against the default tenant, not waved through', async () => {
    const r = await run('/api/agents/member-a/team', { role: 'viewer', tenantId: null })
    expect(isTenantAgentEnabled).toHaveBeenCalledWith('default', 'member-a')
    expect(r.code).toBe(404)
  })

  it('/context-guard and /auto-restart keep their own (403) own-tenant check', async () => {
    for (const sub of ['/context-guard', '/auto-restart']) {
      const r = await run(`/api/agents/hidden-agent${sub}`, { role: 'agent', tenantId: 'acme' })
      expect(r.handled).toBe(false)
    }
  })

  it('names that are not agents (static routes) fall through', async () => {
    for (const p of ['/api/agents/activity', '/api/agents/export-all', '/api/agents/model-suggest', '/api/agents/ghost']) {
      const r = await run(p, { role: 'agent', tenantId: 'acme' })
      expect(r.handled).toBe(false)
    }
  })

  it('only reads are guarded here; writes are decided by the RBAC table', async () => {
    const r = await run('/api/agents/hidden-agent/restart', { method: 'POST', role: 'agent', tenantId: 'acme' })
    expect(r.handled).toBe(false)
  })

  it('a caller with no resolved role (ungated public path, e.g. avatars) is not this guard\'s concern', async () => {
    const r = await run('/api/agents/hidden-agent/avatar', { role: undefined })
    expect(r.handled).toBe(false)
  })

  it('a malformed percent-encoding does not throw', async () => {
    const r = await run('/api/agents/%E0%A4%A/team', { role: 'agent', tenantId: 'acme' })
    expect(r.handled).toBe(false)
  })

  it('/api/agents (the list) and non-agent paths are not touched', async () => {
    expect((await run('/api/agents', { role: 'agent', tenantId: 'acme' })).handled).toBe(false)
    expect((await run('/api/team/graph', { role: 'agent', tenantId: 'acme' })).handled).toBe(false)
  })

  it('is registered first in the dispatcher, ahead of every handler it protects', () => {
    const src = readFileSync(new URL('../web.ts', import.meta.url), 'utf8')
    const chain = src.slice(src.indexOf('new RouteDispatcher()'))
    const first = chain.match(/\.add\(([^)]*)\)/)
    expect(first?.[1]).toBe('tryGuardAgentTenantReads')
  })
})
