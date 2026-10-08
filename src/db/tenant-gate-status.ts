// Read-only facts for the tenant skill gate rollout report (scripts/tenant-gate-rollout-check.py),
// served by GET /api/admin/tenant-gate-status. Plain SELECTs only: nothing here writes.

import { db } from './connection.js'

/** Migrations the gate needs, and the table each one creates. */
export const TENANT_GATE_MIGRATIONS: ReadonlyArray<{ version: number; table: string }> = [
  { version: 64, table: 'tenant_channel_bindings' },
  { version: 65, table: 'agent_tenant_context' },
]

export interface TenantGateMigration {
  version: number
  table: string
  applied: boolean
  table_exists: boolean
}

export interface TenantGateContextRow {
  agent_id: string
  status: string
  tenant_id: string | null
  updated_at: number
}

export interface TenantGateMultiTenantAgent {
  agent_id: string
  tenant_count: number
  has_binding: boolean
}

export interface TenantGateStatus {
  now: number
  migrations: TenantGateMigration[]
  contexts: TenantGateContextRow[]
  multi_tenant_agents: TenantGateMultiTenantAgent[]
}

function tableExists(table: string): boolean {
  try {
    db.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all()
    return true
  } catch {
    return false
  }
}

export function getTenantGateStatus(): TenantGateStatus {
  let versions = new Set<number>()
  try {
    versions = new Set((db.prepare('SELECT version FROM schema_version').all() as { version: number }[]).map((r) => r.version))
  } catch {
    // no schema_version table: nothing counts as applied
  }
  const migrations = TENANT_GATE_MIGRATIONS.map((m) => ({
    version: m.version,
    table: m.table,
    applied: versions.has(m.version),
    table_exists: tableExists(m.table),
  }))

  const contexts = tableExists('agent_tenant_context')
    ? (db.prepare('SELECT agent_id, status, tenant_id, updated_at FROM agent_tenant_context ORDER BY agent_id').all() as TenantGateContextRow[])
    : []

  // Agents enabled for 2+ live tenants, and whether each has any channel binding.
  const perAgent = db
    .prepare(
      `SELECT a.agent_id AS agent_id, COUNT(DISTINCT a.tenant_id) AS tenant_count
       FROM tenant_agent_availability a JOIN tenants t ON t.id = a.tenant_id
       WHERE a.enabled = 1 AND t.disabled_at IS NULL
       GROUP BY a.agent_id HAVING COUNT(DISTINCT a.tenant_id) > 1
       ORDER BY a.agent_id`,
    )
    .all() as { agent_id: string; tenant_count: number }[]
  const bound = tableExists('tenant_channel_bindings')
    ? new Set((db.prepare('SELECT DISTINCT agent_id FROM tenant_channel_bindings').all() as { agent_id: string }[]).map((r) => r.agent_id))
    : new Set<string>()

  return {
    now: Math.floor(Date.now() / 1000),
    migrations,
    contexts,
    multi_tenant_agents: perAgent.map((r) => ({ agent_id: r.agent_id, tenant_count: r.tenant_count, has_binding: bound.has(r.agent_id) })),
  }
}
