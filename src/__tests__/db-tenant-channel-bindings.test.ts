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
    dbMod.deleteTenant('acme')
    expect(dbMod.getChannelBindingTenant('agent-a', 'telegram', '1')).toBeNull()
    expect(dbMod.getChannelBindingTenant('agent-a', 'telegram', '2')).toBe('beta')
  })
})
