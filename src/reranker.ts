import { logger } from './logger.js'
import type { Memory } from './db.js'
import { RERANKER_MODEL, _resetEngineForTests } from './reranker-engine.js'
import { RerankUnavailableError, createDefaultRerankBackend, type RerankBackend } from './reranker-backend.js'

// Cross-encoder rerank of the fused hybrid-search list.
//
// The forward pass is slow (about 0.7 s for ten candidates, 4-5 s for fifty) and, run on the main thread, stops the
// event loop for its whole duration. So it runs on a backend (a worker thread in production, see reranker-backend.ts)
// behind a bounded queue with a time budget: a rerank that cannot finish in time hands back the order it was given
// (the RRF order) instead of making the caller wait, and every such fallback is counted (getRerankStats), because a
// fallback is otherwise an unnoticed drop in result quality.

/** Longest a rerank may take, from the call to the answer, queue wait and model load included. */
export const RERANK_BUDGET_MS = 3000

/**
 * Most reranks outstanding at once, the running one included. With one worker and about 1.2 s per rerank of ten
 * candidates, a second one finishes inside the budget (about 2.4 s) and a third could not, so it is turned away at
 * once instead of queueing for a timeout.
 */
export const RERANK_MAX_PENDING = 2

export type RerankFallbackReason = 'timeout' | 'queue_full' | 'error' | 'unavailable'

export interface RerankStats {
  mode: RerankBackend['mode']
  workerState: ReturnType<RerankBackend['state']>['workerState']
  /** Time the worker needed to load the model, once it did. */
  modelLoadMs: number | null
  startedAt: number
  /** Monotonic since the process started; a measurement window is the difference of two answers. */
  calls: number
  reranked: number
  fallbacks: Record<RerankFallbackReason, number>
  fallbackTotal: number
  running: number
  waiting: number
  lastRerankMs: number | null
  maxRerankMs: number
}

export interface RerankOptions {
  topK?: number
  maxCandidates?: number
  /** Overrides RERANK_BUDGET_MS for this call. */
  budgetMs?: number
  /** Token cap of a (query, passage) pair; the model's own limit (512) when absent. */
  maxLength?: number
}

type Outcome = { ok: true; scores: number[] } | { ok: false; reason: RerankFallbackReason }

interface Job {
  query: string
  passages: string[]
  maxLength?: number
  timer: NodeJS.Timeout
  resolve: (outcome: Outcome) => void
}

let backend: RerankBackend | null = null
let running: Job | null = null
let waiting: Job[] = []
let stats = freshStats()
let lastFallbackLogAt = 0

function freshStats() {
  return {
    startedAt: Date.now(),
    calls: 0,
    reranked: 0,
    fallbacks: { timeout: 0, queue_full: 0, error: 0, unavailable: 0 } as Record<RerankFallbackReason, number>,
    lastRerankMs: null as number | null,
    maxRerankMs: 0,
  }
}

function getBackend(): RerankBackend {
  if (!backend) backend = createDefaultRerankBackend()
  return backend
}

function settle(job: Job, outcome: Outcome): void {
  // Settled by whichever comes first (answer, timeout); the second call finds the promise already resolved.
  clearTimeout(job.timer)
  waiting = waiting.filter(j => j !== job)
  job.resolve(outcome)
}

function pump(): void {
  if (running) return
  const next = waiting.shift()
  if (!next) return
  running = next
  const started = Date.now()
  getBackend().score(next.query, next.passages, next.maxLength).then(
    scores => {
      const ms = Date.now() - started
      stats.lastRerankMs = ms
      stats.maxRerankMs = Math.max(stats.maxRerankMs, ms)
      settle(next, { ok: true, scores })
    },
    (err: unknown) => {
      logger.debug({ err, model: RERANKER_MODEL }, 'Cross-encoder rerank failed')
      settle(next, { ok: false, reason: err instanceof RerankUnavailableError ? 'unavailable' : 'error' })
    },
  ).finally(() => {
    // The slot frees when the backend is done, not when the caller gave up: a timed-out forward pass cannot be
    // cancelled, and the next one must not start on top of it.
    running = null
    pump()
  })
}

function submit(query: string, passages: string[], budgetMs: number, maxLength?: number): Promise<Outcome> {
  const outstanding = (running ? 1 : 0) + waiting.length
  if (outstanding >= RERANK_MAX_PENDING) return Promise.resolve({ ok: false, reason: 'queue_full' })
  return new Promise<Outcome>(resolve => {
    const job: Job = {
      query,
      passages,
      maxLength,
      timer: setTimeout(() => settle(job, { ok: false, reason: 'timeout' }), budgetMs),
      resolve,
    }
    waiting.push(job)
    pump()
  })
}

function noteFallback(reason: RerankFallbackReason): void {
  stats.fallbacks[reason]++
  // One line a minute at most: a stuck worker would otherwise log on every search.
  const now = Date.now()
  if (now - lastFallbackLogAt >= 60_000) {
    lastFallbackLogAt = now
    logger.warn({ reason, fallbacks: { ...stats.fallbacks } }, 'Cross-encoder rerank fell back to the RRF order')
  }
}

/**
 * Re-ranks candidate memories by relevance to query using a cross-encoder.
 *
 * Resolves with the best `topK` of the first `maxCandidates` candidates, highest score first. When the rerank cannot
 * be had in time (budget exceeded, queue full, model or worker failure) it resolves with the candidates in the order
 * they came in and counts a fallback; it never rejects.
 */
export async function rerank(
  query: string,
  candidates: Memory[],
  opts: RerankOptions = {}
): Promise<Memory[]> {
  const { topK = candidates.length, maxCandidates = candidates.length, budgetMs = RERANK_BUDGET_MS, maxLength } = opts
  const pool = candidates.slice(0, maxCandidates)
  if (pool.length === 0) return []

  stats.calls++
  const outcome = await submit(query, pool.map(m => m.content), budgetMs, maxLength)
  if (!outcome.ok) {
    noteFallback(outcome.reason)
    return pool.slice(0, topK)
  }
  stats.reranked++
  return pool
    .map((m, i) => ({ memory: m, score: outcome.scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(r => r.memory)
}

export function getRerankStats(): RerankStats {
  const current = getBackend()
  const b = current.state()
  const fallbackTotal = Object.values(stats.fallbacks).reduce((a, n) => a + n, 0)
  return {
    mode: current.mode,
    workerState: b.workerState,
    modelLoadMs: b.loadMs,
    startedAt: stats.startedAt,
    calls: stats.calls,
    reranked: stats.reranked,
    fallbacks: { ...stats.fallbacks },
    fallbackTotal,
    running: running ? 1 : 0,
    waiting: waiting.length,
    lastRerankMs: stats.lastRerankMs,
    maxRerankMs: stats.maxRerankMs,
  }
}

// Exposed for testing only -- swaps the backend and clears the queue and the counters between tests.
export function _setRerankBackendForTests(next: RerankBackend | null): void {
  for (const job of [running, ...waiting]) if (job) clearTimeout(job.timer)
  running = null
  waiting = []
  backend = next
  stats = freshStats()
  lastFallbackLogAt = 0
}

// Exposed for testing only -- allows resetting the singleton between tests.
export function _resetRankerForTests(): void {
  _setRerankBackendForTests(null)
  _resetEngineForTests()
}
