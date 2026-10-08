import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// Node fixtures use neutral agent-a / agent-b names (no internal identifiers)
const NODE_A = { id: 1, content: 'Node A content here', agent_id: 'agent-a', category: 'warm', created_at: 1000, accessed_at: 2000 }
const NODE_B = { id: 2, content: 'Node B content here', agent_id: 'agent-a', category: 'cold', created_at: 900, accessed_at: 1900 }
const NODE_C = { id: 3, content: 'Node C belongs to agent-b and has a long content string exceeding forty chars', agent_id: 'agent-b', category: 'hot', created_at: 800, accessed_at: 1800 }

// Edge: A -> B (both in node set), C -> X where X is absent (should be filtered)
const EDGE_AB = { src_id: 1, dst_id: 2, weight: 0.9, created_at: 1100 }
const EDGE_GHOST = { src_id: 3, dst_id: 99, weight: 0.85, created_at: 1050 }  // dst_id 99 not in nodes

vi.mock('../db.js', () => ({
  saveAgentMemory: vi.fn(),
  getAgentMemories: vi.fn().mockReturnValue([]),
  searchAgentMemories: vi.fn().mockReturnValue([]),
  getMemoryStats: vi.fn().mockReturnValue({ total: 0 }),
  updateMemory: vi.fn().mockReturnValue(true),
  hybridSearch: vi.fn().mockResolvedValue([]),
  backfillEmbeddings: vi.fn().mockResolvedValue(0),
  clearMemoryCache: vi.fn(),
  searchMemories: vi.fn().mockReturnValue([]),
  getMemoriesForChat: vi.fn().mockReturnValue([]),
  listMemoryGraphNodes: vi.fn().mockReturnValue([]),
  listMemoryLinksAmong: vi.fn().mockReturnValue([]),
  listMemoryLinkDegrees: vi.fn().mockReturnValue([]),
  touchMemoriesAccessed: vi.fn(),
  recordMemoryRead: vi.fn(),
  recordMemoryReadBatch: vi.fn(),
  getStaleMemories: vi.fn().mockReturnValue([]),
  getMemoryVersions: vi.fn().mockReturnValue([]),
  runMemoryMaintenance: vi.fn().mockResolvedValue({}),
  runLinkMaintenance: vi.fn().mockResolvedValue({}),
  getLinksForMemories: vi.fn().mockReturnValue([]),
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'agent-a',
  ALLOWED_CHAT_ID: '0',
  OLLAMA_URL: 'http://localhost:11434',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: () => '0',
}))

import { listMemoryGraphNodes, listMemoryLinksAmong, listMemoryLinkDegrees } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'

// Stage what the three db helpers return for one request.
function stage(nodes: unknown[], edges: unknown[] = [], degrees: unknown[] = []) {
  vi.mocked(listMemoryGraphNodes).mockReturnValue(nodes as never)
  vi.mocked(listMemoryLinksAmong).mockReturnValue(edges as never)
  vi.mocked(listMemoryLinkDegrees).mockReturnValue(degrees as never)
}

function makeCtx(
  path: string,
  role: 'admin' | 'viewer' | 'read_only' = 'viewer',
  tenantId: string | null = null,
): { ctx: RouteContext; out: { status: number; body: any } } {
  const req = new EventEmitter() as any
  req.method = 'GET'
  req.headers = {}
  setImmediate(() => { req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) {
      try { out.body = JSON.parse(b || '{}') } catch { out.body = b }
    },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method: 'GET', url, role, tenantId } as RouteContext
  return { ctx, out }
}

describe('GET /api/memories/graph', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stage([])
  })

  it('returns nodes, edges, meta structure', async () => {
    stage([NODE_A, NODE_B], [EDGE_AB], [{ src_id: 1, degree: 1 }])

    const { ctx, out } = makeCtx('/api/memories/graph')
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body.nodes)).toBe(true)
    expect(Array.isArray(out.body.edges)).toBe(true)
    expect(out.body.meta).toBeDefined()
    expect(typeof out.body.meta.fetched_at).toBe('number')
  })

  it('node labels are truncated to 40 chars + ellipsis when longer', async () => {
    stage([NODE_C])

    const { ctx, out } = makeCtx('/api/memories/graph')
    await tryHandleMemories(ctx)
    const node = out.body.nodes[0]
    expect(node.label.length).toBeLessThanOrEqual(43)  // 40 + '...'
    expect(node.label).toMatch(/\.\.\.$/)
  })

  it('nodes include required fields (id, label, tier, agent, degree, created_at, accessed_at)', async () => {
    stage([NODE_A])

    const { ctx, out } = makeCtx('/api/memories/graph')
    await tryHandleMemories(ctx)
    const node = out.body.nodes[0]
    expect(node.id).toBe(1)
    expect(node.tier).toBe('warm')
    expect(node.agent).toBe('agent-a')
    expect(typeof node.degree).toBe('number')
    expect(typeof node.created_at).toBe('number')
    expect(typeof node.accessed_at).toBe('number')
  })

  it('edges with both endpoints in nodes are included', async () => {
    stage([NODE_A, NODE_B], [EDGE_AB])

    const { ctx, out } = makeCtx('/api/memories/graph')
    await tryHandleMemories(ctx)
    expect(out.body.edges).toHaveLength(1)
    expect(out.body.edges[0].src_id).toBe(1)
    expect(out.body.edges[0].dst_id).toBe(2)
  })

  it('edges whose endpoint is absent from nodes are filtered out (AND not OR)', async () => {
    // EDGE_GHOST has dst_id=99 which is not in the node set
    stage([NODE_C], [EDGE_GHOST])

    const { ctx, out } = makeCtx('/api/memories/graph')
    await tryHandleMemories(ctx)
    // EDGE_GHOST dst_id=99 is not in nodes, so it must be filtered
    expect(out.body.edges).toHaveLength(0)
  })

  it('orphan_count reflects nodes with no edge connections', async () => {
    // NODE_A and NODE_B: only A-B edge, NODE_C is orphan
    stage([NODE_A, NODE_B, NODE_C], [EDGE_AB], [{ src_id: 1, degree: 1 }])

    const { ctx, out } = makeCtx('/api/memories/graph')
    await tryHandleMemories(ctx)
    expect(out.body.meta.orphan_count).toBe(1)  // only NODE_C has no edges
  })

  it('agent filter param is passed to node query', async () => {
    stage([NODE_A])

    const { ctx, out } = makeCtx('/api/memories/graph?agent=agent-a')
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    // limit, agent filter, then the tenant scope ('default' -- no
    // ctx.tenantId in this fixture)
    expect(listMemoryGraphNodes).toHaveBeenCalledWith(200, 'agent-a', 'default')
  })

  it('#810: non-admin viewer is scoped to their own tenant, agent branch', async () => {
    stage([NODE_A])

    const { ctx } = makeCtx('/api/memories/graph?agent=agent-a', 'viewer', 'tenant-a')
    await tryHandleMemories(ctx)
    expect(listMemoryGraphNodes).toHaveBeenCalledWith(200, 'agent-a', 'tenant-a')
  })

  it('#810: non-admin viewer is scoped to their own tenant, no-agent branch', async () => {
    const { ctx } = makeCtx('/api/memories/graph', 'viewer', 'tenant-a')
    await tryHandleMemories(ctx)
    expect(listMemoryGraphNodes).toHaveBeenCalledWith(200, undefined, 'tenant-a')
  })

  it('#810: a non-admin cannot escape their tenant via ?tenant= (param ignored)', async () => {
    const { ctx } = makeCtx('/api/memories/graph?tenant=tenant-b', 'viewer', 'tenant-a')
    await tryHandleMemories(ctx)
    expect(listMemoryGraphNodes).toHaveBeenCalledWith(200, undefined, 'tenant-a')
  })

  it('#810: admin with no ?tenant= sees every tenant (no tenant_id filter)', async () => {
    const { ctx } = makeCtx('/api/memories/graph', 'admin', null)
    await tryHandleMemories(ctx)
    expect(listMemoryGraphNodes).toHaveBeenCalledWith(200, undefined, undefined)
  })

  it('#810: admin with ?tenant= narrows to that one tenant', async () => {
    const { ctx } = makeCtx('/api/memories/graph?tenant=tenant-b', 'admin', null)
    await tryHandleMemories(ctx)
    expect(listMemoryGraphNodes).toHaveBeenCalledWith(200, undefined, 'tenant-b')
  })

  it('limit param is clamped to max 500', async () => {
    const { ctx } = makeCtx('/api/memories/graph?limit=9999')
    await tryHandleMemories(ctx)
    // The limit must be clamped to <= 500
    expect(listMemoryGraphNodes).toHaveBeenCalledWith(500, undefined, 'default')
  })

  it('weight_min default is 0.75 when not specified', async () => {
    stage([NODE_A, NODE_B])

    const { ctx } = makeCtx('/api/memories/graph')
    await tryHandleMemories(ctx)
    expect(listMemoryLinksAmong).toHaveBeenCalledWith([1, 2], 0.75)
    expect(listMemoryLinkDegrees).toHaveBeenCalledWith([1, 2], 0.75)
  })

  it('returns empty nodes/edges when no memories exist', async () => {
    const { ctx, out } = makeCtx('/api/memories/graph')
    await tryHandleMemories(ctx)
    expect(out.body.nodes).toHaveLength(0)
    expect(out.body.edges).toHaveLength(0)
    expect(out.body.meta.total_memories).toBe(0)
    expect(out.body.meta.orphan_count).toBe(0)
  })
})
