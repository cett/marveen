/**
 * Tests for recency-boosted scoring in vectorSearch().
 *
 * Verifies the decay formula, half-life, score bounds, and that the pipeline
 * (ANN/cosine -> recency boost -> rerank) produces valid output. The formula cells need no database; the pipeline
 * cells run on both engines (MARVEEN_TEST_DB=pg runs them on PostgreSQL).
 * The reranker is mocked; real ONNX model is not downloaded in CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'

const { mockRerank } = vi.hoisted(() => ({
  mockRerank: vi.fn().mockResolvedValue([]),
}))

vi.mock('../reranker.js', () => ({
  rerank: mockRerank,
  _resetRankerForTests: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { dbx, saveAgentMemory, hybridSearch, vectorSearch, syncVecMemoryEmbeddingUpdate, floatsToBlob, EMBEDDING_DIM } from '../db.js'

useTestDb()

beforeEach(() => {
  mockRerank.mockClear()
  mockRerank.mockResolvedValue([])
})

describe('recency decay formula', () => {
  it('decays to ~50% at the 35-day half-life (lambda=0.02)', () => {
    const lambda = 0.02
    const halfLife = Math.log(2) / lambda  // ≈ 34.66 days
    const decay = Math.exp(-lambda * halfLife)
    expect(decay).toBeCloseTo(0.5, 2)
  })

  it('equals 1.0 for age=0 (brand-new memory)', () => {
    const lambda = 0.02
    expect(Math.exp(-lambda * 0)).toBe(1.0)
  })

  it('stays in (0, 1] for all realistic ages', () => {
    const lambda = 0.02
    for (const ageDays of [0, 1, 7, 30, 90, 180, 365, 730]) {
      const decay = Math.exp(-lambda * ageDays)
      expect(decay).toBeGreaterThan(0)
      expect(decay).toBeLessThanOrEqual(1)
    }
  })

  it('fresh memory scores higher than old one with same cosine (manual check)', () => {
    const lambda = 0.02
    const cosine = 0.8
    const scoreFresh = cosine * Math.exp(-lambda * 1)    // 1 day old
    const scoreOld   = cosine * Math.exp(-lambda * 180)  // 180 days old
    expect(scoreFresh).toBeGreaterThan(scoreOld)
  })
})

/** The query vector and the stored vector of the twins: identical, so only the recency decay can order them. */
const twinVec = floatsToBlob(Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(i)))
const twinQuery = Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(i))
const DAY = 86400

/** A memory of agent-a with a given creation time and the embedding of the twins (the blob and the vector index). */
async function twinMemory(content: string, createdAt: number): Promise<number> {
  const row = await dbx.get<{ id: number }>(
    `INSERT INTO memories (chat_id, content, sector, salience, category, agent_id, auto_generated, created_at, accessed_at, updated_at, tenant_id)
     VALUES ('chat-r', ?, 'semantic', 1, 'warm', 'agent-a', 0, ?, ?, ?, 'default') RETURNING id`,
    content, createdAt, createdAt, createdAt,
  )
  const id = Number(row!.id)
  await dbx.run('UPDATE memories SET embedding_blob = ? WHERE id = ?', twinVec, id)
  await syncVecMemoryEmbeddingUpdate(id, twinVec)
  return id
}

describe('vectorSearch recency + rerank pipeline', () => {
  it('returns FTS results (hybridSearch) when no embeddings are set', async () => {
    await saveAgentMemory('agent-a', 'recency pipeline test memory', 'warm', 'recency pipeline')
    const results = await hybridSearch('agent-a', 'recency pipeline', 5)
    expect(Array.isArray(results)).toBe(true)
    expect(results.length).toBeGreaterThan(0)
  })

  it('hybridSearch returns valid array even when reranker returns empty', async () => {
    await saveAgentMemory('agent-a', 'another test memory', 'warm', 'test')
    mockRerank.mockResolvedValueOnce([])
    const results = await hybridSearch('agent-a', 'test', 5)
    expect(Array.isArray(results)).toBe(true)
  })

  it('hybridSearch is resilient when reranker throws', async () => {
    await saveAgentMemory('agent-a', 'resilience test', 'warm', 'resilience')
    mockRerank.mockRejectedValueOnce(new Error('onnx runtime error'))
    const results = await hybridSearch('agent-a', 'resilience', 5)
    expect(Array.isArray(results)).toBe(true)
  })

  it('a fresh memory outranks an old one with the same vector: the decay orders them (the old one has the smaller id)', async () => {
    const now = Math.floor(Date.now() / 1000)
    const old = await twinMemory('recency twin old', now - 180 * DAY)
    const fresh = await twinMemory('recency twin fresh', now)
    const ids = (await vectorSearch('agent-a', twinQuery, 2)).map((m) => m.id)
    expect(ids).toEqual([fresh, old])
  })
})
