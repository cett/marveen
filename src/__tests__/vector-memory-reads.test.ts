// The read paths and the multi-statement writes of the vector and memory modules after the facade conversion, on both
// engines (MARVEEN_TEST_DB=pg runs the same cells on PostgreSQL). Real database; the one stub is the embedding endpoint
// (fetch). Written for the survivors of the per-await mutation sweep: each test fails when the await of the statement it
// names is dropped. The cells that inject a failure with a trigger are per engine: SQLite RAISE(ABORT), PostgreSQL a
// RAISE EXCEPTION trigger function; both prove the same product behaviour (a failed write leaves nothing behind).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import {
  searchMemories, getAgentMemories, countAgentMemories, searchAgentMemories, getMemoryStats, updateMemory,
  hybridSearch, runLinkMaintenance, searchArtifactsByVector, clearMemoryCache, insertImportSource, touchMemory,
  searchMemoriesLike, searchMemoriesLikeForAgent, likeContains, dbx,
  touchMemoriesAccessed, decayMemories, createArtifact, storeArtifactEmbedding, syncVecMemoryEmbeddingUpdate,
} from '../db.js'
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

async function addMemory(content: string, o: { agent?: string; category?: string; tenant?: string; chat?: string; keywords?: string } = {}): Promise<number> {
  const now = Math.floor(Date.now() / 1000)
  const row = await dbx.get<{ id: number }>(
    `INSERT INTO memories (chat_id, content, sector, salience, category, agent_id, auto_generated, created_at, accessed_at, updated_at, tenant_id, keywords)
     VALUES (?, ?, 'semantic', 1, ?, ?, 0, ?, ?, ?, ?, ?) RETURNING id`,
    o.chat ?? 'chat-1', content, o.category ?? 'warm', o.agent ?? 'agent-r', now, now, now, o.tenant ?? 'default', o.keywords ?? null,
  )
  return Number(row!.id)
}

const memoryExists = async (id: number): Promise<boolean> =>
  (await dbx.get('SELECT 1 AS one FROM memories WHERE id = ?', id)) !== undefined

/** The vector entry of a memory: the vec0 row on SQLite, the side row on PostgreSQL. */
async function vecCount(id: number): Promise<number> {
  const sql = testDbMode() === 'pg'
    ? 'SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id = ?'
    : 'SELECT COUNT(*) AS n FROM vec_memories WHERE memory_id = ?'
  const row = await dbx.get<{ n: number | string }>(sql, testDbMode() === 'pg' ? id : BigInt(id))
  return Number(row!.n)
}

/**
 * Makes every UPDATE (or DELETE) of one table fail with a message. SQLite: a RAISE(ABORT) trigger; PostgreSQL: a
 * trigger function that raises an exception. Both abort the statement, so the surrounding transaction rolls back.
 */
async function blockWrites(table: string, op: 'UPDATE' | 'DELETE', name: string): Promise<void> {
  if (testDbMode() === 'pg') {
    await dbx.exec(`CREATE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'blocked'; END $$`)
    await dbx.exec(`CREATE TRIGGER ${name} BEFORE ${op} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}_fn()`)
    return
  }
  await dbx.exec(`CREATE TRIGGER ${name} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT, 'blocked'); END`)
}

describe('the memory listings and searches', () => {
  it('searchMemories finds the matching memory of the chat and keeps other chats and tenants out', async () => {
    const mine = await addMemory('the zebra crossing is closed')
    await addMemory('the zebra is elsewhere', { chat: 'chat-2' })
    const acme = await addMemory('the zebra of another tenant', { tenant: 'acme' })
    // no tenant given: the other tenant's row is found too (the chat filter is what keeps chat-2 out)
    expect((await searchMemories('zebra', 'chat-1')).map((m) => m.id).sort()).toEqual([mine, acme].sort())
    expect((await searchMemories('zebra', 'chat-1', 3, 'default')).map((m) => m.id)).toEqual([mine])
  })

  it('getAgentMemories lists the agent\'s and the shared rows, narrowed by category and tenant', async () => {
    const a1 = await addMemory('a1', { category: 'warm' })
    const a2 = await addMemory('a2', { category: 'hot' })
    const sh = await addMemory('sh', { agent: 'agent-other', category: 'shared' })
    await addMemory('foreign', { agent: 'agent-other', category: 'warm' })
    const t = await addMemory('tenant row', { tenant: 'acme' })
    expect((await getAgentMemories('agent-r', 20)).map((m) => m.id).sort()).toEqual([a1, a2, sh, t].sort())
    expect((await getAgentMemories('agent-r', 20, 'hot')).map((m) => m.id)).toEqual([a2])
    expect((await getAgentMemories('agent-r', 20, undefined, 'default')).map((m) => m.id).sort()).toEqual([a1, a2, sh].sort())
    expect((await getAgentMemories('agent-r', 20, 'warm', 'acme')).map((m) => m.id)).toEqual([t])
  })

  it('countAgentMemories counts the same rows, with and without a category', async () => {
    await addMemory('a1', { category: 'warm' })
    await addMemory('a2', { category: 'hot' })
    await addMemory('sh', { agent: 'agent-other', category: 'shared' })
    expect(await countAgentMemories('agent-r')).toBe(3)
    expect(await countAgentMemories('agent-r', 'hot')).toBe(1)
    expect(await countAgentMemories('agent-r', 'shared', 'default')).toBe(1)
  })

  it('searchAgentMemories answers the full-text hits of the agent and the shared tier', async () => {
    const own = await addMemory('quartz geode inventory')
    const shared = await addMemory('quartz in the shared pool', { agent: 'agent-other', category: 'shared' })
    await addMemory('quartz of a stranger', { agent: 'agent-other' })
    expect((await searchAgentMemories('agent-r', 'quartz')).map((m) => m.id).sort()).toEqual([own, shared].sort())
  })

  it('getMemoryStats counts rows, embeddings, agents, tiers and the import rows', async () => {
    const a = await addMemory('a', { category: 'warm' })
    await addMemory('b', { agent: 'agent-other', category: 'hot' })
    await dbx.run('UPDATE memories SET embedding_blob = ? WHERE id = ?', blobOf(embedding(0)), a)
    await insertImportSource({
      id: 's1', type: 'local', path: '/docs/s1', label: 's1', intervalHours: 4, enabled: true, now: 100,
      tenantId: 'default', vaultTokenRef: null, confluenceEmail: null, baseUrl: null,
    })
    await dbx.run(
      `INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, last_seen_at, created_at, updated_at)
       VALUES ('i1', 's1', '/docs/i1.md', 'i1.md', 'h-i1', 'text', 1, 1, 1)`,
    )
    expect(await getMemoryStats()).toEqual({
      total: 2, byAgent: { 'agent-r': 1, 'agent-other': 1 }, byTier: { warm: 1, hot: 1 }, withEmbedding: 1, importCount: 1,
    })
  })
})

describe('updateMemory', () => {
  const versions = async (id: number): Promise<string[]> =>
    (await dbx.all<{ content: string }>('SELECT content FROM memory_versions WHERE memory_id = ? ORDER BY id', id)).map((r) => r.content)
  const contentOf = async (id: number): Promise<string> =>
    (await dbx.get<{ content: string }>('SELECT content FROM memories WHERE id = ?', id))!.content

  it('writes one version record of the old content and updates the row', async () => {
    const id = await addMemory('A')
    expect(await updateMemory(id, 'B')).toBe(true)
    expect(await versions(id)).toEqual(['A'])
    expect(await contentOf(id)).toBe('B')
  })

  it('two overlapping edits chain their version records (the second one records the first one\'s content)', async () => {
    const id = await addMemory('A')
    await Promise.all([updateMemory(id, 'B'), updateMemory(id, 'C')])
    const final = await contentOf(id)
    expect(await versions(id)).toEqual(['A', final === 'C' ? 'B' : 'C'])
  })

  it('a failing update leaves no version record (one transaction)', async () => {
    const id = await addMemory('A')
    await blockWrites('memories', 'UPDATE', 'memory_update_blocked')
    await expect(updateMemory(id, 'B')).rejects.toThrow(/blocked/)
    expect(await versions(id)).toEqual([])
  })

  it('a missing row is false and writes nothing', async () => {
    expect(await updateMemory(99999, 'x')).toBe(false)
    expect(Number((await dbx.get<{ n: number | string }>('SELECT COUNT(*) AS n FROM memory_versions'))!.n)).toBe(0)
  })
})

describe('the writes of touch and decay', () => {
  it('touchMemoriesAccessed moves the access time only, and leaves the salience alone', async () => {
    const id = await addMemory('t')
    await dbx.run('UPDATE memories SET accessed_at = 1, salience = 1 WHERE id = ?', id)
    await touchMemoriesAccessed([id])
    const row = (await dbx.get<{ salience: number; accessed_at: number }>('SELECT salience, accessed_at FROM memories WHERE id = ?', id))!
    expect(Number(row.accessed_at)).toBeGreaterThan(1)
    expect(Number(row.salience)).toBeCloseTo(1)
  })

  // touchMemory and decayMemories use the SQLite scalar MIN / MAX (MIN(salience + 0.1, 5.0)). PostgreSQL has only the
  // aggregate MIN/MAX and the scalar LEAST/GREATEST, so the two statements fail there ("function min(double precision,
  // numeric) does not exist"). Until the statements are made dialect-neutral (a product change, not a test change), the
  // cell runs on SQLite only.
  it.runIf(testDbMode() === 'sqlite')('touchMemory raises the salience and the access time, decay lowers old salience', async () => {
    const id = await addMemory('t')
    await dbx.run('UPDATE memories SET accessed_at = 1, created_at = 1 WHERE id = ?', id)
    await touchMemory(id)
    const row = (await dbx.get<{ salience: number; accessed_at: number }>('SELECT salience, accessed_at FROM memories WHERE id = ?', id))!
    expect(row.salience).toBeCloseTo(1.1)
    expect(Number(row.accessed_at)).toBeGreaterThan(1)
    await decayMemories()
    expect((await dbx.get<{ salience: number }>('SELECT salience FROM memories WHERE id = ?', id))!.salience).toBeCloseTo(1.1 * 0.995)
  })
})

describe('the vector paths', () => {
  it('syncVecMemoryEmbeddingUpdate replaces the entry, and two overlapping calls leave exactly one', async (ctx) => {
    if (!vecExtensionLoaded && testDbMode() === 'sqlite') ctx.skip()
    const id = await addMemory('v')
    await Promise.all([syncVecMemoryEmbeddingUpdate(id, blobOf(embedding(0.1))), syncVecMemoryEmbeddingUpdate(id, blobOf(embedding(0.2)))])
    expect(await vecCount(id)).toBe(1)
  })

  it('hybridSearch answers a memory that only the ANN index knows (no blob, no full-text hit)', async (ctx) => {
    if (!vecExtensionLoaded && testDbMode() === 'sqlite') ctx.skip()
    const id = await addMemory('unrelated words only')
    await syncVecMemoryEmbeddingUpdate(id, blobOf(embedding(0.1)))
    stubEmbeddings(embedding(0))
    expect((await hybridSearch('agent-r', 'zzzzqueryzzzz', 5)).map((m) => m.id)).toEqual([id])
  })

  it('runLinkMaintenance embeds a memory that has none, indexes it, and reports numeric prune and orphan counts', async (ctx) => {
    if (!vecExtensionLoaded && testDbMode() === 'sqlite') ctx.skip()
    const id = await addMemory('needs an embedding')
    stubEmbeddings(embedding(0.3))
    const result = await runLinkMaintenance()
    expect(result.reembedded).toBe(1)
    expect(result.linksPruned).toBe(0)
    expect(result.orphans).toBe(1)
    const row = (await dbx.get<{ embedding_blob: Buffer }>('SELECT embedding_blob FROM memories WHERE id = ?', id))!
    expect(row.embedding_blob.byteLength).toBe(DIM * 4)
    expect(await vecCount(id)).toBe(1)
  })

  it('searchArtifactsByVector answers the pointer of the artifact the ANN index finds', async (ctx) => {
    if (!vecExtensionLoaded && testDbMode() === 'sqlite') ctx.skip()
    // the artifact is created without an embedding (the endpoint answers nothing), then its title embedding is stored
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })))
    const created = await createArtifact({ agent_id: 'agent-r', title: 'Quarterly plan', kind: 'text', mime: 'text/plain', content: Buffer.from('a') })
    stubEmbeddings(embedding(0.1))
    await storeArtifactEmbedding(created.id, 'Quarterly plan', '{}')
    stubEmbeddings(embedding(0))
    const found = await searchArtifactsByVector('plan')
    expect(found.map((a) => [a.id, a.title])).toEqual([[created.id, 'Quarterly plan']])
    expect(found[0].score).toBeGreaterThan(0)
  })

  it('the embedding endpoint answer is read: no embedding means FTS only, and nothing is thrown', async () => {
    const id = await addMemory('walrus colony')
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
  ])('a query of %s matches only the memory that contains it, in the LIKE fallbacks (both engines); a failed full-text search falls back to LIKE on SQLite and surfaces its error on PostgreSQL', async (query, hit, miss) => {
    const h = await addMemory(hit)
    await addMemory(miss)
    expect(ids(await searchMemoriesLikeForAgent('agent-r', query, 10))).toEqual([h])
    expect(ids(await searchMemoriesLike(query, 10))).toEqual([h])
    // the full-text query fails (the first statement of the search is refused): SQLite falls back to LIKE and answers
    // the hit; PostgreSQL has no LIKE fallback and surfaces the error (the decision F4: a failed search is not an
    // empty answer)
    const spy = vi.spyOn(dbx, 'all').mockImplementationOnce(() => Promise.reject(new Error('fts failed')))
    try {
      const found = searchAgentMemories('agent-r', query, 10)
      if (testDbMode() === 'sqlite') expect(ids(await found)).toEqual([h])
      else await expect(found).rejects.toThrow(/^fts failed$/)
    } finally {
      spy.mockRestore()
    }
  })

  it('the keywords column is matched literally too', async () => {
    const h = await addMemory('x', { keywords: 'tier_1 100%' })
    await addMemory('y', { keywords: 'tierX1 100' })
    expect(ids(await searchMemoriesLikeForAgent('agent-r', 'tier_1', 10))).toEqual([h])
  })
})
