// Real-DB checks for db/import.ts: tenant narrowing of the list/stats/search
// reads, the patch whitelist, and the shadow-row cleanup order of the two
// delete paths (FK nulled before the shadow memories go).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  getDb,
  insertImportSource,
  listImportSources,
  getImportSourceTenantId,
  updateImportSource,
  getImportSource,
  deleteImportSource,
  wipeImportMemories,
  listImportAuditLog,
  listImportAuditLogForSource,
  getImportStats,
  searchImportMemories,
} from '../db.js'

function source(id: string, tenantId: string, now = 100): void {
  insertImportSource({
    id, type: 'local', path: `/docs/${id}`, label: id, intervalHours: 4, enabled: true, now,
    tenantId, vaultTokenRef: null, confluenceEmail: null, baseUrl: null,
  })
}

function importRow(id: string, sourceId: string, content: string, shadow: boolean): number | null {
  let shadowId: number | null = null
  if (shadow) {
    shadowId = (getDb().prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, tenant_id)
       VALUES ('0', ?, 'semantic', 1.0, 1, 1, 'import', 'warm', 1, 'default') RETURNING id`
    ).get(content) as { id: number }).id
  }
  getDb().prepare(
    `INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, keywords, last_seen_at, created_at, updated_at, memory_shadow_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 1, 1, ?, ?)`
  ).run(id, sourceId, `/docs/${id}.md`, `${id}.md`, `h-${id}`, content, 10, shadowId)
  return shadowId
}

function audit(sourceId: string, runAt: number, tenantId: string): void {
  getDb().prepare(
    'INSERT INTO import_audit_log (source_id, run_at, tenant_id) VALUES (?, ?, ?)'
  ).run(sourceId, runAt, tenantId)
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('source reads', () => {
  it('listImportSources narrows to the tenant, null = everyone, oldest first', () => {
    source('s-a', 'tenant-a', 100)
    source('s-b', 'tenant-b', 50)
    expect(listImportSources('tenant-a').map((s) => s.id)).toEqual(['s-a'])
    expect(listImportSources(null).map((s) => s.id)).toEqual(['s-b', 's-a'])
    expect(getImportSourceTenantId('s-b')).toBe('tenant-b')
    expect(getImportSourceTenantId('missing')).toBeNull()
  })

  it('updateImportSource touches only the keys present, null clears', () => {
    source('s1', 'default')
    updateImportSource('s1', 500, { label: null, interval_hours: 12 })
    const row = getImportSource('s1')!
    expect(row.label).toBeNull()
    expect(row.interval_hours).toBe(12)
    expect(row.path).toBe('/docs/s1')
    expect(row.updated_at).toBe(500)
  })
})

describe('audit log', () => {
  it('listImportAuditLog narrows by the SOURCE tenant, newest first', () => {
    source('s-a', 'tenant-a')
    source('s-b', 'tenant-b')
    audit('s-a', 10, 'tenant-a')
    audit('s-a', 20, 'tenant-a')
    audit('s-b', 30, 'tenant-b')
    expect(listImportAuditLog('tenant-a').map((r) => r.run_at)).toEqual([20, 10])
    expect(listImportAuditLog(null).map((r) => r.run_at)).toEqual([30, 20, 10])
    expect(listImportAuditLogForSource('s-b').map((r) => r.run_at)).toEqual([30])
  })
})

describe('stats and search', () => {
  it('getImportStats counts per source within the tenant', () => {
    source('s-a', 'tenant-a')
    source('s-b', 'tenant-b')
    importRow('m1', 's-a', 'alpha', false)
    importRow('m2', 's-a', 'beta', false)
    importRow('m3', 's-b', 'gamma', false)
    expect(getImportStats('tenant-a')).toEqual({ total: 2, bySource: [{ source_id: 's-a', c: 2 }] })
    expect(getImportStats(null).total).toBe(3)
  })

  it('searchImportMemories matches content, narrows by tenant, pages', () => {
    source('s-a', 'tenant-a')
    source('s-b', 'tenant-b')
    importRow('m1', 's-a', 'needle one', false)
    importRow('m2', 's-a', 'needle two', false)
    importRow('m3', 's-b', 'needle three', false)
    const a = searchImportMemories('needle', 'tenant-a', 10, 0)
    expect(a.total).toBe(2)
    expect(a.items).toHaveLength(2)
    expect(searchImportMemories('needle', null, 10, 0).total).toBe(3)
    expect(searchImportMemories('needle', 'tenant-a', 1, 1).items).toHaveLength(1)
    expect(searchImportMemories('absent', 'tenant-a', 10, 0)).toEqual({ items: [], total: 0 })
  })
})

describe('deletes with shadow rows', () => {
  const memoryExists = (id: number) => getDb().prepare('SELECT 1 FROM memories WHERE id = ?').get(id) !== undefined

  it('deleteImportSource removes the source, its import rows and their shadow memories only', () => {
    source('s-a', 'tenant-a')
    source('s-b', 'tenant-b')
    const shadowA = importRow('m1', 's-a', 'alpha', true)!
    const shadowB = importRow('m2', 's-b', 'beta', true)!
    expect(deleteImportSource('s-a')).toBe(true)
    expect(getImportSource('s-a')).toBeUndefined()
    expect(memoryExists(shadowA)).toBe(false)
    expect(memoryExists(shadowB)).toBe(true)
    expect(deleteImportSource('s-a')).toBe(false)
  })

  it('wipeImportMemories(sourceId) keeps the source and other sources', () => {
    source('s-a', 'tenant-a')
    source('s-b', 'tenant-b')
    const shadowA = importRow('m1', 's-a', 'alpha', true)!
    importRow('m2', 's-a', 'alpha2', false)
    const shadowB = importRow('m3', 's-b', 'beta', true)!
    expect(wipeImportMemories('s-a')).toBe(2)
    expect(getImportSource('s-a')).toBeDefined()
    expect(memoryExists(shadowA)).toBe(false)
    expect(memoryExists(shadowB)).toBe(true)
    expect(getImportStats(null).total).toBe(1)
  })

  it('wipeImportMemories() clears every source', () => {
    source('s-a', 'tenant-a')
    source('s-b', 'tenant-b')
    const shadowA = importRow('m1', 's-a', 'alpha', true)!
    const shadowB = importRow('m3', 's-b', 'beta', true)!
    expect(wipeImportMemories()).toBe(2)
    expect(memoryExists(shadowA)).toBe(false)
    expect(memoryExists(shadowB)).toBe(false)
    expect(getImportStats(null).total).toBe(0)
  })
})
