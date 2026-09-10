/**
 * GET /api/memories?q=&include_docs=1 -- opt-in workspace_docs search
 * alongside memories (kanban 9156e583). The critical contract under test:
 * WITHOUT include_docs, the response is byte-identical in shape to before
 * this feature (a plain array) -- no existing caller (dashboard, agent
 * recall via curl/fetch) is affected. WITH it, the response becomes
 * { memories, workspace_docs }, and workspace_docs is tenant-scoped exactly
 * like memories already are.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { mockSearchMemories, mockHybridSearch, mockGetDb, mockSearchWorkspaceDocs } = vi.hoisted(() => {
  const fakeMemory = (id: number) => ({
    id, agent_id: 'agent-a', content: 'test content', keywords: 'test',
    category: 'warm', created_at: 1750000000, accessed_at: 1750000001,
    chat_id: '123', topic_key: null, sector: 'semantic', salience: 1.0,
    auto_generated: 0, embedding: null, tenant_id: 'tenant-a',
  })
  return {
    mockSearchMemories: vi.fn().mockReturnValue([fakeMemory(1)]),
    mockHybridSearch: vi.fn().mockResolvedValue([fakeMemory(1)]),
    mockGetDb: vi.fn().mockReturnValue({
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]), run: vi.fn() }),
    }),
    mockSearchWorkspaceDocs: vi.fn().mockReturnValue([
      { id: 'doc1', title: 'Budget plafon terv', agent_id: 'agent-a', tenant_id: 'tenant-a', type: 'plan', task_ref: '670b6218', doc_key: null, created_at: 1750000000, updated_at: 1750000000, snippet: 'The [BudgetEntry] amount' },
    ]),
  }
})

vi.mock('../db.js', () => ({
  saveAgentMemory: vi.fn(),
  getAgentMemories: vi.fn().mockReturnValue([]),
  searchAgentMemories: vi.fn().mockReturnValue([]),
  getMemoryStats: vi.fn(),
  updateMemory: vi.fn(),
  hybridSearch: mockHybridSearch,
  backfillEmbeddings: vi.fn(),
  clearMemoryCache: vi.fn(),
  searchMemories: mockSearchMemories,
  getMemoriesForChat: vi.fn().mockReturnValue([]),
  getDb: mockGetDb,
  touchMemoriesAccessed: vi.fn(),
  recordMemoryRead: vi.fn(),
  recordMemoryReadBatch: vi.fn(),
  getStaleMemories: vi.fn().mockReturnValue([]),
  getMemoryVersions: vi.fn().mockReturnValue([]),
  runMemoryMaintenance: vi.fn(),
  runLinkMaintenance: vi.fn(),
  getLinksForMemories: vi.fn().mockReturnValue([]),
  writeAgentAuditLog: vi.fn(),
  syncVecMemoryDelete: vi.fn(),
}))

vi.mock('../workspace-store.js', () => ({
  searchWorkspaceDocs: mockSearchWorkspaceDocs,
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  ALLOWED_CHAT_ID: '123',
  OLLAMA_URL: 'http://localhost:11434',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { tryHandleMemories } from '../web/routes/memories.js'

function makeCtx(
  path: string,
  params: Record<string, string>,
  opts: { role?: string; tenantId?: string | null } = {},
): { ctx: RouteContext; out: { status: number; body: any } } {
  const req = new EventEmitter() as any
  req.method = 'GET'
  req.headers = { 'accept-encoding': '' }
  setImmediate(() => { req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || 'null') } catch { out.body = b } },
    setHeader: vi.fn(),
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const ctx = { req, res, path: url.pathname, method: 'GET', url, role: opts.role ?? 'viewer', tenantId: opts.tenantId ?? 'tenant-a' } as RouteContext
  return { ctx, out }
}

describe('GET /api/memories?q= -- backward compatibility (no include_docs)', () => {
  it('returns a plain array when include_docs is absent, exactly as before this feature', async () => {
    const { ctx, out } = makeCtx('/api/memories', { q: 'budget' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
    expect(mockSearchWorkspaceDocs).not.toHaveBeenCalled()
  })

  it('returns a plain array for a non-search listing regardless of include_docs (no q)', async () => {
    const { ctx, out } = makeCtx('/api/memories', { include_docs: '1' })
    await tryHandleMemories(ctx)
    expect(Array.isArray(out.body)).toBe(true)
    expect(mockSearchWorkspaceDocs).not.toHaveBeenCalled()
  })

  it('include_docs=0 or any non-"1" value behaves as absent (plain array)', async () => {
    const { ctx, out } = makeCtx('/api/memories', { q: 'budget', include_docs: '0' })
    await tryHandleMemories(ctx)
    expect(Array.isArray(out.body)).toBe(true)
    expect(mockSearchWorkspaceDocs).not.toHaveBeenCalled()
  })
})

describe('GET /api/memories?q=&include_docs=1 -- opt-in combined response', () => {
  it('returns { memories, workspace_docs } and calls searchWorkspaceDocs with the same q/limit', async () => {
    const { ctx, out } = makeCtx('/api/memories', { q: 'budget', include_docs: '1', limit: '25' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(false)
    expect(Array.isArray(out.body.memories)).toBe(true)
    expect(Array.isArray(out.body.workspace_docs)).toBe(true)
    expect(out.body.workspace_docs[0].title).toBe('Budget plafon terv')
    expect(mockSearchWorkspaceDocs).toHaveBeenCalledWith('budget', expect.objectContaining({ limit: 25 }))
  })

  it('a non-admin caller is scoped to their own tenant (SQL-level, mirroring memories search)', async () => {
    const { ctx } = makeCtx('/api/memories', { q: 'budget', include_docs: '1' }, { role: 'viewer', tenantId: 'tenant-a' })
    await tryHandleMemories(ctx)
    expect(mockSearchWorkspaceDocs).toHaveBeenCalledWith('budget', expect.objectContaining({ tenantId: 'tenant-a' }))
  })

  it('an admin caller with no ?tenant= filter passes tenantId=undefined (all tenants), matching memories search semantics', async () => {
    const { ctx } = makeCtx('/api/memories', { q: 'budget', include_docs: '1' }, { role: 'admin', tenantId: null })
    await tryHandleMemories(ctx)
    expect(mockSearchWorkspaceDocs).toHaveBeenCalledWith('budget', expect.objectContaining({ tenantId: undefined }))
  })

  it('an admin caller with an explicit ?tenant= filter scopes workspace_docs to exactly that tenant', async () => {
    const { ctx } = makeCtx('/api/memories', { q: 'budget', include_docs: '1', tenant: 'tenant-b' }, { role: 'admin', tenantId: null })
    await tryHandleMemories(ctx)
    expect(mockSearchWorkspaceDocs).toHaveBeenCalledWith('budget', expect.objectContaining({ tenantId: 'tenant-b' }))
  })

  it('passes agentId through when ?agent= is set', async () => {
    const { ctx } = makeCtx('/api/memories', { q: 'budget', include_docs: '1', agent: 'agent-a' })
    await tryHandleMemories(ctx)
    expect(mockSearchWorkspaceDocs).toHaveBeenCalledWith('budget', expect.objectContaining({ agentId: 'agent-a' }))
  })

  it('passes agentId as undefined (not empty string) when no ?agent= is set', async () => {
    const { ctx } = makeCtx('/api/memories', { q: 'budget', include_docs: '1' })
    await tryHandleMemories(ctx)
    expect(mockSearchWorkspaceDocs).toHaveBeenCalledWith('budget', expect.objectContaining({ agentId: undefined }))
  })
})
