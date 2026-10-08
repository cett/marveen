// Tenant-scoped query facade for the four core tables.
//
// Every method on the returned object hard-wires the caller's tenant_id into
// the SQL so route handlers can never accidentally read or write another
// tenant's data -- even if the caller passes a wrong value, the WHERE clause
// wins. Cross-tenant reads return an empty list (not a 403); cross-tenant
// writes are structurally impossible because the tenant_id column is always
// supplied by the scope, not by the caller.
//
// The SQL lives in db/tenant-scoped.ts, where `tenantId` is a required first
// parameter of every function; this module only binds it once.
//
// Admin-level aggregation that needs to span tenants should use the unscoped
// db functions directly, protected by the admin:all permission check.

import {
  listTenantMemories, getTenantMemory, insertTenantMemory, updateTenantMemory, deleteTenantMemory,
  listTenantKanbanCards, countTenantKanbanCards, getTenantKanbanCard, insertTenantKanbanCard,
  updateTenantKanbanCard, deleteTenantKanbanCard,
  listTenantMessagesFor, insertTenantMessage,
  listTenantImportMemoriesForSource, getTenantImportMemory, insertTenantImportMemory, deleteTenantImportMemory,
} from '../db/tenant-scoped.js'

export type { ScopedMemory, ScopedKanbanCard, ScopedAgentMessage, ScopedImportMemory } from '../db/tenant-scoped.js'

export function scopeToTenant(tenantId: string) {
  return {
    memories: {
      /** List memories for an agent within this tenant, including shared-tier. */
      list: (agentId: string, category?: string, limit?: number) => listTenantMemories(tenantId, agentId, category, limit),
      /** Get a single memory by id, only if it belongs to this tenant. */
      get: (id: number) => getTenantMemory(tenantId, id),
      /** Insert a new memory stamped with this tenant. */
      insert: (agentId: string, category: string, content: string, keywords?: string) =>
        insertTenantMemory(tenantId, agentId, category, content, keywords),
      /** Update a memory only if it belongs to this tenant. */
      update: (id: number, patch: { content?: string; category?: string }) => updateTenantMemory(tenantId, id, patch),
      /** Delete a memory only if it belongs to this tenant. */
      delete: (id: number) => deleteTenantMemory(tenantId, id),
    },

    kanban: {
      /** List this tenant's non-archived cards; `limit`/`offset` only when passed. */
      list: (status?: string, limit?: number, offset?: number) => listTenantKanbanCards(tenantId, status, limit, offset),
      /** Count this tenant's non-archived cards -- pairs with list() for pagination totals. */
      count: (status?: string) => countTenantKanbanCards(tenantId, status),
      /** Get a single card by id, only if it belongs to this tenant. */
      get: (id: string) => getTenantKanbanCard(tenantId, id),
      /** Insert a new kanban card stamped with this tenant. */
      insert: (id: string, title: string, status?: string) => insertTenantKanbanCard(tenantId, id, title, status),
      /** Update a card only if it belongs to this tenant. */
      update: (id: string, patch: { title?: string; status?: string }) => updateTenantKanbanCard(tenantId, id, patch),
      /** Delete a card only if it belongs to this tenant. */
      delete: (id: string) => deleteTenantKanbanCard(tenantId, id),
    },

    agentMessages: {
      /** List messages for a target agent within this tenant. */
      listFor: (toAgent: string, status?: string, limit?: number) => listTenantMessagesFor(tenantId, toAgent, status, limit),
      /** Insert a message stamped with this tenant. */
      insert: (fromAgent: string, toAgent: string, content: string) => insertTenantMessage(tenantId, fromAgent, toAgent, content),
    },

    importMemories: {
      /** List import memories for a source within this tenant. */
      listForSource: (sourceId: string, limit?: number) => listTenantImportMemoriesForSource(tenantId, sourceId, limit),
      /** Get a single import memory by id, only if it belongs to this tenant. */
      get: (id: string) => getTenantImportMemory(tenantId, id),
      /** Insert an import memory stamped with this tenant. */
      insert: (id: string, sourceId: string, filePath: string, content: string) =>
        insertTenantImportMemory(tenantId, id, sourceId, filePath, content),
      /** Delete an import memory only if it belongs to this tenant. */
      delete: (id: string) => deleteTenantImportMemory(tenantId, id),
    },
  }
}

export type TenantScope = ReturnType<typeof scopeToTenant>
