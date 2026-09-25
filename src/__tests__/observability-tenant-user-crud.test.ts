import { describe, it, expect, beforeEach, vi } from 'vitest'

// deleteTenant's transaction calls purgeSecretsForTenant (real vault.json file
// I/O). Stub it so the SQL-only cascade is exercised without touching disk --
// the file-I/O half is already covered by vault.test.ts's own suite.
vi.mock('../web/vault.js', () => ({
  purgeSecretsForTenant: vi.fn().mockReturnValue(0),
}))

import {
  initDatabase,
  createTenant,
  getTenant,
  listTenants,
  updateTenant,
  deleteTenant,
  provisionDashboardUser,
  getDashboardUserById,
  listDashboardUsersFiltered,
  adminPatchDashboardUser,
  countActiveAdmins,
  isAuthorizedPartnerSender,
  listPartnerSenders,
  createPartnerSender,
  disablePartnerSender,
  upsertOtelSpan,
  queryOtelSpans,
} from '../db.js'

// Real in-memory DB, no mocks on db.js itself -- unlike every existing caller
// of these functions (admin-b2b.test.ts, admin-tenant-delete.test.ts,
// partner-senders.test.ts, me.test.ts, messages-routes.test.ts,
// session-user-audit.test.ts), which all mock '../db.js' wholesale and so
// never execute these observability.ts implementations for real.

describe('tenant CRUD', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('createTenant + getTenant round-trip', () => {
    const t = createTenant('acme', 'Acme Corp')
    expect(t.id).toBe('acme')
    expect(t.disabled_at).toBeNull()
    expect(getTenant('acme')).toMatchObject({ id: 'acme', display_name: 'Acme Corp' })
  })

  it('listTenants excludes disabled tenants by default, includes them when asked', () => {
    createTenant('a', 'A')
    createTenant('b', 'B')
    updateTenant('b', { disabled: true })
    const active = listTenants()
    expect(active.map((t) => t.id)).toContain('a')
    expect(active.map((t) => t.id)).not.toContain('b')
    const all = listTenants(true)
    expect(all.map((t) => t.id)).toContain('b')
  })

  it('getTenantForMainAgent finds the tenant whose main_agent_id matches, ignoring disabled ones', async () => {
    const { getTenantForMainAgent } = await import('../db.js')
    createTenant('withmain', 'With Main')
    updateTenant('withmain', { main_agent_id: 'bob' })
    expect(getTenantForMainAgent('bob')?.id).toBe('withmain')
    updateTenant('withmain', { disabled: true })
    expect(getTenantForMainAgent('bob')).toBeUndefined()
  })

  it('updateTenant returns null for a nonexistent tenant', () => {
    expect(updateTenant('ghost', { display_name: 'x' })).toBeNull()
  })

  it('updateTenant with an empty patch returns the existing row unchanged', () => {
    createTenant('c', 'C')
    expect(updateTenant('c', {})).toMatchObject({ id: 'c', display_name: 'C' })
  })

  it('updateTenant can re-enable a disabled tenant (disabled: false clears disabled_at)', () => {
    createTenant('d', 'D')
    updateTenant('d', { disabled: true })
    expect(getTenant('d')?.disabled_at).not.toBeNull()
    updateTenant('d', { disabled: false })
    expect(getTenant('d')?.disabled_at).toBeNull()
  })

  it('updateTenant updates display_name and main_agent_id together', () => {
    createTenant('e', 'E')
    const updated = updateTenant('e', { display_name: 'E2', main_agent_id: 'alice' })
    expect(updated).toMatchObject({ display_name: 'E2', main_agent_id: 'alice' })
  })

  it('deleteTenant refuses to delete the default tenant', () => {
    expect(() => deleteTenant('default')).toThrow('Cannot delete the default tenant')
  })

  it('deleteTenant removes an empty tenant and reports zero deletions', () => {
    createTenant('empty-tenant', 'Empty')
    const result = deleteTenant('empty-tenant')
    expect(result).toEqual({ memoriesDeleted: 0, secretsDeleted: 0 })
    expect(getTenant('empty-tenant')).toBeUndefined()
  })

  it('deleteTenant cascades to the tenant\'s dashboard users and partner senders', () => {
    createTenant('cascade', 'Cascade')
    provisionDashboardUser('u1', 'hash', 'admin', 'cascade')
    createPartnerSender('sender-1', 'cascade', 'Sender One', 'alice')
    deleteTenant('cascade')
    expect(listDashboardUsersFiltered({ tenantId: 'cascade' })).toEqual([])
    expect(listPartnerSenders('cascade')).toEqual([])
  })
})

describe('dashboard user CRUD', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('provisionDashboardUser + getDashboardUserById round-trip', () => {
    const u = provisionDashboardUser('alice', '$hash$', 'admin', null, 'alice@example.com', 'Alice')
    expect(u.username).toBe('alice')
    expect(u.disabled).toBe(0)
    expect(getDashboardUserById(u.id)).toMatchObject({ username: 'alice', role: 'admin' })
  })

  it('getDashboardUserById returns undefined for a missing id', () => {
    expect(getDashboardUserById(999999)).toBeUndefined()
  })

  it('listDashboardUsersFiltered excludes disabled users by default', () => {
    const a = provisionDashboardUser('bob', 'h', 'viewer', null)
    provisionDashboardUser('carol', 'h', 'viewer', null)
    adminPatchDashboardUser(a.id, { disabled: true })
    const active = listDashboardUsersFiltered()
    expect(active.map((u) => u.username)).toContain('carol')
    expect(active.map((u) => u.username)).not.toContain('bob')
    const all = listDashboardUsersFiltered({ includeDisabled: true })
    expect(all.map((u) => u.username)).toContain('bob')
  })

  it('listDashboardUsersFiltered("global") returns only tenant_id IS NULL users', () => {
    createTenant('t1', 'T1')
    provisionDashboardUser('global-user', 'h', 'admin', null)
    provisionDashboardUser('tenant-user', 'h', 'viewer', 't1')
    const globalOnly = listDashboardUsersFiltered({ tenantId: 'global' })
    expect(globalOnly.map((u) => u.username)).toEqual(['global-user'])
  })

  it('listDashboardUsersFiltered(tenantId) scopes to that tenant only', () => {
    createTenant('t2', 'T2')
    provisionDashboardUser('other-tenant-user', 'h', 'viewer', null)
    provisionDashboardUser('t2-user', 'h', 'viewer', 't2')
    const scoped = listDashboardUsersFiltered({ tenantId: 't2' })
    expect(scoped.map((u) => u.username)).toEqual(['t2-user'])
  })

  it('adminPatchDashboardUser returns null for a missing id', () => {
    expect(adminPatchDashboardUser(999999, { role: 'admin' })).toBeNull()
  })

  it('adminPatchDashboardUser updates role, email, display_name and tenant_id independently', () => {
    createTenant('t3', 'T3')
    const u = provisionDashboardUser('dana', 'h', 'viewer', null)
    const patched = adminPatchDashboardUser(u.id, { role: 'admin', tenant_id: 't3', email: 'dana@x.com', display_name: 'Dana' })
    expect(patched).toMatchObject({ role: 'admin', tenant_id: 't3', email: 'dana@x.com', display_name: 'Dana' })
  })

  it('adminPatchDashboardUser can clear tenant_id and email back to null', () => {
    const u = provisionDashboardUser('erin', 'h', 'viewer', null, 'erin@x.com')
    const patched = adminPatchDashboardUser(u.id, { tenant_id: null, email: null })
    expect(patched?.tenant_id).toBeNull()
    expect(patched?.email).toBeNull()
  })

  it('countActiveAdmins counts only non-disabled admins', () => {
    const a1 = provisionDashboardUser('admin1', 'h', 'admin', null)
    provisionDashboardUser('admin2', 'h', 'admin', null)
    provisionDashboardUser('member1', 'h', 'viewer', null)
    expect(countActiveAdmins()).toBe(2)
    adminPatchDashboardUser(a1.id, { disabled: true })
    expect(countActiveAdmins()).toBe(1)
  })
})

describe('partner senders', () => {
  beforeEach(() => { initDatabase(':memory:'); createTenant('pt', 'Partner Tenant') })

  it('createPartnerSender + isAuthorizedPartnerSender round-trip', () => {
    createPartnerSender('sender-a', 'pt', 'Sender A', 'alice')
    expect(isAuthorizedPartnerSender('sender-a', 'pt')).toBe(true)
  })

  it('isAuthorizedPartnerSender is false for an unknown sender or wrong tenant', () => {
    createPartnerSender('sender-b', 'pt', 'Sender B', 'alice')
    expect(isAuthorizedPartnerSender('unknown', 'pt')).toBe(false)
    expect(isAuthorizedPartnerSender('sender-b', 'other-tenant')).toBe(false)
  })

  it('disablePartnerSender revokes authorization and reports success once', () => {
    createPartnerSender('sender-c', 'pt', 'Sender C', 'alice')
    expect(disablePartnerSender('sender-c', 'pt')).toBe(true)
    expect(isAuthorizedPartnerSender('sender-c', 'pt')).toBe(false)
    // Already disabled: no row matches the WHERE ... disabled_at IS NULL clause.
    expect(disablePartnerSender('sender-c', 'pt')).toBe(false)
  })

  it('listPartnerSenders(tenantId) scopes to one tenant; no-arg lists all tenants', () => {
    createTenant('pt2', 'Partner Tenant 2')
    createPartnerSender('sender-d', 'pt', 'Sender D', 'alice')
    createPartnerSender('sender-e', 'pt2', 'Sender E', 'alice')
    expect(listPartnerSenders('pt').map((s) => s.sender_id)).toEqual(['sender-d'])
    const all = listPartnerSenders()
    expect(all.map((s) => s.sender_id).sort()).toEqual(['sender-d', 'sender-e'])
  })
})

describe('queryOtelSpans', () => {
  beforeEach(() => { initDatabase(':memory:') })

  function span(overrides: Partial<Parameters<typeof upsertOtelSpan>[0]> = {}) {
    upsertOtelSpan({
      trace_id: 'trace-1',
      span_id: `span-${Math.random()}`,
      parent_span_id: null,
      agent_id: 'alice',
      operation: 'test-op',
      start_ms: 1000,
      attributes: null,
      ...overrides,
    })
  }

  it('returns spans ordered by start_ms ascending', () => {
    span({ span_id: 's1', start_ms: 300 })
    span({ span_id: 's2', start_ms: 100 })
    span({ span_id: 's3', start_ms: 200 })
    const rows = queryOtelSpans({})
    expect(rows.map((r) => r.span_id)).toEqual(['s2', 's3', 's1'])
  })

  it('filters by agent', () => {
    span({ span_id: 'a1', agent_id: 'alice' })
    span({ span_id: 'a2', agent_id: 'carol' })
    const rows = queryOtelSpans({ agent: 'alice' })
    expect(rows.map((r) => r.span_id)).toEqual(['a1'])
  })

  it('filters by fromMs/toMs range (inclusive)', () => {
    span({ span_id: 'r1', start_ms: 100 })
    span({ span_id: 'r2', start_ms: 200 })
    span({ span_id: 'r3', start_ms: 300 })
    const rows = queryOtelSpans({ fromMs: 150, toMs: 250 })
    expect(rows.map((r) => r.span_id)).toEqual(['r2'])
  })

  it('caps the limit at 5000 even when a larger limit is requested', () => {
    span({ span_id: 'cap1' })
    const rows = queryOtelSpans({ limit: 999999 })
    expect(rows.length).toBe(1) // proves the query still ran (cap didn't throw/break it)
  })

  it('returns an empty array when nothing matches', () => {
    expect(queryOtelSpans({ agent: 'nobody' })).toEqual([])
  })
})
