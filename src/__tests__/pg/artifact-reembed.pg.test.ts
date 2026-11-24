// The artifact re-embed of the PostgreSQL cutover (P-G4): reembedArtifacts embeds every artifact that has no side row, from
// the same title + meta text as the live write path. PostgreSQL only. The embedding service is a stubbed fetch, so the file
// needs no Ollama. Each counting cell first drains the leftovers of the cells before it (the embedder succeeds in the drain),
// so its counts are its own.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPgDbx } from '../../db/pg/index.js'
import { useDbxBackend as setBackend } from '../../db/facade.js'
import { artifactEmbeddingText, reembedArtifacts, setArtifactEmbedding, storeArtifactEmbedding } from '../../db/artifacts.js'
import { EMBEDDING_DIM, floatsToBlob } from '../../db/vector.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

let db: PgTestDb

beforeAll(async () => {
  db = await createPgTestDb()
  setBackend(createPgDbx(db.pool), 'pg')
})

afterAll(async () => {
  setBackend(null)
  if (db) await db.close()
})

afterEach(() => { vi.unstubAllGlobals() })

let seq = 0
const uid = (prefix: string): string => `${prefix}-${process.pid}-${++seq}-${Math.random().toString(36).slice(2, 8)}`

/** A deterministic 768-float vector: the seed picks the direction. */
function vec(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(seed * 1000 + i) * 0.5)
}

/** An artifact row inserted directly (the write path is not what these cells test). */
async function artifact(title: string, meta: string, tenant = 'default'): Promise<string> {
  const id = uid('rea')
  await db.pool.query(
    "INSERT INTO artifacts (id, agent_id, title, kind, mime, content, meta, tenant_id) VALUES ($1, 'agent-re', $2, 'text', 'text/plain', $3, $4, $5)",
    [id, title, Buffer.from('body'), meta, tenant],
  )
  return id
}

async function embeddingCount(id: string): Promise<number> {
  const r = await db.pool.query('SELECT count(*)::int AS n FROM artifact_embeddings WHERE artifact_id = $1', [id])
  return Number(r.rows[0]?.n)
}

/** The stored embedding read back exactly: a double precision cast keeps the float32 value. */
async function storedEmbedding(id: string): Promise<number[] | null> {
  const r = await db.pool.query('SELECT embedding::real[]::double precision[] AS v FROM artifact_embeddings WHERE artifact_id = $1', [id])
  return r.rows.length === 0 ? null : (r.rows[0]?.v as number[])
}

/** Rows that have no side row and whose text is blank: the reembed counts them as skipped on every run. */
async function blankWithoutSideRow(): Promise<number> {
  const r = await db.pool.query(
    `SELECT count(*)::int AS n FROM artifacts a
     WHERE trim(a.title) = '' AND trim(a.meta) = ''
       AND NOT EXISTS (SELECT 1 FROM artifact_embeddings e WHERE e.artifact_id = a.id)`,
  )
  return Number(r.rows[0]?.n)
}

/** Every embedder call: the prompt it was asked to embed, and what it answers (an empty answer for a prompt the test fails). */
function stubEmbedder(answer: (prompt: string) => boolean): string[] {
  const prompts: string[] = []
  vi.stubGlobal('fetch', vi.fn((_url: string, init: { body: string }) => {
    const prompt = (JSON.parse(init.body) as { prompt: string }).prompt
    prompts.push(prompt)
    // the answer depends on the prompt only, so a stored vector can be checked against the text it was made from
    const body = answer(prompt) ? { embedding: vec(prompt.length) } : {}
    return Promise.resolve({ json: () => Promise.resolve(body) })
  }))
  return prompts
}

/** Embed everything that is embeddable now, so the counts of the cell that follows are its own. */
async function drain(): Promise<void> {
  stubEmbedder(() => true)
  await reembedArtifacts()
}

describe('the re-embed: every artifact without a side row is embedded, resumable, and a second run embeds nothing', () => {
  it('the artifacts without a side row are embedded; the stored vector is the one the embedder answered; a second run embeds nothing', async () => {
    await drain()
    const a = await artifact('Quarterly plan', '{"kind":"plan"}')
    const b = await artifact('Minutes', '{"kind":"minutes"}')
    stubEmbedder(() => true)
    const first = await reembedArtifacts()
    expect(first).toEqual({ embedded: 2, pending: 0, skipped: 0, batches: 1 })
    expect(await embeddingCount(a)).toBe(1)
    expect(await embeddingCount(b)).toBe(1)
    // the stored value is the answer for the text of this artifact, read back exactly (float4 through a double cast)
    const expected = floatsToBlob(vec('Quarterly plan {"kind":"plan"}'.length))
    const stored = await storedEmbedding(a)
    for (let i = 0; i < EMBEDDING_DIM; i++) expect(stored![i]).toBe(expected.readFloatLE(i * 4))
    const second = await reembedArtifacts()
    expect(second).toEqual({ embedded: 0, pending: 0, skipped: 0, batches: 0 })
  })

  it('a partly embedded table: only the missing rows are read, across several keyset batches', async () => {
    await drain()
    const done = [await artifact('one', '{}'), await artifact('two', '{}')]
    for (const id of done) await setArtifactEmbedding(id, floatsToBlob(vec(31)))
    const missing = [await artifact('three', '{}'), await artifact('four', '{}'), await artifact('five', '{}')]
    stubEmbedder(() => true)
    const result = await reembedArtifacts(2)
    expect(result.embedded).toBe(3)
    expect(result.pending).toBe(0)
    expect(result.batches).toBeGreaterThanOrEqual(2)
    for (const id of missing) expect(await embeddingCount(id)).toBe(1)
    for (const id of done) expect(await embeddingCount(id)).toBe(1)
  })
})

describe('the re-embed and the live write path take the same text', () => {
  it('the embedder is asked for artifactEmbeddingText(title, meta) on both write paths, blank title included', async () => {
    await drain()
    const live = await artifact('Quarterly plan', '{"kind":"plan"}')
    const blankTitle = await artifact('   ', '{"a":1}')
    const prompts = stubEmbedder(() => true)
    const expected = [
      artifactEmbeddingText('Quarterly plan', '{"kind":"plan"}'),
      artifactEmbeddingText('   ', '{"a":1}'),
    ].sort()
    await storeArtifactEmbedding(live, 'Quarterly plan', '{"kind":"plan"}')
    await storeArtifactEmbedding(blankTitle, '   ', '{"a":1}')
    // the live write path: the two prompts it sent (compared as sets, the cell does not depend on their order)
    expect([...prompts].sort()).toEqual(expected)
    const reembedded = await artifact('Quarterly plan', '{"kind":"plan"}')
    const reembeddedBlank = await artifact('   ', '{"a":1}')
    prompts.length = 0
    await reembedArtifacts()
    // the re-embed walks the rows in id order, so its two prompts are compared as a set as well
    expect(prompts).toHaveLength(2)
    expect([...prompts].sort()).toEqual(expected)
    expect(prompts).toContain('{"a":1}')
    expect(await embeddingCount(reembedded)).toBe(1)
    expect(await embeddingCount(reembeddedBlank)).toBe(1)
  })
})

describe('the re-embed is honest about what it could not do', () => {
  it('an artifact the embedder cannot vectorize is pending, the run goes on, and the next run after recovery embeds it', async () => {
    await drain()
    const ok1 = await artifact('ok one', '{}')
    const failing = await artifact('FAIL here', '{}')
    const ok2 = await artifact('ok two', '{}')
    stubEmbedder((prompt) => !prompt.includes('FAIL'))
    const result = await reembedArtifacts()
    expect(result).toMatchObject({ embedded: 2, pending: 1, skipped: 0 })
    expect(await embeddingCount(ok1)).toBe(1)
    expect(await embeddingCount(ok2)).toBe(1)
    expect(await embeddingCount(failing)).toBe(0)
    stubEmbedder(() => true)
    const again = await reembedArtifacts()
    expect(again).toMatchObject({ embedded: 1, pending: 0 })
    expect(await embeddingCount(failing)).toBe(1)
  })

  it('an artifact with no text to embed is skipped and counted on every run (the count is checked against the table)', async () => {
    await drain()
    const blank = await artifact('  ', '  ')
    const expectedSkipped = await blankWithoutSideRow()
    expect(expectedSkipped).toBeGreaterThanOrEqual(1)
    stubEmbedder(() => true)
    const result = await reembedArtifacts()
    expect(result.skipped).toBe(expectedSkipped)
    expect(result.embedded).toBe(0)
    expect(await embeddingCount(blank)).toBe(0)
  })

  it('a wrong-length answer is pending too (the write refuses it), not an error', async () => {
    await drain()
    const short = await artifact('short answer', '{}')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ embedding: [1, 2, 3] }) })))
    const result = await reembedArtifacts()
    expect(result).toMatchObject({ embedded: 0, pending: 1 })
    expect(await embeddingCount(short)).toBe(0)
  })
})

describe('the re-embed under the serving role: row-level security shows the rows to the system context', () => {
  it('the serving role sees every artifact in the system context, so the run embeds them (an empty result would be a false green)', async () => {
    await drain()
    const a = await artifact('served one', '{"s":1}', 'tenant-x')
    const b = await artifact('served two', '{"s":2}', 'tenant-y')
    setBackend(createPgDbx(db.appPool), 'pg')
    try {
      stubEmbedder(() => true)
      const result = await reembedArtifacts()
      expect(result).toMatchObject({ embedded: 2, pending: 0 })
    } finally {
      setBackend(createPgDbx(db.pool), 'pg')
    }
    expect(await embeddingCount(a)).toBe(1)
    expect(await embeddingCount(b)).toBe(1)
  })
})

describe('the re-embed terminates when the embedder answers nothing (the keyset cursor always advances)', () => {
  it('five pending artifacts in three batches of two: all pending, the run returns (no loop on a stuck cursor)', async () => {
    await drain()
    // blank artifacts left by the cells above are skipped rows of the table, not part of this cell's count
    await db.pool.query("DELETE FROM artifacts WHERE trim(title) = '' AND trim(meta) = ''")
    for (let i = 0; i < 5; i++) await artifact(`unanswered ${i}`, '{}')
    stubEmbedder(() => false)
    // a stuck cursor would re-read the same pending rows forever: the race turns that into a failure, not a hang
    const result = await Promise.race([
      reembedArtifacts(2),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reembedArtifacts did not return')), 10_000)),
    ])
    expect(result).toEqual({ embedded: 0, pending: 5, skipped: 0, batches: 3 })
    expect(await db.pool.query("SELECT count(*)::int AS n FROM artifact_embeddings e JOIN artifacts a ON a.id = e.artifact_id WHERE a.title LIKE 'unanswered %'")
      .then((r) => Number(r.rows[0]?.n))).toBe(0)
  }, 20_000)
})

describe('the re-embed refuses a SQLite backend with its named error', () => {
  it('on the SQLite backend the PostgreSQL-only guard throws, and nothing is read', async () => {
    setBackend(null)
    try {
      await expect(reembedArtifacts()).rejects.toThrow('reembedArtifacts runs on the PostgreSQL backend only')
    } finally {
      setBackend(createPgDbx(db.pool), 'pg')
    }
  })
})
