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
})
