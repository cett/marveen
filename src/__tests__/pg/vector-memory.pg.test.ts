// The memory vector seam and the filter-first search on pgvector (phase 3, step 6b). PostgreSQL only: the seams and
// vectorSearch run on the PG backend of `dbx`, and the side table is the one of migration 0007.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPgDbx } from '../../db/pg/index.js'
import { dbx, useDbxBackend as setBackend } from '../../db/facade.js'
import { blobToVectorLiteral, EMBEDDING_DIM, floatsToBlob, syncVecMemoryDelete, syncVecMemoryEmbeddingUpdate, vectorSearch } from '../../db/vector.js'
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

let seq = 0
const uid = (prefix: string): string => `${prefix}-${process.pid}-${++seq}-${Math.random().toString(36).slice(2, 8)}`
const nowSec = (): number => Math.floor(Date.now() / 1000)

/** A memory row, inserted directly (the scope columns are the ones the search filters on). */
async function memory(opts: { agent: string; tenant?: string; category?: string; createdAt?: number }): Promise<number> {
  const r = await db.pool.query(
    `INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, agent_id, category, tenant_id)
     VALUES ('chat-a', $1, 'semantic', $2, $2, $3, $4, $5) RETURNING id`,
    [uid('memory'), opts.createdAt ?? nowSec(), opts.agent, opts.category ?? 'warm', opts.tenant ?? 'default'],
  )
  return Number(r.rows[0]?.id)
}

/** A deterministic 768-float vector: the seed picks the direction, the same seed gives the same vector. */
function vec(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(seed * 1000 + i) * 0.5)
}

/** A vector close to vec(seed): the query's own vector with a tiny offset (its nearest neighbours). */
const QUERY = vec(1)

/**
 * The stored embedding of one memory, read back exactly. The cast is to double precision: a float4 casts to the double
 * with the same value, while the float4 text is the shortest decimal that rounds to it (0.38662058, not the double
 * 0.38662058115005493), which JS would parse to another double. Each component equals the float32 that was written.
 */
async function storedEmbedding(id: number): Promise<number[] | null> {
  const r = await db.pool.query('SELECT embedding::real[]::double precision[] AS v FROM memory_embeddings WHERE memory_id = $1', [id])
  return r.rows.length === 0 ? null : (r.rows[0]?.v as number[])
}

async function embeddingCount(id: number): Promise<number> {
  const r = await db.pool.query('SELECT count(*)::int AS n FROM memory_embeddings WHERE memory_id = $1', [id])
  return Number(r.rows[0]?.n)
}

describe('the filter-first search: the scope is applied in SQL before the distance order', () => {
  it('an agent sees its own memories and the shared ones, never another agent\'s', async () => {
    const agent = uid('agent-a')
    const other = uid('agent-b')
    const own = await memory({ agent })
    const foreign = await memory({ agent: other })
    const shared = await memory({ agent: other, category: 'shared' })
    await syncVecMemoryEmbeddingUpdate(own, floatsToBlob(QUERY))
    await syncVecMemoryEmbeddingUpdate(foreign, floatsToBlob(QUERY))
    await syncVecMemoryEmbeddingUpdate(shared, floatsToBlob(QUERY))
    const ids = (await vectorSearch(agent, QUERY, 10)).map((m) => m.id)
    expect(ids).toContain(own)
    expect(ids).toContain(shared)
    expect(ids).not.toContain(foreign)
  })

  it('a shared memory of tenant B is not visible to a search in tenant A (the tenant applies to the shared branch too)', async () => {
    // The scope is (agent OR shared) AND tenant: the tenant clause sits outside the parentheses. A shared memory of
    // another tenant holds the exact vector; a search in tenant A finds nothing, and the same search in tenant B does
    // find it (so the cell is not empty by construction).
    const tenantA = uid('tenant-sa')
    const tenantB = uid('tenant-sb')
    const sharedInB = await memory({ agent: uid('agent-owner'), tenant: tenantB, category: 'shared' })
    await syncVecMemoryEmbeddingUpdate(sharedInB, floatsToBlob(QUERY))
    const inA = (await vectorSearch(uid('agent-searcher'), QUERY, 10, false, tenantA)).map((m) => m.id)
    expect(inA).toEqual([])
    const inB = (await vectorSearch(uid('agent-searcher'), QUERY, 10, false, tenantB)).map((m) => m.id)
    expect(inB).toContain(sharedInB)
  })

  it('tenant A\'s nearest neighbour never comes from tenant B, even when tenant B holds the exact vector', async () => {
    const agent = uid('agent-t')
    const tenantA = uid('tenant-a')
    const tenantB = uid('tenant-b')
    const far = await memory({ agent, tenant: tenantA })
    const exact = await memory({ agent, tenant: tenantB })
    await syncVecMemoryEmbeddingUpdate(far, floatsToBlob(vec(7)))
    await syncVecMemoryEmbeddingUpdate(exact, floatsToBlob(QUERY))
    const ids = (await vectorSearch(agent, QUERY, 1, false, tenantA)).map((m) => m.id)
    expect(ids).toEqual([far])
  })

  it('a small tenant is not crowded out by a large one (the top k is taken inside the scope)', async () => {
    const agent = uid('agent-s')
    const big = uid('tenant-big')
    const small = uid('tenant-small')
    for (let i = 0; i < 50; i++) {
      const id = await memory({ agent, tenant: big })
      await syncVecMemoryEmbeddingUpdate(id, floatsToBlob(QUERY))
    }
    const lone = await memory({ agent, tenant: small })
    await syncVecMemoryEmbeddingUpdate(lone, floatsToBlob(vec(9)))
    const ids = (await vectorSearch(agent, QUERY, 1, false, small)).map((m) => m.id)
    expect(ids).toEqual([lone])
  })

  it('twenty memories with the same vector: with limit 1 the smallest id wins every time (the tiebreak is in the SQL, not in the heap order)', async () => {
    const agent = uid('agent-tie')
    // a tenant of its own: the scope clause admits every 'shared' memory of any agent, and the shared memories of the
    // cells above hold the same QUERY vector, so an unscoped search would see them as competitors
    const tenant = uid('tenant-tie')
    const createdAt = nowSec()
    const ids: number[] = []
    for (let i = 0; i < 20; i++) ids.push(await memory({ agent, createdAt, tenant }))
    // The physical order is the reverse of the id order: the embeddings are written from the largest id down, and the
    // memories rows are moved to the end of their heap by no-op updates in the same order, so the smallest id is the
    // last row physically. A plain PostgreSQL run of ORDER BY distance over such a tie returns 19 and 20 for LIMIT 2
    // (checked on PostgreSQL 16), not the smallest ids. Without the id tiebreak in the SQL the search is wrong here.
    const descending = [...ids].sort((a, b) => b - a)
    for (const id of descending) await syncVecMemoryEmbeddingUpdate(id, floatsToBlob(QUERY))
    for (const id of descending) await db.pool.query('UPDATE memories SET content = content WHERE id = $1', [id])
    const smallest = Math.min(...ids)
    for (let round = 0; round < 5; round++) {
      const hits = (await vectorSearch(agent, QUERY, 1, false, tenant)).map((m) => m.id)
      expect(hits).toEqual([smallest])
    }
  })

  it('the distance operator is the L2 distance (checked against the same computation in JS, 1e-5)', async () => {
    const a = vec(3)
    const b = vec(4)
    const r = await db.pool.query('SELECT ($1::vector <-> $2::vector) AS d', [blobToVectorLiteral(floatsToBlob(a)), blobToVectorLiteral(floatsToBlob(b))])
    const js = Math.sqrt(a.reduce((s, x, i) => s + (Math.fround(x) - Math.fround(b[i]!)) ** 2, 0))
    expect(Math.abs(Number(r.rows[0]?.d) - js)).toBeLessThan(1e-5)
  })
})

describe('the seam: one embedding per memory, the parent and the side row', () => {
  it('a re-embed replaces the value (one row, the new vector)', async () => {
    const id = await memory({ agent: uid('agent-r') })
    await syncVecMemoryEmbeddingUpdate(id, floatsToBlob(vec(11)))
    const second = floatsToBlob(vec(12))
    await syncVecMemoryEmbeddingUpdate(id, second)
    expect(await embeddingCount(id)).toBe(1)
    const stored = await storedEmbedding(id)
    for (let i = 0; i < EMBEDDING_DIM; i++) expect(stored![i]).toBe(second.readFloatLE(i * 4))
  })

  it('the seam delete removes the side row and keeps the memory (the import stale-vector case)', async () => {
    const id = await memory({ agent: uid('agent-d') })
    await syncVecMemoryEmbeddingUpdate(id, floatsToBlob(vec(13)))
    await syncVecMemoryDelete(id)
    expect(await embeddingCount(id)).toBe(0)
    const kept = await db.pool.query('SELECT count(*)::int AS n FROM memories WHERE id = $1', [id])
    expect(Number(kept.rows[0]?.n)).toBe(1)
  })

  it('a refused side-row write inside an open transaction is a savepoint: the transaction goes on and its other work commits', async () => {
    const kept = await memory({ agent: uid('agent-sp') })
    const missing = 2_000_000_000 + Math.floor(Math.random() * 1000) // no such memory: the foreign key refuses the row
    const marker = uid('sp-marker')
    await dbx.tx(async (tx) => {
      // the seam's own write fails inside its savepoint: it is logged and returns, the transaction is not aborted
      await expect(syncVecMemoryEmbeddingUpdate(missing, floatsToBlob(vec(15)))).resolves.toBeUndefined()
      // a statement after the failure in the same transaction works (no 25P02 "current transaction is aborted")
      await tx.run('UPDATE memories SET content = ? WHERE id = ?', marker, kept)
    })
    expect(await embeddingCount(missing)).toBe(0)
    const r = await db.pool.query('SELECT content FROM memories WHERE id = $1', [kept])
    expect(r.rows[0]?.content).toBe(marker)
  })

  it('deleting the memory cascades to its embedding', async () => {
    const id = await memory({ agent: uid('agent-c') })
    await syncVecMemoryEmbeddingUpdate(id, floatsToBlob(vec(14)))
    await db.pool.query('DELETE FROM memories WHERE id = $1', [id])
    expect(await embeddingCount(id)).toBe(0)
  })

  it('a wrong-length vector: the memory is kept, no embedding is stored, and the next statement works', async () => {
    const id = await memory({ agent: uid('agent-w') })
    await expect(syncVecMemoryEmbeddingUpdate(id, floatsToBlob(new Array<number>(EMBEDDING_DIM - 1).fill(0.5)))).resolves.toBeUndefined()
    expect(await embeddingCount(id)).toBe(0)
    const kept = await db.pool.query('SELECT count(*)::int AS n FROM memories WHERE id = $1', [id])
    expect(Number(kept.rows[0]?.n)).toBe(1)
    await expect(db.pool.query('SELECT 1 AS ok')).resolves.toBeDefined()
  })

  it('a NaN component: no embedding is stored and the call does not throw', async () => {
    const id = await memory({ agent: uid('agent-n') })
    const values = new Array<number>(EMBEDDING_DIM).fill(0.25)
    values[10] = Number.NaN
    await expect(syncVecMemoryEmbeddingUpdate(id, floatsToBlob(values))).resolves.toBeUndefined()
    expect(await embeddingCount(id)).toBe(0)
  })
})

describe('the float32 edge values survive the text literal (pgvector reads what blobToVectorLiteral writes)', () => {
  it('the extremes, the smallest normal and denormal, zero and minus zero, and a random mix: each value equals Math.fround of the input', async () => {
    const id = await memory({ agent: uid('agent-e') })
    // a deterministic mix for the rest of the vector (LCG, so a failure can be reproduced)
    let s = 20261122 >>> 0
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 0x100000000 - 0.5
    }
    const values: number[] = [3.4028235e38, -3.4028235e38, 1.1754944e-38, 1.4e-45, 0, -0]
    while (values.length < EMBEDDING_DIM) values.push(rnd() * 2)
    await syncVecMemoryEmbeddingUpdate(id, floatsToBlob(values))
    expect(await embeddingCount(id)).toBe(1)
    const stored = await storedEmbedding(id)
    expect(stored).not.toBeNull()
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      // Value equality (===): a -0 input is stored as 0, its sign is not kept (the text is "0"), and 0 === -0 holds.
      // Object.is would fail at index 5 and is deliberately not used.
      if (stored![i] !== Math.fround(values[i]!)) {
        throw new Error(`component ${i}: stored ${stored![i]}, expected ${Math.fround(values[i]!)} (input ${values[i]})`)
      }
    }
  })

  it('the minus zero input reads back as zero (the sign is not preserved by the text form, by design)', async () => {
    const id = await memory({ agent: uid('agent-z') })
    const values = new Array<number>(EMBEDDING_DIM).fill(0)
    values[0] = -0
    await syncVecMemoryEmbeddingUpdate(id, floatsToBlob(values))
    const stored = await storedEmbedding(id)
    expect(stored![0] === 0).toBe(true)
  })
})
