// /api/admin/channel-bindings: which tenant an incoming source belongs to (GET list, PUT bind, DELETE unbind).
// Neutral fixtures only (agent-a, tenant-x).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../db.js', () => ({
  getDb: vi.fn().mockReturnValue({ prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) }) }),
  getTenant: vi.fn(),
  agentBelongsToTenant: vi.fn(),
  listChannelBindings: vi.fn(),
  setChannelBinding: vi.fn(),
  deleteChannelBinding: vi.fn(),
}))
vi.mock('../web/auth-device-keys.js', () => ({ listDeviceKeys: vi.fn().mockReturnValue([]), assignDeviceKeyTenant: vi.fn() }))
vi.mock('../web/password-hash.js', () => ({ hashPassword: vi.fn() }))
vi.mock('../prompt-safety.js', () => ({ sanitizeAgentIdent: vi.fn().mockImplementation((s: string) => s) }))
vi.mock('../web/agent-config.js', () => ({ isKnownAgent: vi.fn(), listAgentNames: vi.fn().mockReturnValue([]) }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

import * as db from '../db.js'
import { isKnownAgent } from '../web/agent-config.js'
import { tryHandleAdminB2b } from '../web/routes/admin-b2b.js'
import { normalizePath } from '../web/routes/versioning.js'

function makeCtx(method: string, rawPath: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: any) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${rawPath}`)
  const { path } = normalizePath(url.pathname)
  return { ctx: { req, res, path, method, url, role: 'admin', tenantId: null, auth: { kind: 'session', user: 'admin-user' } } as RouteContext, out }
}

const TENANT = { id: 'tenant-x', display_name: 'Tenant X', created_at: 1, disabled_at: null }
const REC = { agent_id: 'agent-a', channel: 'telegram', external_id: '111', tenant_id: 'tenant-x', created_by: 'admin-user', created_at: 1, updated_at: 1 }
const PUT = { agent_id: 'agent-a', channel: 'telegram', external_id: '111', tenant_id: 'tenant-x' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isKnownAgent).mockReturnValue(true)
  vi.mocked(db.getTenant).mockReturnValue(TENANT as any)
  vi.mocked(db.agentBelongsToTenant).mockReturnValue(true)
  vi.mocked(db.setChannelBinding).mockReturnValue(REC as any)
})

describe('PUT /api/admin/channel-bindings', () => {
  it('binds a source to a tenant', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/channel-bindings', { ...PUT, channel: 'Telegram' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(db.setChannelBinding).toHaveBeenCalledWith('agent-a', 'telegram', '111', 'tenant-x', 'admin-user')
    expect(out.body.tenant_id).toBe('tenant-x')
  })

  it('unknown agent -> 404, nothing written', async () => {
    vi.mocked(isKnownAgent).mockReturnValue(false)
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/channel-bindings', PUT)
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(404)
    expect(out.body.field).toBe('agent_id')
    expect(db.setChannelBinding).not.toHaveBeenCalled()
  })

  it('missing, disabled or unknown tenant -> 404', async () => {
    vi.mocked(db.getTenant).mockReturnValue(undefined)
    let r = makeCtx('PUT', '/api/v1/admin/channel-bindings', PUT)
    await tryHandleAdminB2b(r.ctx)
    expect(r.out.status).toBe(404)
    vi.mocked(db.getTenant).mockReturnValue({ ...TENANT, disabled_at: 5 } as any)
    r = makeCtx('PUT', '/api/v1/admin/channel-bindings', PUT)
    await tryHandleAdminB2b(r.ctx)
    expect(r.out.status).toBe(404)
    r = makeCtx('PUT', '/api/v1/admin/channel-bindings', { ...PUT, tenant_id: '' })
    await tryHandleAdminB2b(r.ctx)
    expect(r.out.status).toBe(404)
    expect(db.setChannelBinding).not.toHaveBeenCalled()
  })

  it('an agent that does not belong to the tenant cannot be bound to it (409)', async () => {
    vi.mocked(db.agentBelongsToTenant).mockReturnValue(false)
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/channel-bindings', PUT)
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(409)
    expect(db.setChannelBinding).not.toHaveBeenCalled()
  })

  it('the default tenant needs no availability row', async () => {
    vi.mocked(db.getTenant).mockReturnValue({ ...TENANT, id: 'default' } as any)
    vi.mocked(db.agentBelongsToTenant).mockReturnValue(false)
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/channel-bindings', { ...PUT, tenant_id: 'default' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(db.setChannelBinding).toHaveBeenCalled()
  })

  it.each([
    ['channel with a space', { channel: 'tele gram' }, 'channel'],
    ['channel starting with a digit', { channel: '1telegram' }, 'channel'],
    ['empty external_id', { external_id: '  ' }, 'external_id'],
    ['external_id with whitespace', { external_id: '11 1' }, 'external_id'],
    ['external_id with a control character', { external_id: 'a\u0007b' }, 'external_id'],
    ['external_id over 128 chars', { external_id: 'x'.repeat(129) }, 'external_id'],
  ])('rejects %s (400)', async (_name, patch, field) => {
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/channel-bindings', { ...PUT, ...patch })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe(field)
    expect(db.setChannelBinding).not.toHaveBeenCalled()
  })
})

describe('GET /api/admin/channel-bindings', () => {
  it('passes the tenant and agent filters through', async () => {
    vi.mocked(db.listChannelBindings).mockReturnValue([REC] as any)
    const { ctx, out } = makeCtx('GET', '/api/v1/admin/channel-bindings?tenant_id=tenant-x&agent_id=agent-a')
    await tryHandleAdminB2b(ctx)
    expect(db.listChannelBindings).toHaveBeenCalledWith({ tenantId: 'tenant-x', agentId: 'agent-a' })
    expect(out.body).toEqual({ items: [REC], total: 1 })
  })

  it('no filters -> everything', async () => {
    vi.mocked(db.listChannelBindings).mockReturnValue([])
    const { ctx } = makeCtx('GET', '/api/v1/admin/channel-bindings')
    await tryHandleAdminB2b(ctx)
    expect(db.listChannelBindings).toHaveBeenCalledWith({ tenantId: undefined, agentId: undefined })
  })
})

describe('DELETE /api/admin/channel-bindings', () => {
  it('removes a binding', async () => {
    vi.mocked(db.deleteChannelBinding).mockReturnValue(true)
    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/channel-bindings?agent_id=agent-a&channel=Telegram&external_id=111')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(db.deleteChannelBinding).toHaveBeenCalledWith('agent-a', 'telegram', '111')
  })

  it('404 when there is no such binding, 400 when a parameter is missing', async () => {
    vi.mocked(db.deleteChannelBinding).mockReturnValue(false)
    let r = makeCtx('DELETE', '/api/v1/admin/channel-bindings?agent_id=agent-a&channel=telegram&external_id=9')
    await tryHandleAdminB2b(r.ctx)
    expect(r.out.status).toBe(404)
    r = makeCtx('DELETE', '/api/v1/admin/channel-bindings?agent_id=agent-a&channel=telegram')
    await tryHandleAdminB2b(r.ctx)
    expect(r.out.status).toBe(400)
  })
})
