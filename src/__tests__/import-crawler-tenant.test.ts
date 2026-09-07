// Tenant propagation in the local-FS crawler's upsert path: a source's
// tenant_id must land on both the import_memories row it creates and
// that row's shadow memories row, so tenant-scoped stats/search/recall
// queries see only their own tenant's imported content.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, getDb } from '../db.js'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { upsertImportMemory } from '../web/import-crawler.js'

function createSource(db: ReturnType<typeof getDb>, id: string, tenantId: string): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(`
    INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at, tenant_id)
    VALUES (?, 'local', '/tmp/x', 4, 1, ?, ?, ?)
  `).run(id, now, now, tenantId)
}

describe('upsertImportMemory: tenant propagation', () => {
  beforeEach(() => {
    initDatabase(':memory:')
  })

  it('stamps tenantId on both the new import_memories row and its shadow memories row', () => {
    const db = getDb()
    createSource(db, 'src-a', 'tenant-crawl-a')
    const now = Math.floor(Date.now() / 1000)
    const result = upsertImportMemory('src-a', '/docs/note.txt', 'note.txt', 'hash1', 'quarterly budget notes', 'budget', now, 'tenant-crawl-a')
    expect(result).toBe('added')

    const memRow = db.prepare(
      "SELECT tenant_id, memory_shadow_id FROM import_memories WHERE source_id = 'src-a' AND file_path = '/docs/note.txt'"
    ).get() as { tenant_id: string; memory_shadow_id: number }
    expect(memRow.tenant_id).toBe('tenant-crawl-a')
    expect(memRow.memory_shadow_id).not.toBeNull()

    const shadowRow = db.prepare("SELECT tenant_id FROM memories WHERE id = ?").get(memRow.memory_shadow_id) as { tenant_id: string }
    expect(shadowRow.tenant_id).toBe('tenant-crawl-a')
  })

  it('keeps rows in separate tenants distinguishable when two sources share a file path', () => {
    const db = getDb()
    createSource(db, 'src-a', 'tenant-a')
    createSource(db, 'src-b', 'tenant-b')
    const now = Math.floor(Date.now() / 1000)
    upsertImportMemory('src-a', '/docs/shared-name.txt', 'shared-name.txt', 'hashA', 'content A', 'kw', now, 'tenant-a')
    upsertImportMemory('src-b', '/docs/shared-name.txt', 'shared-name.txt', 'hashB', 'content B', 'kw', now, 'tenant-b')

    const rowA = db.prepare("SELECT tenant_id FROM import_memories WHERE source_id = 'src-a'").get() as { tenant_id: string }
    const rowB = db.prepare("SELECT tenant_id FROM import_memories WHERE source_id = 'src-b'").get() as { tenant_id: string }
    expect(rowA.tenant_id).toBe('tenant-a')
    expect(rowB.tenant_id).toBe('tenant-b')
  })

  it('updating existing content (hash change) does not clobber the shadow row tenant_id', () => {
    const db = getDb()
    createSource(db, 'src-c', 'tenant-crawl-c')
    const now = Math.floor(Date.now() / 1000)
    upsertImportMemory('src-c', '/docs/versioned.txt', 'versioned.txt', 'hash-v1', 'version one', 'kw', now, 'tenant-crawl-c')

    const result = upsertImportMemory('src-c', '/docs/versioned.txt', 'versioned.txt', 'hash-v2', 'version two', 'kw', now + 10, 'tenant-crawl-c')
    expect(result).toBe('updated')

    const memRow = db.prepare(
      "SELECT tenant_id, memory_shadow_id FROM import_memories WHERE source_id = 'src-c'"
    ).get() as { tenant_id: string; memory_shadow_id: number }
    expect(memRow.tenant_id).toBe('tenant-crawl-c')

    const shadowRow = db.prepare("SELECT content, tenant_id FROM memories WHERE id = ?").get(memRow.memory_shadow_id) as { content: string; tenant_id: string }
    expect(shadowRow.content).toBe('version two')
    expect(shadowRow.tenant_id).toBe('tenant-crawl-c')
  })

  it('a matching hash (no-op re-scan) still leaves the shadow row tenant_id intact', () => {
    const db = getDb()
    createSource(db, 'src-d', 'tenant-crawl-d')
    const now = Math.floor(Date.now() / 1000)
    upsertImportMemory('src-d', '/docs/stable.txt', 'stable.txt', 'stable-hash', 'stable content', 'kw', now, 'tenant-crawl-d')
    const result = upsertImportMemory('src-d', '/docs/stable.txt', 'stable.txt', 'stable-hash', 'stable content', 'kw', now + 10, 'tenant-crawl-d')
    expect(result).toBe('hash_match')

    const memRow = db.prepare("SELECT tenant_id, memory_shadow_id FROM import_memories WHERE source_id = 'src-d'").get() as { tenant_id: string; memory_shadow_id: number }
    expect(memRow.tenant_id).toBe('tenant-crawl-d')
    const shadowRow = db.prepare("SELECT tenant_id FROM memories WHERE id = ?").get(memRow.memory_shadow_id) as { tenant_id: string }
    expect(shadowRow.tenant_id).toBe('tenant-crawl-d')
  })
})
