// The hybrid document search (text plus vector fusion) on PostgreSQL, without Ollama (phase 3, step 6b, c8). The query
// embedder is replaced by a fixed vector, so the vector leg is real pgvector and the text leg is the 6a full-text search.
// PostgreSQL only.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPgDbx } from '../../db/pg/index.js'
import { useDbxBackend as setBackend } from '../../db/facade.js'
import { EMBEDDING_DIM, floatsToBlob } from '../../db/vector.js'
import { hybridSearchDocs, searchWorkspaceDocs, setWorkspaceDocEmbedding } from '../../db/workspace.js'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'

// The embedder of the query: the same vector as the one vec(1) of the other cells (sin(1000 + i) * 0.5). The factory
// keeps every other export of the module.
vi.mock('../../db/vector.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/vector.js')>()
  return {
    ...actual,
    generateEmbedding: (): Promise<number[]> =>
      Promise.resolve(Array.from({ length: actual.EMBEDDING_DIM }, (_, i) => Math.sin(1000 + i) * 0.5)),
  }
})

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

/** The vector of the mocked embedder: the query lands exactly on it. */
const QUERY = Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(1000 + i) * 0.5)
const far = (): number[] => Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(9000 + i) * 0.5)

/** A text document with its embedding through the write seam (the same call the save path makes). */
async function doc(opts: { agent: string; tenant: string; content: string; vector: number[] }): Promise<string> {
  const id = uid('hybrid')
  await db.pool.query(
    "INSERT INTO workspace_docs (id, agent_id, tenant_id, title, content, content_type) VALUES ($1, $2, $3, 'title', $4, 'text')",
    [id, opts.agent, opts.tenant, opts.content],
  )
  await setWorkspaceDocEmbedding(id, opts.agent, opts.tenant, floatsToBlob(opts.vector))
  return id
}

describe('the hybrid document search fuses the two legs', () => {
  it('with limit 2 and twelve nearer documents, the text-only document is in the fused top 2: only the text leg can put it there', async () => {
    const tenant = uid('tenant-h1')
    const agent = uid('agent-h1')
    // the vector leg keeps limit*2 = 4 hits: the exact-vector document (rank 0) and three fillers. The fillers have no
    // query word and sit a little further from the query than the exact one, so the text-only document (its embedding is
    // far) is outside the vector leg's top 4. Its only rank is the text leg's rank 0, the highest score of the fusion.
    const vectorOnly = await doc({ agent, tenant, content: 'zeta omega', vector: QUERY })
    const textOnly = await doc({ agent, tenant, content: 'alpha beta', vector: far() })
    for (let k = 0; k < 12; k++) {
      await doc({ agent, tenant, content: `filler ${k}`, vector: QUERY.map((x) => x + 0.001 * (k + 1)) })
    }
    const top = (await hybridSearchDocs('alpha', { agentId: agent, tenantId: tenant, limit: 2 })).map((d) => d.id)
    expect(top).toContain(textOnly)
    expect(top).toContain(vectorOnly)
  })

  it('every hit of the text search is in the fused list (the text part is the 6a search, unchanged)', async () => {
    const tenant = uid('tenant-h2')
    const agent = uid('agent-h2')
    await doc({ agent, tenant, content: 'alpha one', vector: far() })
    await doc({ agent, tenant, content: 'alpha two', vector: far() })
    await doc({ agent, tenant, content: 'alpha three', vector: QUERY })
    const textIds = (await searchWorkspaceDocs('alpha', { agentId: agent, tenantId: tenant, limit: 10 })).map((d) => d.id)
    expect(textIds.length).toBe(3)
    const fused = (await hybridSearchDocs('alpha', { agentId: agent, tenantId: tenant, limit: 10 })).map((d) => d.id)
    for (const id of textIds) expect(fused).toContain(id)
  })

  it('a document of tenant B with the exact vector and the query word never comes into tenant A\'s fused list', async () => {
    const tenantA = uid('tenant-hA')
    const tenantB = uid('tenant-hB')
    const agent = uid('agent-h3')
    const inA = await doc({ agent, tenant: tenantA, content: 'alpha', vector: far() })
    const inB = await doc({ agent, tenant: tenantB, content: 'alpha', vector: QUERY })
    const fusedA = (await hybridSearchDocs('alpha', { agentId: agent, tenantId: tenantA, limit: 10 })).map((d) => d.id)
    expect(fusedA).toContain(inA)
    expect(fusedA).not.toContain(inB)
    // the same search in tenant B does find its own document: the cell is not empty by construction
    const fusedB = (await hybridSearchDocs('alpha', { agentId: agent, tenantId: tenantB, limit: 10 })).map((d) => d.id)
    expect(fusedB).toContain(inB)
  })
})
