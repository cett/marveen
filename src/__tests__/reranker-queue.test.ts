/**
 * The rerank queue (src/reranker.ts): a bounded queue with a time budget in front of a backend, and the fallback
 * counter. The backend is a fake whose calls the test resolves by hand, so what is pinned here is the queue's own
 * behaviour: when a rerank is turned away, when it times out, what the slot does after a timeout, and what is counted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  rerank, getRerankStats, _setRerankBackendForTests, RERANK_MAX_PENDING, RERANK_BUDGET_MS,
} from '../reranker.js'
import { RerankUnavailableError, type RerankBackend } from '../reranker-backend.js'
import type { Memory } from '../db.js'

function makeMemory(id: number, content = `m${id}`): Memory {
  return {
    id, chat_id: 'c', topic_key: null, content, sector: 'semantic', salience: 1, created_at: 1, accessed_at: 1,
    updated_at: null, agent_id: 'a', category: 'warm', auto_generated: 0, keywords: null, embedding: null, embedding_blob: null,
  }
}

interface Call { query: string; passages: string[]; maxLength?: number; watchdogMs?: number; resolve: (s: number[]) => void; reject: (e: Error) => void }

class FakeBackend implements RerankBackend {
  readonly mode = 'worker' as const
  calls: Call[] = []
  score(query: string, passages: string[], maxLength?: number, watchdogMs?: number): Promise<number[]> {
    return new Promise((resolve, reject) => { this.calls.push({ query, passages, maxLength, watchdogMs, resolve, reject }) })
  }
  state() { return { workerState: 'ready' as const, loadMs: 1234 } }
  async dispose() {}
}

const pool = [makeMemory(1), makeMemory(2), makeMemory(3)]
const ids = (ms: Memory[]) => ms.map(m => m.id)
const tick = () => new Promise(r => setTimeout(r, 5))

let fake: FakeBackend
beforeEach(() => {
  fake = new FakeBackend()
  _setRerankBackendForTests(fake)
})

describe('rerank queue', () => {
  it('reranks by the backend scores and counts it', async () => {
    const p = rerank('q', pool)
    await tick()
    expect(fake.calls[0].passages).toEqual(['m1', 'm2', 'm3'])
    fake.calls[0].resolve([0.1, 0.9, 0.5])
    expect(ids(await p)).toEqual([2, 3, 1])
    const s = getRerankStats()
    expect(s).toMatchObject({ calls: 1, reranked: 1, fallbackTotal: 0, running: 0, waiting: 0, workerState: 'ready', modelLoadMs: 1234 })
  })

  it('turns a rerank away at once when the queue is full, in the order it came in', async () => {
    expect(RERANK_MAX_PENDING).toBe(2)
    const first = rerank('q1', pool)
    const second = rerank('q2', pool)
    const third = await rerank('q3', pool)
    expect(ids(third)).toEqual([1, 2, 3])
    expect(getRerankStats().fallbacks.queue_full).toBe(1)
    // The third never reached the backend, and the first two still do their work in order.
    expect(fake.calls.map(c => c.query)).toEqual(['q1'])
    fake.calls[0].resolve([0.3, 0.2, 0.1])
    await tick()
    expect(fake.calls.map(c => c.query)).toEqual(['q1', 'q2'])
    fake.calls[1].resolve([0.1, 0.2, 0.3])
    expect(ids(await first)).toEqual([1, 2, 3])
    expect(ids(await second)).toEqual([3, 2, 1])
  })

  it('falls back after the budget and counts a timeout', async () => {
    const out = await rerank('q', pool, { budgetMs: 20 })
    expect(ids(out)).toEqual([1, 2, 3])
    expect(getRerankStats()).toMatchObject({ calls: 1, reranked: 0, fallbackTotal: 1 })
    expect(getRerankStats().fallbacks.timeout).toBe(1)
  })

  it('keeps the slot of a timed-out rerank until the backend is done, and ignores its late answer', async () => {
    const timedOut = await rerank('q1', pool, { budgetMs: 20 })
    expect(ids(timedOut)).toEqual([1, 2, 3])
    // The forward pass cannot be cancelled: still running, so a new rerank waits behind it instead of starting.
    expect(getRerankStats().running).toBe(1)
    const next = rerank('q2', pool, { budgetMs: 500 })
    await tick()
    expect(fake.calls).toHaveLength(1)
    expect(getRerankStats().waiting).toBe(1)
    fake.calls[0].resolve([0.9, 0.1, 0.5])   // the late answer of the timed-out call: dropped
    await tick()
    expect(fake.calls).toHaveLength(2)
    fake.calls[1].resolve([0.1, 0.9, 0.5])
    expect(ids(await next)).toEqual([2, 3, 1])
    expect(getRerankStats()).toMatchObject({ reranked: 1, running: 0, waiting: 0 })
    expect(getRerankStats().fallbacks.timeout).toBe(1)
  })

  it('never sends a waiting rerank to the backend once its budget is spent', async () => {
    const slow = rerank('q1', pool)
    const expired = await rerank('q2', pool, { budgetMs: 20 })
    expect(ids(expired)).toEqual([1, 2, 3])
    expect(getRerankStats().waiting).toBe(0)
    fake.calls[0].resolve([0.1, 0.2, 0.3])
    await slow
    await tick()
    expect(fake.calls).toHaveLength(1)
  })

  it('counts a backend failure as an error and an unavailable worker as unavailable', async () => {
    const failing = rerank('q1', pool)
    await tick()
    fake.calls[0].reject(new Error('ONNX runtime error'))
    expect(ids(await failing)).toEqual([1, 2, 3])
    const down = rerank('q2', pool)
    await tick()
    fake.calls[1].reject(new RerankUnavailableError('cooling down'))
    expect(ids(await down)).toEqual([1, 2, 3])
    expect(getRerankStats().fallbacks).toEqual({ timeout: 0, queue_full: 0, error: 1, unavailable: 1 })
    expect(getRerankStats().fallbackTotal).toBe(2)
  })

  it('applies topK and maxCandidates on the fallback path too', async () => {
    const out = await rerank('q', [makeMemory(1), makeMemory(2), makeMemory(3), makeMemory(4)], { topK: 2, maxCandidates: 3, budgetMs: 10 })
    expect(ids(out)).toEqual([1, 2])
  })

  it('falls back to the first maxCandidates when topK asks for more than that', async () => {
    // topK 4 > maxCandidates 3: the fallback is the pool, not the first four of the input.
    const out = await rerank('q', [makeMemory(1), makeMemory(2), makeMemory(3), makeMemory(4), makeMemory(5)], { topK: 4, maxCandidates: 3, budgetMs: 10 })
    expect(ids(out)).toEqual([1, 2, 3])
  })

  it('gives the backend three times the budget of the call before the worker counts as hung', async () => {
    const p = rerank('q', pool, { budgetMs: 700 })
    await tick()
    expect(fake.calls[0].watchdogMs).toBe(2100)
    fake.calls[0].resolve([0.1, 0.2, 0.3])
    await p
  })

  it('does not count or queue an empty candidate list', async () => {
    expect(await rerank('q', [])).toEqual([])
    expect(fake.calls).toHaveLength(0)
    expect(getRerankStats().calls).toBe(0)
  })

  it('hands the token limit to the backend, and nothing when none is set', async () => {
    const limited = rerank('q1', pool, { maxLength: 256 })
    await tick()
    expect(fake.calls[0].maxLength).toBe(256)
    fake.calls[0].resolve([0.1, 0.2, 0.3])
    await limited
    const unlimited = rerank('q2', pool)
    await tick()
    expect(fake.calls[1].maxLength).toBeUndefined()
    fake.calls[1].resolve([0.1, 0.2, 0.3])
    await unlimited
  })

  it('has a budget that fits one worker pass of ten candidates and a second behind it', () => {
    expect(RERANK_BUDGET_MS).toBe(3000)
  })
})
