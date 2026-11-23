// The containment cell of the memory vector search on PostgreSQL (phase 3, step 6b, c8b): the same fixed corpus and the same
// hand-computed neighbours as the SQLite file (helpers/vec-fixed-corpus.ts), one tenant, no competing rows. PostgreSQL
// only: the search is the pgvector filter-first candidate query (L2, ORDER BY distance, id).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPgDbx } from '../../db/pg/index.js'
import { useDbxBackend as setBackend } from '../../db/facade.js'
import { floatsToBlob, syncVecMemoryEmbeddingUpdate, vectorSearch } from '../../db/vector.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { CORPUS_COMPONENTS, EXPECTED_TOP3, EXPECTED_TOP5, QUERY_ZERO, vectorFor } from '../helpers/vec-fixed-corpus.js'

const AGENT = 'agent-fx'
const TENANT = 'tenant-fx'

let db: PgTestDb

beforeAll(async () => {
  db = await createPgTestDb()
  setBackend(createPgDbx(db.pool), 'pg')
})

afterAll(async () => {
  setBackend(null)
  if (db) await db.close()
})

async function insertMemory(content: string): Promise<number> {
  const r = await db.pool.query(
    `INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, agent_id, category, tenant_id)
     VALUES ('chat-fx', $1, 'semantic', $2, $2, $3, 'warm', $4) RETURNING id`,
    [content, Math.floor(Date.now() / 1000), AGENT, TENANT],
  )
  return Number(r.rows[0]?.id)
}

describe('the memory vector search on a fixed corpus (PostgreSQL)', () => {
  it('the three and the five nearest memories are the hand-computed neighbours, in that order', async () => {
    const idOf: number[] = []
    for (const [i, component] of CORPUS_COMPONENTS.entries()) {
      const id = await insertMemory(`fixed corpus item ${i}`)
      idOf.push(id)
      await syncVecMemoryEmbeddingUpdate(id, floatsToBlob(vectorFor(component)))
    }
    const top3 = (await vectorSearch(AGENT, QUERY_ZERO, 3, false, TENANT)).map((m) => m.id)
    expect(top3).toEqual(EXPECTED_TOP3.map((i) => idOf[i]))
    const top5 = (await vectorSearch(AGENT, QUERY_ZERO, 5, false, TENANT)).map((m) => m.id)
    expect(top5).toEqual(EXPECTED_TOP5.map((i) => idOf[i]))
    // limit 1 makes the SQL LIMIT (limit * RERANK_FACTOR = 5) smaller than the nine items: the order of the SQL decides
    // which five come in, so a descending order would return the five farthest and the nearest of those, not item 6
    const top1 = (await vectorSearch(AGENT, QUERY_ZERO, 1, false, TENANT)).map((m) => m.id)
    expect(top1).toEqual([idOf[EXPECTED_TOP3[0]!]])
  })
})
