// The part of the recall harness that runs the REAL retrieval pipeline over a query set.
// Kept apart from the CLI so it can be exercised against an in-memory database in tests.
import type Database from 'better-sqlite3'
import { embedKey, l2sq, type CaseKind, type QueryCase, type QueryRun } from './recall-eval-lib.js'

export const FINAL_LIMIT = 10
// Mirrors src/db/vector.ts (vectorSearch): keep in sync if those constants change.
export const RERANK_FACTOR = 5
export const VECTOR_RECENCY_LAMBDA = 0.02

interface MemBlob {
  id: number
  agent_id: string
  tenant_id: string
  category: string
  created_at: number
  embedding_blob: Buffer
}

/**
 * Runs every case through the production search functions with a frozen clock (`nowSec`).
 * The caller stubs `fetch` so the production code's own embedding call is answered from the cache;
 * the same cache is passed in `embeddings` for the raw vector stages. A missing embedding throws.
 * The database module must already be initialised (and `db` must be that module's handle).
 */
export async function runCases(
  db: Database.Database,
  cases: QueryCase[],
  embeddings: Record<string, number[]>,
  nowSec: number,
): Promise<QueryRun[]> {
  const { hybridSearch, floatsToBlob, searchArtifactsByVector } = await import('../../src/db/vector.js')
  const { searchAgentMemories } = await import('../../src/db/memory.js')
  const { searchWorkspaceDocs, vectorSearchDocs, hybridSearchDocs } = await import('../../src/workspace-store.js')

  const decay = (createdAt: number) => Math.exp(-VECTOR_RECENCY_LAMBDA * ((nowSec - createdAt) / 86400))
  const allMem = db
    .prepare('SELECT id, agent_id, tenant_id, category, created_at, embedding_blob FROM memories WHERE embedding_blob IS NOT NULL')
    .all() as MemBlob[]
  const byId = new Map(allMem.map((m) => [m.id, m]))
  const vecOf = (m: MemBlob) => new Float32Array(m.embedding_blob.buffer, m.embedding_blob.byteOffset, m.embedding_blob.byteLength / 4)

  const runs: QueryRun[] = []
  for (const c of cases) {
    const q = embeddings[embedKey(c.text)]
    if (!q) throw new Error(`no cached embedding for ${c.id}`)
    const stages: Record<string, string[]> = {}
    if (c.kind === 'memory') {
      const permitted = (m: MemBlob) =>
        (m.agent_id === c.agentId || m.category === 'shared') && (!c.tenantId || m.tenant_id === c.tenantId)
      stages.fts = searchAgentMemories(c.agentId!, c.text, FINAL_LIMIT * 2, c.tenantId).map((m) => String(m.id))
      // vec_prod: what production does inside hybridSearch(limit=10): ANN k=limit*2*5, filter, recency-sort.
      const ann = db
        .prepare('SELECT memory_id, distance FROM vec_memories WHERE embedding MATCH ? AND k = ? ORDER BY distance')
        .all(floatsToBlob(q), BigInt(FINAL_LIMIT * 2 * RERANK_FACTOR)) as { memory_id: number; distance: number }[]
      stages.vec_prod = ann
        .map((r) => ({ m: byId.get(r.memory_id), d: r.distance }))
        .filter((x): x is { m: MemBlob; d: number } => !!x.m && permitted(x.m))
        .map((x) => ({ id: x.m.id, s: (1 / (1 + x.d)) * decay(x.m.created_at) }))
        .sort((a, b) => b.s - a.s || a.id - b.id)
        .slice(0, FINAL_LIMIT)
        .map((x) => String(x.id))
      // vec_exact: filter first, then exact L2 top-10 (what `ORDER BY embedding <-> $1 LIMIT 10` returns on PG).
      stages.vec_exact = allMem
        .filter(permitted)
        .map((m) => ({ id: m.id, d: l2sq(q, vecOf(m)) }))
        .sort((a, b) => a.d - b.d || a.id - b.id)
        .slice(0, FINAL_LIMIT)
        .map((x) => String(x.id))
      stages.final = (await hybridSearch(c.agentId!, c.text, FINAL_LIMIT, c.tenantId)).map((m) => String(m.id))
    } else if (c.kind === 'doc') {
      const o = { agentId: c.agentId, tenantId: c.tenantId, limit: FINAL_LIMIT }
      stages.fts = searchWorkspaceDocs(c.text, { ...o, limit: FINAL_LIMIT * 2 }).map((d) => d.id)
      stages.vec_prod = (await vectorSearchDocs(c.text, o)).map((d) => d.id)
      stages.final = (await hybridSearchDocs(c.text, o)).map((d) => d.id)
    } else {
      const hits = (await searchArtifactsByVector(c.text, FINAL_LIMIT)).map((a) => a.id)
      stages.vec_prod = hits
      stages.final = hits
    }
    runs.push({ id: c.id, kind: c.kind as CaseKind, stages })
  }
  return runs
}
