// The workspace document vector seam and the filter-first document search on pgvector (phase 3, step 6b). PostgreSQL
// only: the seam and the search run on the PG backend of `dbx`, the side table is the one of migration 0007.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPgDbx } from '../../db/pg/index.js'
import { dbx, useDbxBackend as setBackend } from '../../db/facade.js'
import { deleteWorkspaceDoc, pgVectorDocs, setWorkspaceDocEmbedding } from '../../db/workspace.js'
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

let seq = 0
const uid = (prefix: string): string => `${prefix}-${process.pid}-${++seq}-${Math.random().toString(36).slice(2, 8)}`

/** A document row, inserted directly: the scope columns and the content type are what the search filters on. */
async function doc(opts: { agent: string; tenant?: string; contentType?: 'text' | 'binary' }): Promise<string> {
  const id = uid('doc')
  await db.pool.query(
    "INSERT INTO workspace_docs (id, agent_id, tenant_id, title, content, content_type) VALUES ($1, $2, $3, 'title', 'body', $4)",
    [id, opts.agent, opts.tenant ?? 'default', opts.contentType ?? 'text'],
  )
  return id
}

/** A deterministic 768-float vector: the seed picks the direction. */
function vec(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(seed * 1000 + i) * 0.5)
}

const QUERY = vec(1)

async function embeddingCount(id: string): Promise<number> {
  const r = await db.pool.query('SELECT count(*)::int AS n FROM workspace_doc_embeddings WHERE doc_id = $1', [id])
  return Number(r.rows[0]?.n)
}

/** The stored embedding, read back exactly: a double precision cast keeps the float32 value (the float4 text is a shorter decimal). */
async function storedEmbedding(id: string): Promise<number[] | null> {
  const r = await db.pool.query('SELECT embedding::real[]::double precision[] AS v FROM workspace_doc_embeddings WHERE doc_id = $1', [id])
  return r.rows.length === 0 ? null : (r.rows[0]?.v as number[])
}

describe('the document search: the scope is applied in SQL before the distance order', () => {
  it('tenant A\'s nearest document never comes from tenant B, even when tenant B holds the exact vector', async () => {
    const agent = uid('agent-t')
    const tenantA = uid('tenant-a')
    const tenantB = uid('tenant-b')
    const far = await doc({ agent, tenant: tenantA })
    const exact = await doc({ agent, tenant: tenantB })
    await setWorkspaceDocEmbedding(far, agent, tenantA, floatsToBlob(vec(7)))
    await setWorkspaceDocEmbedding(exact, agent, tenantB, floatsToBlob(QUERY))
    const ids = (await pgVectorDocs(QUERY, { tenantId: tenantA, limit: 1 })).map((d) => d.id)
    expect(ids).toEqual([far])
  })

  it('the agent filter: only the named agent\'s documents come back', async () => {
    const tenant = uid('tenant-g')
    const x = uid('agent-x')
    const y = uid('agent-y')
    const mine = await doc({ agent: x, tenant })
    const theirs = await doc({ agent: y, tenant })
    await setWorkspaceDocEmbedding(mine, x, tenant, floatsToBlob(QUERY))
    await setWorkspaceDocEmbedding(theirs, y, tenant, floatsToBlob(QUERY))
    const ids = (await pgVectorDocs(QUERY, { tenantId: tenant, agentId: x, limit: 5 })).map((d) => d.id)
    expect(ids).toEqual([mine])
  })

  it('a binary document has no vector hit, even when a row for it was written directly', async () => {
    const agent = uid('agent-b')
    const tenant = uid('tenant-bin')
    const binary = await doc({ agent, tenant, contentType: 'binary' })
    await db.pool.query('INSERT INTO workspace_doc_embeddings (doc_id, embedding) VALUES ($1, $2::vector)', [binary, `[${vec(1).join(',')}]`])
    const ids = (await pgVectorDocs(QUERY, { tenantId: tenant, agentId: agent, limit: 5 })).map((d) => d.id)
    expect(ids).not.toContain(binary)
  })

  it('two documents with the same vector: with limit 1 the smaller id wins every time (the tiebreak is in the SQL)', async () => {
    const agent = uid('agent-tie')
    const tenant = uid('tenant-tie')
    const first = await doc({ agent, tenant })
    const second = await doc({ agent, tenant })
    expect(first < second).toBe(true)
    await setWorkspaceDocEmbedding(first, agent, tenant, floatsToBlob(QUERY))
    await setWorkspaceDocEmbedding(second, agent, tenant, floatsToBlob(QUERY))
    for (let round = 0; round < 5; round++) {
      const ids = (await pgVectorDocs(QUERY, { tenantId: tenant, agentId: agent, limit: 1 })).map((d) => d.id)
      expect(ids).toEqual([first])
    }
  })
})

describe('the document seam: one embedding per document, replaced, removed with the document', () => {
  it('an update replaces the value (one row, the new vector)', async () => {
    const agent = uid('agent-u')
    const id = await doc({ agent })
    await setWorkspaceDocEmbedding(id, agent, 'default', floatsToBlob(vec(21)))
    const second = floatsToBlob(vec(22))
    await setWorkspaceDocEmbedding(id, agent, 'default', second)
    expect(await embeddingCount(id)).toBe(1)
    const stored = await storedEmbedding(id)
    for (let i = 0; i < EMBEDDING_DIM; i++) expect(stored![i]).toBe(second.readFloatLE(i * 4))
  })

  it('deleting the document removes its embedding', async () => {
    const agent = uid('agent-del')
    const id = await doc({ agent })
    await setWorkspaceDocEmbedding(id, agent, 'default', floatsToBlob(vec(23)))
    expect(await deleteWorkspaceDoc(id)).toBe(true)
    expect(await embeddingCount(id)).toBe(0)
  })

  it('the tenant delete (the purge\'s DELETE on workspace_docs) cascades to the embeddings of that tenant only', async () => {
    const tenant = uid('tenant-purge')
    const other = uid('tenant-keep')
    const agent = uid('agent-p')
    const gone = await doc({ agent, tenant })
    const kept = await doc({ agent, tenant: other })
    await setWorkspaceDocEmbedding(gone, agent, tenant, floatsToBlob(vec(24)))
    await setWorkspaceDocEmbedding(kept, agent, other, floatsToBlob(vec(25)))
    await dbx.tx(async (tx) => { await tx.run('DELETE FROM workspace_docs WHERE tenant_id = ?', tenant) })
    expect(await embeddingCount(gone)).toBe(0)
    expect(await embeddingCount(kept)).toBe(1)
  })

  it('a wrong-length vector: the document is kept, no embedding is stored, and the next statement works', async () => {
    const agent = uid('agent-w')
    const id = await doc({ agent })
    await expect(setWorkspaceDocEmbedding(id, agent, 'default', floatsToBlob(new Array<number>(EMBEDDING_DIM - 1).fill(0.5)))).resolves.toBeUndefined()
    expect(await embeddingCount(id)).toBe(0)
    const kept = await db.pool.query('SELECT count(*)::int AS n FROM workspace_docs WHERE id = $1', [id])
    expect(Number(kept.rows[0]?.n)).toBe(1)
    await expect(db.pool.query('SELECT 1 AS ok')).resolves.toBeDefined()
  })
})
