import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createTenant,
  resolveAgentTenant,
  upsertBlackboard,
  findBlackboardRowByAgent,
  listBlackboardHistory,
  setTenantAgentAvailability,
} from '../db.js'

// resolveAgentTenant + upsertBlackboard tenant assignment against a real
// in-memory SQLite database (tenant_agent_availability has no meaningful
// mock-worthy logic -- these are integration-shaped, matching the pattern in
// db-upsert-blackboard.test.ts).
// fixtures (privacy: no real agent names)

beforeEach(() => {
  initDatabase(':memory:')
  // tenant_agent_availability.tenant_id references tenants(id) -- create the
  // fixtures used across this file up front.
  createTenant('tenant-a', 'Tenant A')
  createTenant('tenant-b', 'Tenant B')
  createTenant('tenant-c', 'Tenant C')
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
