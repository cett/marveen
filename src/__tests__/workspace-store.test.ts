import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  saveWorkspaceDoc,
  getWorkspaceDocUpdatedAtMs,
  sweepExpiredWorkspaceDocs,
  storeWorkspaceDocEmbedding,
  backfillWorkspaceDocs,
} from '../workspace-store.js'

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().prepare('DELETE FROM workspace_docs').run()
  getDb().prepare('DELETE FROM kanban_cards').run()
})

// ---------------------------------------------------------------------------
// getWorkspaceDocUpdatedAtMs
// ---------------------------------------------------------------------------

describe('getWorkspaceDocUpdatedAtMs', () => {
  it('returns null when no doc matches the (agent_id, doc_key) pair', () => {
    expect(getWorkspaceDocUpdatedAtMs('agent-a', 'handoff')).toBeNull()
  })

  it('returns updated_at converted to milliseconds for a matching doc', () => {
    saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'handoff',
      title: 'Handoff', content: 'body', content_type: 'text', type: 'notes',
    })
    const row = getDb().prepare(
      'SELECT updated_at FROM workspace_docs WHERE agent_id = ? AND doc_key = ?',
    ).get('agent-a', 'handoff') as { updated_at: number }

    expect(getWorkspaceDocUpdatedAtMs('agent-a', 'handoff')).toBe(row.updated_at * 1000)
  })

  it('does not touch last_accessed_at (unlike getWorkspaceDoc)', () => {
    const doc = saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'handoff',
      title: 'Handoff', content: 'body', content_type: 'text', type: 'notes',
    })
    getWorkspaceDocUpdatedAtMs('agent-a', 'handoff')
    const row = getDb().prepare(
      'SELECT last_accessed_at FROM workspace_docs WHERE id = ?',
    ).get(doc.id) as { last_accessed_at: number | null }
    expect(row.last_accessed_at).toBeNull()
  })

  it('scopes strictly by agent_id -- another agent with the same doc_key does not match', () => {
    saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'handoff',
      title: 'Handoff', content: 'body', content_type: 'text', type: 'notes',
    })
    expect(getWorkspaceDocUpdatedAtMs('agent-b', 'handoff')).toBeNull()
  })

  it('upsert on (agent_id, doc_key) advances updated_at rather than creating a second row', () => {
    saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default', doc_key: 'handoff',
      title: 'Handoff', content: 'v1', content_type: 'text', type: 'notes',
    })
    saveWorkspaceDoc({
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

  it('deletes an old doc with no task_ref', () => {
    insertDoc('doc-old-notask', OLD)
    expect(sweepExpiredWorkspaceDocs(TTL_DAYS)).toBe(1)
    expect(getDb().prepare('SELECT 1 FROM workspace_docs WHERE id = ?').get('doc-old-notask')).toBeUndefined()
  })

  it('keeps a fresh doc with no task_ref', () => {
    insertDoc('doc-fresh-notask', FRESH)
    expect(sweepExpiredWorkspaceDocs(TTL_DAYS)).toBe(0)
    expect(getDb().prepare('SELECT 1 FROM workspace_docs WHERE id = ?').get('doc-fresh-notask')).toBeDefined()
  })

  it('deletes an old doc whose linked kanban card is done', () => {
    getDb().prepare(
      "INSERT INTO kanban_cards (id, title, status, created_at, updated_at) VALUES ('card-done', 'x', 'done', ?, ?)",
    ).run(OLD, OLD)
    insertDoc('doc-old-done-task', OLD, { taskRef: 'card-done' })
    expect(sweepExpiredWorkspaceDocs(TTL_DAYS)).toBe(1)
    expect(getDb().prepare('SELECT 1 FROM workspace_docs WHERE id = ?').get('doc-old-done-task')).toBeUndefined()
  })

  it('keeps an old doc whose linked kanban card is still in_progress', () => {
    getDb().prepare(
      "INSERT INTO kanban_cards (id, title, status, created_at, updated_at) VALUES ('card-open', 'x', 'in_progress', ?, ?)",
    ).run(OLD, OLD)
    insertDoc('doc-old-open-task', OLD, { taskRef: 'card-open' })
    expect(sweepExpiredWorkspaceDocs(TTL_DAYS)).toBe(0)
    expect(getDb().prepare('SELECT 1 FROM workspace_docs WHERE id = ?').get('doc-old-open-task')).toBeDefined()
  })

  it('exempts binary content even when old and task-less', () => {
    insertDoc('doc-old-binary', OLD, { contentType: 'binary' })
    expect(sweepExpiredWorkspaceDocs(TTL_DAYS)).toBe(0)
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
    const doc = saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'Embed-test', content: 'some content to embed', content_type: 'text', type: 'notes',
    })
    await expect(storeWorkspaceDocEmbedding(doc.id, 'agent-a', 'default', 'Embed-test some content to embed'))
      .resolves.toBeUndefined()
  })

  it('does not throw for an unknown doc id', async () => {
    await expect(storeWorkspaceDocEmbedding('nonexistent-id', 'agent-a', 'default', 'text')).resolves.toBeUndefined()
  })

  it('does not throw for empty text', async () => {
    const doc = saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'Empty', content: '', content_type: 'text', type: 'notes',
    })
    await expect(storeWorkspaceDocEmbedding(doc.id, 'agent-a', 'default', '')).resolves.toBeUndefined()
  })

  it('does not throw for a binary doc', async () => {
    const doc = saveWorkspaceDoc({
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
    saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'Backfill-me', content: 'needs an embedding', content_type: 'text', type: 'notes',
    })
    const count = await backfillWorkspaceDocs()
    expect(typeof count).toBe('number')
  })

  it('skips binary docs and docs with no content', async () => {
    saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'Binary-skip', content_blob: Buffer.from('x'), content_type: 'binary', type: 'notes',
    })
    saveWorkspaceDoc({
      agent_id: 'agent-a', tenant_id: 'default',
      title: 'No-content', content: null, content_type: 'text', type: 'notes',
    })
    // Neither row is eligible -- the SELECT filter excludes both, so no
    // Ollama calls happen and the function still resolves cleanly.
    const count = await backfillWorkspaceDocs()
    expect(typeof count).toBe('number')
  })

  it('skips docs that already have an embedding_blob', async () => {
    const doc = saveWorkspaceDoc({
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
