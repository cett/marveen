import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// tenant_channel_bindings (migration 0064): which tenant an incoming source belongs to.
// Real SQLite, fresh module instance per test (STORE_DIR is resolved at import time).
let dbMod: typeof import('../db.js')
let storeDir: string

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'db-tenant-bindings-test-'))
  process.env['MARVEEN_STORE_DIR'] = storeDir
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  await dbMod.createTenant('acme', 'Acme')
  await dbMod.createTenant('beta', 'Beta')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

describe('tenant channel bindings', () => {
  it('a source without a binding is not bound and resolves to the default tenant', async () => {
    expect(await dbMod.getChannelBindingTenant('agent-a', 'telegram', '111')).toBeNull()
    expect(await dbMod.resolveSourceTenant('agent-a', 'telegram', '111')).toBe('default')
  })

  it('a bound source resolves to its tenant, per agent and per channel', async () => {
    await dbMod.setChannelBinding('agent-a', 'telegram', '111', 'acme', 'admin')
    expect(await dbMod.resolveSourceTenant('agent-a', 'telegram', '111')).toBe('acme')
    expect(await dbMod.resolveSourceTenant('agent-b', 'telegram', '111')).toBe('default')   // other agent
    expect(await dbMod.resolveSourceTenant('agent-a', 'slack', '111')).toBe('default')      // other channel
    expect(await dbMod.resolveSourceTenant('agent-a', 'telegram', '112')).toBe('default')   // other source
  })

  it('the channel is case-insensitive', async () => {
    await dbMod.setChannelBinding('agent-a', 'Telegram', '111', 'acme', 'admin')
    expect(await dbMod.getChannelBindingTenant('agent-a', 'TELEGRAM', '111')).toBe('acme')
    expect((await dbMod.listChannelBindings())[0].channel).toBe('telegram')
  })

  it('a source belongs to exactly one tenant: re-binding moves it', async () => {
    await dbMod.setChannelBinding('agent-a', 'telegram', '111', 'acme', 'admin')
    const moved = await dbMod.setChannelBinding('agent-a', 'telegram', '111', 'beta', 'admin')
    expect(moved.tenant_id).toBe('beta')
    expect(await dbMod.listChannelBindings()).toHaveLength(1)
    expect(await dbMod.resolveSourceTenant('agent-a', 'telegram', '111')).toBe('beta')
  })

  it('deleting a binding sends the source back to the default tenant', async () => {
    await dbMod.setChannelBinding('agent-a', 'telegram', '111', 'acme', 'admin')
    expect(await dbMod.deleteChannelBinding('agent-a', 'telegram', '111')).toBe(true)
    expect(await dbMod.deleteChannelBinding('agent-a', 'telegram', '111')).toBe(false)
    expect(await dbMod.resolveSourceTenant('agent-a', 'telegram', '111')).toBe('default')
  })

  it('lists filtered by tenant and by agent', async () => {
    await dbMod.setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
    await dbMod.setChannelBinding('agent-a', 'telegram', '2', 'beta', 'admin')
    await dbMod.setChannelBinding('agent-b', 'dashboard', 'u1', 'acme', 'admin')
    expect(await dbMod.listChannelBindings()).toHaveLength(3)
    expect((await dbMod.listChannelBindings({ tenantId: 'acme' })).map(b => b.external_id).sort()).toEqual(['1', 'u1'])
    expect(await dbMod.listChannelBindings({ agentId: 'agent-a' })).toHaveLength(2)
    expect(await dbMod.listChannelBindings({ tenantId: 'acme', agentId: 'agent-b' })).toHaveLength(1)
  })

  it('deleting a tenant removes its bindings and leaves the other tenants\' bindings alone (FK cascade off: the purge itself does it)', async () => {
    dbMod.getDb().pragma('foreign_keys = OFF')   // the FK cascade would mask a missing explicit purge
    await dbMod.setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
    await dbMod.setChannelBinding('agent-a', 'telegram', '2', 'beta', 'admin')
    const ctx = dbMod.getDb().prepare("INSERT INTO agent_tenant_context (agent_id, tenant_id, status) VALUES (?, ?, 'bound')")
    ctx.run('agent-a', 'acme'); ctx.run('agent-b', 'beta')
    dbMod.deleteTenant('acme')
    expect(await dbMod.getChannelBindingTenant('agent-a', 'telegram', '1')).toBeNull()
    expect(await dbMod.getChannelBindingTenant('agent-a', 'telegram', '2')).toBe('beta')
    // an agent's recorded active context must not keep naming a deleted tenant
    const left = dbMod.getDb().prepare('SELECT agent_id FROM agent_tenant_context').all() as { agent_id: string }[]
    expect(left.map(r => r.agent_id)).toEqual(['agent-b'])
  })

  describe('a binding change takes effect at once (the recorded context of the agent is dropped)', () => {
    const seedContext = () => {
      const st = dbMod.getDb().prepare("INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status) VALUES (?, ?, 'bound')")
      st.run('agent-a', 'acme'); st.run('agent-b', 'acme')
    }
    const contextAgents = () =>
      (dbMod.getDb().prepare('SELECT agent_id FROM agent_tenant_context ORDER BY agent_id').all() as { agent_id: string }[]).map(r => r.agent_id)

    it('re-binding to another tenant and deleting a binding drop that agent\'s context only', async () => {
      await dbMod.setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
      seedContext()
      await dbMod.setChannelBinding('agent-a', 'telegram', '1', 'beta', 'admin')
      expect(contextAgents()).toEqual(['agent-b'])
      seedContext()
      expect(await dbMod.deleteChannelBinding('agent-a', 'telegram', '1')).toBe(true)
      expect(contextAgents()).toEqual(['agent-b'])
    })

    it('an unchanged re-PUT and a delete of a missing binding leave the context alone', async () => {
      await dbMod.setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
      seedContext()
      await dbMod.setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
      expect(await dbMod.deleteChannelBinding('agent-a', 'telegram', '999')).toBe(false)
      expect(contextAgents()).toEqual(['agent-a', 'agent-b'])
    })
  })

  describe('getDelegationTenant: a delegation inherits the tenant of the sender\'s active request', () => {
    const setContext = (agent: string, tenant: string | null, status: string, updatedAt?: number) =>
      dbMod.getDb().prepare('INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status, updated_at) VALUES (?, ?, ?, ?)')
        .run(agent, tenant ?? '', status, updatedAt ?? Math.floor(Date.now() / 1000))
    const enable = (tenant: string, agent: string) =>
      dbMod.getDb().prepare('INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES (?, ?, 1)').run(tenant, agent)

    it('a bound, fresh context of an agent that serves the tenant is stamped onto the message', async () => {
      enable('acme', 'agent-a'); setContext('agent-a', 'acme', 'bound')
      expect(await dbMod.getDelegationTenant('agent-a')).toBe('acme')
      const msg = await dbMod.createAgentMessage('agent-a', 'agent-b', 'do it')
      expect(msg.tenant_id).toBe('acme')
      expect((await dbMod.getAgentMessage(msg.id))?.tenant_id).toBe('acme')
    })

    it('the tenant\'s main agent needs no availability row', async () => {
      dbMod.getDb().prepare("UPDATE tenants SET main_agent_id = 'main-x' WHERE id = 'acme'").run()
      setContext('main-x', 'acme', 'bound')
      expect(await dbMod.getDelegationTenant('main-x')).toBe('acme')
    })

    it.each([
      ['no context row', () => {}],
      ['status default', () => setContext('agent-a', 'default', 'default')],
      ['status unknown', () => setContext('agent-a', '', 'unknown')],
      ['status conflict', () => setContext('agent-a', '', 'conflict')],
      ['stale context', () => { enable('acme', 'agent-a'); setContext('agent-a', 'acme', 'bound', 1) }],
      ['agent not enabled for the tenant', () => setContext('agent-a', 'acme', 'bound')],
      ['agent disabled for the tenant', () => { enable('acme', 'agent-a'); dbMod.getDb().prepare('UPDATE tenant_agent_availability SET enabled = 0').run(); setContext('agent-a', 'acme', 'bound') }],
      ['tenant disabled', () => { enable('acme', 'agent-a'); setContext('agent-a', 'acme', 'bound'); dbMod.getDb().prepare("UPDATE tenants SET disabled_at = 5 WHERE id = 'acme'").run() }],
    ])('%s -> default (least-privileged stamp)', async (_name, arrange) => {
      arrange()
      expect(await dbMod.getDelegationTenant('agent-a')).toBe('default')
      expect((await dbMod.createAgentMessage('agent-a', 'agent-b', 'x')).tenant_id).toBe('default')
    })

    it('an explicit partner tenant and a federated recipient are left as given', async () => {
      enable('acme', 'agent-a'); setContext('agent-a', 'acme', 'bound')
      expect((await dbMod.createAgentMessage('agent-a', 'agent-b', 'x', null, null, 'beta')).tenant_id).toBe('beta')
      expect((await dbMod.createAgentMessage('agent-a', 'peer/agent-z', 'x')).tenant_id).toBe('default')
    })

    it('pinTenant keeps the given tenant even while the sender serves another one (the [Eredmény] notice)', async () => {
      enable('acme', 'agent-a'); setContext('agent-a', 'acme', 'bound')
      // inherited: a plain send from a bound agent picks up its current tenant ...
      expect((await dbMod.createAgentMessage('agent-a', 'agent-b', 'x')).tenant_id).toBe('acme')
      // ... a pinned 'default' (reply to a fleet message) does not, and a pinned partner tenant stays as given
      const pinnedDefault = await dbMod.createAgentMessage('agent-a', 'agent-b', 'x', null, null, 'default', null, true)
      expect(pinnedDefault.tenant_id).toBe('default')
      expect((await dbMod.getAgentMessage(pinnedDefault.id))?.tenant_id).toBe('default')
      expect((await dbMod.createAgentMessage('agent-a', 'agent-b', 'x', null, null, 'beta', null, true)).tenant_id).toBe('beta')
    })

    it('a DB error is the default stamp, not a crash', async () => {
      dbMod.getDb().exec('DROP TABLE agent_tenant_context')
      expect(await dbMod.getDelegationTenant('agent-a')).toBe('default')
    })
  })

  describe('disabling drops the affected agent contexts at once', () => {
    const ctx = () => dbMod.getDb().prepare('INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status) VALUES (?, ?, \'bound\')')
    const agents = () => (dbMod.getDb().prepare('SELECT agent_id FROM agent_tenant_context ORDER BY agent_id').all() as { agent_id: string }[]).map(r => r.agent_id)

    it('disabling the agent for a tenant drops that agent\'s context for that tenant only', async () => {
      ctx().run('agent-a', 'acme'); ctx().run('agent-b', 'acme'); ctx().run('agent-c', 'beta')
      await dbMod.setTenantAgentAvailability('acme', 'agent-a', true)
      expect(agents()).toEqual(['agent-a', 'agent-b', 'agent-c'])       // enabling changes nothing
      await dbMod.setTenantAgentAvailability('acme', 'agent-a', false)
      expect(agents()).toEqual(['agent-b', 'agent-c'])
      await dbMod.setTenantAgentAvailability('beta', 'agent-b', false)         // agent-b's context is acme's: untouched
      expect(agents()).toEqual(['agent-b', 'agent-c'])
    })

    it('disabling a tenant or changing its main agent drops every context of that tenant', async () => {
      ctx().run('agent-a', 'acme'); ctx().run('agent-b', 'acme'); ctx().run('agent-c', 'beta')
      await dbMod.updateTenant('acme', { display_name: 'Acme 2' })
      expect(agents()).toEqual(['agent-a', 'agent-b', 'agent-c'])       // unrelated edit
      await dbMod.updateTenant('acme', { main_agent_id: 'agent-a' })
      expect(agents()).toEqual(['agent-c'])
      ctx().run('agent-b', 'beta')
      await dbMod.updateTenant('beta', { disabled: true })
      expect(agents()).toEqual([])
    })
  })

  describe('explainServingTenantMiss: why a shared agent has no tenant right now', () => {
    const NOW = 1_800_000_000
    const setContext = (tenant: string, status: string, updatedAt = NOW) =>
      dbMod.getDb().prepare('INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status, updated_at) VALUES (?, ?, ?, ?)')
        .run('agent-a', tenant, status, updatedAt)
    const enable = (tenant: string) =>
      dbMod.getDb().prepare('INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES (?, ?, 1)').run(tenant, 'agent-a')

    it('names each reason, and agrees with getServingTenant about when there is an answer', async () => {
      const cases: Array<[string, () => void, string, string | null]> = [
        ['no row', () => {}, 'no_row', null],
        ['unknown source', () => setContext('', 'unknown'), 'unknown', null],
        ['conflicting sources', () => setContext('', 'conflict'), 'conflict', null],
        ['stale bound context', () => { enable('acme'); setContext('acme', 'bound', NOW - 43201) }, 'stale', null],
        ['stale default context', () => setContext('default', 'default', NOW - 43201), 'stale', null],
        ['bound tenant the agent no longer serves', () => setContext('acme', 'bound'), 'not_serving', null],
        ['fresh bound context', () => { enable('acme'); setContext('acme', 'bound') }, 'fresh', 'acme'],
        ['fresh default context', () => setContext('default', 'default'), 'fresh', 'default'],
      ]
      for (const [name, arrange, reason, serving] of cases) {
        dbMod.getDb().prepare('DELETE FROM agent_tenant_context').run()
        dbMod.getDb().prepare('DELETE FROM tenant_agent_availability').run()
        arrange()
        expect([name, await dbMod.explainServingTenantMiss('agent-a', NOW)]).toEqual([name, reason])
        expect([name, await dbMod.getServingTenant('agent-a', NOW)]).toEqual([name, serving])
      }
    })
  })
})
