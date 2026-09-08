// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { db, vecExtensionLoaded } from './connection.js'
import { Memory, MemoryVersion } from './memory.js'
import { DashboardUser, DashboardUserPublic } from './sessions.js'
import { syncVecMemoryDelete } from './vector.js'

export function recordMemoryRead(
  agentId: string,
  memoryId: number,
  context: 'heartbeat' | 'search' | 'direct',
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES (?, ?, ?, ?)'
  ).run(agentId, memoryId, now, context)
}

// Record reads for a batch of memory ids in a single transaction.
export function recordMemoryReadBatch(
  agentId: string,
  memoryIds: number[],
  context: 'heartbeat' | 'search' | 'direct',
): void {
  if (memoryIds.length === 0) return
  const now = Math.floor(Date.now() / 1000)
  const stmt = db.prepare(
    'INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES (?, ?, ?, ?)'
  )
  const tx = db.transaction(() => {
    for (const id of memoryIds) stmt.run(agentId, id, now, context)
  })
  tx()
}

// Returns memories that are stale for the given agent:
// updated_at > agent's last span_read.read_at (or never read at all).
export function getStaleMemories(agentId: string, tenantId?: string): Memory[] {
  const tc = tenantId ? '\n      AND m.tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  return db.prepare(`
    SELECT m.* FROM memories m
    LEFT JOIN (
      SELECT memory_id, MAX(read_at) AS last_read
      FROM span_reads
      WHERE agent_id = ?
      GROUP BY memory_id
    ) sr ON sr.memory_id = m.id
    WHERE (m.agent_id = ? OR m.category = 'shared')
      AND m.updated_at > COALESCE(sr.last_read, 0)${tc}
    ORDER BY m.updated_at DESC
  `).all(agentId, agentId, ...tp) as Memory[]
}

export function getMemoryVersions(memoryId: number): MemoryVersion[] {
  return db.prepare(
    'SELECT * FROM memory_versions WHERE memory_id = ? ORDER BY changed_at DESC, id DESC'
  ).all(memoryId) as MemoryVersion[]
}

// Auto tier-resorting based on span_reads activity. All three steps run in
// a single transaction so a crash leaves the DB in a consistent state.
//
// warm -> cold: memory is at least warmToColdDays old AND has not been read
//   in the last warmToColdDays (hot is manually managed; shared is never
//   auto-archived -- both implicitly excluded by category='warm').
//   The created_at guard prevents freshly saved memories from being archived
//   immediately on their first maintenance run just because they have no reads yet.
// cold -> warm: read by 2+ distinct agents within the last coldToWarmDays.
// version prune: delete memory_versions older than 180 days.
//
// Returns affected row counts for observability.
export function runMemoryMaintenance(opts: {
  warmToColdDays?: number
  coldToWarmDays?: number
  minAgents?: number
  versionTtlDays?: number
} = {}): { warmToCold: number; coldToWarm: number; prunedVersions: number } {
  const warmToColdSecs = (opts.warmToColdDays ?? 30) * 86400
  const coldToWarmSecs = (opts.coldToWarmDays ?? 30) * 86400
  const minAgents = opts.minAgents ?? 2
  const versionCutoff = Math.floor(Date.now() / 1000) - (opts.versionTtlDays ?? 180) * 86400
  const now = Math.floor(Date.now() / 1000)

  return db.transaction(() => {
    // Only warm -> cold: hot is manually managed; shared belongs to all agents.
    // created_at check: memory must be at least warmToColdSecs old before it
    // can be auto-archived (a brand-new unread memory is not the same as a stale one).

    // Log warm->cold transitions before UPDATE so memory_versions has an audit trail.
    // SELECT candidates first (same WHERE as the UPDATE below), then bulk-insert versions.
    type CandRow = { id: number; content: string; keywords: string | null }
    const warmToColdCandidates = db.prepare(`
      SELECT id, content, keywords FROM memories
      WHERE category = 'warm'
        AND created_at < ? - ?
        AND NOT EXISTS (
          SELECT 1 FROM span_reads
          WHERE span_reads.memory_id = memories.id
            AND span_reads.read_at > ? - ?
        )
    `).all(now, warmToColdSecs, now, warmToColdSecs) as CandRow[]

    if (warmToColdCandidates.length > 0) {
      const logV = db.prepare(
        'INSERT INTO memory_versions(memory_id, content, category, keywords, changed_at, changed_by, change_type) VALUES (?,?,?,?,?,?,?)'
      )
      for (const c of warmToColdCandidates) {
        logV.run(c.id, c.content, 'cold', c.keywords, now, 'system:maintenance', 'category_change')
      }
    }

    const warmToCold = db.prepare(`
      UPDATE memories
      SET category = 'cold', updated_at = ?
      WHERE category = 'warm'
        AND created_at < ? - ?
        AND NOT EXISTS (
          SELECT 1 FROM span_reads
          WHERE span_reads.memory_id = memories.id
            AND span_reads.read_at > ? - ?
        )
    `).run(now, now, warmToColdSecs, now, warmToColdSecs).changes

    // Log cold->warm transitions before UPDATE.
    const coldToWarmCandidates = db.prepare(`
      SELECT id, content, keywords FROM memories
      WHERE category = 'cold'
        AND id IN (
          SELECT memory_id FROM span_reads
          WHERE read_at > ? - ?
          GROUP BY memory_id
          HAVING COUNT(DISTINCT agent_id) >= ?
        )
    `).all(now, coldToWarmSecs, minAgents) as CandRow[]

    if (coldToWarmCandidates.length > 0) {
      const logV = db.prepare(
        'INSERT INTO memory_versions(memory_id, content, category, keywords, changed_at, changed_by, change_type) VALUES (?,?,?,?,?,?,?)'
      )
      for (const c of coldToWarmCandidates) {
        logV.run(c.id, c.content, 'warm', c.keywords, now, 'system:maintenance', 'category_change')
      }
    }

    const coldToWarm = db.prepare(`
      UPDATE memories
      SET category = 'warm', updated_at = ?
      WHERE category = 'cold'
        AND id IN (
          SELECT memory_id FROM span_reads
          WHERE read_at > ? - ?
          GROUP BY memory_id
          HAVING COUNT(DISTINCT agent_id) >= ?
        )
    `).run(now, now, coldToWarmSecs, minAgents).changes

    const prunedVersions = db.prepare(
      'DELETE FROM memory_versions WHERE changed_at < ?'
    ).run(versionCutoff).changes

    return { warmToCold, coldToWarm, prunedVersions }
  })()
}

// Delete memory_versions entries older than ttlDays (default 180).
export function pruneMemoryVersions(ttlDays = 180): number {
  const cutoff = Math.floor(Date.now() / 1000) - ttlDays * 86400
  return db.prepare(
    'DELETE FROM memory_versions WHERE changed_at < ?'
  ).run(cutoff).changes
}

export interface OtelSpan {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  agent_id: string
  operation: string
  start_ms: number
  end_ms: number | null
  status: 'ok' | 'error' | 'timeout' | 'running'
  attributes: string | null
}

export function upsertOtelSpan(span: Omit<OtelSpan, 'end_ms' | 'status'> & { end_ms?: number | null; status?: OtelSpan['status'] }): void {
  db.prepare(`
    INSERT INTO otel_spans (trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status, attributes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (trace_id, span_id) DO UPDATE SET
      end_ms = excluded.end_ms,
      status = excluded.status,
      attributes = COALESCE(excluded.attributes, otel_spans.attributes)
  `).run(
    span.trace_id, span.span_id, span.parent_span_id ?? null,
    span.agent_id, span.operation, span.start_ms,
    span.end_ms ?? null, span.status ?? 'running', span.attributes ?? null,
  )
}

export function closeOtelSpan(traceId: string, spanId: string, endMs: number, status: OtelSpan['status']): boolean {
  return db.prepare(`
    UPDATE otel_spans SET end_ms = ?, status = ? WHERE trace_id = ? AND span_id = ?
  `).run(endMs, status, traceId, spanId).changes > 0
}

export function getOtelTrace(traceId: string): OtelSpan[] {
  return db.prepare('SELECT * FROM otel_spans WHERE trace_id = ? ORDER BY start_ms ASC')
    .all(traceId) as OtelSpan[]
}

export interface OtelTraceSummary {
  trace_id: string
  root_operation: string
  root_agent: string
  start_ms: number
  end_ms: number | null
  span_count: number
  status: string
}

// Query spans for OTEL JSON export. All params are optional.
export function queryOtelSpans(opts: {
  agent?: string
  fromMs?: number
  toMs?: number
  limit?: number
}): OtelSpan[] {
  const { agent, fromMs, toMs, limit = 1000 } = opts
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (agent) { clauses.push('agent_id = ?'); params.push(agent) }
  if (fromMs !== undefined) { clauses.push('start_ms >= ?'); params.push(fromMs) }
  if (toMs !== undefined) { clauses.push('start_ms <= ?'); params.push(toMs) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  params.push(Math.min(limit, 5000))
  return db.prepare(
    `SELECT * FROM otel_spans ${where} ORDER BY start_ms ASC LIMIT ?`,
  ).all(...params) as OtelSpan[]
}

export function listOtelTraces(limit = 50): OtelTraceSummary[] {
  return db.prepare(`
    SELECT
      s.trace_id,
      s.operation  AS root_operation,
      s.agent_id   AS root_agent,
      s.start_ms,
      (SELECT MAX(end_ms) FROM otel_spans WHERE trace_id = s.trace_id) AS end_ms,
      (SELECT COUNT(*)    FROM otel_spans WHERE trace_id = s.trace_id) AS span_count,
      CASE
        WHEN EXISTS (SELECT 1 FROM otel_spans WHERE trace_id = s.trace_id AND status = 'error')   THEN 'error'
        WHEN EXISTS (SELECT 1 FROM otel_spans WHERE trace_id = s.trace_id AND status = 'timeout') THEN 'timeout'
        WHEN EXISTS (SELECT 1 FROM otel_spans WHERE trace_id = s.trace_id AND status = 'running') THEN 'running'
        ELSE 'ok'
      END AS status
    FROM otel_spans s
    WHERE s.parent_span_id IS NULL
    ORDER BY s.start_ms DESC
    LIMIT ?
  `).all(limit) as OtelTraceSummary[]
}

// ── B2B Tenant registry ───────────────────────────────────────────────────────

export interface Tenant {
  id: string
  display_name: string
  created_at: number
  disabled_at: number | null
}

export function createTenant(id: string, displayName: string): Tenant {
  const now = Math.floor(Date.now() / 1000)
  db.prepare('INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)')
    .run(id, displayName, now)
  return { id, display_name: displayName, created_at: now, disabled_at: null }
}

export function getTenant(id: string): Tenant | undefined {
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as Tenant | undefined
}

export function listTenants(includeDisabled = false): Tenant[] {
  if (includeDisabled) {
    return db.prepare('SELECT * FROM tenants ORDER BY created_at ASC').all() as Tenant[]
  }
  return db.prepare('SELECT * FROM tenants WHERE disabled_at IS NULL ORDER BY created_at ASC').all() as Tenant[]
}

export function updateTenant(id: string, patch: { display_name?: string; disabled?: boolean }): Tenant | null {
  const existing = getTenant(id)
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const fields: string[] = []
  const params: unknown[] = []
  if (patch.display_name !== undefined) {
    fields.push('display_name = ?')
    params.push(patch.display_name)
  }
  if (patch.disabled === true) {
    fields.push('disabled_at = ?')
    params.push(now)
  } else if (patch.disabled === false) {
    fields.push('disabled_at = NULL')
  }
  if (fields.length === 0) return existing
  params.push(id)
  db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as Tenant
}

// Permanently delete a tenant and all its associated data.
// Deletion order respects FK constraints and audit requirements:
//   1. Reject pending approvals first (before dashboard_users are gone).
//   2. Revoke api_tokens (tombstone: kept for access-history audit, revoked_at set).
//   3. Drop identity/access rows: dashboard_users, partner_senders, device_keys.
//   4. Drop all approvals (including now-rejected ones per Jonas 2026-08-30).
//   5. Drop agent_messages and import_memories.
//   6. Drop kanban child tables before kanban_cards.
//   7. Drop memories row-by-row with vec0 sync (safe path chosen 2026-08-30).
//   8. Drop artifacts (vec_artifacts cleaned by DELETE trigger).
//   9. Drop schedules (tenant_id IS NULL = fleet scope, untouched).
//  10. Drop skill_tenant_access before skills (FK; SQLite FK enforcement is off by default).
//  11. Drop skills.
//  12. Drop vec_workspace_docs then workspace_docs (app-level vec sync, no trigger).
//  13. Drop tenant_agent_availability.
//  14. Drop the tenant row itself.
// The 'default' tenant is permanently guarded and throws if passed.
export function deleteTenant(tenantId: string): { memoriesDeleted: number } {
  if (tenantId === 'default') throw new Error('Cannot delete the default tenant')

  return db.transaction((): { memoriesDeleted: number } => {
    // 1. Reject pending approvals
    db.prepare(
      "UPDATE approvals SET status = 'rejected', resolved_at = unixepoch() WHERE tenant_id = ? AND status = 'pending'",
    ).run(tenantId)

    // 2. Revoke api_tokens (tombstone -- keep row for audit, mark revoked)
    db.prepare('UPDATE api_tokens SET revoked_at = unixepoch() WHERE tenant_id = ? AND revoked_at IS NULL').run(tenantId)

    // 3. Drop identity/access rows
    db.prepare('DELETE FROM dashboard_users WHERE tenant_id = ?').run(tenantId)
    db.prepare('DELETE FROM partner_senders WHERE tenant_id = ?').run(tenantId)
    db.prepare('DELETE FROM device_keys WHERE tenant_id = ?').run(tenantId)

    // 4. Drop all approvals
    db.prepare('DELETE FROM approvals WHERE tenant_id = ?').run(tenantId)

    // 5. Drop messages and import memories
    db.prepare('DELETE FROM agent_messages WHERE tenant_id = ?').run(tenantId)
    db.prepare('DELETE FROM import_memories WHERE tenant_id = ?').run(tenantId)

    // 6. Drop kanban (child tables before parent)
    const cardIds = (
      db.prepare('SELECT id FROM kanban_cards WHERE tenant_id = ?').all(tenantId) as { id: string }[]
    ).map((r) => r.id)
    if (cardIds.length > 0) {
      const ph = cardIds.map(() => '?').join(', ')
      db.prepare(`DELETE FROM kanban_card_labels WHERE card_id IN (${ph})`).run(...cardIds)
      db.prepare(`DELETE FROM kanban_card_events  WHERE card_id IN (${ph})`).run(...cardIds)
      db.prepare(`DELETE FROM kanban_comments     WHERE card_id IN (${ph})`).run(...cardIds)
    }
    db.prepare('DELETE FROM kanban_cards WHERE tenant_id = ?').run(tenantId)

    // 7. Drop memories -- row-by-row to keep vec0 index in sync (same connection, safe inside tx)
    const memIds = (
      db.prepare('SELECT id FROM memories WHERE tenant_id = ?').all(tenantId) as { id: number }[]
    ).map((r) => r.id)
    for (const id of memIds) {
      syncVecMemoryDelete(id)
      db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    }

    // 8. Drop artifacts (vec_artifacts kept in sync by the vec_artifacts_ad DELETE trigger)
    db.prepare('DELETE FROM artifacts WHERE tenant_id = ?').run(tenantId)

    // 9. Drop schedules (tenant_id IS NULL = fleet scope, those are untouched)
    db.prepare('DELETE FROM schedules WHERE tenant_id = ?').run(tenantId)

    // 10 & 11. Drop skill_tenant_access before skills (SQLite FK enforcement is off by default;
    //          explicit two-pass: access grants TO this tenant, then grants FROM its skills).
    db.prepare('DELETE FROM skill_tenant_access WHERE tenant_id = ?').run(tenantId)
    const skillIds = (
      db.prepare('SELECT id FROM skills WHERE tenant_id = ?').all(tenantId) as { id: string }[]
    ).map((r) => r.id)
    if (skillIds.length > 0) {
      const ph = skillIds.map(() => '?').join(', ')
      db.prepare(`DELETE FROM skill_tenant_access WHERE skill_id IN (${ph})`).run(...skillIds)
    }
    db.prepare('DELETE FROM skills WHERE tenant_id = ?').run(tenantId)

    // 12. Drop workspace_docs -- vec_workspace_docs has no trigger, sync manually before main delete.
    if (vecExtensionLoaded) {
      try { db.prepare('DELETE FROM vec_workspace_docs WHERE tenant_id = ?').run(tenantId) } catch { /* vec0 unavailable */ }
    }
    db.prepare('DELETE FROM workspace_docs WHERE tenant_id = ?').run(tenantId)

    // 13. Drop tenant_agent_availability (SQLite FK enforcement is off by default)
    db.prepare('DELETE FROM tenant_agent_availability WHERE tenant_id = ?').run(tenantId)

    // 14. Drop the tenant row
    db.prepare('DELETE FROM tenants WHERE id = ?').run(tenantId)

    return { memoriesDeleted: memIds.length }
  })()
}

// ── B2B Dashboard user provisioning ──────────────────────────────────────────

/** Admin-controlled user provisioning: explicit role + tenant_id, no first-user-wins. */
export function provisionDashboardUser(
  username: string,
  passwordHash: string,
  role: string,
  tenantId: string | null,
  email?: string | null,
  displayName?: string | null,
): DashboardUser {
  const now = Math.floor(Date.now() / 1000)
  const info = db
    .prepare('INSERT INTO dashboard_users (username, password_hash, role, tenant_id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(username, passwordHash, role, tenantId, email ?? null, displayName ?? null, now, now)
  return { id: Number(info.lastInsertRowid), username, password_hash: passwordHash, role, tenant_id: tenantId, email: email ?? null, display_name: displayName ?? null, created_at: now, updated_at: now, disabled: 0 }
}

export function getDashboardUserById(id: number): DashboardUser | undefined {
  return db.prepare('SELECT * FROM dashboard_users WHERE id = ?').get(id) as DashboardUser | undefined
}

export interface ListUsersOpts {
  tenantId?: string | 'global'
  includeDisabled?: boolean
}

export function listDashboardUsersFiltered(opts: ListUsersOpts = {}): DashboardUserPublic[] {
  const conditions: string[] = []
  const params: unknown[] = []
  if (!opts.includeDisabled) {
    conditions.push('disabled = 0')
  }
  if (opts.tenantId === 'global') {
    conditions.push('tenant_id IS NULL')
  } else if (opts.tenantId) {
    conditions.push('tenant_id = ?')
    params.push(opts.tenantId)
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return db
    .prepare(`SELECT id, username, role, tenant_id, email, display_name, created_at, updated_at, disabled FROM dashboard_users ${where} ORDER BY username COLLATE NOCASE`)
    .all(...params) as DashboardUserPublic[]
}

export interface AdminUserPatch {
  role?: string
  tenant_id?: string | null
  password_hash?: string
  disabled?: boolean
  email?: string | null
  display_name?: string | null
}

export function adminPatchDashboardUser(id: number, patch: AdminUserPatch): DashboardUser | null {
  const existing = getDashboardUserById(id)
  if (!existing) return null
  const now = Math.floor(Date.now() / 1000)
  const fields: string[] = ['updated_at = ?']
  const params: unknown[] = [now]
  if (patch.role !== undefined) { fields.push('role = ?'); params.push(patch.role) }
  if ('tenant_id' in patch) { fields.push('tenant_id = ?'); params.push(patch.tenant_id ?? null) }
  if (patch.password_hash !== undefined) { fields.push('password_hash = ?'); params.push(patch.password_hash) }
  if (patch.disabled !== undefined) { fields.push('disabled = ?'); params.push(patch.disabled ? 1 : 0) }
  if ('email' in patch) { fields.push('email = ?'); params.push(patch.email ?? null) }
  if ('display_name' in patch) { fields.push('display_name = ?'); params.push(patch.display_name ?? null) }
  params.push(id)
  db.prepare(`UPDATE dashboard_users SET ${fields.join(', ')} WHERE id = ?`).run(...params)
  return getDashboardUserById(id) ?? null
}

export function countActiveAdmins(): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM dashboard_users WHERE role = 'admin' AND disabled = 0").get() as { c: number }).c
}

// Prefix that marks a message as a completion report / acknowledgement.
// Used by shouldNotifyDelegator to avoid ping-pong chains.
export const COMPLETION_REPORT_PREFIX = '[Eredmény]'

// ── Partner Senders ───────────────────────────────────────────────────────────

export interface PartnerSender {
  sender_id: string
  tenant_id: string
  display_name: string
  created_by: string
  created_at: number
  disabled_at: number | null
}

export function isAuthorizedPartnerSender(senderId: string, tenantId: string): boolean {
  const row = db.prepare(
    'SELECT 1 FROM partner_senders WHERE sender_id = ? AND tenant_id = ? AND disabled_at IS NULL'
  ).get(senderId, tenantId)
  return row != null
}

export function listPartnerSenders(tenantId?: string): PartnerSender[] {
  if (tenantId != null) {
    return db.prepare(
      'SELECT sender_id, tenant_id, display_name, created_by, created_at, disabled_at FROM partner_senders WHERE tenant_id = ? ORDER BY created_at ASC'
    ).all(tenantId) as PartnerSender[]
  }
  return db.prepare(
    'SELECT sender_id, tenant_id, display_name, created_by, created_at, disabled_at FROM partner_senders ORDER BY tenant_id, created_at ASC'
  ).all() as PartnerSender[]
}

export function createPartnerSender(senderId: string, tenantId: string, displayName: string, createdBy: string): PartnerSender {
  db.prepare(
    'INSERT INTO partner_senders (sender_id, tenant_id, display_name, created_by) VALUES (?, ?, ?, ?)'
  ).run(senderId, tenantId, displayName, createdBy)
  return db.prepare(
    'SELECT sender_id, tenant_id, display_name, created_by, created_at, disabled_at FROM partner_senders WHERE sender_id = ? AND tenant_id = ?'
  ).get(senderId, tenantId) as PartnerSender
}

export function disablePartnerSender(senderId: string, tenantId: string): boolean {
  const result = db.prepare(
    'UPDATE partner_senders SET disabled_at = unixepoch() WHERE sender_id = ? AND tenant_id = ? AND disabled_at IS NULL'
  ).run(senderId, tenantId)
  return result.changes > 0
}
