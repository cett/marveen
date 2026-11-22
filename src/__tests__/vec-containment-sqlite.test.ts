// The containment cell of the memory vector search on SQLite (phase 3, step 6b, c8b): a fixed corpus whose neighbours are
// computed by hand (see helpers/vec-fixed-corpus.ts), one tenant, no competing rows. The PostgreSQL side is the same
// corpus and the same expected order in pg/vec-containment.pg.test.ts.
import { beforeAll, describe, expect, it } from 'vitest'
import { db, initDatabase } from '../db.js'
import { vecExtensionLoaded } from '../db/connection.js'
import { floatsToBlob, syncVecMemoryEmbeddingUpdate, vectorSearch } from '../db/vector.js'
import { CORPUS_COMPONENTS, EXPECTED_TOP3, EXPECTED_TOP5, QUERY_ZERO, vectorFor } from './helpers/vec-fixed-corpus.js'

const AGENT = 'agent-fx'
const TENANT = 'tenant-fx'

function insertMemory(content: string): number {
  return (db.prepare(
    `INSERT INTO memories (chat_id, content, sector, salience, category, agent_id, auto_generated, created_at, accessed_at, updated_at, tenant_id)
     VALUES ('chat-fx', ?, 'semantic', 1, 'warm', ?, 0, unixepoch(), unixepoch(), unixepoch(), ?) RETURNING id`,
  ).get(content, AGENT, TENANT) as { id: number }).id
}

beforeAll(() => { initDatabase(':memory:') })

describe('the memory vector search on a fixed corpus (SQLite)', () => {
  it('the three and the five nearest memories are the hand-computed neighbours, in that order', async () => {
    // loud, not a skip: without the vector index the search would return nothing and the cell would fail for the wrong reason
    expect(vecExtensionLoaded).toBe(true)
    const idOf: number[] = []
    for (const [i, component] of CORPUS_COMPONENTS.entries()) {
      const id = insertMemory(`fixed corpus item ${i}`)
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
