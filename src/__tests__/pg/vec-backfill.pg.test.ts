// The batched, resumable backfill of the PostgreSQL side tables from the blob columns (phase 3, step 6b, c7). PostgreSQL
// only: the backfill runs on the PG backend of `dbx`. The rows are inserted directly, with their blob, the way the
// SQLite-era writers left them. Each counting cell first drains the leftovers of the cells before it, so its counts are its own.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPgDbx } from '../../db/pg/index.js'
import { dbx, useDbxBackend as setBackend } from '../../db/facade.js'
import { backfillPgEmbeddings, EMBEDDING_DIM, floatsToBlob, syncVecMemoryEmbeddingUpdate } from '../../db/vector.js'
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

/** A deterministic 768-float vector: the seed picks the direction. */
function vec(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(seed * 1000 + i) * 0.5)
}

const BLOB = floatsToBlob(vec(1))

/** n memories with the blob, no side row. Returns their ids in ascending order. */
async function bulkMemories(n: number, blob: Buffer): Promise<number[]> {
  const r = await db.pool.query(
    `INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, agent_id, category, tenant_id, embedding_blob)
     SELECT 'chat-a', $1::text || g::text, 'semantic', $2, $2, 'agent-bf', 'warm', 'default', $3
     FROM generate_series(1, $4) g RETURNING id`,
    [uid('bf') + '-', nowSec(), blob, n],
  )
  return r.rows.map((row) => Number(row.id)).sort((a, b) => a - b)
}

async function memoryWithBlob(blob: Buffer | null): Promise<number> {
  const r = await db.pool.query(
    `INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, agent_id, category, tenant_id, embedding_blob)
     VALUES ('chat-a', $1, 'semantic', $2, $2, 'agent-bf', 'warm', 'default', $3) RETURNING id`,
    [uid('bf'), nowSec(), blob],
  )
  return Number(r.rows[0]?.id)
}

async function sideCount(ids: number[]): Promise<number> {
  const r = await db.pool.query('SELECT count(*)::int AS n FROM memory_embeddings WHERE memory_id = ANY($1::bigint[])', [ids])
  return Number(r.rows[0]?.n)
}

/** The stored embedding read back exactly (the same two-step cast as the seam cells). */
async function storedMemoryEmbedding(id: number): Promise<number[] | null> {
  const r = await db.pool.query('SELECT embedding::real[]::double precision[] AS v FROM memory_embeddings WHERE memory_id = $1', [id])
  return r.rows.length === 0 ? null : (r.rows[0]?.v as number[])
}

/** Clear the leftovers of the earlier cells (the valid ones are embedded; the bad ones are passed over, not counted here). */
async function drainMemories(): Promise<void> {
  await backfillPgEmbeddings('memory')
}

describe('the memory backfill: embedded from the blob, in batches, idempotent', () => {
  it('a memory with a blob and no side row is embedded, with the blob value, and a second run embeds nothing', async () => {
    await drainMemories()
    const a = await memoryWithBlob(floatsToBlob(vec(21)))
    const b = await memoryWithBlob(floatsToBlob(vec(22)))
    const first = await backfillPgEmbeddings('memory')
    expect(first).toEqual({ embedded: 2, skipped: 0, batches: 1 })
    expect(await sideCount([a, b])).toBe(2)
    const stored = await storedMemoryEmbedding(a)
    const expected = floatsToBlob(vec(21))
    for (let i = 0; i < EMBEDDING_DIM; i++) expect(stored![i]).toBe(expected.readFloatLE(i * 4))
    const second = await backfillPgEmbeddings('memory')
    expect(second).toEqual({ embedded: 0, skipped: 0, batches: 0 })
    expect(await sideCount([a, b])).toBe(2)
  })

  it('2001 memories with a blob are embedded in one run: a full batch of 2000, then the last partial batch of 1', async () => {
    await drainMemories()
    const ids = await bulkMemories(2001, BLOB)
    const result = await backfillPgEmbeddings('memory')
    expect(result).toEqual({ embedded: 2001, skipped: 0, batches: 2 })
    expect(await sideCount(ids)).toBe(2001)
  })

  it('a resumed run embeds only the rows that have no side row yet (NOT EXISTS), and leaves the rows that have one untouched', async () => {
    await drainMemories()
    const ids = await bulkMemories(10, BLOB)
    const live = vec(31)
    // the live seam wrote the first four rows with another vector: the backfill must not overwrite them
    for (const id of ids.slice(0, 4)) await syncVecMemoryEmbeddingUpdate(id, floatsToBlob(live))
    const result = await backfillPgEmbeddings('memory')
    expect(result).toEqual({ embedded: 6, skipped: 0, batches: 1 })
    expect(await sideCount(ids)).toBe(10)
    const kept = await storedMemoryEmbedding(ids[0]!)
    const liveBlob = floatsToBlob(live)
    for (let i = 0; i < EMBEDDING_DIM; i++) expect(kept![i]).toBe(liveBlob.readFloatLE(i * 4))
  })

  it('a batch size smaller than the table: the keyset walks every batch, and the counts add up', async () => {
    await drainMemories()
    const ids = await bulkMemories(7, BLOB)
    const result = await backfillPgEmbeddings('memory', 3)
    expect(result).toEqual({ embedded: 7, skipped: 0, batches: 3 })
    expect(await sideCount(ids)).toBe(7)
  })
})

describe('the document backfill: text documents embedded, binary documents not selected', () => {
  it('a text document with a blob is embedded, and a binary document with a blob is not', async () => {
    await drainMemories()
    const r = await backfillPgEmbeddings('workspace_doc')
    // drain the document target as well: the earlier cells left no document rows, so this run is the baseline
    expect(r.skipped).toBe(0)
    const text = uid('doc')
    const binary = uid('doc')
    await db.pool.query(
      "INSERT INTO workspace_docs (id, agent_id, tenant_id, title, content, content_type, embedding_blob) VALUES ($1, 'agent-bf', 'default', 't', 'body', 'text', $2)",
      [text, BLOB],
    )
    await db.pool.query(
      "INSERT INTO workspace_docs (id, agent_id, tenant_id, title, content, content_type, embedding_blob) VALUES ($1, 'agent-bf', 'default', 't', 'body', 'binary', $2)",
      [binary, BLOB],
    )
    const result = await backfillPgEmbeddings('workspace_doc')
    expect(result).toEqual({ embedded: 1, skipped: 0, batches: 1 })
    const side = await db.pool.query('SELECT doc_id FROM workspace_doc_embeddings WHERE doc_id = ANY($1::text[]) ORDER BY doc_id', [[text, binary]])
    expect(side.rows.map((row) => row.doc_id)).toEqual([text])
  })
})

describe('the document keyset walks several batches on a text id', () => {
  it('five text documents in batches of 2: three batches, five embedded, each id once', async () => {
    const leftovers = await backfillPgEmbeddings('workspace_doc')
    expect(leftovers.skipped).toBe(0)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const id = uid('doc-batch')
      ids.push(id)
      await db.pool.query(
        "INSERT INTO workspace_docs (id, agent_id, tenant_id, title, content, content_type, embedding_blob) VALUES ($1, 'agent-bf', 'default', 't', 'body', 'text', $2)",
        [id, BLOB],
      )
    }
    const result = await backfillPgEmbeddings('workspace_doc', 2)
    expect(result).toEqual({ embedded: 5, skipped: 0, batches: 3 })
    const side = await db.pool.query('SELECT count(*)::int AS n FROM workspace_doc_embeddings WHERE doc_id = ANY($1::text[])', [ids])
    expect(Number(side.rows[0]?.n)).toBe(5)
  })
})

describe('a row without a blob is not selected: not embedded, not counted as skipped', () => {
  it('a memory with a NULL blob is passed over silently, a memory with a blob is embedded', async () => {
    await drainMemories()
    const noBlob = await memoryWithBlob(null)
    const withBlob = await memoryWithBlob(BLOB)
    const result = await backfillPgEmbeddings('memory')
    expect(result).toEqual({ embedded: 1, skipped: 0, batches: 1 })
    expect(await sideCount([noBlob])).toBe(0)
    expect(await sideCount([withBlob])).toBe(1)
  })

  it('a text document with a NULL blob is passed over silently', async () => {
    const leftovers = await backfillPgEmbeddings('workspace_doc')
    expect(leftovers.skipped).toBe(0)
    const id = uid('doc-noblob')
    await db.pool.query(
      "INSERT INTO workspace_docs (id, agent_id, tenant_id, title, content, content_type, embedding_blob) VALUES ($1, 'agent-bf', 'default', 't', 'body', 'text', NULL)",
      [id],
    )
    const result = await backfillPgEmbeddings('workspace_doc')
    expect(result).toEqual({ embedded: 0, skipped: 0, batches: 0 })
    const side = await db.pool.query('SELECT count(*)::int AS n FROM workspace_doc_embeddings WHERE doc_id = $1', [id])
    expect(Number(side.rows[0]?.n)).toBe(0)
  })
})

describe('a bad blob is skipped and counted; the run goes on', () => {
  it('a short blob and a blob with a NaN component are skipped and counted, and the rows around them are embedded', async () => {
    await drainMemories()
    const good1 = await memoryWithBlob(BLOB)
    const short = await memoryWithBlob(Buffer.alloc(8))
    const nanValues = new Array<number>(EMBEDDING_DIM).fill(0.25)
    nanValues[10] = Number.NaN
    const nanBlob = await memoryWithBlob(floatsToBlob(nanValues))
    const good2 = await memoryWithBlob(BLOB)
    const result = await backfillPgEmbeddings('memory')
    expect(result).toEqual({ embedded: 2, skipped: 2, batches: 1 })
    expect(await sideCount([good1, good2])).toBe(2)
    expect(await sideCount([short, nanBlob])).toBe(0)
  })
})
