import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../web/password-hash.js', () => ({
  hashPassword: vi.fn().mockResolvedValue('$hash$'),
}))

vi.mock('../web/vault.js', () => ({ secretsExistForTenant: vi.fn().mockReturnValue(false) }))
vi.mock('../db.js', () => ({
  getDashboardUser: vi.fn().mockResolvedValue(undefined),
  writeAdminAuditLog: vi.fn(),
  createTenant: vi.fn(),
  getTenant: vi.fn(),
  listTenants: vi.fn(),
  updateTenant: vi.fn(),
  provisionDashboardUser: vi.fn(),
  getDashboardUserById: vi.fn(),
  listDashboardUsersFiltered: vi.fn(),
  adminPatchDashboardUser: vi.fn(),
  deleteDashboardUserKeepingLastAdmin: vi.fn(),
  countActiveAdmins: vi.fn(),
  listPartnerSenders: vi.fn(),
  createPartnerSender: vi.fn(),
  disablePartnerSender: vi.fn(),
  listTenantAgentAvailability: vi.fn().mockResolvedValue([]),
  setTenantAgentAvailability: vi.fn(),
}))

vi.mock('../web/auth-device-keys.js', () => ({
  listDeviceKeys: vi.fn().mockResolvedValue([]),
  assignDeviceKeyTenant: vi.fn().mockResolvedValue(true),
}))

vi.mock('../prompt-safety.js', () => ({
  sanitizeAgentIdent: vi.fn().mockImplementation((s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '')),
}))

vi.mock('../web/agent-config.js', () => ({
  isKnownAgent: vi.fn().mockReturnValue(false),
  listAgentNames: vi.fn().mockReturnValue([]),
}))

vi.mock('../web/mcp-risk-policy.js', () => ({
  getHighRiskMcpServersForAgent: vi.fn().mockReturnValue([]),
}))

vi.mock('../web/skill-regen.js', () => ({
  regenTenantSkillFilesForAgentChange: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

import * as db from '../db.js'
import { secretsExistForTenant } from '../web/vault.js'
import * as agentConfig from '../web/agent-config.js'
import * as deviceKeys from '../web/auth-device-keys.js'
import * as mcpRiskPolicy from '../web/mcp-risk-policy.js'
import * as skillRegen from '../web/skill-regen.js'
import { tryHandleAdminB2b } from '../web/routes/admin-b2b.js'
import { normalizePath } from '../web/routes/versioning.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Mirrors the web.ts dispatch flow: normalizePath strips /v1 before ctx.path
// is set, so the handler always sees /api/admin/... not /api/v1/admin/...
// Using normalizePath here ensures the test exercises the same path the
// production dispatcher presents to the handler.
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
  return {
    ctx: { req, res, path, method, url, role: 'admin', auth: { kind: 'session', user: 'admin-user' } } as RouteContext,
    out,
  }
}

const SAMPLE_TENANT: db.Tenant = { id: 'acme-corp', display_name: 'Acme Corp', created_at: 1787000000, disabled_at: null, main_agent_id: null }
const SAMPLE_USER = { id: 5, username: 'acme-viewer', role: 'agent', tenant_id: 'acme-corp', email: null, display_name: null, created_at: 1787000000, updated_at: 1787000000, password_hash: '$hash$', disabled: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.getDashboardUser).mockResolvedValue(undefined)
})

// ── Tenants ───────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/tenants', () => {
  it('creates a tenant and returns 201', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(undefined)
    vi.mocked(db.createTenant).mockResolvedValue(SAMPLE_TENANT)
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/tenants', { id: 'acme-corp', display_name: 'Acme Corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(201)
    expect(out.body.id).toBe('acme-corp')
    expect(vi.mocked(db.createTenant)).toHaveBeenCalledWith('acme-corp', 'Acme Corp')
  })

  it('returns 409 when the vault still holds secrets of a deleted tenant with that id, and creates nothing', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(undefined)
    vi.mocked(secretsExistForTenant).mockReturnValueOnce(true)
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/tenants', { id: 'acme-corp', display_name: 'Acme Corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
    expect(vi.mocked(db.createTenant)).not.toHaveBeenCalled()
  })

  it('returns 400 for invalid tenant id (uppercase)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/tenants', { id: 'Acme-Corp', display_name: 'x' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('id')
  })

  it('returns 400 for reserved tenant id', async () => {
    for (const reserved of ['default', 'admin', 'system', 'root']) {
      const { ctx, out } = makeCtx('POST', '/api/v1/admin/tenants', { id: reserved, display_name: 'x' })
      await tryHandleAdminB2b(ctx)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('invalid_value')
      expect(out.body.field).toBe('id')
    }
  })

  it('returns 400 for missing display_name', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/tenants', { id: 'acme-corp', display_name: '' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('display_name')
  })

  it('returns 409 when tenant id already exists', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/tenants', { id: 'acme-corp', display_name: 'Acme Corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
  })
})

describe('GET /api/v1/admin/tenants', () => {
  it('returns tenant list', async () => {
    vi.mocked(db.listTenants).mockResolvedValue([SAMPLE_TENANT])
    const { ctx, out } = makeCtx('GET', '/api/v1/admin/tenants')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(out.body.items).toHaveLength(1)
    expect(out.body.total).toBe(1)
    expect(vi.mocked(db.listTenants)).toHaveBeenCalledWith(false)
  })

  it('passes include_disabled=true to listTenants', async () => {
    vi.mocked(db.listTenants).mockResolvedValue([])
    const { ctx, out } = makeCtx('GET', '/api/v1/admin/tenants?include_disabled=true')
    await tryHandleAdminB2b(ctx)
    expect(vi.mocked(db.listTenants)).toHaveBeenCalledWith(true)
    expect(out.status).toBe(200)
  })
})

describe('PATCH /api/v1/admin/tenants/:id', () => {
  it('updates display_name', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    vi.mocked(db.updateTenant).mockResolvedValue({ ...SAMPLE_TENANT, display_name: 'Acme Corporation' })
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/tenants/acme-corp', { display_name: 'Acme Corporation' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(out.body.display_name).toBe('Acme Corporation')
  })

  it('returns 404 for unknown tenant', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(undefined)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/tenants/ghost', { display_name: 'x' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
    expect(out.body.field).toBe('id')
  })

  it('returns 403 when disabling default tenant', async () => {
    vi.mocked(db.getTenant).mockResolvedValue({ id: 'default', display_name: 'Fleet', created_at: 0, disabled_at: null, main_agent_id: null })
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/tenants/default', { disabled: true })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
  })

  it('returns 400 for empty body', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/tenants/acme-corp', {})
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
  })
})

// ── Users ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/users', () => {
  it('creates a scoped user and returns 201 without password', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    vi.mocked(db.provisionDashboardUser).mockResolvedValue(SAMPLE_USER as any)
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/users', {
      username: 'acme-viewer', password: 'supersecret123', role: 'agent', tenant_id: 'acme-corp',
    })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(201)
    expect(out.body.username).toBe('acme-viewer')
    expect(out.body.password_hash).toBeUndefined()
    expect(out.body.disabled).toBe(false)
  })

  it('creates a global admin user (tenant_id=null)', async () => {
    vi.mocked(db.provisionDashboardUser).mockResolvedValue({ ...SAMPLE_USER, role: 'admin', tenant_id: null } as any)
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/users', {
      username: 'new-admin', password: 'supersecret123', role: 'admin', tenant_id: null,
    })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(201)
    expect(out.body.role).toBe('admin')
    expect(out.body.tenant_id).toBeNull()
  })

  it('returns 400 for username too short', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/users', { username: 'ab', password: 'supersecret123', role: 'agent', tenant_id: 'acme-corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('username')
  })

  it('returns 400 for password too short', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/users', { username: 'acme-viewer', password: 'short', role: 'agent', tenant_id: 'acme-corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('password')
  })

  it('returns 400 for invalid role', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/users', { username: 'acme-viewer', password: 'supersecret123', role: 'superuser', tenant_id: 'acme-corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('role')
  })

  it('returns 403 forbidden when tenant_id omitted for non-admin', async () => {
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/users', { username: 'acme-viewer', password: 'supersecret123', role: 'agent' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
    expect(out.body.field).toBe('tenant_id')
  })

  it('returns 403 forbidden when admin role + tenant_id provided', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/users', { username: 'new-admin', password: 'supersecret123', role: 'admin', tenant_id: 'acme-corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
    expect(out.body.field).toBe('tenant_id')
  })

  it('returns 404 not_found for disabled tenant', async () => {
    vi.mocked(db.getTenant).mockResolvedValue({ ...SAMPLE_TENANT, disabled_at: 1787000001 })
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/users', { username: 'acme-viewer', password: 'supersecret123', role: 'agent', tenant_id: 'acme-corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
    expect(out.body.field).toBe('tenant_id')
  })

  it('returns 409 for duplicate username', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    vi.mocked(db.getDashboardUser).mockResolvedValue(SAMPLE_USER as any)
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/users', { username: 'acme-viewer', password: 'supersecret123', role: 'agent', tenant_id: 'acme-corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
    expect(out.body.field).toBe('username')
  })
})

describe('GET /api/v1/admin/users', () => {
  it('returns user list', async () => {
    vi.mocked(db.listDashboardUsersFiltered).mockResolvedValue([SAMPLE_USER as any])
    const { ctx, out } = makeCtx('GET', '/api/v1/admin/users')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(out.body.items).toHaveLength(1)
    expect(out.body.total).toBe(1)
    expect(out.body.items[0].password_hash).toBeUndefined()
    expect(vi.mocked(db.listDashboardUsersFiltered)).toHaveBeenCalledWith({ tenantId: undefined, includeDisabled: false })
  })

  it('filters by tenant_id', async () => {
    vi.mocked(db.listDashboardUsersFiltered).mockResolvedValue([])
    const { ctx, out } = makeCtx('GET', '/api/v1/admin/users?tenant_id=acme-corp')
    await tryHandleAdminB2b(ctx)
    expect(vi.mocked(db.listDashboardUsersFiltered)).toHaveBeenCalledWith({ tenantId: 'acme-corp', includeDisabled: false })
    expect(out.status).toBe(200)
  })
})

describe('PATCH /api/v1/admin/users/:id', () => {
  it('updates role and returns 200 (final state validation: admin + null)', async () => {
    const existingAdmin = { ...SAMPLE_USER, role: 'admin', tenant_id: null, username: 'some-admin' }
    vi.mocked(db.getDashboardUserById).mockResolvedValue(existingAdmin as any)
    vi.mocked(db.adminPatchDashboardUser).mockResolvedValue({ status: 'updated', user: { ...existingAdmin, role: 'admin' } } as any)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/users/5', { role: 'admin' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(vi.mocked(db.adminPatchDashboardUser)).toHaveBeenCalled()
  })

  it('returns 403 and the same hint when the update itself refuses to demote the last active admin (compare-and-set)', async () => {
    const lastAdmin = { ...SAMPLE_USER, username: 'someone-else', role: 'admin', tenant_id: null }
    vi.mocked(db.getDashboardUserById).mockResolvedValue(lastAdmin as any)
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    vi.mocked(db.adminPatchDashboardUser).mockResolvedValue({ status: 'last_admin' })
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/users/5', { role: 'viewer', tenant_id: 'acme-corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ error: 'forbidden', hint: 'Cannot remove the last administrator' })
    expect(vi.mocked(db.writeAdminAuditLog)).not.toHaveBeenCalled()
  })

  it('returns 404 when the user is gone by the time of the update', async () => {
    vi.mocked(db.getDashboardUserById).mockResolvedValue({ ...SAMPLE_USER } as any)
    vi.mocked(db.adminPatchDashboardUser).mockResolvedValue({ status: 'not_found' })
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/users/5', { email: 'new@acme.com' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('returns 403 forbidden when PATCH submits tenant_id for existing admin (final state)', async () => {
    const existingAdmin = { ...SAMPLE_USER, role: 'admin', tenant_id: null }
    vi.mocked(db.getDashboardUserById).mockResolvedValue(existingAdmin as any)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/users/5', { tenant_id: 'acme-corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
    expect(out.body.field).toBe('tenant_id')
  })

  it('returns 403 forbidden when admin disables their own account', async () => {
    const selfUser = { ...SAMPLE_USER, username: 'admin-user', role: 'admin', tenant_id: null }
    vi.mocked(db.getDashboardUserById).mockResolvedValue(selfUser as any)
    vi.mocked(db.countActiveAdmins).mockResolvedValue(2)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/users/5', { disabled: true })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
  })

  it('returns 403 forbidden when disabling the last active admin', async () => {
    const lastAdmin = { ...SAMPLE_USER, username: 'other-admin', role: 'admin', tenant_id: null }
    vi.mocked(db.getDashboardUserById).mockResolvedValue(lastAdmin as any)
    vi.mocked(db.countActiveAdmins).mockResolvedValue(1)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/users/5', { disabled: true })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
  })

  it('returns 404 for unknown user', async () => {
    vi.mocked(db.getDashboardUserById).mockResolvedValue(undefined)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/users/999', { role: 'viewer' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
    expect(out.body.field).toBe('userId')
  })

  it('returns 400 required for empty body', async () => {
    vi.mocked(db.getDashboardUserById).mockResolvedValue(SAMPLE_USER as any)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/users/5', {})
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
  })

  it('returns false for unmatched route', async () => {
    const { ctx } = makeCtx('GET', '/api/v1/other')
    expect(await tryHandleAdminB2b(ctx)).toBe(false)
  })
})

describe('POST /api/v1/admin/users -- profile fields', () => {
  it('creates a user with email and display_name and returns both in response', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    vi.mocked(db.provisionDashboardUser).mockResolvedValue({ ...SAMPLE_USER, email: 'viewer@acme.com', display_name: 'Acme Viewer' } as any)
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/users', {
      username: 'acme-viewer', password: 'password123456', role: 'agent', tenant_id: 'acme-corp',
      email: 'viewer@acme.com', display_name: 'Acme Viewer',
    })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(201)
    expect(out.body.email).toBe('viewer@acme.com')
    expect(out.body.display_name).toBe('Acme Viewer')
    expect(out.body).not.toHaveProperty('password_hash')
  })

  it('returns 400 for email without @', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    const { ctx, out } = makeCtx('POST', '/api/v1/admin/users', {
      username: 'acme-viewer', password: 'password123456', role: 'agent', tenant_id: 'acme-corp',
      email: 'notanemail',
    })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('email')
  })
})

describe('PATCH /api/v1/admin/users/:id -- profile fields', () => {
  it('updates email and returns it in response', async () => {
    vi.mocked(db.getDashboardUserById).mockResolvedValue({ ...SAMPLE_USER } as any)
    vi.mocked(db.adminPatchDashboardUser).mockResolvedValue({ status: 'updated', user: { ...SAMPLE_USER, email: 'new@acme.com' } } as any)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/users/5', { email: 'new@acme.com' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(out.body.email).toBe('new@acme.com')
  })

  it('returns 400 for PATCH with email without @', async () => {
    vi.mocked(db.getDashboardUserById).mockResolvedValue({ ...SAMPLE_USER } as any)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/users/5', { email: 'notvalid' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('email')
  })
})

// ── DELETE /api/v1/admin/users/:id ───────────────────────────────────────────

describe('DELETE /api/v1/admin/users/:id', () => {
  it('hard-deletes user and returns 200', async () => {
    vi.mocked(db.getDashboardUserById).mockResolvedValue(SAMPLE_USER as any)
    vi.mocked(db.deleteDashboardUserKeepingLastAdmin).mockResolvedValue('deleted')
    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/users/5')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(vi.mocked(db.deleteDashboardUserKeepingLastAdmin)).toHaveBeenCalledWith(SAMPLE_USER.username)
  })

  it('returns 404 for unknown user', async () => {
    vi.mocked(db.getDashboardUserById).mockResolvedValue(undefined)
    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/users/999')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('returns 403 when deleting own account', async () => {
    const self = { ...SAMPLE_USER, username: 'admin-user' }
    vi.mocked(db.getDashboardUserById).mockResolvedValue(self as any)
    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/users/5')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
  })

  it('returns 403 when the delete itself refuses the last admin (the count moved after the pre-check)', async () => {
    vi.mocked(db.getDashboardUserById).mockResolvedValue({ ...SAMPLE_USER, role: 'admin', tenant_id: null } as any)
    vi.mocked(db.countActiveAdmins).mockResolvedValue(2)
    vi.mocked(db.deleteDashboardUserKeepingLastAdmin).mockResolvedValue('last_admin')
    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/users/5')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
  })

  it('returns 404 when the user vanished between the lookup and the delete', async () => {
    vi.mocked(db.getDashboardUserById).mockResolvedValue(SAMPLE_USER as any)
    vi.mocked(db.deleteDashboardUserKeepingLastAdmin).mockResolvedValue('not_found')
    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/users/5')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(404)
  })

  it('returns 403 when deleting the last admin', async () => {
    const lastAdmin = { ...SAMPLE_USER, username: 'other-admin', role: 'admin', tenant_id: null }
    vi.mocked(db.getDashboardUserById).mockResolvedValue(lastAdmin as any)
    vi.mocked(db.countActiveAdmins).mockResolvedValue(1)
    const { ctx, out } = makeCtx('DELETE', '/api/v1/admin/users/5')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
  })
})

// ── Agent availability ────────────────────────────────────────────────────────

describe('GET /api/v1/admin/agent-availability', () => {
  it('returns matrix with all known agents, deny-by-default', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    vi.mocked(agentConfig.listAgentNames).mockReturnValue(['jarvis', 'zack'])
    vi.mocked(db.listTenantAgentAvailability).mockResolvedValue([
      { tenant_id: 'acme-corp', agent_id: 'jarvis', enabled: 1, updated_at: 1787000000 },
    ])
    const { ctx, out } = makeCtx('GET', '/api/v1/admin/agent-availability?tenant_id=acme-corp')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(out.body.tenant_id).toBe('acme-corp')
    expect(out.body.items).toHaveLength(2)
    const jarvis = out.body.items.find((i: any) => i.agent_id === 'jarvis')
    const zack = out.body.items.find((i: any) => i.agent_id === 'zack')
    expect(jarvis.enabled).toBe(true)
    expect(zack.enabled).toBe(false)
  })

  it('returns 400 when tenant_id missing', async () => {
    const { ctx, out } = makeCtx('GET', '/api/v1/admin/agent-availability')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('tenant_id')
  })

  it('returns 404 for unknown tenant', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(undefined)
    const { ctx, out } = makeCtx('GET', '/api/v1/admin/agent-availability?tenant_id=ghost')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })
})

describe('PUT /api/v1/admin/agent-availability', () => {
  it('enables a known agent for a tenant', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    vi.mocked(agentConfig.isKnownAgent).mockReturnValue(true)
    const updatedRow = { tenant_id: 'acme-corp', agent_id: 'jarvis', enabled: 1 as const, updated_at: 1787000001 }
    vi.mocked(db.setTenantAgentAvailability).mockResolvedValue(updatedRow)
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/agent-availability', { tenant_id: 'acme-corp', agent_id: 'jarvis', enabled: true })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(out.body.enabled).toBe(true)
    expect(out.body.agent_id).toBe('jarvis')
    expect(vi.mocked(db.setTenantAgentAvailability)).toHaveBeenCalledWith('acme-corp', 'jarvis', true)
  })

  it('re-reconciles the tenant skill files of the tenants the agent serves after an availability change, and survives a failing regen', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    vi.mocked(agentConfig.isKnownAgent).mockReturnValue(true)
    vi.mocked(db.setTenantAgentAvailability).mockResolvedValue({ tenant_id: 'acme-corp', agent_id: 'demo-agent', enabled: 0 as const, updated_at: 1787000002 })
    vi.mocked(skillRegen.regenTenantSkillFilesForAgentChange).mockClear()
    const a = makeCtx('PUT', '/api/v1/admin/agent-availability', { tenant_id: 'acme-corp', agent_id: 'demo-agent', enabled: false })
    await tryHandleAdminB2b(a.ctx)
    expect(a.out.status).toBe(200)
    expect(skillRegen.regenTenantSkillFilesForAgentChange).toHaveBeenCalledWith('demo-agent', 'acme-corp')

    vi.mocked(skillRegen.regenTenantSkillFilesForAgentChange).mockRejectedValueOnce(new Error('disk full'))
    const b = makeCtx('PUT', '/api/v1/admin/agent-availability', { tenant_id: 'acme-corp', agent_id: 'demo-agent', enabled: false })
    await tryHandleAdminB2b(b.ctx)
    expect(b.out.status).toBe(200)   // the matrix change itself stands
  })

  it('returns 400 when tenant_id missing', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/agent-availability', { agent_id: 'jarvis', enabled: true })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('tenant_id')
  })

  it('returns 404 for unknown agent', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    vi.mocked(agentConfig.isKnownAgent).mockReturnValue(false)
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/agent-availability', { tenant_id: 'acme-corp', agent_id: 'ghost', enabled: true })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(404)
    expect(out.body.field).toBe('agent_id')
  })
})

// ── Device keys ───────────────────────────────────────────────────────────────

describe('GET /api/v1/admin/device-keys', () => {
  it('returns list of device keys', async () => {
    vi.mocked(deviceKeys.listDeviceKeys).mockResolvedValue([
      { id: 1, name: 'Phone', createdAt: 1787000000, lastUsedAt: null, expiresAt: null, installId: null, tenantId: null },
      { id: 2, name: 'Tablet', createdAt: 1787000001, lastUsedAt: 1787000100, expiresAt: null, installId: null, tenantId: 'acme-corp' },
    ])
    const { ctx, out } = makeCtx('GET', '/api/v1/admin/device-keys')
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(out.body.items).toHaveLength(2)
    expect(out.body.total).toBe(2)
    expect(out.body.items[1].tenantId).toBe('acme-corp')
  })
})

describe('PATCH /api/v1/admin/device-keys/:id', () => {
  it('assigns a tenant to a device key', async () => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    vi.mocked(deviceKeys.assignDeviceKeyTenant).mockResolvedValue(true)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/device-keys/3', { tenant_id: 'acme-corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.tenant_id).toBe('acme-corp')
    expect(vi.mocked(deviceKeys.assignDeviceKeyTenant)).toHaveBeenCalledWith(3, 'acme-corp')
  })

  it('clears tenant assignment when tenant_id is null', async () => {
    vi.mocked(deviceKeys.assignDeviceKeyTenant).mockResolvedValue(true)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/device-keys/3', { tenant_id: null })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(out.body.tenant_id).toBeNull()
    expect(vi.mocked(deviceKeys.assignDeviceKeyTenant)).toHaveBeenCalledWith(3, null)
  })

  it('returns 400 when tenant_id field missing', async () => {
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/device-keys/3', {})
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('tenant_id')
  })

  it('returns 404 when device key not found', async () => {
    vi.mocked(deviceKeys.assignDeviceKeyTenant).mockResolvedValue(false)
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/device-keys/999', { tenant_id: null })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('returns 404 for disabled tenant', async () => {
    vi.mocked(db.getTenant).mockResolvedValue({ ...SAMPLE_TENANT, disabled_at: 1787000001 })
    const { ctx, out } = makeCtx('PATCH', '/api/v1/admin/device-keys/3', { tenant_id: 'acme-corp' })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(404)
    expect(out.body.field).toBe('tenant_id')
  })
})


// ── Agent availability matrix -- fleet-only agents MCP risk gate ───────────

describe('PUT /api/v1/admin/agent-availability -- fleet-only agents MCP risk gate', () => {
  beforeEach(() => {
    vi.mocked(db.getTenant).mockResolvedValue(SAMPLE_TENANT)
    vi.mocked(agentConfig.isKnownAgent).mockReturnValue(true)
    vi.mocked(db.setTenantAgentAvailability).mockResolvedValue({ tenant_id: 'acme-corp', agent_id: 'agent-a', enabled: 1, updated_at: 1787000000 })
  })

  it('enables an agent with no high-risk MCP servers directly (no confirmation needed)', async () => {
    vi.mocked(mcpRiskPolicy.getHighRiskMcpServersForAgent).mockReturnValue([])
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/agent-availability', { tenant_id: 'acme-corp', agent_id: 'agent-a', enabled: true })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(out.body.enabled).toBe(true)
    expect(vi.mocked(db.setTenantAgentAvailability)).toHaveBeenCalledWith('acme-corp', 'agent-a', true)
  })

  it('returns 409 with risky_mcp_servers when enabling an agent with high-risk MCP servers for a B2B tenant', async () => {
    vi.mocked(mcpRiskPolicy.getHighRiskMcpServersForAgent).mockReturnValue(['github', 'hetzner'])
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/agent-availability', { tenant_id: 'acme-corp', agent_id: 'agent-b', enabled: true })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
    expect(out.body.risky_mcp_servers).toEqual(['github', 'hetzner'])
    expect(vi.mocked(db.setTenantAgentAvailability)).not.toHaveBeenCalled()
  })

  it('proceeds when confirm:true is sent alongside a high-risk agent', async () => {
    vi.mocked(mcpRiskPolicy.getHighRiskMcpServersForAgent).mockReturnValue(['github'])
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/agent-availability', { tenant_id: 'acme-corp', agent_id: 'agent-b', enabled: true, confirm: true })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(vi.mocked(db.setTenantAgentAvailability)).toHaveBeenCalledWith('acme-corp', 'agent-b', true)
  })

  it('does not gate on the default tenant even for a high-risk agent', async () => {
    vi.mocked(db.getTenant).mockResolvedValue({ id: 'default', display_name: 'Fleet', created_at: 0, disabled_at: null, main_agent_id: null })
    vi.mocked(mcpRiskPolicy.getHighRiskMcpServersForAgent).mockReturnValue(['hetzner'])
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/agent-availability', { tenant_id: 'default', agent_id: 'agent-a', enabled: true })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(vi.mocked(db.setTenantAgentAvailability)).toHaveBeenCalledWith('default', 'agent-a', true)
  })

  it('does not gate when disabling an agent, even if it carries high-risk MCP servers', async () => {
    vi.mocked(mcpRiskPolicy.getHighRiskMcpServersForAgent).mockReturnValue(['github'])
    vi.mocked(db.setTenantAgentAvailability).mockResolvedValue({ tenant_id: 'acme-corp', agent_id: 'agent-b', enabled: 0, updated_at: 1787000000 })
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/agent-availability', { tenant_id: 'acme-corp', agent_id: 'agent-b', enabled: false })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(200)
    expect(vi.mocked(db.setTenantAgentAvailability)).toHaveBeenCalledWith('acme-corp', 'agent-b', false)
  })

  it('returns 404 for an unknown agent before evaluating MCP risk', async () => {
    vi.mocked(agentConfig.isKnownAgent).mockReturnValue(false)
    const { ctx, out } = makeCtx('PUT', '/api/v1/admin/agent-availability', { tenant_id: 'acme-corp', agent_id: 'ghost', enabled: true })
    await tryHandleAdminB2b(ctx)
    expect(out.status).toBe(404)
    expect(vi.mocked(mcpRiskPolicy.getHighRiskMcpServersForAgent)).not.toHaveBeenCalled()
  })
})
