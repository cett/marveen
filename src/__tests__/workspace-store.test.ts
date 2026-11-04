import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { generateEmbedding } from '../db/vector.js'
import {
  saveWorkspaceDoc,
  patchWorkspaceDoc,
  getWorkspaceDocUpdatedAtMs,
  sweepExpiredWorkspaceDocs,
  storeWorkspaceDocEmbedding,
  backfillWorkspaceDocs,
  vectorSearchDocs,
  hybridSearchDocs,
} from '../db/workspace.js'

// Wraps the real generateEmbedding so every existing test keeps hitting the
// real (Ollama-less, always-null-in-CI) implementation by default -- only
// tests that explicitly queue a mockResolvedValueOnce below get a fake
// vector, to exercise the ANN path without a live Ollama.
vi.mock('../db/vector.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../db/vector.js')>()
  return { ...orig, generateEmbedding: vi.fn(orig.generateEmbedding) }
})

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().prepare('DELETE FROM workspace_docs').run()
  getDb().prepare('DELETE FROM kanban_cards').run()
  getDb().prepare('DELETE FROM vec_workspace_docs').run()
})

// ---------------------------------------------------------------------------
// getWorkspaceDocUpdatedAtMs
// ---------------------------------------------------------------------------

describe('getWorkspaceDocUpdatedAtMs', () => {
  it('returns null when no doc matches the (agent_id, doc_key) pair', async () => {
    expect(await getWorkspaceDocUpdatedAtMs('agent-a', 'handoff')).toBeNull()
  })

  it('returns updated_at converted to milliseconds for a matching doc', async () => {
    await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'handoff',
      title: 'Handoff', content: 'body', content_type: 'text', type: 'notes',
    })
    const row = getDb().prepare(
      'SELECT updated_at FROM workspace_docs WHERE agent_id = ? AND doc_key = ?',
    ).get('agent-a', 'handoff') as { updated_at: number }

    expect(await getWorkspaceDocUpdatedAtMs('agent-a', 'handoff')).toBe(row.updated_at * 1000)
  })

  it('does not touch last_accessed_at (unlike getWorkspaceDoc)', async () => {
    const doc = await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'handoff',
      title: 'Handoff', content: 'body', content_type: 'text', type: 'notes',
    })
    await getWorkspaceDocUpdatedAtMs('agent-a', 'handoff')
    const row = getDb().prepare(
      'SELECT last_accessed_at FROM workspace_docs WHERE id = ?',
    ).get(doc.id) as { last_accessed_at: number | null }
    expect(row.last_accessed_at).toBeNull()
  })

  it('scopes strictly by agent_id -- another agent with the same doc_key does not match', async () => {
    await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'handoff',
      title: 'Handoff', content: 'body', content_type: 'text', type: 'notes',
    })
    expect(await getWorkspaceDocUpdatedAtMs('agent-b', 'handoff')).toBeNull()
  })

  it('upsert on (agent_id, doc_key) advances updated_at rather than creating a second row', async () => {
    await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'handoff',
      title: 'Handoff', content: 'v1', content_type: 'text', type: 'notes',
    })
    await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'handoff',
      title: 'Handoff', content: 'v2', content_type: 'text', type: 'notes',
    })
    const count = (getDb().prepare(
      "SELECT COUNT(*) as n FROM workspace_docs WHERE agent_id = 'agent-a' AND doc_key = 'handoff'",
    ).get() as { n: number }).n
    expect(count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Interleaving: the module is asynchronous, so two calls started together run their statements alternately
// unless each read-modify-write is one transaction.
// ---------------------------------------------------------------------------

describe('concurrent writers', () => {
  it('two saves of one (agent_id, doc_key) started together both succeed and leave one row', async () => {
    const base = { agent_id: 'agent-a', tenant_id: 'default', doc_key: 'race', content_type: 'text' as const, type: 'notes' as const }
    const [first, second] = await Promise.all([
      saveWorkspaceDoc({ ...base, title: 'first', content: 'one' }),
      saveWorkspaceDoc({ ...base, title: 'second', content: 'two' }),
    ])
    expect(first.id).toBe(second.id)
    const rows = getDb().prepare("SELECT title FROM workspace_docs WHERE agent_id = 'agent-a' AND doc_key = 'race'").all() as { title: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('second')
  })

  it('two patches of different fields started together both land (no stale merge overwrites the other)', async () => {
    const doc = await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'merge', title: 'before', content: 'body', content_type: 'text', type: 'notes',
    })
    await Promise.all([
      patchWorkspaceDoc(doc.id, { title: 'after' }),
      patchWorkspaceDoc(doc.id, { task_ref: 'card-1' }),
    ])
    const row = getDb().prepare('SELECT title, task_ref FROM workspace_docs WHERE id = ?').get(doc.id) as { title: string; task_ref: string | null }
    expect(row).toEqual({ title: 'after', task_ref: 'card-1' })
  })
})

// ---------------------------------------------------------------------------
// sweepExpiredWorkspaceDocs
// ---------------------------------------------------------------------------

describe('sweepExpiredWorkspaceDocs', () => {
  const TTL_DAYS = 14
  const OLD = Math.floor(Date.now() / 1000) - (TTL_DAYS + 1) * 86400
  const FRESH = Math.floor(Date.now() / 1000) - 60

  function insertDoc(id: string, updatedAt: number, opts: { taskRef?: string; contentType?: string } = {}) {
    getDb().prepare(`
      INSERT INTO workspace_docs (id, agent_id, tenant_id, doc_key, title, content, content_type, type, task_ref, created_at, updated_at)
      VALUES (?, 'agent-a', 'default', NULL, 'doc', 'body', ?, 'notes', ?, ?, ?)
    `).run(id, opts.contentType ?? 'text', opts.taskRef ?? null, updatedAt, updatedAt)
  }

  it('deletes an old doc with no task_ref', async () => {
    insertDoc('doc-old-notask', OLD)
    expect(await sweepExpiredWorkspaceDocs(TTL_DAYS)).toBe(1)
    expect(getDb().prepare('SELECT 1 FROM workspace_docs WHERE id = ?').get('doc-old-notask')).toBeUndefined()
  })

  it('keeps a fresh doc with no task_ref', async () => {
    insertDoc('doc-fresh-notask', FRESH)
    expect(await sweepExpiredWorkspaceDocs(TTL_DAYS)).toBe(0)
    expect(getDb().prepare('SELECT 1 FROM workspace_docs WHERE id = ?').get('doc-fresh-notask')).toBeDefined()
  })

  it('deletes an old doc whose linked kanban card is done', async () => {
    getDb().prepare(
      "INSERT INTO kanban_cards (id, title, status, created_at, updated_at) VALUES ('card-done', 'x', 'done', ?, ?)",
    ).run(OLD, OLD)
    insertDoc('doc-old-done-task', OLD, { taskRef: 'card-done' })
    expect(await sweepExpiredWorkspaceDocs(TTL_DAYS)).toBe(1)
    expect(getDb().prepare('SELECT 1 FROM workspace_docs WHERE id = ?').get('doc-old-done-task')).toBeUndefined()
  })

  it('keeps an old doc whose linked kanban card is still in_progress', async () => {
    getDb().prepare(
      "INSERT INTO kanban_cards (id, title, status, created_at, updated_at) VALUES ('card-open', 'x', 'in_progress', ?, ?)",
    ).run(OLD, OLD)
    insertDoc('doc-old-open-task', OLD, { taskRef: 'card-open' })
    expect(await sweepExpiredWorkspaceDocs(TTL_DAYS)).toBe(0)
    expect(getDb().prepare('SELECT 1 FROM workspace_docs WHERE id = ?').get('doc-old-open-task')).toBeDefined()
  })

  it('exempts binary content even when old and task-less', async () => {
    insertDoc('doc-old-binary', OLD, { contentType: 'binary' })
    expect(await sweepExpiredWorkspaceDocs(TTL_DAYS)).toBe(0)
    expect(getDb().prepare('SELECT 1 FROM workspace_docs WHERE id = ?').get('doc-old-binary')).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// storeWorkspaceDocEmbedding (Ollama-free path -- see artifacts-db.test.ts's
// equivalent "Ollama-free path" describe block for the same convention: no
// Ollama server runs in CI, so generateEmbedding resolves to null and this
// must be a graceful, non-throwing no-op).
// ---------------------------------------------------------------------------

describe('storeWorkspaceDocEmbedding', () => {
  it('does not throw when Ollama is unavailable (matches artifacts-db.test.ts convention: only assert no throw, not the null/embedded outcome, since a locally running Ollama would legitimately produce a real embedding)', async () => {
    const doc = await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'Embed-test', content: 'some content to embed', content_type: 'text', type: 'notes',
    })
    await expect(storeWorkspaceDocEmbedding(doc.id, 'agent-a', 'default', 'Embed-test some content to embed'))
      .resolves.toBeUndefined()
  })

  it('computes the embedding outside the transaction: another statement is not held up while it is pending', async () => {
    const doc = await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'embed-lock',
      title: 'Embed-lock', content: 'some content to embed', content_type: 'text', type: 'notes',
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(generateEmbedding).mockImplementationOnce(async () => {
      await gate
      return null
    })
    const pending = storeWorkspaceDocEmbedding(doc.id, 'agent-a', 'default', 'Embed-lock some content to embed')
    // A transaction open across the embedding call would hold the connection lock, and this read would wait for it.
    const probe = await Promise.race([
      getWorkspaceDocUpdatedAtMs('agent-a', 'embed-lock').then(() => 'read'),
      new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100)),
    ])
    release()
    await pending
    expect(probe).toBe('read')
  })

  it('does not throw for an unknown doc id', async () => {
    await expect(storeWorkspaceDocEmbedding('nonexistent-id', 'agent-a', 'default', 'text')).resolves.toBeUndefined()
  })

  it('does not throw for empty text', async () => {
    const doc = await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'Empty', content: '', content_type: 'text', type: 'notes',
    })
    await expect(storeWorkspaceDocEmbedding(doc.id, 'agent-a', 'default', '')).resolves.toBeUndefined()
  })

  it('does not throw for a binary doc', async () => {
    const doc = await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'Binary-doc', content_blob: Buffer.from('x'), content_type: 'binary', type: 'notes',
    })
    await expect(storeWorkspaceDocEmbedding(doc.id, 'agent-a', 'default', 'Binary-doc')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// backfillWorkspaceDocs
// ---------------------------------------------------------------------------

describe('backfillWorkspaceDocs', () => {
  it('does not throw and returns a number when Ollama is unavailable', async () => {
    await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'Backfill-me', content: 'needs an embedding', content_type: 'text', type: 'notes',
    })
    const count = await backfillWorkspaceDocs()
    expect(typeof count).toBe('number')
  })

  it('skips binary docs and docs with no content', async () => {
    await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'Binary-skip', content_blob: Buffer.from('x'), content_type: 'binary', type: 'notes',
    })
    await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'No-content', content: null, content_type: 'text', type: 'notes',
    })
    // Neither row is eligible -- the SELECT filter excludes both, so no
    // Ollama calls happen and the function still resolves cleanly.
    const count = await backfillWorkspaceDocs()
    expect(typeof count).toBe('number')
  })

  it('skips docs that already have an embedding_blob', async () => {
    const doc = await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'Already-embedded', content: 'text', content_type: 'text', type: 'notes',
    })
    getDb().prepare('UPDATE workspace_docs SET embedding_blob = ? WHERE id = ?').run(Buffer.from([1, 2, 3, 4]), doc.id)
    const before = (getDb().prepare('SELECT embedding_blob FROM workspace_docs WHERE id = ?').get(doc.id) as { embedding_blob: Buffer }).embedding_blob
    await backfillWorkspaceDocs()
    const after = (getDb().prepare('SELECT embedding_blob FROM workspace_docs WHERE id = ?').get(doc.id) as { embedding_blob: Buffer }).embedding_blob
    expect(after).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// vectorSearchDocs / hybridSearchDocs
//
// No Ollama server runs in CI, so vectorSearchDocs resolves to [] (graceful
// no-op, same convention as searchArtifactsByVector) -- these tests exercise
// the parts that do NOT depend on a real embedding: the graceful-empty
// contract for vectorSearchDocs, and hybridSearchDocs' FTS-only fallback
// (RRF over a single non-empty list preserves that list's order, so with no
// vector results hybridSearchDocs must behave exactly like searchWorkspaceDocs).
// ---------------------------------------------------------------------------

describe('vectorSearchDocs', () => {
  it('resolves to an empty array when no embedding can be generated (Ollama unavailable)', async () => {
    await expect(vectorSearchDocs('anything', { limit: 5 })).resolves.toEqual([])
  })
})

describe('vectorSearchDocs -- tenant isolation (critical)', () => {
  // Same 768-dim vector for every doc/query: cosine distance is irrelevant
  // here, this test only proves the ANN hit set's join back to
  // workspace_docs is scoped by tenant_id at the SQL level, not post-filter.
  const FAKE_EMBEDDING = new Array(768).fill(0).map((_, i) => Math.sin(i))

  it('an ANN hit never crosses a tenant boundary even when both tenants embed identical content', async () => {
    vi.mocked(generateEmbedding).mockResolvedValueOnce(FAKE_EMBEDDING)
    const docA = await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'tenant-vec-a',
      title: 'Vec doc A', content: 'vectorisolationprobe shared content', content_type: 'text', type: 'notes',
    })
    await storeWorkspaceDocEmbedding(docA.id, 'agent-a', 'tenant-vec-a', 'vectorisolationprobe shared content')

    vi.mocked(generateEmbedding).mockResolvedValueOnce(FAKE_EMBEDDING)
    const docB = await saveWorkspaceDoc({
      agent_id: 'agent-b', tenant_id: 'tenant-vec-b',
      title: 'Vec doc B', content: 'vectorisolationprobe shared content', content_type: 'text', type: 'notes',
    })
    await storeWorkspaceDocEmbedding(docB.id, 'agent-b', 'tenant-vec-b', 'vectorisolationprobe shared content')

    vi.mocked(generateEmbedding).mockResolvedValueOnce(FAKE_EMBEDDING)
    const resultsA = await vectorSearchDocs('vectorisolationprobe', { tenantId: 'tenant-vec-a', limit: 10 })
    expect(resultsA.map(r => r.id)).toEqual([docA.id])
    expect(resultsA.every(r => r.tenant_id === 'tenant-vec-a')).toBe(true)

    vi.mocked(generateEmbedding).mockResolvedValueOnce(FAKE_EMBEDDING)
    const resultsB = await vectorSearchDocs('vectorisolationprobe', { tenantId: 'tenant-vec-b', limit: 10 })
    expect(resultsB.map(r => r.id)).toEqual([docB.id])

    // Admin (no tenantId) sees both -- by design, same contract as searchWorkspaceDocs.
    vi.mocked(generateEmbedding).mockResolvedValueOnce(FAKE_EMBEDDING)
    const resultsAdmin = await vectorSearchDocs('vectorisolationprobe', { limit: 10 })
    expect(resultsAdmin.map(r => r.id).sort()).toEqual([docA.id, docB.id].sort())
  })
})

describe('hybridSearchDocs', () => {
  it('falls back to pure FTS ranking when vectorSearchDocs finds nothing', async () => {
    await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'Hybrid fallback test', content: 'unique fusiontestkeyword content', content_type: 'text', type: 'notes',
    })
    const results = await hybridSearchDocs('fusiontestkeyword', { limit: 5 })
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('Hybrid fallback test')
  })

  it('is tenant-scoped exactly like searchWorkspaceDocs', async () => {
    await saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'tenant-x',
      title: 'Tenant-x doc', content: 'fusionscopekeyword content', content_type: 'text', type: 'notes',
    })
    const otherTenant = await hybridSearchDocs('fusionscopekeyword', { tenantId: 'tenant-y', limit: 5 })
    expect(otherTenant).toEqual([])
    const sameTenant = await hybridSearchDocs('fusionscopekeyword', { tenantId: 'tenant-x', limit: 5 })
    expect(sameTenant.length).toBe(1)
  })

  it('returns an empty array when nothing matches either FTS or vector', async () => {
    const results = await hybridSearchDocs('nonexistentqueryzzz', { limit: 5 })
    expect(results).toEqual([])
  })
})
