// Real-DB checks for the read helpers behind the /api/memories routes. The
// route tests stub these out, so the tenant narrowing and the link/degree
// shape are pinned here against actual SQL.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  getDb,
  searchMemoriesLikeForAgent,
  searchMemoriesLike,
  listUpdatedSinceLastReadIds,
  listRecentMemoryIdsForAgent,
  listMemoryGraphNodes,
  listMemoryGraphNodesInWindow,
  listMemoryLinksAmong,
  listMemoryLinkDegrees,
  listCategoryChangesInWindow,
  getMemoryDetailRow,
  countMemoryReads,
  listMemoryNeighbors,
  listMemoryCategoryHistory,
  getImportMetaForShadow,
  getMemoryById,
  getMemoryOwnerRow,
  deleteMemoryRow,
} from '../db.js'

function seed(
  content: string,
  agent: string,
  tenant: string,
  opts: { category?: string; createdAt?: number; accessedAt?: number; updatedAt?: number | null } = {},
): number {
  const createdAt = opts.createdAt ?? 1000
  return (getDb().prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, updated_at, agent_id, category, auto_generated, keywords, tenant_id)
     VALUES ('0', NULL, ?, 'semantic', 1.0, ?, ?, ?, ?, ?, 0, 'kw', ?) RETURNING id`
  ).get(content, createdAt, opts.accessedAt ?? createdAt, opts.updatedAt ?? null, agent, opts.category ?? 'warm', tenant) as { id: number }).id
}

function link(src: number, dst: number, weight: number, createdAt = 1100): void {
  getDb().prepare("INSERT INTO memory_links (src_id, dst_id, link_type, weight, created_at) VALUES (?, ?, 'explicit', ?, ?)")
    .run(src, dst, weight, createdAt)
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('LIKE fallbacks', () => {
  it('agent variant matches own and shared rows, narrowed to the tenant', () => {
    seed('needle own', 'agent-a', 'tenant-a')
    seed('needle shared', 'agent-b', 'tenant-a', { category: 'shared' })
    seed('needle other agent', 'agent-b', 'tenant-a')
    seed('needle other tenant', 'agent-a', 'tenant-b')
    const got = searchMemoriesLikeForAgent('agent-a', 'needle', 10, 'tenant-a').map((m) => m.content).sort()
    expect(got).toEqual(['needle own', 'needle shared'])
  })

  it('agent variant is unscoped without a tenant id', () => {
    seed('needle one', 'agent-a', 'tenant-a')
    seed('needle two', 'agent-a', 'tenant-b')
    expect(searchMemoriesLikeForAgent('agent-a', 'needle', 10)).toHaveLength(2)
  })

  it('plain variant narrows to the tenant and honours the limit', () => {
    seed('needle a1', 'agent-a', 'tenant-a', { accessedAt: 10 })
    seed('needle a2', 'agent-a', 'tenant-a', { accessedAt: 20 })
    seed('needle b1', 'agent-a', 'tenant-b')
    expect(searchMemoriesLike('needle', 10, 'tenant-a')).toHaveLength(2)
    expect(searchMemoriesLike('needle', 1, 'tenant-a').map((m) => m.content)).toEqual(['needle a2'])
    expect(searchMemoriesLike('needle', 10)).toHaveLength(3)
  })
})

describe('listUpdatedSinceLastReadIds', () => {
  it('returns only memories updated after the agent last read them', () => {
    const fresh = seed('fresh', 'agent-a', 'default', { updatedAt: 500 })
    const read = seed('already read', 'agent-a', 'default', { updatedAt: 500 })
    const never = seed('never read', 'agent-a', 'default', { updatedAt: 500 })
    getDb().prepare("INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES ('agent-a', ?, 400, 'direct')").run(fresh)
    getDb().prepare("INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES ('agent-a', ?, 600, 'direct')").run(read)
    // another agent's read must not count
    getDb().prepare("INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES ('agent-b', ?, 900, 'direct')").run(fresh)
    expect(listUpdatedSinceLastReadIds('agent-a', [fresh, read, never]).sort()).toEqual([fresh, never].sort())
  })
})

describe('graph nodes', () => {
  it('listMemoryGraphNodes: tenant + agent narrowing, newest access first, limit', () => {
    const a1 = seed('a1', 'agent-a', 'tenant-a', { accessedAt: 10 })
    const a2 = seed('a2', 'agent-a', 'tenant-a', { accessedAt: 20 })
    seed('b1', 'agent-a', 'tenant-b', { accessedAt: 30 })
    seed('c1', 'agent-b', 'tenant-a', { accessedAt: 40 })
    expect(listMemoryGraphNodes(10, undefined, 'tenant-a').map((n) => n.id)).toEqual([seedIdOf('c1'), a2, a1])
    expect(listMemoryGraphNodes(10, 'agent-a', 'tenant-a').map((n) => n.id)).toEqual([a2, a1])
    expect(listMemoryGraphNodes(1, 'agent-a', 'tenant-a').map((n) => n.id)).toEqual([a2])
    expect(listMemoryGraphNodes(10, 'agent-a')).toHaveLength(3)
    expect(listMemoryGraphNodes(10)).toHaveLength(4)
  })

  it('listMemoryGraphNodesInWindow: window bounds inclusive, tenant narrowing, oldest first', () => {
    const early = seed('early', 'agent-a', 'tenant-a', { createdAt: 100 })
    const edge = seed('edge', 'agent-a', 'tenant-a', { createdAt: 200 })
    seed('late', 'agent-a', 'tenant-a', { createdAt: 900 })
    seed('other tenant', 'agent-a', 'tenant-b', { createdAt: 150 })
    expect(listMemoryGraphNodesInWindow(100, 200, undefined, 'tenant-a').map((n) => n.id)).toEqual([early, edge])
    expect(listMemoryGraphNodesInWindow(100, 200, 'agent-b', 'tenant-a')).toEqual([])
    expect(listMemoryGraphNodesInWindow(100, 200)).toHaveLength(3)
  })
})

function seedIdOf(content: string): number {
  return (getDb().prepare('SELECT id FROM memories WHERE content = ?').get(content) as { id: number }).id
}

describe('links', () => {
  it('listMemoryLinksAmong keeps only edges with both ends in the set and weight >= min', () => {
    const a = seed('a', 'agent-a', 'default')
    const b = seed('b', 'agent-a', 'default')
    const c = seed('c', 'agent-a', 'default')
    link(a, b, 0.9)
    link(a, c, 0.5) // below threshold
    expect(listMemoryLinksAmong([a, b], 0.75).map((e) => [e.src_id, e.dst_id])).toEqual([[a, b]])
    expect(listMemoryLinksAmong([a], 0.75)).toEqual([]) // dst outside the set
    expect(listMemoryLinksAmong([], 0.75)).toEqual([])
  })

  it('listMemoryLinkDegrees counts outgoing edges per source above the threshold', () => {
    const a = seed('a', 'agent-a', 'default')
    const b = seed('b', 'agent-a', 'default')
    const c = seed('c', 'agent-a', 'default')
    link(a, b, 0.9)
    link(a, c, 0.8)
    link(b, c, 0.4)
    expect(listMemoryLinkDegrees([a, b, c], 0.75)).toEqual([{ src_id: a, degree: 2 }])
    expect(listMemoryLinkDegrees([], 0.75)).toEqual([])
  })

  it('listMemoryNeighbors returns up to 5 strongest per direction, weight >= 0.75', () => {
    const hub = seed('hub', 'agent-a', 'default')
    const out = seed('out', 'agent-a', 'default')
    const inn = seed('in', 'agent-a', 'default')
    const weak = seed('weak', 'agent-a', 'default')
    link(hub, out, 0.9)
    link(inn, hub, 0.8)
    link(hub, weak, 0.5)
    const got = listMemoryNeighbors(hub)
    expect(got.map((n) => [n.id, n.direction])).toEqual([[out, 'outgoing'], [inn, 'incoming']])
  })
})

describe('version history', () => {
  it('listCategoryChangesInWindow filters by type, window and id set', () => {
    const a = seed('a', 'agent-a', 'default')
    const b = seed('b', 'agent-a', 'default')
    const ins = getDb().prepare("INSERT INTO memory_versions (memory_id, content, category, keywords, changed_at, changed_by, change_type) VALUES (?, 'x', ?, NULL, ?, 'sys', ?)")
    ins.run(a, 'cold', 150, 'category_change')
    ins.run(a, 'cold', 160, 'update') // wrong type
    ins.run(a, 'warm', 999, 'category_change') // outside window
    ins.run(b, 'cold', 150, 'category_change') // outside id set
    expect(listCategoryChangesInWindow([a], 100, 200)).toEqual([{ memory_id: a, changed_at: 150, category: 'cold' }])
    expect(listCategoryChangesInWindow([], 100, 200)).toEqual([])
  })

  it('listMemoryCategoryHistory returns category_change rows oldest first', () => {
    const a = seed('a', 'agent-a', 'default')
    const ins = getDb().prepare("INSERT INTO memory_versions (memory_id, content, category, keywords, changed_at, changed_by, change_type) VALUES (?, 'x', ?, NULL, ?, 'sys', ?)")
    ins.run(a, 'warm', 300, 'category_change')
    ins.run(a, 'cold', 100, 'category_change')
    ins.run(a, 'hot', 200, 'update')
    expect(listMemoryCategoryHistory(a).map((r) => r.category)).toEqual(['cold', 'warm'])
  })
})

describe('single-row helpers', () => {
  it('detail row, read count and by-id lookup', () => {
    const a = seed('detail me', 'agent-a', 'tenant-a')
    getDb().prepare("INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES ('agent-a', ?, 5, 'direct')").run(a)
    getDb().prepare("INSERT INTO span_reads (agent_id, memory_id, read_at, context) VALUES ('agent-b', ?, 6, 'search')").run(a)
    expect(getMemoryDetailRow(a)?.content).toBe('detail me')
    expect(getMemoryDetailRow(a + 100)).toBeUndefined()
    expect(countMemoryReads(a)).toBe(2)
    expect(getMemoryById(a)?.tenant_id).toBe('tenant-a')
    expect(getMemoryById(a + 100)).toBeUndefined()
  })

  it('owner row exposes agent and tenant; delete removes exactly that row', () => {
    const a = seed('a', 'agent-a', 'tenant-a')
    const b = seed('b', 'agent-b', 'tenant-b')
    expect(getMemoryOwnerRow(a)).toEqual({ agent_id: 'agent-a', tenant_id: 'tenant-a' })
    expect(getMemoryOwnerRow(a + 100)).toBeUndefined()
    expect(deleteMemoryRow(a)).toBe(1)
    expect(deleteMemoryRow(a)).toBe(0)
    expect(getMemoryById(b)).toBeDefined()
  })

  it('getImportMetaForShadow resolves file and source label, null when absent', () => {
    const shadow = seed('shadow', 'import', 'default')
    getDb().prepare("INSERT INTO import_sources (id, type, path, label, interval_hours, enabled, created_at, updated_at, tenant_id) VALUES ('src1', 'local', '/docs', 'Docs', 4, 1, 1, 1, 'default')").run()
    getDb().prepare("INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, last_seen_at, created_at, updated_at, memory_shadow_id) VALUES ('im1', 'src1', '/docs/a.md', 'a.md', 'h', 'c', 1, 1, 1, ?)").run(shadow)
    expect(getImportMetaForShadow(shadow)).toEqual({ file_name: 'a.md', file_path: '/docs/a.md', source_label: 'Docs' })
    expect(getImportMetaForShadow(shadow + 100)).toBeUndefined()
  })
})

describe('listRecentMemoryIdsForAgent', () => {
  it('returns the agent ids newest-accessed first, capped by the limit', () => {
    const a1 = seed('a1', 'agent-a', 'default', { accessedAt: 10 })
    const a2 = seed('a2', 'agent-a', 'default', { accessedAt: 20 })
    seed('b1', 'agent-b', 'default', { accessedAt: 30 })
    expect(listRecentMemoryIdsForAgent('agent-a', 10)).toEqual([a2, a1])
    expect(listRecentMemoryIdsForAgent('agent-a', 1)).toEqual([a2])
  })
})
