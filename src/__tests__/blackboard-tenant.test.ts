import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createTenant,
  resolveAgentTenant,
  upsertBlackboard,
  updateBlackboardRowById,
  getBlackboardRowById,
  findBlackboardRowByAgent,
  listBlackboardHistory,
  setTenantAgentAvailability,
} from '../db.js'

// resolveAgentTenant + upsertBlackboard tenant assignment against a real
// in-memory SQLite database (tenant_agent_availability has no meaningful
// mock-worthy logic -- these are integration-shaped, matching the pattern in
// db-upsert-blackboard.test.ts).
// fixtures (privacy: no real agent names)

beforeEach(async () => {
  initDatabase(':memory:')
  // tenant_agent_availability.tenant_id references tenants(id) -- create the
  // fixtures used across this file up front.
  await createTenant('tenant-a', 'Tenant A')
  await createTenant('tenant-b', 'Tenant B')
  await createTenant('tenant-c', 'Tenant C')
})

describe('resolveAgentTenant', () => {
  it('returns "default" for an agent with no tenant_agent_availability rows (fleet agent)', async () => {
    expect(await resolveAgentTenant('agent-x')).toBe('default')
  })

  it('returns the single tenant for an agent assigned to exactly one tenant', async () => {
    await setTenantAgentAvailability('tenant-a', 'agent-a', true)
    expect(await resolveAgentTenant('agent-a')).toBe('tenant-a')
  })

  it('returns "_multi_" for an agent assigned to 2+ tenants', async () => {
    await setTenantAgentAvailability('tenant-a', 'agent-b', true)
    await setTenantAgentAvailability('tenant-b', 'agent-b', true)
    expect(await resolveAgentTenant('agent-b')).toBe('_multi_')
  })

  it('ignores disabled (enabled=0) rows -- they are not a real assignment', async () => {
    await setTenantAgentAvailability('tenant-a', 'agent-c', true)
    await setTenantAgentAvailability('tenant-b', 'agent-c', false) // explicitly revoked
    expect(await resolveAgentTenant('agent-c')).toBe('tenant-a')
  })

  it('falls back to "default" when every row for the agent is disabled', async () => {
    await setTenantAgentAvailability('tenant-a', 'agent-c', false)
    expect(await resolveAgentTenant('agent-c')).toBe('default')
  })
})

describe('upsertBlackboard: tenant_id assignment', () => {
  it('stamps tenant_id from resolveAgentTenant on insert', async () => {
    await setTenantAgentAvailability('tenant-a', 'agent-a', true)
    const row = await upsertBlackboard('agent-a', { status: 'active', summary: 'working' })
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('fleet agents (no availability row) get tenant_id "default"', async () => {
    const row = await upsertBlackboard('agent-x', { status: 'active', summary: 'working' })
    expect(row.tenant_id).toBe('default')
  })

  it('a shared (2+ tenant) agent gets the "_multi_" sentinel', async () => {
    await setTenantAgentAvailability('tenant-a', 'agent-b', true)
    await setTenantAgentAvailability('tenant-b', 'agent-b', true)
    const row = await upsertBlackboard('agent-b', { status: 'active', summary: 'working' })
    expect(row.tenant_id).toBe('_multi_')
  })

  it('re-resolves tenant_id on every write, tracking availability changes', async () => {
    const first = await upsertBlackboard('agent-d', { status: 'active', summary: 'v1' })
    expect(first.tenant_id).toBe('default')

    await setTenantAgentAvailability('tenant-c', 'agent-d', true)
    const second = await upsertBlackboard('agent-d', { status: 'active', summary: 'v2' })
    expect(second.tenant_id).toBe('tenant-c')
    expect((await findBlackboardRowByAgent('agent-d'))?.tenant_id).toBe('tenant-c')
  })
})

describe('listBlackboardHistory: tenant filter', () => {
  it('filters history rows to the given tenantId', async () => {
    await setTenantAgentAvailability('tenant-a', 'agent-a', true)
    await setTenantAgentAvailability('tenant-b', 'agent-e', true)
    await upsertBlackboard('agent-a', { status: 'active', summary: 'a' })
    await upsertBlackboard('agent-e', { status: 'active', summary: 'b' })

    const tenantAHistory = await listBlackboardHistory({ tenantId: 'tenant-a' })
    expect(tenantAHistory).toHaveLength(1)
    expect(tenantAHistory[0]!.agent_id).toBe('agent-a')
  })

  it('tenantId=null (or omitted) returns rows across all tenants', async () => {
    await setTenantAgentAvailability('tenant-a', 'agent-a', true)
    await setTenantAgentAvailability('tenant-b', 'agent-e', true)
    await upsertBlackboard('agent-a', { status: 'active', summary: 'a' })
    await upsertBlackboard('agent-e', { status: 'active', summary: 'b' })

    const all = await listBlackboardHistory({})
    expect(all).toHaveLength(2)
  })
})

describe('updateBlackboardRowById: write scope is part of the UPDATE', () => {
  const FIELDS = { status: 'done', summary: 'patched', task_ref: null, blocked_by: null, blocked_reason: null }

  it('a tenant scope writes a row of that tenant and reports it', async () => {
    await setTenantAgentAvailability('tenant-a', 'agent-a', true)
    const row = await upsertBlackboard('agent-a', { status: 'active', summary: 'mine' })
    expect(await updateBlackboardRowById(row.id, FIELDS, { tenantId: 'tenant-a' })).toBe(true)
    expect((await getBlackboardRowById(row.id))!.summary).toBe('patched')
  })

  it('a tenant scope does not write a row of another tenant', async () => {
    await setTenantAgentAvailability('tenant-b', 'agent-e', true)
    const row = await upsertBlackboard('agent-e', { status: 'active', summary: 'theirs' })
    expect(await updateBlackboardRowById(row.id, FIELDS, { tenantId: 'tenant-a' })).toBe(false)
    const after = (await getBlackboardRowById(row.id))!
    expect(after.summary).toBe('theirs')
    expect(after.status).toBe('active')
  })

  it('a tenant scope never writes a shared (_multi_) row', async () => {
    await setTenantAgentAvailability('tenant-a', 'agent-b', true)
    await setTenantAgentAvailability('tenant-b', 'agent-b', true)
    const row = await upsertBlackboard('agent-b', { status: 'active', summary: 'shared' })
    expect(await updateBlackboardRowById(row.id, FIELDS, { tenantId: 'tenant-a' })).toBe(false)
    expect((await getBlackboardRowById(row.id))!.summary).toBe('shared')
  })

  it('an owner scope writes only that agent\'s row', async () => {
    const mine = await upsertBlackboard('agent-x', { status: 'active', summary: 'mine' })
    const other = await upsertBlackboard('agent-y', { status: 'active', summary: 'other' })
    expect(await updateBlackboardRowById(other.id, FIELDS, { ownerAgentId: 'agent-x' })).toBe(false)
    expect((await getBlackboardRowById(other.id))!.summary).toBe('other')
    expect(await updateBlackboardRowById(mine.id, FIELDS, { ownerAgentId: 'agent-x' })).toBe(true)
    expect((await getBlackboardRowById(mine.id))!.summary).toBe('patched')
  })

  it('without a scope (admin) any row is written; an unknown id reports false', async () => {
    await setTenantAgentAvailability('tenant-b', 'agent-e', true)
    const row = await upsertBlackboard('agent-e', { status: 'active', summary: 'theirs' })
    expect(await updateBlackboardRowById(row.id, FIELDS)).toBe(true)
    expect(await updateBlackboardRowById('nope0000', FIELDS)).toBe(false)
  })
})
