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
  dbMod.createTenant('acme', 'Acme')
  dbMod.createTenant('beta', 'Beta')
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(storeDir, { recursive: true, force: true })
})

describe('tenant channel bindings', () => {
  it('a source without a binding is not bound and resolves to the default tenant', () => {
    expect(dbMod.getChannelBindingTenant('agent-a', 'telegram', '111')).toBeNull()
    expect(dbMod.resolveSourceTenant('agent-a', 'telegram', '111')).toBe('default')
  })

  it('a bound source resolves to its tenant, per agent and per channel', () => {
    dbMod.setChannelBinding('agent-a', 'telegram', '111', 'acme', 'admin')
    expect(dbMod.resolveSourceTenant('agent-a', 'telegram', '111')).toBe('acme')
    expect(dbMod.resolveSourceTenant('agent-b', 'telegram', '111')).toBe('default')   // other agent
    expect(dbMod.resolveSourceTenant('agent-a', 'slack', '111')).toBe('default')      // other channel
    expect(dbMod.resolveSourceTenant('agent-a', 'telegram', '112')).toBe('default')   // other source
  })

  it('the channel is case-insensitive', () => {
    dbMod.setChannelBinding('agent-a', 'Telegram', '111', 'acme', 'admin')
    expect(dbMod.getChannelBindingTenant('agent-a', 'TELEGRAM', '111')).toBe('acme')
    expect(dbMod.listChannelBindings()[0].channel).toBe('telegram')
  })

  it('a source belongs to exactly one tenant: re-binding moves it', () => {
    dbMod.setChannelBinding('agent-a', 'telegram', '111', 'acme', 'admin')
    const moved = dbMod.setChannelBinding('agent-a', 'telegram', '111', 'beta', 'admin')
    expect(moved.tenant_id).toBe('beta')
    expect(dbMod.listChannelBindings()).toHaveLength(1)
    expect(dbMod.resolveSourceTenant('agent-a', 'telegram', '111')).toBe('beta')
  })

  it('deleting a binding sends the source back to the default tenant', () => {
    dbMod.setChannelBinding('agent-a', 'telegram', '111', 'acme', 'admin')
    expect(dbMod.deleteChannelBinding('agent-a', 'telegram', '111')).toBe(true)
    expect(dbMod.deleteChannelBinding('agent-a', 'telegram', '111')).toBe(false)
    expect(dbMod.resolveSourceTenant('agent-a', 'telegram', '111')).toBe('default')
  })

  it('lists filtered by tenant and by agent', () => {
    dbMod.setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
    dbMod.setChannelBinding('agent-a', 'telegram', '2', 'beta', 'admin')
    dbMod.setChannelBinding('agent-b', 'dashboard', 'u1', 'acme', 'admin')
    expect(dbMod.listChannelBindings()).toHaveLength(3)
    expect(dbMod.listChannelBindings({ tenantId: 'acme' }).map(b => b.external_id).sort()).toEqual(['1', 'u1'])
    expect(dbMod.listChannelBindings({ agentId: 'agent-a' })).toHaveLength(2)
    expect(dbMod.listChannelBindings({ tenantId: 'acme', agentId: 'agent-b' })).toHaveLength(1)
  })

  it('deleting a tenant removes its bindings and leaves the other tenants\' bindings alone (FK cascade off: the purge itself does it)', () => {
    dbMod.getDb().pragma('foreign_keys = OFF')   // the FK cascade would mask a missing explicit purge
    dbMod.setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
    dbMod.setChannelBinding('agent-a', 'telegram', '2', 'beta', 'admin')
    const ctx = dbMod.getDb().prepare("INSERT INTO agent_tenant_context (agent_id, tenant_id, status) VALUES (?, ?, 'bound')")
    ctx.run('agent-a', 'acme'); ctx.run('agent-b', 'beta')
    dbMod.deleteTenant('acme')
    expect(dbMod.getChannelBindingTenant('agent-a', 'telegram', '1')).toBeNull()
    expect(dbMod.getChannelBindingTenant('agent-a', 'telegram', '2')).toBe('beta')
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

    it('re-binding to another tenant and deleting a binding drop that agent\'s context only', () => {
      dbMod.setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
      seedContext()
      dbMod.setChannelBinding('agent-a', 'telegram', '1', 'beta', 'admin')
      expect(contextAgents()).toEqual(['agent-b'])
      seedContext()
      expect(dbMod.deleteChannelBinding('agent-a', 'telegram', '1')).toBe(true)
      expect(contextAgents()).toEqual(['agent-b'])
    })

    it('an unchanged re-PUT and a delete of a missing binding leave the context alone', () => {
      dbMod.setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
      seedContext()
      dbMod.setChannelBinding('agent-a', 'telegram', '1', 'acme', 'admin')
      expect(dbMod.deleteChannelBinding('agent-a', 'telegram', '999')).toBe(false)
      expect(contextAgents()).toEqual(['agent-a', 'agent-b'])
    })
  })

  describe('getDelegationTenant: a delegation inherits the tenant of the sender\'s active request', () => {
    const setContext = (agent: string, tenant: string | null, status: string, updatedAt?: number) =>
      dbMod.getDb().prepare('INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status, updated_at) VALUES (?, ?, ?, ?)')
        .run(agent, tenant ?? '', status, updatedAt ?? Math.floor(Date.now() / 1000))
    const enable = (tenant: string, agent: string) =>
      dbMod.getDb().prepare('INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES (?, ?, 1)').run(tenant, agent)

    it('a bound, fresh context of an agent that serves the tenant is stamped onto the message', () => {
      enable('acme', 'agent-a'); setContext('agent-a', 'acme', 'bound')
      expect(dbMod.getDelegationTenant('agent-a')).toBe('acme')
      const msg = dbMod.createAgentMessage('agent-a', 'agent-b', 'do it')
      expect(msg.tenant_id).toBe('acme')
      expect(dbMod.getAgentMessage(msg.id)?.tenant_id).toBe('acme')
    })

    it('the tenant\'s main agent needs no availability row', () => {
      dbMod.getDb().prepare("UPDATE tenants SET main_agent_id = 'main-x' WHERE id = 'acme'").run()
      setContext('main-x', 'acme', 'bound')
      expect(dbMod.getDelegationTenant('main-x')).toBe('acme')
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
    ])('%s -> default (least-privileged stamp)', (_name, arrange) => {
      arrange()
      expect(dbMod.getDelegationTenant('agent-a')).toBe('default')
      expect(dbMod.createAgentMessage('agent-a', 'agent-b', 'x').tenant_id).toBe('default')
    })

    it('an explicit partner tenant and a federated recipient are left as given', () => {
      enable('acme', 'agent-a'); setContext('agent-a', 'acme', 'bound')
      expect(dbMod.createAgentMessage('agent-a', 'agent-b', 'x', null, null, 'beta').tenant_id).toBe('beta')
      expect(dbMod.createAgentMessage('agent-a', 'peer/agent-z', 'x').tenant_id).toBe('default')
    })

    it('a DB error is the default stamp, not a crash', () => {
      dbMod.getDb().exec('DROP TABLE agent_tenant_context')
      expect(dbMod.getDelegationTenant('agent-a')).toBe('default')
    })
  })

  describe('disabling drops the affected agent contexts at once', () => {
    const ctx = () => dbMod.getDb().prepare('INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status) VALUES (?, ?, \'bound\')')
    const agents = () => (dbMod.getDb().prepare('SELECT agent_id FROM agent_tenant_context ORDER BY agent_id').all() as { agent_id: string }[]).map(r => r.agent_id)

    it('disabling the agent for a tenant drops that agent\'s context for that tenant only', () => {
      ctx().run('agent-a', 'acme'); ctx().run('agent-b', 'acme'); ctx().run('agent-c', 'beta')
      dbMod.setTenantAgentAvailability('acme', 'agent-a', true)
      expect(agents()).toEqual(['agent-a', 'agent-b', 'agent-c'])       // enabling changes nothing
      dbMod.setTenantAgentAvailability('acme', 'agent-a', false)
      expect(agents()).toEqual(['agent-b', 'agent-c'])
      dbMod.setTenantAgentAvailability('beta', 'agent-b', false)         // agent-b's context is acme's: untouched
      expect(agents()).toEqual(['agent-b', 'agent-c'])
    })

    it('disabling a tenant or changing its main agent drops every context of that tenant', () => {
      ctx().run('agent-a', 'acme'); ctx().run('agent-b', 'acme'); ctx().run('agent-c', 'beta')
      dbMod.updateTenant('acme', { display_name: 'Acme 2' })
      expect(agents()).toEqual(['agent-a', 'agent-b', 'agent-c'])       // unrelated edit
      dbMod.updateTenant('acme', { main_agent_id: 'agent-a' })
      expect(agents()).toEqual(['agent-c'])
      ctx().run('agent-b', 'beta')
      dbMod.updateTenant('beta', { disabled: true })
      expect(agents()).toEqual([])
    })
  })
})
