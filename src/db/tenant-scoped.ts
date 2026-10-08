// db/tenant-scoped.ts -- tenant-pinned reads and writes for the four core
// tables (memories, kanban_cards, agent_messages, import_memories).
//
// Every function takes `tenantId` as its first, required parameter and puts it
// in the WHERE clause (or stamps it on the insert), so a caller can never reach
// another tenant's rows: a cross-tenant read is an empty result, a cross-tenant
// write changes nothing. There is deliberately no default and no "all tenants"
// value; admin-wide aggregation uses the unscoped db functions instead.
// web/tenant-scope.ts wraps these in the scopeToTenant() facade.

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { db } from './connection.js'
import { syncVecMemoryDelete } from './vector.js'

export interface ScopedMemory {
  id: number
  agent_id: string
  category: string
  key: string
  value: string
  tenant_id: string
  [key: string]: unknown
}

export interface ScopedKanbanCard {
  id: string
  title: string
  status: string
  tenant_id: string
  [key: string]: unknown
}

export interface ScopedAgentMessage {
  id: number
  from_agent: string
  to_agent: string
  content: string
  status: string
  tenant_id: string
  [key: string]: unknown
}

export interface ScopedImportMemory {
  id: string
  source_id: string
  file_path: string
  content: string
  tenant_id: string
  [key: string]: unknown
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

// ── memories ─────────────────────────────────────────────────────────────────

/** List memories for an agent within the tenant, including shared-tier. */
export function listTenantMemories(tenantId: string, agentId: string, category?: string, limit = 50): ScopedMemory[] {
  if (category) {
    return db
      .prepare(
        `SELECT * FROM memories
         WHERE tenant_id = ? AND (agent_id = ? OR category = 'shared') AND category = ?
         ORDER BY accessed_at DESC LIMIT ?`,
      )
      .all(tenantId, agentId, category, limit) as ScopedMemory[]
  }
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE tenant_id = ? AND (agent_id = ? OR category = 'shared')
       ORDER BY accessed_at DESC LIMIT ?`,
    )
    .all(tenantId, agentId, limit) as ScopedMemory[]
}

export function getTenantMemory(tenantId: string, id: number): ScopedMemory | null {
  return (
    (db.prepare('SELECT * FROM memories WHERE tenant_id = ? AND id = ?').get(tenantId, id) as ScopedMemory | undefined) ?? null
  )
}

export function insertTenantMemory(tenantId: string, agentId: string, category: string, content: string, keywords?: string): number {
  const now = nowSeconds()
  const row = db
    .prepare(
      `INSERT INTO memories (chat_id, sector, agent_id, category, content, keywords, tenant_id, created_at, accessed_at)
       VALUES ('', 'semantic', ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(agentId, category, content, keywords ?? null, tenantId, now, now) as { id: number }
  return row.id
}

export function updateTenantMemory(tenantId: string, id: number, patch: { content?: string; category?: string }): boolean {
  const fields: string[] = []
  const params: unknown[] = []
  if (patch.content !== undefined) { fields.push('content = ?'); params.push(patch.content) }
  if (patch.category !== undefined) { fields.push('category = ?'); params.push(patch.category) }
  if (fields.length === 0) return false
  params.push(tenantId, id)
  const result = db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`).run(...params)
  return result.changes > 0
}

export function deleteTenantMemory(tenantId: string, id: number): boolean {
  const result = db.prepare('DELETE FROM memories WHERE tenant_id = ? AND id = ?').run(tenantId, id)
  if (result.changes > 0) syncVecMemoryDelete(id)
  return result.changes > 0
}

// ── kanban_cards ─────────────────────────────────────────────────────────────

/**
 * List the tenant's kanban cards, excluding archived ones -- matches the
 * unscoped listKanbanCards() so tenant-scoped and fleet-wide counts agree.
 * `limit` is only applied when explicitly passed; the default (unbounded) call
 * mirrors the unscoped path instead of silently truncating at a fixed page
 * size. `offset` is only meaningful together with `limit` (kanban board
 * per-column "load more").
 */
export function listTenantKanbanCards(tenantId: string, status?: string, limit?: number, offset?: number): ScopedKanbanCard[] {
  let limitClause = ''
  if (limit !== undefined) {
    limitClause = ' LIMIT ?'
    if (offset !== undefined) limitClause += ' OFFSET ?'
  }
  if (status) {
    const params: unknown[] = [tenantId, status]
    if (limit !== undefined) { params.push(limit); if (offset !== undefined) params.push(offset) }
    return db
      .prepare(
        `SELECT * FROM kanban_cards
         WHERE tenant_id = ? AND status = ? AND archived_at IS NULL
         ORDER BY created_at DESC${limitClause}`,
      )
      .all(...params) as ScopedKanbanCard[]
  }
  const params: unknown[] = [tenantId]
  if (limit !== undefined) { params.push(limit); if (offset !== undefined) params.push(offset) }
  return db
    .prepare(
      `SELECT * FROM kanban_cards
       WHERE tenant_id = ? AND archived_at IS NULL
       ORDER BY created_at DESC${limitClause}`,
    )
    .all(...params) as ScopedKanbanCard[]
}

/** Count the tenant's non-archived cards -- pairs with the list for pagination totals. */
export function countTenantKanbanCards(tenantId: string, status?: string): number {
  if (status) {
    return (db
      .prepare('SELECT COUNT(*) AS n FROM kanban_cards WHERE tenant_id = ? AND status = ? AND archived_at IS NULL')
      .get(tenantId, status) as { n: number }).n
  }
  return (db
    .prepare('SELECT COUNT(*) AS n FROM kanban_cards WHERE tenant_id = ? AND archived_at IS NULL')
    .get(tenantId) as { n: number }).n
}

export function getTenantKanbanCard(tenantId: string, id: string): ScopedKanbanCard | null {
  return (
    (db.prepare('SELECT * FROM kanban_cards WHERE tenant_id = ? AND id = ?').get(tenantId, id) as ScopedKanbanCard | undefined) ?? null
  )
}

export function insertTenantKanbanCard(tenantId: string, id: string, title: string, status = 'planned'): void {
  const now = nowSeconds()
  db.prepare(
    'INSERT INTO kanban_cards (id, title, status, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, title, status, tenantId, now, now)
}

export function updateTenantKanbanCard(tenantId: string, id: string, patch: { title?: string; status?: string }): boolean {
  const fields: string[] = []
  const params: unknown[] = []
  if (patch.title !== undefined) { fields.push('title = ?'); params.push(patch.title) }
  if (patch.status !== undefined) { fields.push('status = ?'); params.push(patch.status) }
  if (fields.length === 0) return false
  params.push(tenantId, id)
  const result = db.prepare(`UPDATE kanban_cards SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`).run(...params)
  return result.changes > 0
}

export function deleteTenantKanbanCard(tenantId: string, id: string): boolean {
  const result = db.prepare('DELETE FROM kanban_cards WHERE tenant_id = ? AND id = ?').run(tenantId, id)
  return result.changes > 0
}

// ── agent_messages ───────────────────────────────────────────────────────────

/** List messages for a target agent within the tenant. */
export function listTenantMessagesFor(tenantId: string, toAgent: string, status?: string, limit = 100): ScopedAgentMessage[] {
  if (status) {
    return db
      .prepare(
        `SELECT * FROM agent_messages
         WHERE tenant_id = ? AND to_agent = ? AND status = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(tenantId, toAgent, status, limit) as ScopedAgentMessage[]
  }
  return db
    .prepare(
      `SELECT * FROM agent_messages
       WHERE tenant_id = ? AND to_agent = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(tenantId, toAgent, limit) as ScopedAgentMessage[]
}

export function insertTenantMessage(tenantId: string, fromAgent: string, toAgent: string, content: string): number {
  const row = db
    .prepare(
      `INSERT INTO agent_messages (from_agent, to_agent, content, status, tenant_id, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?)
       RETURNING id`,
    )
    .get(fromAgent, toAgent, content, tenantId, nowSeconds()) as { id: number }
  return row.id
}

// ── import_memories ──────────────────────────────────────────────────────────

export function listTenantImportMemoriesForSource(tenantId: string, sourceId: string, limit = 500): ScopedImportMemory[] {
  return db
    .prepare(
      `SELECT * FROM import_memories
       WHERE tenant_id = ? AND source_id = ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(tenantId, sourceId, limit) as ScopedImportMemory[]
}

export function getTenantImportMemory(tenantId: string, id: string): ScopedImportMemory | null {
  return (
    (db.prepare('SELECT * FROM import_memories WHERE tenant_id = ? AND id = ?').get(tenantId, id) as ScopedImportMemory | undefined) ?? null
  )
}

export function insertTenantImportMemory(tenantId: string, id: string, sourceId: string, filePath: string, content: string): void {
  const now = nowSeconds()
  db.prepare(
    `INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, tenant_id, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, sourceId, filePath, basename(filePath), createHash('sha256').update(content).digest('hex'), content, tenantId, now, now, now)
}

export function deleteTenantImportMemory(tenantId: string, id: string): boolean {
  const result = db.prepare('DELETE FROM import_memories WHERE tenant_id = ? AND id = ?').run(tenantId, id)
  return result.changes > 0
}
