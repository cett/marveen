// Verifies migration 0032: re-resolving fleet_blackboard/history tenant_id
// against the CURRENT tenant_agent_availability state, for rows that were
// stamped BEFORE a later availability change and never re-written since.
//
// Regression scenario (found during live verification of the tenant-isolation
// migration): an existing
// fleet agent (0 tenant_agent_availability rows, implicit tenant_id=default)
// gets granted to a real tenant. upsertBlackboard's own on-write re-resolve
// correctly derives '_multi_' for any FUTURE write, but that agent's PRIOR,
// un-touched blackboard row keeps showing the single-tenant value from
// before the grant -- exposing default-tenant data under the granted
// tenant's view until the agent writes again. 0032 is the one-time catch-up.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { initDatabase, getDb, createTenant, setTenantAgentAvailability, upsertBlackboard } from '../db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION_PATH = join(__dirname, '../../src/migrations/0032_blackboard_tenant_id_reresolve.sql')

function reapplyMigration(db: Database.Database): void {
  db.exec(readFileSync(MIGRATION_PATH, 'utf-8'))
}

beforeEach(() => {
  initDatabase(':memory:')
  createTenant('tenant-a', 'Tenant A')
  createTenant('tenant-b', 'Tenant B')
})

describe('Migration 0032 -- re-resolves stale rows against current availability', () => {
  it('a fleet agent later also granted to a tenant: stale single-tenant row becomes "_multi_"', () => {
    // Agent starts as a pure fleet agent (0 rows) and writes -- tenant_id="default".
    upsertBlackboard('agent-a', { status: 'active', summary: 'fleet work' })
    // Now granted to tenant-a WITHOUT an explicit "default" row yet (the bug's
    // starting state) -- the row is still stale at this point.
    setTenantAgentAvailability('tenant-a', 'agent-a', true)

    const db = getDb()
    const before = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-a') as { tenant_id: string }
    expect(before.tenant_id).toBe('default') // stale -- not re-derived yet

    // The gap is closed by also granting the agent's original "default"
    // membership explicitly (the immediate operational fix)...
    setTenantAgentAvailability('default', 'agent-a', true)
    // ...but the existing row STILL hasn't been re-written, so it is still stale.
    const stillStale = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-a') as { tenant_id: string }
    expect(stillStale.tenant_id).toBe('default')

    reapplyMigration(db)

    const after = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-a') as { tenant_id: string }
    expect(after.tenant_id).toBe('_multi_')
  })

  it('a single-tenant agent stays correctly single-tenant after re-resolve (no false positive)', () => {
    setTenantAgentAvailability('tenant-a', 'agent-b', true)
    upsertBlackboard('agent-b', { status: 'active', summary: 'tenant work' })

    const db = getDb()
    reapplyMigration(db)

    const row = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-b') as { tenant_id: string }
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('a revoked (fully disabled) agent reverts to "default" on re-resolve', () => {
    setTenantAgentAvailability('tenant-a', 'agent-c', true)
    upsertBlackboard('agent-c', { status: 'active', summary: 'tenant work' })
    setTenantAgentAvailability('tenant-a', 'agent-c', false) // revoked

    const db = getDb()
    const stale = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-c') as { tenant_id: string }
    expect(stale.tenant_id).toBe('tenant-a') // stale -- upsertBlackboard was never called again

    reapplyMigration(db)

    const after = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-c') as { tenant_id: string }
    expect(after.tenant_id).toBe('default')
  })

  it('re-resolves fleet_blackboard_history rows the same way', () => {
    upsertBlackboard('agent-a', { status: 'active', summary: 'v1' })
    setTenantAgentAvailability('tenant-a', 'agent-a', true)
    setTenantAgentAvailability('default', 'agent-a', true)

    const db = getDb()
    reapplyMigration(db)

    const rows = db.prepare('SELECT tenant_id FROM fleet_blackboard_history WHERE agent_id = ?').all('agent-a') as { tenant_id: string }[]
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.tenant_id).toBe('_multi_')
  })

  it('is idempotent -- running it twice in a row does not change the result', () => {
    upsertBlackboard('agent-a', { status: 'active', summary: 'v1' })
    setTenantAgentAvailability('tenant-a', 'agent-a', true)
    setTenantAgentAvailability('default', 'agent-a', true)

    const db = getDb()
    reapplyMigration(db)
    reapplyMigration(db)

    const row = db.prepare('SELECT tenant_id FROM fleet_blackboard WHERE agent_id = ?').get('agent-a') as { tenant_id: string }
    expect(row.tenant_id).toBe('_multi_')
  })
})
