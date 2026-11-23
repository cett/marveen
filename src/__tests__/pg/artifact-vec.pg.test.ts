// The artifact vector seam and the scoped artifact search on pgvector (phase 3, step 6b, c6). PostgreSQL only: the seam and
// the search run on the PG backend of `dbx`, the side table is the one of migration 0007. The embedding service is a
// stubbed fetch, so the file needs no Ollama.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPgDbx } from '../../db/pg/index.js'
import { dbx, useDbxBackend as setBackend } from '../../db/facade.js'
import { setArtifactEmbedding, storeArtifactEmbedding } from '../../db/artifacts.js'
import { EMBEDDING_DIM, floatsToBlob, pgVectorArtifacts } from '../../db/vector.js'
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

/** An artifact row, inserted directly: the tenant is what the scoped search filters on. */
async function artifact(tenant: string): Promise<string> {
  const id = uid('art')
  await db.pool.query(
    "INSERT INTO artifacts (id, agent_id, title, kind, mime, content, meta, tenant_id) VALUES ($1, 'agent-a', 'title', 'text', 'text/plain', $2, '{}', $3)",
    [id, Buffer.from('body'), tenant],
  )
  return id
}

/** A deterministic 768-float vector: the seed picks the direction. */
function vec(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(seed * 1000 + i) * 0.5)
}

const QUERY = vec(1)

async function embeddingCount(id: string): Promise<number> {
  const r = await db.pool.query('SELECT count(*)::int AS n FROM artifact_embeddings WHERE artifact_id = $1', [id])
  return Number(r.rows[0]?.n)
}

/** The stored embedding, read back exactly: a double precision cast keeps the float32 value (the float4 text is a shorter decimal). */
async function storedEmbedding(id: string): Promise<number[] | null> {
  const r = await db.pool.query('SELECT embedding::real[]::double precision[] AS v FROM artifact_embeddings WHERE artifact_id = $1', [id])
  return r.rows.length === 0 ? null : (r.rows[0]?.v as number[])
}

describe('the artifact embedding is one value per artifact, in the side table', () => {
  it('a re-embed replaces the stored value: one row, the new value', async () => {
    const id = await artifact('default')
    await setArtifactEmbedding(id, floatsToBlob(vec(1)))
    await setArtifactEmbedding(id, floatsToBlob(vec(2)))
    expect(await embeddingCount(id)).toBe(1)
    const stored = await storedEmbedding(id)
    expect(stored).not.toBeNull()
    const expected = floatsToBlob(vec(2))
    for (let i = 0; i < EMBEDDING_DIM; i++) expect((stored as number[])[i]).toBe(expected.readFloatLE(i * 4))
  })

  it('a delete of the artifact removes its embedding (the cascade)', async () => {
    const id = await artifact('default')
    await setArtifactEmbedding(id, floatsToBlob(vec(3)))
    expect(await embeddingCount(id)).toBe(1)
    await db.pool.query('DELETE FROM artifacts WHERE id = $1', [id])
    expect(await embeddingCount(id)).toBe(0)
  })

  it('a wrong-length blob is refused: the artifact is kept without an embedding, and the call does not throw', async () => {
    const id = await artifact('default')
    await expect(setArtifactEmbedding(id, floatsToBlob([1, 2, 3]))).resolves.toBeUndefined()
    expect(await embeddingCount(id)).toBe(0)
    const r = await db.pool.query('SELECT count(*)::int AS n FROM artifacts WHERE id = $1', [id])
    expect(Number(r.rows[0]?.n)).toBe(1)
  })

  it('storeArtifactEmbedding on PostgreSQL writes the side row keyed by the artifact id', async () => {
    const id = await artifact('default')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ embedding: vec(4) }) })))
    await storeArtifactEmbedding(id, 'a title', '{}')
    expect(await embeddingCount(id)).toBe(1)
  })

  it('storeArtifactEmbedding on PostgreSQL does nothing for an artifact that does not exist (no throw)', async () => {
    const missing = uid('art-missing')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ embedding: vec(5) }) })))
    await expect(storeArtifactEmbedding(missing, 'a title', '{}')).resolves.toBeUndefined()
    expect(await embeddingCount(missing)).toBe(0)
  })
})

describe('the artifact search: the tenant scope is applied in SQL before the distance order', () => {
  it('tenant A\'s nearest artifact never comes from tenant B, even when tenant B holds the exact vector', async () => {
    const tenantA = uid('tenant-a')
    const tenantB = uid('tenant-b')
    const farA = await artifact(tenantA)
    const exactB = await artifact(tenantB)
    await setArtifactEmbedding(farA, floatsToBlob(vec(7)))
    await setArtifactEmbedding(exactB, floatsToBlob(QUERY))

    const hits = await pgVectorArtifacts(QUERY, 5, { tenantId: tenantA })
    const ids = hits.map(h => h.id)
    expect(ids).toContain(farA)
    expect(ids).not.toContain(exactB)
    expect(hits[0]?.id).toBe(farA)
  })

  it('without a scope the exact vector of any tenant is the first hit (score 1)', async () => {
    const tenant = uid('tenant-open')
    const exact = await artifact(tenant)
    const other = await artifact(tenant)
    await setArtifactEmbedding(exact, floatsToBlob(QUERY))
    await setArtifactEmbedding(other, floatsToBlob(vec(8)))

    // other cells may have left exact-match vectors of their own: the exact hits tie, so the check is on the set
    const hits = await pgVectorArtifacts(QUERY, 1000)
    expect(hits[0]?.score).toBeCloseTo(1, 6)
    expect(hits.filter(h => h.score > 0.999999).map(h => h.id)).toContain(exact)
    expect(hits.map(h => h.id)).toContain(other)
  })

  it('the limit is applied after the scope: a small tenant is not crowded out by a large one', async () => {
    const big = uid('tenant-big')
    const small = uid('tenant-small')
    for (let i = 0; i < 6; i++) {
      const id = await artifact(big)
      await setArtifactEmbedding(id, floatsToBlob(QUERY))
    }
    const smallOne = await artifact(small)
    await setArtifactEmbedding(smallOne, floatsToBlob(vec(9)))

    const hits = await pgVectorArtifacts(QUERY, 2, { tenantId: small })
    expect(hits.map(h => h.id)).toEqual([smallOne])
  })
})
