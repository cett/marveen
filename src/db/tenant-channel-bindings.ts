// Read/write access to tenant_channel_bindings (migration 0064): which tenant an
// incoming source (Telegram chat, dashboard chat, inter-agent sender, ...) belongs to,
// per agent. The use-time skill isolation resolves the active tenant from here.
import { dbx } from './facade.js'

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
export async function getChannelBindingTenant(agentId: string, channel: string, externalId: string): Promise<string | null> {
  const row = await dbx.get<{ tenant_id: string }>('SELECT tenant_id FROM tenant_channel_bindings WHERE agent_id = ? AND channel = ? AND external_id = ?', agentId, channel.toLowerCase(), externalId)
  return row?.tenant_id ?? null
}

/** Tenant of an incoming source: its binding, else the default tenant. Never inferred from another source. */
export async function resolveSourceTenant(agentId: string, channel: string, externalId: string): Promise<string> {
  return await getChannelBindingTenant(agentId, channel, externalId) ?? UNBOUND_SOURCE_TENANT
}

/**
 * Drops the recorded active-tenant context of an agent (agent_tenant_context, written by the
 * UserPromptSubmit hook once per prompt). Called when a binding changes so the change takes effect
 * at once: with no context row the use-time gate fails closed until the agent's next prompt
 * re-resolves the source.
 */
export async function invalidateAgentTenantContext(agentId: string): Promise<void> {
  await dbx.run('DELETE FROM agent_tenant_context WHERE agent_id = ?', agentId)
}

export async function listChannelBindings(filter: { tenantId?: string; agentId?: string } = {}): Promise<TenantChannelBinding[]> {
  const where: string[] = []
  const params: string[] = []
  if (filter.tenantId) { where.push('tenant_id = ?'); params.push(filter.tenantId) }
  if (filter.agentId) { where.push('agent_id = ?'); params.push(filter.agentId) }
  const sql = `SELECT ${COLUMNS} FROM tenant_channel_bindings${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY agent_id, channel, external_id`
  return dbx.all<TenantChannelBinding>(sql, ...params)
}

/** Bind a source to a tenant; re-binding an existing source moves it to the new tenant. */
export async function setChannelBinding(agentId: string, channel: string, externalId: string, tenantId: string, createdBy: string): Promise<TenantChannelBinding> {
  const ch = channel.toLowerCase()
  // ONE transaction: the binding and the drop of the active-tenant context change together. As two statements, a
  // failure between them would leave the new binding with the old context, an agent serving the previous tenant.
  return await dbx.tx(async (tx) => {
    const previous = (await tx.get<{ tenant_id: string }>('SELECT tenant_id FROM tenant_channel_bindings WHERE agent_id = ? AND channel = ? AND external_id = ?', agentId, ch, externalId))?.tenant_id ?? null
    await tx.run(`
      INSERT INTO tenant_channel_bindings (agent_id, channel, external_id, tenant_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
      ON CONFLICT(agent_id, channel, external_id) DO UPDATE SET
        tenant_id  = excluded.tenant_id,
        updated_at = excluded.updated_at
    `, agentId, ch, externalId, tenantId, createdBy)
    if (previous !== tenantId) await tx.run('DELETE FROM agent_tenant_context WHERE agent_id = ?', agentId)
    return (await tx.get(`SELECT ${COLUMNS} FROM tenant_channel_bindings WHERE agent_id = ? AND channel = ? AND external_id = ?`, agentId, ch, externalId)) as TenantChannelBinding
  })
}

/** True iff a binding existed and was removed (the source then falls back to the default tenant). */
export async function deleteChannelBinding(agentId: string, channel: string, externalId: string): Promise<boolean> {
  // ONE transaction, for the same reason as setChannelBinding.
  return await dbx.tx(async (tx) => {
    const removed = (await tx.run('DELETE FROM tenant_channel_bindings WHERE agent_id = ? AND channel = ? AND external_id = ?', agentId, channel.toLowerCase(), externalId)).changes > 0
    if (removed) await tx.run('DELETE FROM agent_tenant_context WHERE agent_id = ?', agentId)
    return removed
  })
}

/**
 * True iff the agent currently serves the tenant: the tenant is not disabled and the agent is its
 * main agent or is enabled for it in tenant_agent_availability. Same rule as _serves() in
 * scripts/hooks/tenant_context_lib.py (keep the two in step).
 */
export async function agentServesTenant(agentId: string, tenantId: string): Promise<boolean> {
  return await dbx.get(`
      SELECT 1 FROM tenants t
      WHERE t.id = ? AND t.disabled_at IS NULL
        AND (t.main_agent_id = ? OR EXISTS (
          SELECT 1 FROM tenant_agent_availability a WHERE a.tenant_id = t.id AND a.agent_id = ? AND a.enabled = 1))
    `, tenantId, agentId, agentId) !== undefined
}

const DEFAULT_CONTEXT_MAX_AGE_SECONDS = 43200

/**
 * The tenant of the request an agent is serving right now, when that is unambiguous: a
 * fresh `bound` context whose tenant the agent still serves, or a fresh `default` context
 * (a source that carries no tenant, i.e. the local operator). Anything else (no row, unknown,
 * conflict, stale, the agent no longer serving the tenant, a DB error) is null: the caller
 * must not guess. Unlike getDelegationTenant this does not fold those cases into 'default'.
 */
export async function getServingTenant(agentId: string, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<string | null> {
  try {
    const row = await dbx.get<{ tenant_id: string | null; status: string; updated_at: number }>('SELECT tenant_id, status, updated_at FROM agent_tenant_context WHERE agent_id = ?', agentId)
    if (!row || (row.status !== 'bound' && row.status !== 'default') || !row.tenant_id) return null
    const parsed = Number.parseInt(process.env['TENANT_CONTEXT_MAX_AGE_SECONDS'] ?? '', 10)
    const maxAge = Number.isFinite(parsed) ? parsed : DEFAULT_CONTEXT_MAX_AGE_SECONDS
    if (maxAge > 0 && nowSeconds - (row.updated_at ?? 0) > maxAge) return null
    if (row.status === 'default') return row.tenant_id
    return await agentServesTenant(agentId, row.tenant_id) ? row.tenant_id : null
  } catch {
    return null
  }
}

/**
 * Why getServingTenant has no answer for this agent, as a short counter label (the token-shadow
 * target): no_row (no context was ever written), unknown / conflict (the source of the last prompt
 * could not be proven), stale (older than the max age), not_serving (the agent no longer serves the
 * tenant of its bound context), error. 'fresh' when the context does answer.
 */
export async function explainServingTenantMiss(agentId: string, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<string> {
  try {
    const row = await dbx.get<{ tenant_id: string | null; status: string; updated_at: number }>('SELECT tenant_id, status, updated_at FROM agent_tenant_context WHERE agent_id = ?', agentId)
    if (!row) return 'no_row'
    if ((row.status !== 'bound' && row.status !== 'default') || !row.tenant_id) return row.status === 'conflict' ? 'conflict' : 'unknown'
    const parsed = Number.parseInt(process.env['TENANT_CONTEXT_MAX_AGE_SECONDS'] ?? '', 10)
    const maxAge = Number.isFinite(parsed) ? parsed : DEFAULT_CONTEXT_MAX_AGE_SECONDS
    if (maxAge > 0 && nowSeconds - (row.updated_at ?? 0) > maxAge) return 'stale'
    if (row.status === 'default') return 'fresh'
    return await agentServesTenant(agentId, row.tenant_id) ? 'fresh' : 'not_serving'
  } catch {
    return 'error'
  }
}

/**
 * Tenant a message sent BY this agent is stamped with: the tenant of the request the agent is serving
 * (agent_tenant_context, status 'bound') so a delegation inherits it. Anything else (no context, default,
 * unknown, conflict, stale, the agent no longer serving the tenant, a DB error) is 'default', the
 * least-privileged stamp: a receiver never gains tenant skills from it.
 * Staleness uses the same TENANT_CONTEXT_MAX_AGE_SECONDS as the use-time gate.
 */
export async function getDelegationTenant(agentId: string, nowSeconds: number = Math.floor(Date.now() / 1000)): Promise<string> {
  try {
    const row = await dbx.get<{ tenant_id: string | null; status: string; updated_at: number }>('SELECT tenant_id, status, updated_at FROM agent_tenant_context WHERE agent_id = ?', agentId)
    if (!row || row.status !== 'bound' || !row.tenant_id || row.tenant_id === UNBOUND_SOURCE_TENANT) return UNBOUND_SOURCE_TENANT
    const parsed = Number.parseInt(process.env['TENANT_CONTEXT_MAX_AGE_SECONDS'] ?? '', 10)
    const maxAge = Number.isFinite(parsed) ? parsed : DEFAULT_CONTEXT_MAX_AGE_SECONDS
    if (maxAge > 0 && nowSeconds - (row.updated_at ?? 0) > maxAge) return UNBOUND_SOURCE_TENANT
    return await agentServesTenant(agentId, row.tenant_id) ? row.tenant_id : UNBOUND_SOURCE_TENANT
  } catch {
    return UNBOUND_SOURCE_TENANT
  }
}
