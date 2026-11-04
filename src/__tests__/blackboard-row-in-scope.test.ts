// blackboardRowInScope (src/db/agents.ts): the pre-read check of PATCH /api/blackboard/:id. This calls the REAL function
// from the REAL module: the route test replaces ../db.js with a mock, and a copy of the predicate in a test would
// pass whatever the real one does.
//
// Privacy: neutral fixtures only (agent-a, agent-b, tenant-a, tenant-b).

import { describe, it, expect } from 'vitest'
import { blackboardRowInScope } from '../db/agents.js'

const row = (agent_id: string, tenant_id: string) => ({ agent_id, tenant_id })

describe('blackboardRowInScope (real module)', () => {
  it('tenant scope: a row of that tenant is in scope', () => {
    expect(blackboardRowInScope(row('agent-a', 'tenant-a'), { tenantId: 'tenant-a' })).toBe(true)
  })

  it('tenant scope: a row of another tenant is out of scope', () => {
    expect(blackboardRowInScope(row('agent-a', 'tenant-b'), { tenantId: 'tenant-a' })).toBe(false)
  })

  it('tenant scope: the _multi_ sentinel row (a shared agent) matches no real tenant', () => {
    expect(blackboardRowInScope(row('agent-a', '_multi_'), { tenantId: 'tenant-a' })).toBe(false)
    expect(blackboardRowInScope(row('agent-a', '_multi_'), { tenantId: 'default' })).toBe(false)
  })

  it('owner scope: the agent\'s own row is in scope, whatever tenant it carries', () => {
    expect(blackboardRowInScope(row('agent-a', 'tenant-a'), { ownerAgentId: 'agent-a' })).toBe(true)
    expect(blackboardRowInScope(row('agent-a', '_multi_'), { ownerAgentId: 'agent-a' })).toBe(true)
  })

  it('owner scope: another agent\'s row is out of scope, also in the caller\'s own tenant', () => {
    expect(blackboardRowInScope(row('agent-b', 'tenant-a'), { ownerAgentId: 'agent-a' })).toBe(false)
  })

  it('no scope (admin): every row is in scope', () => {
    expect(blackboardRowInScope(row('agent-a', 'tenant-a'), undefined)).toBe(true)
    expect(blackboardRowInScope(row('agent-b', '_multi_'), undefined)).toBe(true)
  })

  it('the two scope kinds are told apart: a tenant scope never compares the owner and an owner scope never the tenant', () => {
    // same agent, other tenant: a tenant scope refuses, an owner scope accepts
    expect(blackboardRowInScope(row('agent-a', 'tenant-b'), { tenantId: 'tenant-a' })).toBe(false)
    expect(blackboardRowInScope(row('agent-a', 'tenant-b'), { ownerAgentId: 'agent-a' })).toBe(true)
    // same tenant, other agent: a tenant scope accepts, an owner scope refuses
    expect(blackboardRowInScope(row('agent-b', 'tenant-a'), { tenantId: 'tenant-a' })).toBe(true)
    expect(blackboardRowInScope(row('agent-b', 'tenant-a'), { ownerAgentId: 'agent-a' })).toBe(false)
  })
})
