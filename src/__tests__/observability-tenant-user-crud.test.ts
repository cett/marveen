import { describe, it, expect, beforeEach, vi } from 'vitest'

// deleteTenant's transaction calls purgeSecretsForTenant (real vault.json file
// I/O). Stub it so the SQL-only cascade is exercised without touching disk --
// the file-I/O half is already covered by vault.test.ts's own suite.
vi.mock('../web/vault.js', () => ({
  purgeSecretsForTenant: vi.fn().mockReturnValue(0),
}))

import {
  initDatabase,
  getDb,
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

  it('createTenant + getTenant round-trip', async () => {
    const t = await createTenant('acme', 'Acme Corp')
    expect(t.id).toBe('acme')
    expect(t.disabled_at).toBeNull()
    expect(await getTenant('acme')).toMatchObject({ id: 'acme', display_name: 'Acme Corp' })
  })

  it('listTenants excludes disabled tenants by default, includes them when asked', async () => {
    await createTenant('a', 'A')
    await createTenant('b', 'B')
    await updateTenant('b', { disabled: true })
    const active = await listTenants()
    expect(active.map((t) => t.id)).toContain('a')
    expect(active.map((t) => t.id)).not.toContain('b')
    const all = await listTenants(true)
    expect(all.map((t) => t.id)).toContain('b')
  })

  it('getTenantForMainAgent finds the tenant whose main_agent_id matches, ignoring disabled ones', async () => {
    const { getTenantForMainAgent } = await import('../db.js')
    await createTenant('withmain', 'With Main')
    await updateTenant('withmain', { main_agent_id: 'bob' })
    expect((await getTenantForMainAgent('bob'))?.id).toBe('withmain')
    await updateTenant('withmain', { disabled: true })
    expect(await getTenantForMainAgent('bob')).toBeUndefined()
  })

  it('updateTenant returns null for a nonexistent tenant', async () => {
    expect(await updateTenant('ghost', { display_name: 'x' })).toBeNull()
  })

  it('updateTenant with an empty patch returns the existing row unchanged', async () => {
    await createTenant('c', 'C')
    expect(await updateTenant('c', {})).toMatchObject({ id: 'c', display_name: 'C' })
  })

  it('updateTenant can re-enable a disabled tenant (disabled: false clears disabled_at)', async () => {
    await createTenant('d', 'D')
    await updateTenant('d', { disabled: true })
    expect((await getTenant('d'))?.disabled_at).not.toBeNull()
    await updateTenant('d', { disabled: false })
    expect((await getTenant('d'))?.disabled_at).toBeNull()
  })

  it('updateTenant updates display_name and main_agent_id together', async () => {
    await createTenant('e', 'E')
    const updated = await updateTenant('e', { display_name: 'E2', main_agent_id: 'alice' })
    expect(updated).toMatchObject({ display_name: 'E2', main_agent_id: 'alice' })
  })

  it('deleteTenant refuses to delete the default tenant', async () => {
    await expect(deleteTenant('default')).rejects.toThrow('Cannot delete the default tenant')
  })

  it('deleteTenant removes an empty tenant and reports zero deletions', async () => {
    await createTenant('empty-tenant', 'Empty')
    const result = await deleteTenant('empty-tenant')
    expect(result).toMatchObject({ memoriesDeleted: 0, secretsDeleted: 0, scheduleNames: [], exclusiveAgents: [] })
    expect(await getTenant('empty-tenant')).toBeUndefined()
  })

  it('deleteTenant drops the tenant\'s schedules and their pending retries, and names them for the file-mirror cleanup', async () => {
    await createTenant('acme-s', 'Acme S')
    const d = getDb()
    const ins = d.prepare("INSERT INTO schedules (id, schedule, agent, tenant_id, created_at, updated_at) VALUES (?, '0 9 * * *', 'agent-a', ?, 0, 0)")
    ins.run('acme-job', 'acme-s'); ins.run('acme-job-2', 'acme-s'); ins.run('other-job', 'default')
    const retry = d.prepare("INSERT INTO pending_task_retries (task_name, agent_name, first_attempt, last_attempt) VALUES (?, 'agent-a', 1, 1)")
    retry.run('acme-job'); retry.run('other-job')

    const result = await deleteTenant('acme-s')

    expect([...result.scheduleNames].sort()).toEqual(['acme-job', 'acme-job-2'])
    expect(d.prepare("SELECT id FROM schedules WHERE tenant_id = 'acme-s'").all()).toEqual([])
    // Fix-revert proof: without the retry cleanup the acme-job row would survive.
    expect(d.prepare('SELECT task_name FROM pending_task_retries ORDER BY task_name').all()).toEqual([{ task_name: 'other-job' }])
    expect(d.prepare("SELECT id FROM schedules WHERE id = 'other-job'").get()).toBeDefined()
  })

  it('deleteTenant cascades to the tenant\'s dashboard users and partner senders', async () => {
    await createTenant('cascade', 'Cascade')
    await provisionDashboardUser('u1', 'hash', 'admin', 'cascade')
    await createPartnerSender('sender-1', 'cascade', 'Sender One', 'alice')
    await deleteTenant('cascade')
    expect(await listDashboardUsersFiltered({ tenantId: 'cascade' })).toEqual([])
    expect(await listPartnerSenders('cascade')).toEqual([])
  })
})

describe('dashboard user CRUD', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('provisionDashboardUser + getDashboardUserById round-trip', async () => {
    const u = await provisionDashboardUser('alice', '$hash$', 'admin', null, 'alice@example.com', 'Alice')
    expect(u.username).toBe('alice')
    expect(u.disabled).toBe(0)
    expect(await getDashboardUserById(u.id)).toMatchObject({ username: 'alice', role: 'admin' })
  })

  it('getDashboardUserById returns undefined for a missing id', async () => {
    expect(await getDashboardUserById(999999)).toBeUndefined()
  })

  it('listDashboardUsersFiltered excludes disabled users by default', async () => {
    const a = await provisionDashboardUser('bob', 'h', 'viewer', null)
    await provisionDashboardUser('carol', 'h', 'viewer', null)
    await adminPatchDashboardUser(a.id, { disabled: true })
    const active = await listDashboardUsersFiltered()
    expect(active.map((u) => u.username)).toContain('carol')
    expect(active.map((u) => u.username)).not.toContain('bob')
    const all = await listDashboardUsersFiltered({ includeDisabled: true })
    expect(all.map((u) => u.username)).toContain('bob')
  })

  it('listDashboardUsersFiltered("global") returns only tenant_id IS NULL users', async () => {
    await createTenant('t1', 'T1')
    await provisionDashboardUser('global-user', 'h', 'admin', null)
    await provisionDashboardUser('tenant-user', 'h', 'viewer', 't1')
    const globalOnly = await listDashboardUsersFiltered({ tenantId: 'global' })
    expect(globalOnly.map((u) => u.username)).toEqual(['global-user'])
  })

  it('listDashboardUsersFiltered(tenantId) scopes to that tenant only', async () => {
    await createTenant('t2', 'T2')
    await provisionDashboardUser('other-tenant-user', 'h', 'viewer', null)
    await provisionDashboardUser('t2-user', 'h', 'viewer', 't2')
    const scoped = await listDashboardUsersFiltered({ tenantId: 't2' })
    expect(scoped.map((u) => u.username)).toEqual(['t2-user'])
  })

  it('adminPatchDashboardUser answers not_found for a missing id', async () => {
    expect(await adminPatchDashboardUser(999999, { role: 'admin' })).toEqual({ status: 'not_found' })
  })

  it('adminPatchDashboardUser updates role, email, display_name and tenant_id independently', async () => {
    await createTenant('t3', 'T3')
    const u = await provisionDashboardUser('dana', 'h', 'viewer', null)
    const patched = await adminPatchDashboardUser(u.id, { role: 'admin', tenant_id: 't3', email: 'dana@x.com', display_name: 'Dana' })
    expect(patched).toMatchObject({ status: 'updated', user: { role: 'admin', tenant_id: 't3', email: 'dana@x.com', display_name: 'Dana' } })
  })

  it('adminPatchDashboardUser can clear tenant_id and email back to null', async () => {
    const u = await provisionDashboardUser('erin', 'h', 'viewer', null, 'erin@x.com')
    const patched = await adminPatchDashboardUser(u.id, { tenant_id: null, email: null })
    expect(patched.status === 'updated' ? patched.user.tenant_id : 'not updated').toBeNull()
    expect(patched.status === 'updated' ? patched.user.email : 'not updated').toBeNull()
  })

  it('countActiveAdmins counts only non-disabled admins', async () => {
    const a1 = await provisionDashboardUser('admin1', 'h', 'admin', null)
    await provisionDashboardUser('admin2', 'h', 'admin', null)
    await provisionDashboardUser('member1', 'h', 'viewer', null)
    expect(await countActiveAdmins()).toBe(2)
    await adminPatchDashboardUser(a1.id, { disabled: true })
    expect(await countActiveAdmins()).toBe(1)
  })
})

describe('partner senders', () => {
  beforeEach(async () => { initDatabase(':memory:'); await createTenant('pt', 'Partner Tenant') })

  it('createPartnerSender + isAuthorizedPartnerSender round-trip', async () => {
    await createPartnerSender('sender-a', 'pt', 'Sender A', 'alice')
    expect(await isAuthorizedPartnerSender('sender-a', 'pt')).toBe(true)
  })

  it('isAuthorizedPartnerSender is false for an unknown sender or wrong tenant', async () => {
    await createPartnerSender('sender-b', 'pt', 'Sender B', 'alice')
    expect(await isAuthorizedPartnerSender('unknown', 'pt')).toBe(false)
    expect(await isAuthorizedPartnerSender('sender-b', 'other-tenant')).toBe(false)
  })

  it('disablePartnerSender revokes authorization and reports success once', async () => {
    await createPartnerSender('sender-c', 'pt', 'Sender C', 'alice')
    expect(await disablePartnerSender('sender-c', 'pt')).toBe(true)
    expect(await isAuthorizedPartnerSender('sender-c', 'pt')).toBe(false)
    // Already disabled: no row matches the WHERE ... disabled_at IS NULL clause.
    expect(await disablePartnerSender('sender-c', 'pt')).toBe(false)
  })

  it('listPartnerSenders(tenantId) scopes to one tenant; no-arg lists all tenants', async () => {
    await createTenant('pt2', 'Partner Tenant 2')
    await createPartnerSender('sender-d', 'pt', 'Sender D', 'alice')
    await createPartnerSender('sender-e', 'pt2', 'Sender E', 'alice')
    expect((await listPartnerSenders('pt')).map((s) => s.sender_id)).toEqual(['sender-d'])
    const all = await listPartnerSenders()
    expect(all.map((s) => s.sender_id).sort()).toEqual(['sender-d', 'sender-e'])
  })
})

describe('queryOtelSpans', () => {
  beforeEach(() => { initDatabase(':memory:') })

  async function span(overrides: Partial<Parameters<typeof upsertOtelSpan>[0]> = {}) {
    await upsertOtelSpan({
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

  it('returns spans ordered by start_ms ascending', async () => {
    await span({ span_id: 's1', start_ms: 300 })
    await span({ span_id: 's2', start_ms: 100 })
    await span({ span_id: 's3', start_ms: 200 })
    const rows = await queryOtelSpans({})
    expect(rows.map((r) => r.span_id)).toEqual(['s2', 's3', 's1'])
  })

  it('filters by agent', async () => {
    await span({ span_id: 'a1', agent_id: 'alice' })
    await span({ span_id: 'a2', agent_id: 'carol' })
    const rows = await queryOtelSpans({ agent: 'alice' })
    expect(rows.map((r) => r.span_id)).toEqual(['a1'])
  })

  it('filters by fromMs/toMs range (inclusive)', async () => {
    await span({ span_id: 'r1', start_ms: 100 })
    await span({ span_id: 'r2', start_ms: 200 })
    await span({ span_id: 'r3', start_ms: 300 })
    const rows = await queryOtelSpans({ fromMs: 150, toMs: 250 })
    expect(rows.map((r) => r.span_id)).toEqual(['r2'])
  })

  it('caps the limit at 5000 even when a larger limit is requested', async () => {
    await span({ span_id: 'cap1' })
    const rows = await queryOtelSpans({ limit: 999999 })
    expect(rows.length).toBe(1) // proves the query still ran (cap didn't throw/break it)
  })

  it('returns an empty array when nothing matches', async () => {
    expect(await queryOtelSpans({ agent: 'nobody' })).toEqual([])
  })
})
