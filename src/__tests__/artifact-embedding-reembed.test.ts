// storeArtifactEmbedding on a vec0 table: embedding the same artifact a second time (its title or meta changed) must
// REPLACE the stored vector. INSERT OR REPLACE does not replace in vec0 ("UNIQUE constraint failed on vec_artifacts
// primary key"), the error was swallowed, and the vector of a changed artifact stayed stale. SQLite only (the vector
// index is sqlite-vec; the pgvector phase replaces it), so the file opens the database by hand and is not in the
// PG module partition. The embedding service is a stubbed fetch, so the test needs no Ollama.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dbx, initDatabase } from '../db.js'
import { createArtifact, storeArtifactEmbedding } from '../db/artifacts.js'

const DIM = 768
// the first component tells the vectors apart: the stub answers with [marker, 0, 0, ...] for the prompt
const markers = new Map<string, number>()
const embeddingFor = (prompt: string): number[] => {
  const v = new Array<number>(DIM).fill(0)
  v[0] = markers.get(prompt) ?? 0.5
  return v
}

beforeEach(() => {
  initDatabase(':memory:')
  markers.clear()
  vi.stubGlobal('fetch', vi.fn((_url: string, init: { body: string }) => {
    const { prompt } = JSON.parse(init.body) as { prompt: string }
    return Promise.resolve({ json: () => Promise.resolve({ embedding: embeddingFor(prompt) }) })
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

const stored = async (): Promise<number[]> => {
  const rows = (await dbx.all('SELECT artifact_rowid, embedding FROM vec_artifacts')) as { artifact_rowid: number; embedding: Buffer }[]
  return rows.map((r) => r.embedding.readFloatLE(0))
}

describe('storeArtifactEmbedding re-embeds', () => {
  it('a second embedding of the same artifact replaces the stored vector (one row, the new value)', async () => {
    markers.set('first title {}', 0.25)
    markers.set('second title {}', 0.75)
    const { id } = await createArtifact({ agent_id: 'agent-a', title: 'first title', kind: 'text', content: Buffer.from('x') })
    await storeArtifactEmbedding(id, 'first title', '{}')
    expect(await stored()).toEqual([0.25])
    await storeArtifactEmbedding(id, 'second title', '{}')
    expect(await stored()).toEqual([0.75])
  })

  it('another artifact keeps its own vector, and a third embedding still replaces', async () => {
    markers.set('a {}', 0.1)
    markers.set('b {}', 0.2)
    markers.set('a2 {}', 0.3)
    markers.set('a3 {}', 0.4)
    const a = (await createArtifact({ agent_id: 'agent-a', title: 'a', kind: 'text', content: Buffer.from('x') })).id
    const b = (await createArtifact({ agent_id: 'agent-a', title: 'b', kind: 'text', content: Buffer.from('y') })).id
    await storeArtifactEmbedding(a, 'a', '{}')
    await storeArtifactEmbedding(b, 'b', '{}')
    await storeArtifactEmbedding(a, 'a2', '{}')
    await storeArtifactEmbedding(a, 'a3', '{}')
    expect((await stored()).map((x) => Math.round(x * 100)).sort((p, q) => p - q)).toEqual([20, 40])
  })
})
