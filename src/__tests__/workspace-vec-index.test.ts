// The vec index of workspace_docs next to the rows: what save / patch / delete / sweep leave in
// vec_workspace_docs, the savepoint around the best-effort vec write, and the invariant "a vec row exists only
// while its doc does" when the writers are started together (the module is asynchronous, so their statements
// interleave unless each unit is one transaction).
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { generateEmbedding, floatsToBlob } from '../db/vector.js'
import {
  saveWorkspaceDoc, patchWorkspaceDoc, deleteWorkspaceDoc, sweepExpiredWorkspaceDocs,
  storeWorkspaceDocEmbedding, backfillWorkspaceDocs, getWorkspaceDocUpdatedAtMs,
} from '../db/workspace.js'

vi.mock('../db/vector.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../db/vector.js')>()
  return { ...orig, generateEmbedding: vi.fn(orig.generateEmbedding) }
})

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  vi.mocked(generateEmbedding).mockClear()
  getDb().prepare('DELETE FROM workspace_docs').run()
  getDb().prepare('DELETE FROM kanban_cards').run()
  getDb().prepare('DELETE FROM vec_workspace_docs').run()
})

const VEC = new Array(768).fill(0).map((_, i) => Math.sin(i))
const VEC2 = new Array(768).fill(0).map((_, i) => Math.cos(i))
const blob = (v: number[]) => floatsToBlob(v)
const vecRows = (id: string) => (getDb().prepare('SELECT COUNT(*) n FROM vec_workspace_docs WHERE doc_id = ?').get(id) as { n: number }).n
const orphans = () => (getDb().prepare('SELECT COUNT(*) n FROM vec_workspace_docs WHERE doc_id NOT IN (SELECT id FROM workspace_docs)').get() as { n: number }).n
const docRows = (id: string) => (getDb().prepare('SELECT COUNT(*) n FROM workspace_docs WHERE id = ?').get(id) as { n: number }).n
const base = { agent_id: 'agent-a', tenant_id: 'default', content_type: 'text' as const, type: 'notes' as const }
const age = (id: string, days: number) => getDb().prepare('UPDATE workspace_docs SET updated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - days * 86400, id)

describe('the vec index follows save / patch / delete / sweep', () => {
  it('save (insert) writes the vec row; a second save of the key keeps exactly one', async () => {
    const a = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 't', content: 'c', embedding_blob: blob(VEC) })
    expect(vecRows(a.id)).toBe(1)
    const b = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 't2', content: 'c2', embedding_blob: blob(VEC2) })
    expect(b.id).toBe(a.id)
    expect(vecRows(a.id)).toBe(1)
  })
  it('patch with an embedding writes the vec row', async () => {
    const a = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 't', content: 'c' })
    expect(vecRows(a.id)).toBe(0)
    await patchWorkspaceDoc(a.id, { title: 'x', embedding_blob: blob(VEC) })
    expect(vecRows(a.id)).toBe(1)
  })
  it('delete removes the vec row with the doc', async () => {
    const a = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 't', content: 'c', embedding_blob: blob(VEC) })
    await deleteWorkspaceDoc(a.id)
    expect(docRows(a.id)).toBe(0)
    expect(vecRows(a.id)).toBe(0)
  })
  it('sweep removes the vec row of every swept doc and keeps the others', async () => {
    const old = await saveWorkspaceDoc({ ...base, doc_key: 'old', title: 't', content: 'c', embedding_blob: blob(VEC) })
    const fresh = await saveWorkspaceDoc({ ...base, doc_key: 'fresh', title: 't', content: 'c', embedding_blob: blob(VEC2) })
    age(old.id, 60)
    expect(await sweepExpiredWorkspaceDocs(30)).toBe(1)
    expect(docRows(old.id)).toBe(0)
    expect(vecRows(old.id)).toBe(0)
    expect(vecRows(fresh.id)).toBe(1)
  })
})

describe('the vec write is best effort and rolls back only itself (savepoint)', () => {
  it('a failing vec insert (wrong dimension) does not fail the save, keeps the doc update and the previous vec row', async () => {
    const a = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 'before', content: 'c', embedding_blob: blob(VEC) })
    expect(vecRows(a.id)).toBe(1)
    const b = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 'after', content: 'c2', embedding_blob: blob([1, 2, 3]) })
    expect(b.title).toBe('after')
    // The DELETE of the savepoint is rolled back with the failed INSERT: the old entry is still there.
    expect(vecRows(a.id)).toBe(1)
  })
  it('the same on patch', async () => {
    const a = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 'before', content: 'c', embedding_blob: blob(VEC) })
    const p = await patchWorkspaceDoc(a.id, { title: 'after', embedding_blob: blob([1, 2, 3]) })
    expect(p?.title).toBe('after')
    expect(vecRows(a.id)).toBe(1)
  })
})

describe('backfill does not hold the connection lock while the embedding is pending', () => {
  it('a read is not held up by a pending embedding call', async () => {
    const a = await saveWorkspaceDoc({ ...base, doc_key: 'bf', title: 't', content: 'text to embed' })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    vi.mocked(generateEmbedding).mockImplementationOnce(async () => { await gate; return null })
    const embedCall = vi.mocked(generateEmbedding)
    const pending = backfillWorkspaceDocs()
    await vi.waitFor(() => { expect(embedCall.mock.calls.length).toBeGreaterThan(0) })
    const probe = await Promise.race([
      getWorkspaceDocUpdatedAtMs('agent-a', 'bf').then(() => 'read'),
      new Promise<string>((r) => setTimeout(() => r('blocked'), 100)),
    ])
    release()
    await pending
    expect(probe).toBe('read')
    expect(a.id).toBeTruthy()
  })
})

describe('writers started together keep the vec index consistent with the rows', () => {
  it('delete started together with a patch that carries an embedding leaves no orphan vec row', async () => {
    const a = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 't', content: 'c', embedding_blob: blob(VEC) })
    await Promise.all([deleteWorkspaceDoc(a.id), patchWorkspaceDoc(a.id, { title: 'x', embedding_blob: blob(VEC2) })])
    expect(docRows(a.id)).toBe(0)
    expect(orphans()).toBe(0)
  })
  it('patch started first, then delete: no orphan', async () => {
    const a = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 't', content: 'c', embedding_blob: blob(VEC) })
    await Promise.all([patchWorkspaceDoc(a.id, { title: 'x', embedding_blob: blob(VEC2) }), deleteWorkspaceDoc(a.id)])
    expect(orphans()).toBe(0)
  })
  it('sweep started together with a patch of the expired doc: the vec row exists exactly when the doc does', async () => {
    const a = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 't', content: 'c', embedding_blob: blob(VEC) })
    age(a.id, 60)
    await Promise.all([sweepExpiredWorkspaceDocs(30), patchWorkspaceDoc(a.id, { title: 'fresh' })])
    expect(vecRows(a.id)).toBe(docRows(a.id))
  })
  it('patch started first, then sweep: same invariant', async () => {
    const a = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 't', content: 'c', embedding_blob: blob(VEC) })
    age(a.id, 60)
    await Promise.all([patchWorkspaceDoc(a.id, { title: 'fresh' }), sweepExpiredWorkspaceDocs(30)])
    expect(vecRows(a.id)).toBe(docRows(a.id))
  })
  it('storeWorkspaceDocEmbedding started together with a delete leaves no orphan vec row', async () => {
    const a = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 't', content: 'c' })
    vi.mocked(generateEmbedding).mockResolvedValueOnce(VEC)
    await Promise.all([storeWorkspaceDocEmbedding(a.id, 'agent-a', 'default', 'some text'), deleteWorkspaceDoc(a.id)])
    expect(orphans()).toBe(0)
  })
  it('delete first, then storeWorkspaceDocEmbedding: no orphan', async () => {
    const a = await saveWorkspaceDoc({ ...base, doc_key: 'k', title: 't', content: 'c' })
    vi.mocked(generateEmbedding).mockResolvedValueOnce(VEC)
    await Promise.all([deleteWorkspaceDoc(a.id), storeWorkspaceDocEmbedding(a.id, 'agent-a', 'default', 'some text')])
    expect(orphans()).toBe(0)
  })
})
