// The tenant resolvers and the channel bindings on the async db facade: a binding change and the drop of the agent's
// recorded context are one transaction, overlapping changes stay consistent, and a resolver that cannot read answers
// "no tenant" instead of guessing. Real in-memory database, no mocks.
// Each test names the line it protects: take that line out of src/db/tenant-channel-bindings.ts and the test fails.
import { describe, it, expect, beforeEach } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { refuseWrite } from './helpers/refuse-write.js'
import {
  dbx, createTenant, setChannelBinding, deleteChannelBinding, getChannelBindingTenant, listChannelBindings,
  getServingTenant, explainServingTenantMiss,
} from '../db.js'

useTestDb()

beforeEach(async () => {
  await createTenant('acme', 'Acme')
  await createTenant('beta', 'Beta')
})

const seedContext = async (agentId: string, tenantId: string): Promise<void> => {
  await dbx.run('DELETE FROM agent_tenant_context WHERE agent_id = ?', agentId)
  await dbx.run("INSERT INTO agent_tenant_context (agent_id, tenant_id, status) VALUES (?, ?, 'bound')", agentId, tenantId)
}
const contextAgents = async (): Promise<string[]> =>
  (await dbx.all<{ agent_id: string }>('SELECT agent_id FROM agent_tenant_context ORDER BY agent_id')).map((r) => r.agent_id)
const blockContextDrop = (): Promise<void> =>
  refuseWrite(dbx, { name: 'context_drop_blocked', table: 'agent_tenant_context', message: 'blocked', event: 'DELETE' })

describe('setChannelBinding', () => {
  it('a failing drop of the context rolls the new binding back: the source keeps its tenant, the context stays', async () => {
    await setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
    await seedContext('agent-a', 'acme')
    await blockContextDrop()
    await expect(setChannelBinding('agent-a', 'telegram', '1', 'beta', 'admin')).rejects.toThrow(/blocked/)
    expect(await getChannelBindingTenant('agent-a', 'telegram', '1')).toBe('acme')
    expect(await contextAgents()).toEqual(['agent-a'])
  })

  it('a first binding that fails to drop the context leaves no binding behind', async () => {
    await seedContext('agent-a', 'acme')
    await blockContextDrop()
    await expect(setChannelBinding('agent-a', 'telegram', '9', 'beta', 'admin')).rejects.toThrow(/blocked/)
    expect(await listChannelBindings()).toEqual([])
  })

  it('two overlapping moves of one source end on one row, and the context of the agent is dropped', async () => {
    await setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
    await seedContext('agent-a', 'acme')
    await seedContext('agent-b', 'acme')
    await Promise.all([
      setChannelBinding('agent-a', 'telegram', '1', 'beta', 'admin'),
      setChannelBinding('agent-a', 'telegram', '1', 'beta', 'admin'),
    ])
    expect(await listChannelBindings()).toHaveLength(1)
    expect(await getChannelBindingTenant('agent-a', 'telegram', '1')).toBe('beta')
    expect(await contextAgents()).toEqual(['agent-b'])
  })

  it('two overlapping binds of one source to different tenants leave exactly one of them, never a mix', async () => {
    const [first, second] = await Promise.all([
      setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin'),
      setChannelBinding('agent-a', 'telegram', '1', 'beta', 'admin'),
    ])
    expect([first.tenant_id, second.tenant_id]).toEqual(['acme', 'beta'])
    const rows = await listChannelBindings()
    expect(rows).toHaveLength(1)
    // One of the two tenants, never a mix: which call commits last is not fixed (PostgreSQL commit order).
    expect(['acme', 'beta']).toContain(rows[0].tenant_id)
  })
})

describe('deleteChannelBinding', () => {
  it('a failing drop of the context rolls the delete back: the binding stays', async () => {
    await setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
    await seedContext('agent-a', 'acme')
    await blockContextDrop()
    await expect(deleteChannelBinding('agent-a', 'telegram', '1')).rejects.toThrow(/blocked/)
    expect(await getChannelBindingTenant('agent-a', 'telegram', '1')).toBe('acme')
  })

  it('of two overlapping deletes exactly one removes the binding', async () => {
    await setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
    const results = await Promise.all([
      deleteChannelBinding('agent-a', 'telegram', '1'),
      deleteChannelBinding('agent-a', 'telegram', '1'),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await getChannelBindingTenant('agent-a', 'telegram', '1')).toBeNull()
  })
})

describe('the serving-tenant resolvers fail closed', () => {
  it('a context table that cannot be read gives no tenant and the error label, a fresh bound context does answer', async () => {
    await dbx.run('INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES (?, ?, 1)', 'acme', 'agent-a')
    await seedContext('agent-a', 'acme')
    expect(await getServingTenant('agent-a')).toBe('acme')
    await dbx.run('DROP TABLE agent_tenant_context')
    expect(await getServingTenant('agent-a')).toBeNull()
    expect(await explainServingTenantMiss('agent-a')).toBe('error')
  })

  it('an availability table that cannot be read cannot turn a bound context into an answer', async () => {
    await seedContext('agent-a', 'acme')
    await dbx.run('DROP TABLE tenant_agent_availability')
    expect(await getServingTenant('agent-a')).toBeNull()
    expect(await explainServingTenantMiss('agent-a')).toBe('error')
  })
})
