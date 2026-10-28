// The read paths and the multi-statement writes of the vector and memory modules after the facade conversion.
// Real in-memory database; the one stub is the embedding endpoint (fetch). Written for the survivors of the
// per-await mutation sweep: each test fails when the await of the statement it names is dropped.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import {
  db, searchMemories, getAgentMemories, countAgentMemories, searchAgentMemories, getMemoryStats, updateMemory,
  hybridSearch, runLinkMaintenance, searchArtifactsByVector, clearMemoryCache, insertImportSource, touchMemory,
  searchMemoriesLike, searchMemoriesLikeForAgent, likeContains, dbx,
  touchMemoriesAccessed, decayMemories,
} from '../db.js'
import { syncVecMemoryEmbeddingUpdate } from '../db/vector.js'
import { vecExtensionLoaded } from '../db/connection.js'

useTestDb()
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); clearMemoryCache() })

const DIM = 768
function embedding(tilt: number): number[] {
  const v = new Array<number>(DIM).fill(0)
  v[0] = 1
  v[1] = tilt
  return v
}
const blobOf = (floats: number[]): Buffer => Buffer.from(new Float32Array(floats).buffer)

/** The embedding endpoint answers the same vector for every text. */
function stubEmbeddings(floats: number[]): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ embedding: floats }) })))
}

function addMemory(content: string, o: { agent?: string; category?: string; tenant?: string; chat?: string; keywords?: string } = {}): number {
  return (db.prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, category, agent_id, auto_generated, created_at, accessed_at, updated_at, tenant_id, keywords)
     VALUES (?, ?, 'semantic', 1, ?, ?, 0, unixepoch(), unixepoch(), unixepoch(), ?, ?) RETURNING id`,
  ).get(o.chat ?? 'chat-1', content, o.category ?? 'warm', o.agent ?? 'agent-r', o.tenant ?? 'default', o.keywords ?? null) as { id: number }).id
}
const vecExists = (id: number): boolean => db.prepare('SELECT 1 FROM vec_memories WHERE memory_id = ?').get(BigInt(id)) !== undefined

describe('the memory listings and searches', () => {
  it('searchMemories finds the matching memory of the chat and keeps other chats and tenants out', async () => {
    const mine = addMemory('the zebra crossing is closed')
    addMemory('the zebra is elsewhere', { chat: 'chat-2' })
    addMemory('the zebra of another tenant', { tenant: 'acme' })
    expect((await searchMemories('zebra', 'chat-1')).map((m) => m.id).sort()).toEqual([mine, mine + 2].sort())
    expect((await searchMemories('zebra', 'chat-1', 3, 'default')).map((m) => m.id)).toEqual([mine])
  })

  it('getAgentMemories lists the agent\'s and the shared rows, narrowed by category and tenant', async () => {
    const a1 = addMemory('a1', { category: 'warm' })
    const a2 = addMemory('a2', { category: 'hot' })
    const sh = addMemory('sh', { agent: 'agent-other', category: 'shared' })
    addMemory('foreign', { agent: 'agent-other', category: 'warm' })
    const t = addMemory('tenant row', { tenant: 'acme' })
    expect((await getAgentMemories('agent-r', 20)).map((m) => m.id).sort()).toEqual([a1, a2, sh, t].sort())
    expect((await getAgentMemories('agent-r', 20, 'hot')).map((m) => m.id)).toEqual([a2])
    expect((await getAgentMemories('agent-r', 20, undefined, 'default')).map((m) => m.id).sort()).toEqual([a1, a2, sh].sort())
    expect((await getAgentMemories('agent-r', 20, 'warm', 'acme')).map((m) => m.id)).toEqual([t])
  })

  it('countAgentMemories counts the same rows, with and without a category', async () => {
    addMemory('a1', { category: 'warm' })
    addMemory('a2', { category: 'hot' })
    addMemory('sh', { agent: 'agent-other', category: 'shared' })
    expect(await countAgentMemories('agent-r')).toBe(3)
    expect(await countAgentMemories('agent-r', 'hot')).toBe(1)
    expect(await countAgentMemories('agent-r', 'shared', 'default')).toBe(1)
  })

  it('searchAgentMemories answers the full-text hits of the agent and the shared tier', async () => {
    const own = addMemory('quartz geode inventory')
    const shared = addMemory('quartz in the shared pool', { agent: 'agent-other', category: 'shared' })
    addMemory('quartz of a stranger', { agent: 'agent-other' })
    expect((await searchAgentMemories('agent-r', 'quartz')).map((m) => m.id).sort()).toEqual([own, shared].sort())
  })

  it('getMemoryStats counts rows, embeddings, agents, tiers and the import rows', async () => {
    const a = addMemory('a', { category: 'warm' })
    addMemory('b', { agent: 'agent-other', category: 'hot' })
    db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(blobOf(embedding(0)), a)
    await insertImportSource({
      id: 's1', type: 'local', path: '/docs/s1', label: 's1', intervalHours: 4, enabled: true, now: 100,
      tenantId: 'default', vaultTokenRef: null, confluenceEmail: null, baseUrl: null,
    })
    db.prepare(
      `INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, last_seen_at, created_at, updated_at)
       VALUES ('i1', 's1', '/docs/i1.md', 'i1.md', 'h-i1', 'text', 1, 1, 1)`,
    ).run()
    expect(await getMemoryStats()).toEqual({
      total: 2, byAgent: { 'agent-r': 1, 'agent-other': 1 }, byTier: { warm: 1, hot: 1 }, withEmbedding: 1, importCount: 1,
    })
  })
})

describe('updateMemory', () => {
  const versions = (id: number): string[] =>
    (db.prepare('SELECT content FROM memory_versions WHERE memory_id = ? ORDER BY id').all(id) as { content: string }[]).map((r) => r.content)

  it('writes one version record of the old content and updates the row', async () => {
    const id = addMemory('A')
    expect(await updateMemory(id, 'B')).toBe(true)
    expect(versions(id)).toEqual(['A'])
    expect((db.prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string }).content).toBe('B')
  })

  it('two overlapping edits chain their version records (the second one records the first one\'s content)', async () => {
    const id = addMemory('A')
    await Promise.all([updateMemory(id, 'B'), updateMemory(id, 'C')])
    const final = (db.prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string }).content
    expect(versions(id)).toEqual(['A', final === 'C' ? 'B' : 'C'])
  })

  it('a failing update leaves no version record (one transaction)', async () => {
    const id = addMemory('A')
    db.exec("CREATE TRIGGER memory_update_blocked BEFORE UPDATE ON memories BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    await expect(updateMemory(id, 'B')).rejects.toThrow(/blocked/)
    expect(versions(id)).toEqual([])
  })

  it('a missing row is false and writes nothing', async () => {
    expect(await updateMemory(99999, 'x')).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_versions').get()).toEqual({ n: 0 })
  })
})

describe('the writes of touch and decay', () => {
  it('touchMemory raises the salience and the access time, touchMemoriesAccessed the access time, decay lowers old salience', async () => {
    const id = addMemory('t')
    db.prepare('UPDATE memories SET accessed_at = 1, created_at = 1 WHERE id = ?').run(id)
    await touchMemory(id)
    const row = db.prepare('SELECT salience, accessed_at FROM memories WHERE id = ?').get(id) as { salience: number; accessed_at: number }
    expect(row.salience).toBeCloseTo(1.1)
    expect(row.accessed_at).toBeGreaterThan(1)
    db.prepare('UPDATE memories SET accessed_at = 1 WHERE id = ?').run(id)
    await touchMemoriesAccessed([id])
    expect((db.prepare('SELECT accessed_at FROM memories WHERE id = ?').get(id) as { accessed_at: number }).accessed_at).toBeGreaterThan(1)
    await decayMemories()
    expect((db.prepare('SELECT salience FROM memories WHERE id = ?').get(id) as { salience: number }).salience).toBeCloseTo(1.1 * 0.995)
  })
})

describe('the vector paths', () => {
  it('syncVecMemoryEmbeddingUpdate replaces the entry, and two overlapping calls leave exactly one', async (ctx) => {
    if (!vecExtensionLoaded) ctx.skip()
    const id = addMemory('v')
    await Promise.all([syncVecMemoryEmbeddingUpdate(id, blobOf(embedding(0.1))), syncVecMemoryEmbeddingUpdate(id, blobOf(embedding(0.2)))])
    expect(db.prepare('SELECT COUNT(*) AS n FROM vec_memories WHERE memory_id = ?').get(BigInt(id))).toEqual({ n: 1 })
  })

  it('hybridSearch answers a memory that only the ANN index knows (no blob, no full-text hit)', async (ctx) => {
    if (!vecExtensionLoaded) ctx.skip()
    const id = addMemory('unrelated words only')
    db.prepare('INSERT INTO vec_memories(memory_id, embedding) VALUES(?, ?)').run(BigInt(id), blobOf(embedding(0.1)))
    stubEmbeddings(embedding(0))
    expect((await hybridSearch('agent-r', 'zzzzqueryzzzz', 5)).map((m) => m.id)).toEqual([id])
  })

  it('runLinkMaintenance embeds a memory that has none, indexes it, and reports numeric prune and orphan counts', async (ctx) => {
    if (!vecExtensionLoaded) ctx.skip()
    const id = addMemory('needs an embedding')
    stubEmbeddings(embedding(0.3))
    const result = await runLinkMaintenance()
    expect(result.reembedded).toBe(1)
    expect(result.linksPruned).toBe(0)
    expect(result.orphans).toBe(1)
    expect((db.prepare('SELECT embedding_blob FROM memories WHERE id = ?').get(id) as { embedding_blob: Buffer }).embedding_blob.byteLength).toBe(DIM * 4)
    expect(vecExists(id)).toBe(true)
  })

  it('searchArtifactsByVector answers the pointer of the artifact the ANN index finds', async (ctx) => {
    if (!vecExtensionLoaded) ctx.skip()
    const row = db.prepare(
      "INSERT INTO artifacts (agent_id, tenant_id, title, kind, mime, content, meta) VALUES ('agent-r', 'default', 'Quarterly plan', 'text', 'text/plain', X'61', '{}') RETURNING rowid AS rid, id",
    ).get() as { rid: number; id: string }
    db.prepare('INSERT INTO vec_artifacts(artifact_rowid, embedding) VALUES(?, ?)').run(BigInt(row.rid), blobOf(embedding(0.1)))
    stubEmbeddings(embedding(0))
    const found = await searchArtifactsByVector('plan')
    expect(found.map((a) => [a.id, a.title])).toEqual([[row.id, 'Quarterly plan']])
    expect(found[0].score).toBeGreaterThan(0)
  })

  it('the embedding endpoint answer is read: no embedding means FTS only, and nothing is thrown', async () => {
    const id = addMemory('walrus colony')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
    expect((await hybridSearch('agent-r', 'walrus', 5)).map((m) => m.id)).toEqual([id])
  })
})

describe('the LIKE fallbacks take the user\'s text literally', () => {
  const ids = (rows: { id: number }[]): number[] => rows.map((r) => r.id).sort()

  it('likeContains escapes the wildcards and the escape character', () => {
    expect(likeContains('50%_off\\')).toBe('%50\\%\\_off\\\\%')
    expect(likeContains('plain')).toBe('%plain%')
  })

  it.each([
    ['100%', '100% sure', '100X sure'],
    ['snake_case', 'snake_case name', 'snakeXcase name'],
    ['a\\b', 'path a\\b here', 'path aXb here'],
  ])('a query of %s matches only the memory that contains it, in all three fallbacks', async (query, hit, miss) => {
    const h = addMemory(hit)
    addMemory(miss)
    expect(ids(await searchMemoriesLikeForAgent('agent-r', query, 10))).toEqual([h])
    expect(ids(await searchMemoriesLike(query, 10))).toEqual([h])
    // searchAgentMemories falls back to LIKE when the full-text query fails
    const realAll = dbx.all.bind(dbx)
    vi.spyOn(dbx, 'all').mockImplementationOnce(() => Promise.reject(new Error('fts failed')))
    expect(ids(await searchAgentMemories('agent-r', query, 10))).toEqual([h])
    vi.mocked(dbx.all).mockImplementation(realAll)
  })

  it('the keywords column is matched literally too', async () => {
    const h = addMemory('x', { keywords: 'tier_1 100%' })
    addMemory('y', { keywords: 'tierX1 100' })
    expect(ids(await searchMemoriesLikeForAgent('agent-r', 'tier_1', 10))).toEqual([h])
  })
})
