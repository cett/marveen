// Read/write access to tenant_channel_bindings (migration 0064): which tenant an
// incoming source (Telegram chat, dashboard chat, inter-agent sender, ...) belongs to,
// per agent. The use-time skill isolation resolves the active tenant from here.
import { db } from './connection.js'

export interface TenantChannelBinding {
  agent_id: string
  channel: string
  external_id: string
  tenant_id: string
  created_by: string
  created_at: number
  updated_at: number
}

const COLUMNS = 'agent_id, channel, external_id, tenant_id, created_by, created_at, updated_at'

/** Tenant a source without any binding row belongs to (fleet-internal use). */
export const UNBOUND_SOURCE_TENANT = 'default'

/** The bound tenant of a source, or null when the source has no binding. */
export function getChannelBindingTenant(agentId: string, channel: string, externalId: string): string | null {
  const row = db
    .prepare('SELECT tenant_id FROM tenant_channel_bindings WHERE agent_id = ? AND channel = ? AND external_id = ?')
    .get(agentId, channel.toLowerCase(), externalId) as { tenant_id: string } | undefined
  return row?.tenant_id ?? null
}

/** Tenant of an incoming source: its binding, else the default tenant. Never inferred from another source. */
export function resolveSourceTenant(agentId: string, channel: string, externalId: string): string {
  return getChannelBindingTenant(agentId, channel, externalId) ?? UNBOUND_SOURCE_TENANT
}

/**
 * Drops the recorded active-tenant context of an agent (agent_tenant_context, written by the
 * UserPromptSubmit hook once per prompt). Called when a binding changes so the change takes effect
 * at once: with no context row the use-time gate fails closed until the agent's next prompt
 * re-resolves the source.
 */
export function invalidateAgentTenantContext(agentId: string): void {
  db.prepare('DELETE FROM agent_tenant_context WHERE agent_id = ?').run(agentId)
}

export function listChannelBindings(filter: { tenantId?: string; agentId?: string } = {}): TenantChannelBinding[] {
  const where: string[] = []
  const params: string[] = []
  if (filter.tenantId) { where.push('tenant_id = ?'); params.push(filter.tenantId) }
  if (filter.agentId) { where.push('agent_id = ?'); params.push(filter.agentId) }
  const sql = `SELECT ${COLUMNS} FROM tenant_channel_bindings${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY agent_id, channel, external_id`
  return db.prepare(sql).all(...params) as TenantChannelBinding[]
}

/** Bind a source to a tenant; re-binding an existing source moves it to the new tenant. */
export function setChannelBinding(agentId: string, channel: string, externalId: string, tenantId: string, createdBy: string): TenantChannelBinding {
  const ch = channel.toLowerCase()
  const previous = getChannelBindingTenant(agentId, ch, externalId)
  db.prepare(`
    INSERT INTO tenant_channel_bindings (agent_id, channel, external_id, tenant_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(agent_id, channel, external_id) DO UPDATE SET
      tenant_id  = excluded.tenant_id,
      updated_at = excluded.updated_at
  `).run(agentId, ch, externalId, tenantId, createdBy)
  if (previous !== tenantId) invalidateAgentTenantContext(agentId)
  return db
    .prepare(`SELECT ${COLUMNS} FROM tenant_channel_bindings WHERE agent_id = ? AND channel = ? AND external_id = ?`)
    .get(agentId, ch, externalId) as TenantChannelBinding
}

/** True iff a binding existed and was removed (the source then falls back to the default tenant). */
export function deleteChannelBinding(agentId: string, channel: string, externalId: string): boolean {
  const removed = db
    .prepare('DELETE FROM tenant_channel_bindings WHERE agent_id = ? AND channel = ? AND external_id = ?')
    .run(agentId, channel.toLowerCase(), externalId).changes > 0
  if (removed) invalidateAgentTenantContext(agentId)
  return removed
}
