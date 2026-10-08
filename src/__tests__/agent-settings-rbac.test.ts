// Proof tests for the context-guard/auto-restart tenant-scoped RBAC
// (agent_settings, migration 0058, #985 group 3/8 -- three required
// assertions, not just a row count):
//   (a) non-admin, own-tenant write  -> allowed
//   (b) non-admin, cross-tenant write -> 403
//   (c) admin, cross-tenant write     -> allowed
// Real in-memory DB (tenants/tenant_agent_availability/agent_settings), real
// route handler -- only filesystem-touching collaborators outside the RBAC
// path under test are mocked, mirroring agents-process-routes-extended.test.ts.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn().mockReturnValue({ ok: true }),
}))
vi.mock('../web/agent-process.js', () => ({
  startAgentProcess: vi.fn(),
  stopAgentProcess: vi.fn(),
  restartAgentProcess: vi.fn(),
  getAgentProcessInfo: vi.fn(),
}))
vi.mock('../web/agent-desired-state.js', () => ({
  addDesiredAgent: vi.fn(),
  removeDesiredAgent: vi.fn(),
  getDesiredAgents: vi.fn().mockReturnValue(new Set()),
}))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: vi.fn(),
  wrapAgentMessageForDelivery: vi.fn().mockReturnValue(''),
}))
vi.mock('../store-watcher.js', () => ({
  setStoreWriteActor: vi.fn(),
  clearStoreWriteActor: vi.fn(),
  startStoreWatcher: vi.fn(),
  stopStoreWatcher: vi.fn(),
}))
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    // Every test agent "exists" on disk -- the RBAC check under test runs
    // after this existence check, not instead of it.
    agentDir: vi.fn().mockReturnValue('/tmp'),
  }
})

import { initDatabase, getDb, createTenant, setTenantAgentAvailability } from '../db.js'
import { tryHandleAgentsProcess } from '../web/routes/agents-process.js'
import { setStoreWriteActor } from '../store-watcher.js'

beforeAll(() => {
  initDatabase(':memory:')
  createTenant('rbac-tenant-owner', 'Owner Tenant')
  createTenant('rbac-tenant-other', 'Other Tenant')
  setTenantAgentAvailability('rbac-tenant-owner', 'rbac-agent', true)
})

afterEach(() => {
  getDb().exec("DELETE FROM agent_settings WHERE agent_id = 'rbac-agent'")
})

function makeCtx(opts: {
  method: string
  path: string
  body?: string
  role?: RouteContext['role']
  tenantId?: RouteContext['tenantId']
}): { ctx: RouteContext; statusCode: () => number; responseBody: () => unknown } {
  const { method, path, body = '', role, tenantId } = opts
  const em = new EventEmitter()
  Object.assign(em, { headers: {}, method, url: path })
  setImmediate(() => {
    if (body) em.emit('data', Buffer.from(body))
    em.emit('end')
  })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const ctx: RouteContext = {
    req: em as unknown as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://localhost${path}`),
    auth: { kind: 'token' },
    role,
    tenantId,
  }
  return { ctx, statusCode: () => code, responseBody: () => { try { return JSON.parse(resBody) } catch { return resBody } } }
}

describe('PUT /api/agents/:name/auto-restart -- tenant RBAC', () => {
  it('(a) non-admin, own-tenant write is allowed', async () => {
    const { ctx, statusCode } = makeCtx({
      method: 'PUT',
      path: '/api/agents/rbac-agent/auto-restart',
      body: JSON.stringify({ enabled: true }),
      role: 'agent',
      tenantId: 'rbac-tenant-owner',
    })
    expect(await tryHandleAgentsProcess(ctx)).toBe(true)
    expect(statusCode()).toBe(200)
  })

  it('(b) non-admin, cross-tenant write is blocked with 403', async () => {
    const { ctx, statusCode, responseBody } = makeCtx({
      method: 'PUT',
      path: '/api/agents/rbac-agent/auto-restart',
      body: JSON.stringify({ enabled: true }),
      role: 'agent',
      tenantId: 'rbac-tenant-other',
    })
    expect(await tryHandleAgentsProcess(ctx)).toBe(true)
    expect(statusCode()).toBe(403)
    expect((responseBody() as any).error).toBe('forbidden')
  })

  it('(c) admin, cross-tenant write is allowed', async () => {
    const { ctx, statusCode } = makeCtx({
      method: 'PUT',
      path: '/api/agents/rbac-agent/auto-restart',
      body: JSON.stringify({ enabled: true }),
      role: 'admin',
      tenantId: 'rbac-tenant-other',
    })
    expect(await tryHandleAgentsProcess(ctx)).toBe(true)
    expect(statusCode()).toBe(200)
  })
})

describe('the store write the config PUT causes is filed under the owning tenant', () => {
  it.each(['auto-restart', 'context-guard'])('%s hands the agent\'s tenant to the store-watcher slot, not the caller\'s', async (route) => {
    vi.mocked(setStoreWriteActor).mockClear()
    const { ctx, statusCode } = makeCtx({
      method: 'PUT',
      path: `/api/agents/rbac-agent/${route}`,
      body: JSON.stringify({ enabled: true }),
      role: 'admin',
      tenantId: 'rbac-tenant-other',
    })
    expect(await tryHandleAgentsProcess(ctx)).toBe(true)
    expect(statusCode()).toBe(200)
    expect(setStoreWriteActor).toHaveBeenCalledWith('dashboard', 'rbac-tenant-owner')
  })
})

describe('GET/PUT /api/agents/:name/context-guard -- tenant RBAC', () => {
  it('(a) non-admin, own-tenant read and write are allowed', async () => {
    const put = makeCtx({
      method: 'PUT',
      path: '/api/agents/rbac-agent/context-guard',
      body: JSON.stringify({ enabled: true }),
      role: 'agent',
      tenantId: 'rbac-tenant-owner',
    })
    expect(await tryHandleAgentsProcess(put.ctx)).toBe(true)
    expect(put.statusCode()).toBe(200)

    const get = makeCtx({
      method: 'GET',
      path: '/api/agents/rbac-agent/context-guard',
      role: 'agent',
      tenantId: 'rbac-tenant-owner',
    })
    expect(await tryHandleAgentsProcess(get.ctx)).toBe(true)
    expect(get.statusCode()).toBe(200)
  })

  it('(b) non-admin, cross-tenant read is blocked with 403', async () => {
    const { ctx, statusCode } = makeCtx({
      method: 'GET',
      path: '/api/agents/rbac-agent/context-guard',
      role: 'agent',
      tenantId: 'rbac-tenant-other',
    })
    expect(await tryHandleAgentsProcess(ctx)).toBe(true)
    expect(statusCode()).toBe(403)
  })

  it('(b) non-admin, cross-tenant write is blocked with 403', async () => {
    const { ctx, statusCode } = makeCtx({
      method: 'PUT',
      path: '/api/agents/rbac-agent/context-guard',
      body: JSON.stringify({ enabled: true }),
      role: 'agent',
      tenantId: 'rbac-tenant-other',
    })
    expect(await tryHandleAgentsProcess(ctx)).toBe(true)
    expect(statusCode()).toBe(403)
  })

  it('(c) admin, cross-tenant read and write are allowed', async () => {
    const put = makeCtx({
      method: 'PUT',
      path: '/api/agents/rbac-agent/context-guard',
      body: JSON.stringify({ enabled: true }),
      role: 'admin',
      tenantId: 'rbac-tenant-other',
    })
    expect(await tryHandleAgentsProcess(put.ctx)).toBe(true)
    expect(put.statusCode()).toBe(200)

    const get = makeCtx({
      method: 'GET',
      path: '/api/agents/rbac-agent/context-guard',
      role: 'admin',
      tenantId: 'rbac-tenant-other',
    })
    expect(await tryHandleAgentsProcess(get.ctx)).toBe(true)
    expect(get.statusCode()).toBe(200)
  })
})

describe('write tenant stamping', () => {
  it('a write always stamps the agent\'s own resolved owning tenant, not the caller\'s', async () => {
    const { ctx } = makeCtx({
      method: 'PUT',
      path: '/api/agents/rbac-agent/auto-restart',
      body: JSON.stringify({ enabled: true }),
      role: 'admin',
      tenantId: 'rbac-tenant-other',
    })
    await tryHandleAgentsProcess(ctx)
    const row = getDb().prepare(
      `SELECT tenant_id FROM agent_settings WHERE agent_id = 'rbac-agent' AND setting_key = 'auto_restart'`,
    ).get() as { tenant_id: string }
    expect(row.tenant_id).toBe('rbac-tenant-owner')
  })
})
