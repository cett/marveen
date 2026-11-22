// The tenant resolvers and the channel bindings on the async db facade: a binding change and the drop of the agent's
// recorded context are one transaction, overlapping changes stay consistent, and a resolver that cannot read answers
// "no tenant" instead of guessing. Real in-memory database, no mocks.
// Each test names the line it protects: take that line out of src/db/tenant-channel-bindings.ts and the test fails.
import { describe, it, expect, beforeEach } from 'vitest'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { refuseWrite } from './helpers/refuse-write.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'
import {
  dbx, createTenant, setChannelBinding, deleteChannelBinding, getChannelBindingTenant, listChannelBindings,
  getServingTenant, explainServingTenantMiss,
} from '../db.js'
import { advisoryKeyOf, advisoryLockKeyed } from '../db/dialect.js'

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

describe('setChannelBinding: the per-binding lock', () => {
  // Holder cell (PostgreSQL, two real connections): a transaction takes the binding key, moves the source to another tenant and
  // writes that tenant's context, parked before its commit. The bind to the OLD tenant must wait on the advisory key, and
  // after the commit it must re-read the tenant the holder committed, so the holder's context is dropped.
  // The bind may spell the channel in any case: the key is built from the lower-cased channel, so both spellings wait on the same lock.
  const parkedBind = async (bindChannel: string): Promise<void> => {
    await setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
    const key = advisoryLockKeyed('channel:', advisoryKeyOf('agent-a', 'telegram', '1'))
    if (!key) throw new Error('the binding key is a PostgreSQL advisory lock')
    const il = interleave()
    il.hold('binding-parked')
    const holder = dbx.tx(async (tx) => {
      await tx.run(key.sql, ...key.params)
      await tx.run("UPDATE tenant_channel_bindings SET tenant_id = 'beta', updated_at = unixepoch() WHERE agent_id = ? AND channel = ? AND external_id = ?", 'agent-a', 'telegram', '1')
      await tx.run("INSERT INTO agent_tenant_context (agent_id, tenant_id, status) VALUES ('agent-a', 'beta', 'bound')")
      await il.pass('binding-parked')
    })
    await il.reached('binding-parked')
    const waiting = setChannelBinding('agent-a', bindChannel, '1', 'acme', 'admin')
    try {
      await waitBlockedOnLock(dbx, 1, 'pg')
      // the waiter is on the advisory key (a row wait would be locktype transactionid)
      // pg_locks is server-wide: only the waiters of this test database count (other files run in parallel).
      expect.soft(Number((await dbx.get<{ c: number | string }>(
        "SELECT COUNT(*) AS c FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
      ))?.c)).toBe(1)
    } finally {
      il.open('binding-parked')
      await holder
    }
    expect((await waiting).tenant_id).toBe('acme')
    expect(await getChannelBindingTenant('agent-a', 'telegram', '1')).toBe('acme')
    expect(await contextAgents()).toEqual([])
  }
  it.runIf(testDbMode() === 'pg')('waits on the binding key and drops the context the holder committed (two real connections)', () => parkedBind('telegram'))
  it.runIf(testDbMode() === 'pg')('the same, when the bind spells the channel in capitals: it waits on the same key (PostgreSQL)', () => parkedBind('Telegram'))

  it('re-binding a source to the tenant it already has keeps the agent context', async () => {
    await setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
    await seedContext('agent-a', 'acme')
    await setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
    expect(await contextAgents()).toEqual(['agent-a'])
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
