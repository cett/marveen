import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createTenant, setTenantAgentAvailability, getEnabledAgentsForTenant } from '../db.js'

// Test getEnabledAgentsForTenant against the real exported function with an
// in-memory SQLite database, so a broken query (wrong column, wrong enabled
// filter) is caught even when route-level tests mock db.js entirely.

beforeEach(() => {
  initDatabase(':memory:')
  createTenant('acme', 'Acme')
  createTenant('other-co', 'Other Co')
})

describe('getEnabledAgentsForTenant', () => {
  it('returns an empty list for a tenant with no availability rows', () => {
    expect(getEnabledAgentsForTenant('acme')).toEqual([])
  })

  it('returns only the enabled=1 agents for the given tenant', () => {
    setTenantAgentAvailability('acme', 'peter', true)
    setTenantAgentAvailability('acme', 'zoe', true)
    setTenantAgentAvailability('acme', 'carmen', false)

    expect(getEnabledAgentsForTenant('acme').sort()).toEqual(['peter', 'zoe'])
  })

  it('does not leak another tenant\'s enabled agents', () => {
    setTenantAgentAvailability('acme', 'peter', true)
    setTenantAgentAvailability('other-co', 'vera', true)

    expect(getEnabledAgentsForTenant('acme')).toEqual(['peter'])
    expect(getEnabledAgentsForTenant('other-co')).toEqual(['vera'])
  })

  it('reflects a later disable of a previously-enabled agent', () => {
    setTenantAgentAvailability('acme', 'peter', true)
    expect(getEnabledAgentsForTenant('acme')).toEqual(['peter'])

    setTenantAgentAvailability('acme', 'peter', false)
    expect(getEnabledAgentsForTenant('acme')).toEqual([])
  })
})
