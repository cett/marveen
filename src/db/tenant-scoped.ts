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
import { KANBAN_SEQ_COLUMN, kanbanWriteClearsDispatch } from './kanban.js'
import { dbx } from './facade.js'
import { syncVecMemoryDelete } from './vector.js'
import { assertNoReservedMarker } from '../server-markers.js'

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
export async function listTenantMemories(tenantId: string, agentId: string, category?: string, limit = 50): Promise<ScopedMemory[]> {
  if (category) {
    return dbx.all<ScopedMemory>(`SELECT * FROM memories
         WHERE tenant_id = ? AND (agent_id = ? OR category = 'shared') AND category = ?
         ORDER BY accessed_at DESC LIMIT ?`, tenantId, agentId, category, limit)
  }
  return dbx.all<ScopedMemory>(`SELECT * FROM memories
       WHERE tenant_id = ? AND (agent_id = ? OR category = 'shared')
       ORDER BY accessed_at DESC LIMIT ?`, tenantId, agentId, limit)
}

export async function getTenantMemory(tenantId: string, id: number): Promise<ScopedMemory | null> {
  return (
    (await dbx.get<ScopedMemory>('SELECT * FROM memories WHERE tenant_id = ? AND id = ?', tenantId, id)) ?? null
  )
}

export async function insertTenantMemory(tenantId: string, agentId: string, category: string, content: string, keywords?: string): Promise<number> {
  const now = nowSeconds()
  const row = (await dbx.get(`INSERT INTO memories (chat_id, sector, agent_id, category, content, keywords, tenant_id, created_at, accessed_at)
       VALUES ('', 'semantic', ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`, agentId, category, content, keywords ?? null, tenantId, now, now)) as { id: number }
  return row.id
}

export async function updateTenantMemory(tenantId: string, id: number, patch: { content?: string; category?: string }): Promise<boolean> {
  const fields: string[] = []
  const params: unknown[] = []
  if (patch.content !== undefined) { fields.push('content = ?'); params.push(patch.content) }
  if (patch.category !== undefined) { fields.push('category = ?'); params.push(patch.category) }
  if (fields.length === 0) return false
  params.push(tenantId, id)
  const result = await dbx.run(`UPDATE memories SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`, ...params)
  return result.changes > 0
}

export async function deleteTenantMemory(tenantId: string, id: number): Promise<boolean> {
  const result = await dbx.run('DELETE FROM memories WHERE tenant_id = ? AND id = ?', tenantId, id)
  if (result.changes > 0) await syncVecMemoryDelete(id)
  return result.changes > 0
}

// ── kanban_cards ─────────────────────────────────────────────────────────────

/**
 * List the tenant's kanban cards, excluding archived ones -- matches the
 * unscoped listKanbanCards() so tenant-scoped and fleet-wide counts agree, and
 * so does the shape: every card carries `seq` (the number shown as
 * #N) and the order is the board's manual order (`sort_order`, then newest).
 * `limit` is only applied when explicitly passed; the default (unbounded) call
 * mirrors the unscoped path instead of silently truncating at a fixed page
 * size. `offset` is only meaningful together with `limit` (kanban board
 * per-column "load more").
 */
export async function listTenantKanbanCards(tenantId: string, status?: string, limit?: number, offset?: number): Promise<ScopedKanbanCard[]> {
  let limitClause = ''
  if (limit !== undefined) {
    limitClause = ' LIMIT ?'
    if (offset !== undefined) limitClause += ' OFFSET ?'
  }
  if (status) {
    const params: unknown[] = [tenantId, status]
    if (limit !== undefined) { params.push(limit); if (offset !== undefined) params.push(offset) }
    return dbx.all<ScopedKanbanCard>(`SELECT ${KANBAN_SEQ_COLUMN}, * FROM kanban_cards
         WHERE tenant_id = ? AND status = ? AND archived_at IS NULL
         ORDER BY sort_order ASC, created_at DESC${limitClause}`, ...params)
  }
  const params: unknown[] = [tenantId]
  if (limit !== undefined) { params.push(limit); if (offset !== undefined) params.push(offset) }
  return dbx.all<ScopedKanbanCard>(`SELECT ${KANBAN_SEQ_COLUMN}, * FROM kanban_cards
       WHERE tenant_id = ? AND archived_at IS NULL
       ORDER BY sort_order ASC, created_at DESC${limitClause}`, ...params)
}

/** Count the tenant's non-archived cards -- pairs with the list for pagination totals. */
export async function countTenantKanbanCards(tenantId: string, status?: string): Promise<number> {
  if (status) {
    return ((await dbx.get('SELECT COUNT(*) AS n FROM kanban_cards WHERE tenant_id = ? AND status = ? AND archived_at IS NULL', tenantId, status)) as { n: number }).n
  }
  return ((await dbx.get('SELECT COUNT(*) AS n FROM kanban_cards WHERE tenant_id = ? AND archived_at IS NULL', tenantId)) as { n: number }).n
}

export async function getTenantKanbanCard(tenantId: string, id: string): Promise<ScopedKanbanCard | null> {
  return (
    (await dbx.get<ScopedKanbanCard>(`SELECT ${KANBAN_SEQ_COLUMN}, * FROM kanban_cards WHERE tenant_id = ? AND id = ?`, tenantId, id)) ?? null
  )
}

export async function insertTenantKanbanCard(tenantId: string, id: string, title: string, status = 'planned'): Promise<void> {
  const now = nowSeconds()
  await dbx.run('INSERT INTO kanban_cards (id, title, status, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', id, title, status, tenantId, now, now)
}

export async function updateTenantKanbanCard(tenantId: string, id: string, patch: { title?: string; status?: string }): Promise<boolean> {
  const fields: string[] = []
  const params: unknown[] = []
  if (patch.title !== undefined) { fields.push('title = ?'); params.push(patch.title) }
  if (patch.status !== undefined) {
    fields.push('status = ?'); params.push(patch.status)
    // Leaving in_progress ends the stay the dispatch guard belongs to (see kanbanWriteClearsDispatch).
    if (kanbanWriteClearsDispatch(patch.status)) fields.push('dispatched_at = NULL')
  }
  if (fields.length === 0) return false
  params.push(tenantId, id)
  const result = await dbx.run(`UPDATE kanban_cards SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`, ...params)
  return result.changes > 0
}

export async function deleteTenantKanbanCard(tenantId: string, id: string): Promise<boolean> {
  const result = await dbx.run('DELETE FROM kanban_cards WHERE tenant_id = ? AND id = ?', tenantId, id)
  return result.changes > 0
}

// ── agent_messages ───────────────────────────────────────────────────────────

/** List messages for a target agent within the tenant. */
export async function listTenantMessagesFor(tenantId: string, toAgent: string, status?: string, limit = 100): Promise<ScopedAgentMessage[]> {
  if (status) {
    return dbx.all<ScopedAgentMessage>(`SELECT * FROM agent_messages
         WHERE tenant_id = ? AND to_agent = ? AND status = ?
         ORDER BY created_at DESC LIMIT ?`, tenantId, toAgent, status, limit)
  }
  return dbx.all<ScopedAgentMessage>(`SELECT * FROM agent_messages
       WHERE tenant_id = ? AND to_agent = ?
       ORDER BY created_at DESC LIMIT ?`, tenantId, toAgent, limit)
}

export async function insertTenantMessage(tenantId: string, fromAgent: string, toAgent: string, content: string): Promise<number> {
  // Same gate as createAgentMessage: this is a second INSERT into agent_messages.
  assertNoReservedMarker(fromAgent, content)
  const row = (await dbx.get(`INSERT INTO agent_messages (from_agent, to_agent, content, status, tenant_id, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?)
       RETURNING id`, fromAgent, toAgent, content, tenantId, nowSeconds())) as { id: number }
  return row.id
}

// ── import_memories ──────────────────────────────────────────────────────────

export async function listTenantImportMemoriesForSource(tenantId: string, sourceId: string, limit = 500): Promise<ScopedImportMemory[]> {
  return dbx.all<ScopedImportMemory>(`SELECT * FROM import_memories
       WHERE tenant_id = ? AND source_id = ?
       ORDER BY updated_at DESC LIMIT ?`, tenantId, sourceId, limit)
}

export async function getTenantImportMemory(tenantId: string, id: string): Promise<ScopedImportMemory | null> {
  return (
    (await dbx.get<ScopedImportMemory>('SELECT * FROM import_memories WHERE tenant_id = ? AND id = ?', tenantId, id)) ?? null
  )
}

export async function insertTenantImportMemory(tenantId: string, id: string, sourceId: string, filePath: string, content: string): Promise<void> {
  const now = nowSeconds()
  await dbx.run(`INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, tenant_id, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, sourceId, filePath, basename(filePath), createHash('sha256').update(content).digest('hex'), content, tenantId, now, now, now)
}

export async function deleteTenantImportMemory(tenantId: string, id: string): Promise<boolean> {
  const result = await dbx.run('DELETE FROM import_memories WHERE tenant_id = ? AND id = ?', tenantId, id)
  return result.changes > 0
}
