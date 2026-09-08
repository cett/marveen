// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { db } from './connection.js'

export interface VaultSshKey {
  id: string
  label: string
  username: string
  vault_key_id: string
  public_key: string
  fingerprint: string
  key_type: string
  created_at: number
  tenant_id: string
}

/** tenantId null -- admin global view (no filter, every tenant's keys). */
export function listVaultSshKeys(tenantId: string | null = null): VaultSshKey[] {
  if (tenantId === null) return db.prepare('SELECT * FROM vault_ssh_keys ORDER BY label ASC').all() as VaultSshKey[]
  return db.prepare('SELECT * FROM vault_ssh_keys WHERE tenant_id = ? ORDER BY label ASC').all(tenantId) as VaultSshKey[]
}

export function getVaultSshKey(id: string): VaultSshKey | undefined {
  return db.prepare('SELECT * FROM vault_ssh_keys WHERE id = ?').get(id) as VaultSshKey | undefined
}

export function createVaultSshKey(key: Pick<VaultSshKey, 'id' | 'label' | 'username' | 'vault_key_id' | 'public_key' | 'fingerprint' | 'key_type' | 'tenant_id'>): VaultSshKey {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO vault_ssh_keys (id, label, username, vault_key_id, public_key, fingerprint, key_type, created_at, tenant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(key.id, key.label, key.username, key.vault_key_id, key.public_key, key.fingerprint, key.key_type, now, key.tenant_id)
  return { ...key, created_at: now }
}

// Unassign the key from all servers, then delete it. Returns the count of
// servers that were unassigned so callers can surface that in the response.
export function deleteVaultSshKey(id: string): { deleted: boolean; unassigned: number } {
  return db.transaction(() => {
    const unassigned = db.prepare(
      'UPDATE vault_ssh_servers SET ssh_key_id = NULL, updated_at = ? WHERE ssh_key_id = ?'
    ).run(Math.floor(Date.now() / 1000), id).changes
    const deleted = db.prepare('DELETE FROM vault_ssh_keys WHERE id = ?').run(id).changes > 0
    return { deleted, unassigned }
  })()
}

// Stores server metadata. The ssh_key_id FK points to vault_ssh_keys (nullable;
// null = no key assigned = keyStatus "missing"). Legacy per-server key columns
// (vault_key_id, key_type, fingerprint, key_expires_at) have been removed via
// DROP COLUMN migration above.

export interface VaultSshServer {
  id: string
  name: string
  host: string
  port: number
  username: string
  ssh_key_id: string | null
  description: string | null
  tenant_id: string
  created_at: number
  updated_at: number
}

export type SshKeyStatus = 'ok' | 'missing'

export function computeSshKeyStatus(server: VaultSshServer): SshKeyStatus {
  return server.ssh_key_id ? 'ok' : 'missing'
}

export function listVaultSshServers(tenantId?: string | null): VaultSshServer[] {
  const tc = tenantId ? ' WHERE tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  return db.prepare(`SELECT * FROM vault_ssh_servers${tc} ORDER BY name ASC`).all(...tp) as VaultSshServer[]
}

export function getVaultSshServer(id: string): VaultSshServer | undefined {
  return db.prepare('SELECT * FROM vault_ssh_servers WHERE id = ?').get(id) as VaultSshServer | undefined
}

export function createVaultSshServer(server: Pick<VaultSshServer, 'id' | 'name' | 'host' | 'port' | 'username' | 'description' | 'tenant_id'>): VaultSshServer {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    `INSERT INTO vault_ssh_servers (id, name, host, port, username, description, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(server.id, server.name, server.host, server.port, server.username, server.description ?? null, server.tenant_id, now, now)
  return { ...server, ssh_key_id: null, created_at: now, updated_at: now }
}

export function updateVaultSshServer(id: string, patch: Partial<Pick<VaultSshServer, 'name' | 'host' | 'port' | 'username' | 'ssh_key_id' | 'description'>>): boolean {
  const now = Math.floor(Date.now() / 1000)
  const sets: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.name !== undefined)        { sets.push('name = ?');        params.push(patch.name) }
  if (patch.host !== undefined)        { sets.push('host = ?');        params.push(patch.host) }
  if (patch.port !== undefined)        { sets.push('port = ?');        params.push(patch.port) }
  if (patch.username !== undefined)    { sets.push('username = ?');    params.push(patch.username) }
  if (patch.ssh_key_id !== undefined)  { sets.push('ssh_key_id = ?'); params.push(patch.ssh_key_id) }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description) }
  params.push(id)
  return db.prepare(`UPDATE vault_ssh_servers SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
}

export function deleteVaultSshServer(id: string): boolean {
  return db.prepare('DELETE FROM vault_ssh_servers WHERE id = ?').run(id).changes > 0
}

export interface Approval {
  id: string
  agent_id: string
  category: string
  action_description: string
  action_payload: string | null
  status: 'pending' | 'approved' | 'rejected' | 'timeout'
  timeout_at: number | null
  telegram_message_id: number | null
  requested_at: number
  resolved_at: number | null
  resolved_by: string | null
  tenant_id: string | null
}

export function createApproval(params: {
  id: string
  agent_id: string
  category: string
  action_description: string
  action_payload?: string | null
  timeout_at?: number | null
  tenant_id?: string | null
}): Approval {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO approvals (id, agent_id, category, action_description, action_payload, timeout_at, requested_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.agent_id,
    params.category,
    params.action_description,
    params.action_payload ?? null,
    params.timeout_at ?? null,
    now,
    params.tenant_id ?? null,
  )
  return {
    id: params.id,
    agent_id: params.agent_id,
    category: params.category,
    action_description: params.action_description,
    action_payload: params.action_payload ?? null,
    status: 'pending',
    timeout_at: params.timeout_at ?? null,
    telegram_message_id: null,
    requested_at: now,
    resolved_at: null,
    resolved_by: null,
    tenant_id: params.tenant_id ?? null,
  }
}

export function getApproval(id: string): Approval | undefined {
  return db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Approval | undefined
}

export function resolveApproval(id: string, status: 'approved' | 'rejected' | 'timeout', resolvedBy: string, telegramMessageId?: number | null): boolean {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(`
    UPDATE approvals
    SET status = ?, resolved_at = ?, resolved_by = ?,
        telegram_message_id = COALESCE(?, telegram_message_id)
    WHERE id = ? AND status = 'pending'
  `).run(status, now, resolvedBy, telegramMessageId ?? null, id).changes > 0
}

export function listApprovals(opts: {
  agent_id?: string
  category?: string
  status?: string
  limit?: number
  tenantId?: string
}): Approval[] {
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.agent_id) { conditions.push('agent_id = ?'); params.push(opts.agent_id) }
  if (opts.category) { conditions.push('category = ?'); params.push(opts.category) }
  if (opts.status) { conditions.push('status = ?'); params.push(opts.status) }
  // SQL-level tenant filter must come before LIMIT (per 626/704 pagination lesson).
  if (opts.tenantId !== undefined) { conditions.push('tenant_id = ?'); params.push(opts.tenantId) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.min(opts.limit ?? 100, 500)
  params.push(limit)
  return db.prepare(`SELECT * FROM approvals ${where} ORDER BY requested_at DESC LIMIT ?`).all(...params) as Approval[]
}

// Stamp trace context onto an agent_messages row that was created without one.
// Called by the message-router tick BEFORE delivery so the span is stamped
// exactly once (pending rows only -- delivered/done rows are already closed).
export function stampMessageTrace(
  id: number,
  traceId: string,
  spanId: string,
  parentSpanId: string | null,
): boolean {
  return db.prepare(`
    UPDATE agent_messages
       SET trace_id = ?, span_id = ?, parent_span_id = ?
     WHERE id = ? AND status = 'pending' AND trace_id IS NULL
  `).run(traceId, spanId, parentSpanId, id).changes > 0
}

export function expireTimedOutApprovals(): number {
  const now = Math.floor(Date.now() / 1000)
  return db.prepare(`
    UPDATE approvals SET status = 'timeout', resolved_at = ?
    WHERE status = 'pending' AND timeout_at IS NOT NULL AND timeout_at <= ?
  `).run(now, now).changes
}
