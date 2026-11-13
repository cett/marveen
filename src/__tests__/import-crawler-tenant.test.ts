// Tenant propagation in the local-FS crawler's upsert path: a source's
// tenant_id must land on both the import_memories row it creates and
// that row's shadow memories row, so tenant-scoped stats/search/recall
// queries see only their own tenant's imported content.

import { describe, it, expect, vi } from 'vitest'
import { dbx } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { upsertImportMemory } from '../web/import-crawler.js'

async function createSource(id: string, tenantId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await dbx.run(`
    INSERT INTO import_sources (id, type, path, interval_hours, enabled, created_at, updated_at, tenant_id)
    VALUES (?, 'local', '/tmp/x', 4, 1, ?, ?, ?)
  `, id, now, now, tenantId)
}

describe('upsertImportMemory: tenant propagation', () => {
  useTestDb()

  it('stamps tenantId on both the new import_memories row and its shadow memories row', async () => {
    await createSource('src-a', 'tenant-crawl-a')
    const now = Math.floor(Date.now() / 1000)
    const result = await upsertImportMemory('src-a', '/docs/note.txt', 'note.txt', 'hash1', 'quarterly budget notes', 'budget', now, 'tenant-crawl-a')
    expect(result).toBe('added')

    const memRow = (await dbx.get<{ tenant_id: string; memory_shadow_id: number }>(
      "SELECT tenant_id, memory_shadow_id FROM import_memories WHERE source_id = 'src-a' AND file_path = '/docs/note.txt'",
    ))!
    expect(memRow.tenant_id).toBe('tenant-crawl-a')
    expect(memRow.memory_shadow_id).not.toBeNull()

    const shadowRow = (await dbx.get<{ tenant_id: string }>('SELECT tenant_id FROM memories WHERE id = ?', memRow.memory_shadow_id))!
    expect(shadowRow.tenant_id).toBe('tenant-crawl-a')
  })

  it('keeps rows in separate tenants distinguishable when two sources share a file path', async () => {
    await createSource('src-a', 'tenant-a')
    await createSource('src-b', 'tenant-b')
    const now = Math.floor(Date.now() / 1000)
    await upsertImportMemory('src-a', '/docs/shared-name.txt', 'shared-name.txt', 'hashA', 'content A', 'kw', now, 'tenant-a')
    await upsertImportMemory('src-b', '/docs/shared-name.txt', 'shared-name.txt', 'hashB', 'content B', 'kw', now, 'tenant-b')

    const rowA = (await dbx.get<{ tenant_id: string }>("SELECT tenant_id FROM import_memories WHERE source_id = 'src-a'"))!
    const rowB = (await dbx.get<{ tenant_id: string }>("SELECT tenant_id FROM import_memories WHERE source_id = 'src-b'"))!
    expect(rowA.tenant_id).toBe('tenant-a')
    expect(rowB.tenant_id).toBe('tenant-b')
  })

  it('updating existing content (hash change) does not clobber the shadow row tenant_id', async () => {
    await createSource('src-c', 'tenant-crawl-c')
    const now = Math.floor(Date.now() / 1000)
    await upsertImportMemory('src-c', '/docs/versioned.txt', 'versioned.txt', 'hash-v1', 'version one', 'kw', now, 'tenant-crawl-c')

    const result = await upsertImportMemory('src-c', '/docs/versioned.txt', 'versioned.txt', 'hash-v2', 'version two', 'kw', now + 10, 'tenant-crawl-c')
    expect(result).toBe('updated')

    const memRow = (await dbx.get<{ tenant_id: string; memory_shadow_id: number }>(
      "SELECT tenant_id, memory_shadow_id FROM import_memories WHERE source_id = 'src-c'",
    ))!
    expect(memRow.tenant_id).toBe('tenant-crawl-c')

    const shadowRow = (await dbx.get<{ content: string; tenant_id: string }>('SELECT content, tenant_id FROM memories WHERE id = ?', memRow.memory_shadow_id))!
    expect(shadowRow.content).toBe('version two')
    expect(shadowRow.tenant_id).toBe('tenant-crawl-c')
  })

  it('a matching hash (no-op re-scan) still leaves the shadow row tenant_id intact', async () => {
    await createSource('src-d', 'tenant-crawl-d')
    const now = Math.floor(Date.now() / 1000)
    await upsertImportMemory('src-d', '/docs/stable.txt', 'stable.txt', 'stable-hash', 'stable content', 'kw', now, 'tenant-crawl-d')
    const result = await upsertImportMemory('src-d', '/docs/stable.txt', 'stable.txt', 'stable-hash', 'stable content', 'kw', now + 10, 'tenant-crawl-d')
    expect(result).toBe('hash_match')

    const memRow = (await dbx.get<{ tenant_id: string; memory_shadow_id: number }>("SELECT tenant_id, memory_shadow_id FROM import_memories WHERE source_id = 'src-d'"))!
    expect(memRow.tenant_id).toBe('tenant-crawl-d')
    const shadowRow = (await dbx.get<{ tenant_id: string }>('SELECT tenant_id FROM memories WHERE id = ?', memRow.memory_shadow_id))!
    expect(shadowRow.tenant_id).toBe('tenant-crawl-d')
  })
})
