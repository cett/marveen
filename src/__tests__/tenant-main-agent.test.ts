import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createTenant, updateTenant, getTenantForMainAgent, setTenantAgentAvailability, getTenantsForAgent } from '../db.js'
import { getDb } from '../db.js'

// getTenantForMainAgent/getTenantsForAgent back the Agents screen's tenant
// main-agent badge and tenant visibility chips. Real in-memory SQLite so a
// broken query is caught even when route-level tests mock db.js entirely.

beforeEach(() => {
  initDatabase(':memory:')
  createTenant('acme', 'Acme')
  createTenant('other-co', 'Other Co')
})

// tenants.main_agent_id has no dedicated setter (out of scope: no new
// endpoint), so tests set it directly the same way the migration does.
function setMainAgent(tenantId: string, agentId: string | null): void {
  getDb().prepare('UPDATE tenants SET main_agent_id = ? WHERE id = ?').run(agentId, tenantId)
}

describe('getTenantForMainAgent', () => {
  it('returns undefined when no tenant designates this agent as main', () => {
    expect(getTenantForMainAgent('agent-a')).toBeUndefined()
  })

  it('returns the tenant whose main_agent_id matches', () => {
    setMainAgent('acme', 'agent-a')
    const tenant = getTenantForMainAgent('agent-a')
    expect(tenant?.id).toBe('acme')
    expect(tenant?.display_name).toBe('Acme')
  })

  it('does not match a different agent', () => {
    setMainAgent('acme', 'agent-a')
    expect(getTenantForMainAgent('agent-b')).toBeUndefined()
  })

  it('excludes a disabled tenant even if main_agent_id still points at this agent', () => {
    setMainAgent('acme', 'agent-a')
    updateTenant('acme', { disabled: true })
    expect(getTenantForMainAgent('agent-a')).toBeUndefined()
  })
})

describe('getTenantsForAgent', () => {
  it('returns an empty list for an agent with no availability rows', () => {
    expect(getTenantsForAgent('agent-a')).toEqual([])
  })

  it('returns only the tenant ids this agent is enabled=1 for', () => {
    setTenantAgentAvailability('acme', 'agent-a', true)
    setTenantAgentAvailability('other-co', 'agent-a', true)
    setTenantAgentAvailability('acme', 'agent-b', false)

    expect(getTenantsForAgent('agent-a').sort()).toEqual(['acme', 'other-co'])
    expect(getTenantsForAgent('agent-b')).toEqual([])
  })
})
