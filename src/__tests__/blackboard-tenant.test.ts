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
  it('returns "default" for an agent with no tenant_agent_availability rows (fleet agent)', () => {
    expect(resolveAgentTenant('agent-x')).toBe('default')
  })

  it('returns the single tenant for an agent assigned to exactly one tenant', () => {
    setTenantAgentAvailability('tenant-a', 'agent-a', true)
    expect(resolveAgentTenant('agent-a')).toBe('tenant-a')
  })

  it('returns "_multi_" for an agent assigned to 2+ tenants', () => {
    setTenantAgentAvailability('tenant-a', 'agent-b', true)
    setTenantAgentAvailability('tenant-b', 'agent-b', true)
    expect(resolveAgentTenant('agent-b')).toBe('_multi_')
  })

  it('ignores disabled (enabled=0) rows -- they are not a real assignment', () => {
    setTenantAgentAvailability('tenant-a', 'agent-c', true)
    setTenantAgentAvailability('tenant-b', 'agent-c', false) // explicitly revoked
    expect(resolveAgentTenant('agent-c')).toBe('tenant-a')
  })

  it('falls back to "default" when every row for the agent is disabled', () => {
    setTenantAgentAvailability('tenant-a', 'agent-c', false)
    expect(resolveAgentTenant('agent-c')).toBe('default')
  })
})

describe('upsertBlackboard: tenant_id assignment', () => {
  it('stamps tenant_id from resolveAgentTenant on insert', () => {
    setTenantAgentAvailability('tenant-a', 'agent-a', true)
    const row = upsertBlackboard('agent-a', { status: 'active', summary: 'working' })
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('fleet agents (no availability row) get tenant_id "default"', () => {
    const row = upsertBlackboard('agent-x', { status: 'active', summary: 'working' })
    expect(row.tenant_id).toBe('default')
  })

  it('a shared (2+ tenant) agent gets the "_multi_" sentinel', () => {
    setTenantAgentAvailability('tenant-a', 'agent-b', true)
    setTenantAgentAvailability('tenant-b', 'agent-b', true)
    const row = upsertBlackboard('agent-b', { status: 'active', summary: 'working' })
    expect(row.tenant_id).toBe('_multi_')
  })

  it('re-resolves tenant_id on every write, tracking availability changes', () => {
    const first = upsertBlackboard('agent-d', { status: 'active', summary: 'v1' })
    expect(first.tenant_id).toBe('default')

    setTenantAgentAvailability('tenant-c', 'agent-d', true)
    const second = upsertBlackboard('agent-d', { status: 'active', summary: 'v2' })
    expect(second.tenant_id).toBe('tenant-c')
    expect(findBlackboardRowByAgent('agent-d')?.tenant_id).toBe('tenant-c')
  })
})

describe('listBlackboardHistory: tenant filter', () => {
  it('filters history rows to the given tenantId', () => {
    setTenantAgentAvailability('tenant-a', 'agent-a', true)
    setTenantAgentAvailability('tenant-b', 'agent-e', true)
    upsertBlackboard('agent-a', { status: 'active', summary: 'a' })
    upsertBlackboard('agent-e', { status: 'active', summary: 'b' })

    const tenantAHistory = listBlackboardHistory({ tenantId: 'tenant-a' })
    expect(tenantAHistory).toHaveLength(1)
    expect(tenantAHistory[0]!.agent_id).toBe('agent-a')
  })

  it('tenantId=null (or omitted) returns rows across all tenants', () => {
    setTenantAgentAvailability('tenant-a', 'agent-a', true)
    setTenantAgentAvailability('tenant-b', 'agent-e', true)
    upsertBlackboard('agent-a', { status: 'active', summary: 'a' })
    upsertBlackboard('agent-e', { status: 'active', summary: 'b' })

    const all = listBlackboardHistory({})
    expect(all).toHaveLength(2)
  })
})
