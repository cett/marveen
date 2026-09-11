/**
 * GET /api/memories?q=&include_docs=... -- workspace_docs search alongside
 * memories (kanban 9156e583, default-recall P4 of #842). The critical
 * contracts under test:
 * - An explicit include_docs=0/1 always wins, regardless of the
 *   WORKSPACE_DOC_RECALL_DEFAULT setting.
 * - Absent include_docs falls back to that setting: true (the shipped
 *   default) folds workspace_docs in automatically; a caller who opts the
 *   setting back to false keeps the pre-P4 plain-array behavior with no
 *   further change on their end.
 * - Either way, the combined shape is { memories, workspace_docs }, and
 *   workspace_docs is tenant-scoped exactly like memories already are (SQL
 *   level in hybridSearchDocs, plus a defence-in-depth post-filter here).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { mockSearchMemories, mockHybridSearch, mockGetDb, mockHybridSearchDocs, mockGetEffectiveSettingValue } = vi.hoisted(() => {
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
    mockHybridSearchDocs: vi.fn().mockResolvedValue([
      { id: 'doc1', title: 'Budget plafon terv', agent_id: 'agent-a', tenant_id: 'tenant-a', type: 'plan', task_ref: '670b6218', doc_key: null, created_at: 1750000000, updated_at: 1750000000, snippet: 'The [BudgetEntry] amount' },
    ]),
    // Defaults to '1' (WORKSPACE_DOC_RECALL_DEFAULT's shipped default); tests
    // that need the opt-out-by-default scenario override with '0'.
    mockGetEffectiveSettingValue: vi.fn().mockReturnValue('1'),
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
  hybridSearchDocs: mockHybridSearchDocs,
}))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: mockGetEffectiveSettingValue,
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

beforeEach(() => { mockGetEffectiveSettingValue.mockReturnValue('1') })

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

describe('GET /api/memories?q= -- explicit include_docs=0 opt-out (always wins)', () => {
  beforeEach(() => { mockGetEffectiveSettingValue.mockReturnValue('1') })

  it('include_docs=0 forces a plain array even though the default setting is true', async () => {
    const { ctx, out } = makeCtx('/api/memories', { q: 'budget', include_docs: '0' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
    expect(mockHybridSearchDocs).not.toHaveBeenCalled()
  })

  it('returns a plain array for a non-search listing regardless of include_docs (no q)', async () => {
    const { ctx, out } = makeCtx('/api/memories', { include_docs: '1' })
    await tryHandleMemories(ctx)
    expect(Array.isArray(out.body)).toBe(true)
    expect(mockHybridSearchDocs).not.toHaveBeenCalled()
  })
})

describe('GET /api/memories?q= -- default-recall (WORKSPACE_DOC_RECALL_DEFAULT, no include_docs param)', () => {
  it('absent include_docs + setting true (shipped default) returns the combined { memories, workspace_docs } shape', async () => {
    mockGetEffectiveSettingValue.mockReturnValue('1')
    const { ctx, out } = makeCtx('/api/memories', { q: 'budget' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(false)
    expect(Array.isArray(out.body.memories)).toBe(true)
    expect(Array.isArray(out.body.workspace_docs)).toBe(true)
    expect(mockHybridSearchDocs).toHaveBeenCalled()
  })

  it('absent include_docs + setting false preserves the pre-P4 plain-array behavior', async () => {
    mockGetEffectiveSettingValue.mockReturnValue('0')
    const { ctx, out } = makeCtx('/api/memories', { q: 'budget' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
    expect(mockHybridSearchDocs).not.toHaveBeenCalled()
  })

  it('a non-admin caller only ever sees their own tenant\'s docs in the default-recall path (defence-in-depth post-filter)', async () => {
    mockGetEffectiveSettingValue.mockReturnValue('1')
    mockHybridSearchDocs.mockResolvedValueOnce([
      { id: 'doc-own', title: 'Own tenant doc', agent_id: 'agent-a', tenant_id: 'tenant-a', type: 'plan', task_ref: null, doc_key: null, created_at: 1750000000, updated_at: 1750000000, snippet: 'ok' },
      { id: 'doc-other', title: 'Other tenant doc', agent_id: 'agent-b', tenant_id: 'tenant-b', type: 'plan', task_ref: null, doc_key: null, created_at: 1750000000, updated_at: 1750000000, snippet: 'leak' },
    ])
    const { ctx, out } = makeCtx('/api/memories', { q: 'budget' }, { role: 'viewer', tenantId: 'tenant-a' })
    await tryHandleMemories(ctx)
    expect(out.body.workspace_docs).toHaveLength(1)
    expect(out.body.workspace_docs[0].id).toBe('doc-own')
  })
})

describe('GET /api/memories?q=&include_docs=1 -- opt-in combined response', () => {
  it('returns { memories, workspace_docs } and calls hybridSearchDocs with the same q/limit', async () => {
    const { ctx, out } = makeCtx('/api/memories', { q: 'budget', include_docs: '1', limit: '25' })
    await tryHandleMemories(ctx)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(false)
    expect(Array.isArray(out.body.memories)).toBe(true)
    expect(Array.isArray(out.body.workspace_docs)).toBe(true)
    expect(out.body.workspace_docs[0].title).toBe('Budget plafon terv')
    expect(mockHybridSearchDocs).toHaveBeenCalledWith('budget', expect.objectContaining({ limit: 25 }))
  })

  it('a non-admin caller is scoped to their own tenant (SQL-level, mirroring memories search)', async () => {
    const { ctx } = makeCtx('/api/memories', { q: 'budget', include_docs: '1' }, { role: 'viewer', tenantId: 'tenant-a' })
    await tryHandleMemories(ctx)
    expect(mockHybridSearchDocs).toHaveBeenCalledWith('budget', expect.objectContaining({ tenantId: 'tenant-a' }))
  })

  it('an admin caller with no ?tenant= filter passes tenantId=undefined (all tenants), matching memories search semantics', async () => {
    const { ctx } = makeCtx('/api/memories', { q: 'budget', include_docs: '1' }, { role: 'admin', tenantId: null })
    await tryHandleMemories(ctx)
    expect(mockHybridSearchDocs).toHaveBeenCalledWith('budget', expect.objectContaining({ tenantId: undefined }))
  })

  it('an admin caller with an explicit ?tenant= filter scopes workspace_docs to exactly that tenant', async () => {
    const { ctx } = makeCtx('/api/memories', { q: 'budget', include_docs: '1', tenant: 'tenant-b' }, { role: 'admin', tenantId: null })
    await tryHandleMemories(ctx)
    expect(mockHybridSearchDocs).toHaveBeenCalledWith('budget', expect.objectContaining({ tenantId: 'tenant-b' }))
  })

  it('passes agentId through when ?agent= is set', async () => {
    const { ctx } = makeCtx('/api/memories', { q: 'budget', include_docs: '1', agent: 'agent-a' })
    await tryHandleMemories(ctx)
    expect(mockHybridSearchDocs).toHaveBeenCalledWith('budget', expect.objectContaining({ agentId: 'agent-a' }))
  })

  it('passes agentId as undefined (not empty string) when no ?agent= is set', async () => {
    const { ctx } = makeCtx('/api/memories', { q: 'budget', include_docs: '1' })
    await tryHandleMemories(ctx)
    expect(mockHybridSearchDocs).toHaveBeenCalledWith('budget', expect.objectContaining({ agentId: undefined }))
  })
})
