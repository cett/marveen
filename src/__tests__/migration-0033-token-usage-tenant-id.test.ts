// Verifies migration 0033: backfilling token_usage.tenant_id from
// tenant_agent_availability (the deny-by-default opt-in matrix), the same
// architecture as 0031/0032 (fleet_blackboard tenant isolation, kanban #735)
// applied to the Overview "Token ma" card's data source.
//
//   0 enabled availability rows for the agent -> tenant_id = 'default'
//   1 enabled row                             -> tenant_id = that tenant
//   2+ enabled rows                           -> tenant_id = '_multi_'

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { initDatabase, getDb, createTenant, setTenantAgentAvailability } from '../db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION_PATH = join(__dirname, '../../src/migrations/0033_token_usage_tenant_id.sql')

function reapplyMigration(db: Database.Database): void {
  // The migration's own ALTER TABLE only runs once (0033 is already applied
  // by initDatabase's normal migration pass), so re-apply just the backfill
  // UPDATE statements -- skip the ALTER TABLE line to avoid "duplicate column".
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')
  const withoutAlter = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('ALTER TABLE'))
    .join('\n')
  db.exec(withoutAlter)
}

function insertTokenUsageRow(db: Database.Database, agent: string, sessionId: string, timestamp: number): void {
  db.prepare(
    `INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model)
     VALUES (?, ?, ?, 100, 50, 'claude-sonnet-5')`
  ).run(agent, sessionId, timestamp)
}

beforeEach(() => {
  initDatabase(':memory:')
  createTenant('tenant-a', 'Tenant A')
  createTenant('tenant-b', 'Tenant B')
})

describe('Migration 0033 -- backfills token_usage.tenant_id from tenant_agent_availability', () => {
  it('a fleet agent (0 enabled rows) defaults to "default"', () => {
    const db = getDb()
    insertTokenUsageRow(db, 'fleet-agent', 'sess-1', 1000)

    const row = db.prepare('SELECT tenant_id FROM token_usage WHERE agent = ?').get('fleet-agent') as { tenant_id: string }
    expect(row.tenant_id).toBe('default')
  })

  it('a single-tenant agent backfills to that tenant', () => {
    const db = getDb()
    setTenantAgentAvailability('tenant-a', 'agent-b', true)
    insertTokenUsageRow(db, 'agent-b', 'sess-1', 1000)
    // Row was inserted with the column DEFAULT ('default') -- simulate a
    // pre-existing row from before the agent was granted, needing backfill.
    reapplyMigration(db)

    const row = db.prepare('SELECT tenant_id FROM token_usage WHERE agent = ?').get('agent-b') as { tenant_id: string }
    expect(row.tenant_id).toBe('tenant-a')
  })

  it('a multi-tenant agent (2+ enabled rows) backfills to "_multi_"', () => {
    const db = getDb()
    setTenantAgentAvailability('tenant-a', 'agent-c', true)
    setTenantAgentAvailability('tenant-b', 'agent-c', true)
    insertTokenUsageRow(db, 'agent-c', 'sess-1', 1000)
    reapplyMigration(db)

    const row = db.prepare('SELECT tenant_id FROM token_usage WHERE agent = ?').get('agent-c') as { tenant_id: string }
    expect(row.tenant_id).toBe('_multi_')
  })

  it('a revoked (fully disabled) agent reverts to "default" on re-resolve', () => {
    const db = getDb()
    setTenantAgentAvailability('tenant-a', 'agent-d', true)
    insertTokenUsageRow(db, 'agent-d', 'sess-1', 1000)
    reapplyMigration(db)
    const midway = db.prepare('SELECT tenant_id FROM token_usage WHERE agent = ?').get('agent-d') as { tenant_id: string }
    expect(midway.tenant_id).toBe('tenant-a')

    setTenantAgentAvailability('tenant-a', 'agent-d', false)
    reapplyMigration(db)

    const after = db.prepare('SELECT tenant_id FROM token_usage WHERE agent = ?').get('agent-d') as { tenant_id: string }
    expect(after.tenant_id).toBe('default')
  })

  it('is idempotent -- running the backfill twice in a row does not change the result', () => {
    const db = getDb()
    setTenantAgentAvailability('tenant-a', 'agent-e', true)
    setTenantAgentAvailability('tenant-b', 'agent-e', true)
    insertTokenUsageRow(db, 'agent-e', 'sess-1', 1000)

    reapplyMigration(db)
    reapplyMigration(db)

    const row = db.prepare('SELECT tenant_id FROM token_usage WHERE agent = ?').get('agent-e') as { tenant_id: string }
    expect(row.tenant_id).toBe('_multi_')
  })
})
