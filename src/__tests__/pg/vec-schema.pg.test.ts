// The vector embedding tables of migration 0007 (phase 3, step 6b, c2): the extension, the 768 dimension, the refusal of a
// NaN component, the cascade from each parent, one embedding per parent, and the preflight refusal of a database without
// the extension. PostgreSQL only; the parity of the three tables with the SQLite twin is in baseline-parity (PG_ONLY_TABLES).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { pgPreflight, PgPreflightError } from '../../db/pg/preflight.js'

const DIM = 768
let db: PgTestDb
const extra: PgTestDb[] = []

beforeAll(async () => {
  db = await createPgTestDb()
})

afterAll(async () => {
  for (const d of extra) await d.close()
  if (db) await db.close()
})

/** A pgvector literal with n finite components. */
function literal(n: number, first = 0.25): string {
  const parts = new Array<string>(n).fill('0.25')
  if (n > 0) parts[0] = String(first)
  return `[${parts.join(',')}]`
}

let seq = 0
const uid = (prefix: string): string => `${prefix}-${process.pid}-${++seq}-${Math.random().toString(36).slice(2, 8)}`

async function newMemory(): Promise<number> {
  const r = await db.pool.query(
    "INSERT INTO memories (chat_id, content, sector, created_at, accessed_at) VALUES ('chat-a', $1, 'semantic', 1, 1) RETURNING id",
    [`memory ${uid('m')}`],
  )
  return Number(r.rows[0]?.id)
}

async function newDoc(): Promise<string> {
  const id = uid('doc')
  await db.pool.query("INSERT INTO workspace_docs (id, agent_id, title, content) VALUES ($1, 'agent-a', 'title', 'body')", [id])
  return id
}

async function newArtifact(): Promise<string> {
  const id = uid('art')
  await db.pool.query("INSERT INTO artifacts (id, agent_id, title, kind, content) VALUES ($1, 'agent-a', 'title', 'text', $2)", [
    id,
    Buffer.from('body'),
  ])
  return id
}

async function count(table: string, column: string, value: string | number): Promise<number> {
  const r = await db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [value])
  return Number(r.rows[0]?.n)
}

describe('the extension and the dimension', () => {
  it('the vector extension is installed in the migrated template', async () => {
    const r = await db.pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'")
    expect(r.rows.length).toBe(1)
  })

  it('a 768-float embedding is accepted (positive control)', async () => {
    const id = await newMemory()
    await expect(
      db.pool.query('INSERT INTO memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)', [id, literal(DIM)]),
    ).resolves.toBeDefined()
  })

  it('a 767-float and a 769-float embedding are refused', async () => {
    const short = await newMemory()
    const long = await newMemory()
    await expect(
      db.pool.query('INSERT INTO memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)', [short, literal(DIM - 1)]),
    ).rejects.toThrow()
    await expect(
      db.pool.query('INSERT INTO memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)', [long, literal(DIM + 1)]),
    ).rejects.toThrow()
    expect(await count('memory_embeddings', 'memory_id', short)).toBe(0)
    expect(await count('memory_embeddings', 'memory_id', long)).toBe(0)
  })

  it('a NaN component is refused, so a failing embedder cannot store one', async () => {
    const id = await newMemory()
    await expect(
      db.pool.query('INSERT INTO memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)', [id, literal(DIM, Number.NaN)]),
    ).rejects.toThrow()
    expect(await count('memory_embeddings', 'memory_id', id)).toBe(0)
  })
})

describe('the embedding follows its parent: one per parent, deleted with it', () => {
  it('deleting a memory removes its embedding', async () => {
    const id = await newMemory()
    await db.pool.query('INSERT INTO memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)', [id, literal(DIM)])
    expect(await count('memory_embeddings', 'memory_id', id)).toBe(1)
    await db.pool.query('DELETE FROM memories WHERE id = $1', [id])
    expect(await count('memory_embeddings', 'memory_id', id)).toBe(0)
  })

  it('deleting a workspace document removes its embedding', async () => {
    const id = await newDoc()
    await db.pool.query('INSERT INTO workspace_doc_embeddings (doc_id, embedding) VALUES ($1, $2::vector)', [id, literal(DIM)])
    expect(await count('workspace_doc_embeddings', 'doc_id', id)).toBe(1)
    await db.pool.query('DELETE FROM workspace_docs WHERE id = $1', [id])
    expect(await count('workspace_doc_embeddings', 'doc_id', id)).toBe(0)
  })

  it('deleting an artifact removes its embedding', async () => {
    const id = await newArtifact()
    await db.pool.query('INSERT INTO artifact_embeddings (artifact_id, embedding) VALUES ($1, $2::vector)', [id, literal(DIM)])
    expect(await count('artifact_embeddings', 'artifact_id', id)).toBe(1)
    await db.pool.query('DELETE FROM artifacts WHERE id = $1', [id])
    expect(await count('artifact_embeddings', 'artifact_id', id)).toBe(0)
  })

  it('a second embedding for the same memory is refused (one per parent)', async () => {
    const id = await newMemory()
    await db.pool.query('INSERT INTO memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)', [id, literal(DIM)])
    await expect(
      db.pool.query('INSERT INTO memory_embeddings (memory_id, embedding) VALUES ($1, $2::vector)', [id, literal(DIM)]),
    ).rejects.toThrow(/duplicate key/)
  })

  it('an embedding with no parent row is refused (the foreign key)', async () => {
    await expect(
      db.pool.query('INSERT INTO workspace_doc_embeddings (doc_id, embedding) VALUES ($1, $2::vector)', [uid('no-such-doc'), literal(DIM)]),
    ).rejects.toThrow(/foreign key/)
  })
})

describe('preflight: a database without the vector extension is refused, naming the extension and the major', () => {
  it('accepts the migrated database', async () => {
    const report = await pgPreflight(db.pool)
    expect(Array.isArray(report.warnings)).toBe(true)
  })

  it('refuses a database without the vector extension', async () => {
    const other = await createPgTestDb()
    extra.push(other)
    await other.pool.query('DROP EXTENSION vector CASCADE')
    await expect(pgPreflight(other.pool)).rejects.toThrow(PgPreflightError)
    await expect(pgPreflight(other.pool)).rejects.toThrow(/vector extension is not installed/)
    await expect(pgPreflight(other.pool)).rejects.toThrow(/PostgreSQL \d+/)
    await expect(pgPreflight(other.pool)).rejects.toThrow(/docs\/local-pgvector\.md/)
  })
})
