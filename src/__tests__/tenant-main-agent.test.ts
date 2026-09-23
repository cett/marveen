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

// updateTenant() also accepts main_agent_id (see 'updateTenant' describe
// block below); these tests predate that and just set the column directly
// to keep getTenantForMainAgent/getTenantsForAgent coverage independent of it.
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

describe('updateTenant main_agent_id patch', () => {
  it('sets main_agent_id via the patch and getTenantForMainAgent then finds it', () => {
    const updated = updateTenant('acme', { main_agent_id: 'agent-a' })
    expect(updated?.main_agent_id).toBe('agent-a')
    expect(getTenantForMainAgent('agent-a')?.id).toBe('acme')
  })

  it('leaves main_agent_id untouched when the patch omits it', () => {
    updateTenant('acme', { main_agent_id: 'agent-a' })
    const updated = updateTenant('acme', { display_name: 'Acme Renamed' })
    expect(updated?.main_agent_id).toBe('agent-a')
    expect(updated?.display_name).toBe('Acme Renamed')
  })

  it('can combine main_agent_id and display_name in a single patch (install-seed use case)', () => {
    const updated = updateTenant('acme', { main_agent_id: 'agent-b', display_name: 'Main fleet' })
    expect(updated?.main_agent_id).toBe('agent-b')
    expect(updated?.display_name).toBe('Main fleet')
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
