// End-to-end check of the recall harness on a SYNTHETIC corpus (no private data): the real
// retrieval functions run against an in-memory database with deterministic pseudo-embeddings, so CI
// can prove the harness is deterministic, filters correctly and detects a degraded candidate.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { initDatabase, getDb, vecExtensionLoaded } from '../../src/db/connection.js'
import { runCases } from '../eval/recall-eval-run.js'
import {
  compareSnapshots,
  embedKey,
  syntheticEmbedding,
  type QueryCase,
  type Snapshot,
} from '../eval/recall-eval-lib.js'
import { floatsToBlob, initVecSupport } from '../../src/db/vector.js'

// sqlite-vec is optional in CI: without it there is no vec0 pipeline to freeze, so the suite skips.
let vecAvailable = false

const NOW_SEC = 1_800_000_000
const TOPICS = ['alma', 'korte', 'szilva', 'cseresznye', 'barack', 'dio', 'mogyoro', 'mandula']

const embeddings: Record<string, number[]> = {}
function embed(text: string): number[] {
  const e = syntheticEmbedding(text)
  embeddings[embedKey(text)] = e
  return e
}

function insertMemory(agent: string, category: string, content: string): number {
  const db = getDb()
  const blob = floatsToBlob(embed(content))
  const info = db
    .prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, category, agent_id, auto_generated, created_at, accessed_at, keywords, embedding_blob)
       VALUES ('c', ?, 'semantic', 1, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(content, category, agent, NOW_SEC - 86400, NOW_SEC - 86400, content.split(' ').join(','), blob)
  const id = Number(info.lastInsertRowid)
  db.prepare('INSERT INTO vec_memories(memory_id, embedding) VALUES(?, ?)').run(BigInt(id), blob)
  return id
}

const ids: Record<string, number> = {}
let cases: QueryCase[] = []

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_SEC * 1000)
  vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
    const prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt
    const emb = embeddings[embedKey(prompt)]
    if (!emb) throw new Error('synthetic embedding cache miss')
    return new Response(JSON.stringify({ embedding: emb }), { status: 200 })
  })
  initDatabase(':memory:')
  initVecSupport()
  vecAvailable = vecExtensionLoaded
  if (!vecAvailable) return
  TOPICS.forEach((t, i) => {
    ids[`a-${t}`] = insertMemory('agent-a', 'warm', `${t} gyumolcs recept szinten fontos jegyzet szam ${i}`)
    ids[`b-${t}`] = insertMemory('agent-b', 'warm', `${t} masik ugynok magan jegyzete szam ${i}`)
  })
  ids['shared'] = insertMemory('agent-b', 'shared', 'kozos flotta tudas alma gyumolcs mindenkinek')
  cases = TOPICS.map((t, i) => {
    const text = `${t} gyumolcs recept szinten fontos jegyzet szam ${i}`
    return { id: `memory:${String(i + 1).padStart(3, '0')}`, kind: 'memory', agentId: 'agent-a', tenantId: 'default', text, style: 'phrase' } as QueryCase
  })
  for (const c of cases) embed(c.text)
})

afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('recall harness on a synthetic corpus', () => {
  beforeEach((ctx) => {
    if (!vecAvailable) ctx.skip()
  })

  it('records the four stages per memory query', async () => {
    const runs = await runCases(getDb(), cases, embeddings, NOW_SEC)
    expect(runs).toHaveLength(cases.length)
    for (const r of runs) expect(Object.keys(r.stages).sort()).toEqual(['final', 'fts', 'vec_exact', 'vec_prod'])
  })

  it('is deterministic: two runs over the same data are identical', async () => {
    const a = await runCases(getDb(), cases, embeddings, NOW_SEC)
    const b = await runCases(getDb(), cases, embeddings, NOW_SEC)
    expect(b).toEqual(a)
  })

  it('exact L2 puts the memory whose own text is the query first', async () => {
    const runs = await runCases(getDb(), cases, embeddings, NOW_SEC)
    TOPICS.forEach((t, i) => expect(runs[i].stages.vec_exact[0]).toBe(String(ids[`a-${t}`])))
  })

  it('never returns another agent\'s private memory, but does return shared ones', async () => {
    const runs = await runCases(getDb(), cases, embeddings, NOW_SEC)
    const privateB = new Set(TOPICS.map((t) => String(ids[`b-${t}`])))
    for (const r of runs) {
      for (const stage of ['vec_exact', 'vec_prod', 'final']) {
        for (const id of r.stages[stage]) expect(privateB.has(id), `${r.id}/${stage}`).toBe(false)
      }
    }
    expect(runs[0].stages.vec_exact).toContain(String(ids['shared']))
  })

  it('a missing embedding is an error, not a silent skip', async () => {
    const bad: QueryCase[] = [{ id: 'memory:999', kind: 'memory', agentId: 'agent-a', text: 'nincs ilyen embedding a cache-ben', style: 'phrase' }]
    await expect(runCases(getDb(), bad, embeddings, NOW_SEC)).rejects.toThrow(/no cached embedding/)
  })

  it('compare passes on an identical run and fails once the top result disappears', async () => {
    const meta: Snapshot['meta'] = {
      createdAt: 'x', gitSha: 'x', backend: 'sqlite', frozenNowSec: NOW_SEC, rerankEnabled: false,
      embedModel: 'nomic-embed-text', corpus: {}, querySetSha256: 'synthetic',
    }
    const base: Snapshot = { meta, runs: await runCases(getDb(), cases, embeddings, NOW_SEC) }
    const same: Snapshot = { meta, runs: await runCases(getDb(), cases, embeddings, NOW_SEC) }
    expect(compareSnapshots(base, same).pass).toBe(true)

    // Degrade the "candidate backend": drop the top exact match of every query from the corpus.
    const db = getDb()
    const dropped = TOPICS.map((t) => ids[`a-${t}`])
    for (const id of dropped) {
      db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(BigInt(id))
      db.prepare('DELETE FROM memories WHERE id = ?').run(id)
    }
    const degraded: Snapshot = { meta, runs: await runCases(db, cases, embeddings, NOW_SEC) }
    const rep = compareSnapshots(base, degraded)
    expect(rep.pass).toBe(false)
    expect(rep.kinds[0].finalMrr).toBeLessThan(1)
  })
})
