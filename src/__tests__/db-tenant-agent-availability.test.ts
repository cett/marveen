import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createTenant, setTenantAgentAvailability, getEnabledAgentsForTenant } from '../db.js'

// Test getEnabledAgentsForTenant against the real exported function with an
// in-memory SQLite database, so a broken query (wrong column, wrong enabled
// filter) is caught even when route-level tests mock db.js entirely.

beforeEach(async () => {
  initDatabase(':memory:')
  await createTenant('acme', 'Acme')
  await createTenant('other-co', 'Other Co')
})

describe('getEnabledAgentsForTenant', () => {
  it('returns an empty list for a tenant with no availability rows', async () => {
    expect(await getEnabledAgentsForTenant('acme')).toEqual([])
  })

  it('returns only the enabled=1 agents for the given tenant', async () => {
    await setTenantAgentAvailability('acme', 'peter', true)
    await setTenantAgentAvailability('acme', 'zoe', true)
    await setTenantAgentAvailability('acme', 'carmen', false)

    expect((await getEnabledAgentsForTenant('acme')).sort()).toEqual(['peter', 'zoe'])
  })

  it('does not leak another tenant\'s enabled agents', async () => {
    await setTenantAgentAvailability('acme', 'peter', true)
    await setTenantAgentAvailability('other-co', 'vera', true)

    expect(await getEnabledAgentsForTenant('acme')).toEqual(['peter'])
    expect(await getEnabledAgentsForTenant('other-co')).toEqual(['vera'])
  })

  it('reflects a later disable of a previously-enabled agent', async () => {
    await setTenantAgentAvailability('acme', 'peter', true)
    expect(await getEnabledAgentsForTenant('acme')).toEqual(['peter'])

    await setTenantAgentAvailability('acme', 'peter', false)
    expect(await getEnabledAgentsForTenant('acme')).toEqual([])
  })
})
