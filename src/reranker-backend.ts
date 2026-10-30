import { existsSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { logger } from './logger.js'
import { registerSigtermFlush } from './web/sigterm-flush.js'
import { scorePairs, _resetEngineForTests } from './reranker-engine.js'
import type { RerankReply, RerankRequest } from './reranker-worker.js'

/** Scores (query, passage) pairs, 0..1 in passage order. One call at a time: the queue in reranker.ts serializes. */
export interface RerankBackend {
  readonly mode: 'worker' | 'in-process'
  /**
   * `watchdogMs`: a worker whose request has been running this long is considered hung and is replaced (worker
   * backend only; the in-process backend cannot be stopped from outside).
   */
  score(query: string, passages: string[], maxLength?: number, watchdogMs?: number): Promise<number[]>
  /** What the backend knows about itself, for the stats view. */
  state(): { workerState: 'not-started' | 'loading' | 'ready' | 'down'; loadMs: number | null }
  dispose(): Promise<void>
}

/** The backend refused without trying: the worker crashed recently and is cooling down. */
export class RerankUnavailableError extends Error {}

/** The model on the main thread: the pre-worker behaviour, used where the compiled worker file does not exist. */
export class InProcessRerankBackend implements RerankBackend {
  readonly mode = 'in-process' as const
  score(query: string, passages: string[], maxLength?: number): Promise<number[]> { return scorePairs(query, passages, maxLength) }
  state() { return { workerState: 'not-started' as const, loadMs: null } }
  async dispose(): Promise<void> { _resetEngineForTests() }
}

/** The slice of node:worker_threads' Worker the backend uses; the tests pass a fake. */
export interface WorkerLike {
  postMessage(msg: RerankRequest): void
  on(event: 'message', cb: (msg: RerankReply) => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
  on(event: 'exit', cb: (code: number) => void): unknown
  terminate(): Promise<number>
  unref(): void
}

export interface WorkerBackendOptions {
  spawn: () => WorkerLike
  /** After an unexpected worker exit no new worker is started for this long; callers fall back meanwhile. */
  cooldownMs?: number
  /** Default for a request that brings no watchdog time of its own. */
  watchdogMs?: number
  now?: () => number
}

const DEFAULT_COOLDOWN_MS = 30_000
/** A running request is given this many times the budget its caller waits for before the worker is declared hung. */
export const RERANK_WATCHDOG_FACTOR = 3
const DEFAULT_WATCHDOG_MS = 9_000

interface Pending { resolve: (scores: number[]) => void; reject: (err: Error) => void; watchdog: NodeJS.Timeout }

/**
 * The model in a worker thread: spawned on first use, replaced after a crash or when it hangs (with a cooldown),
 * stopped on SIGTERM and not started again after that.
 */
export class WorkerRerankBackend implements RerankBackend {
  readonly mode = 'worker' as const
  private worker: WorkerLike | null = null
  private loaded = false
  private loadMs: number | null = null
  private everSpawned = false
  private downUntil = 0
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private flushRegistered = false
  private disposed = false
  private readonly cooldownMs: number
  private readonly watchdogMs: number
  private readonly now: () => number

  constructor(private readonly opts: WorkerBackendOptions) {
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.watchdogMs = opts.watchdogMs ?? DEFAULT_WATCHDOG_MS
    this.now = opts.now ?? Date.now
  }

  state() {
    const workerState = this.worker
      ? (this.loaded ? 'ready' as const : 'loading' as const)
      : (this.everSpawned ? 'down' as const : 'not-started' as const)
    return { workerState, loadMs: this.loadMs }
  }

  score(query: string, passages: string[], maxLength?: number, watchdogMs?: number): Promise<number[]> {
    let worker: WorkerLike
    try {
      worker = this.ensureWorker()
    } catch (err) {
      return Promise.reject(err)
    }
    const id = this.nextId++
    return new Promise<number[]>((resolve, reject) => {
      // A native forward pass cannot be interrupted from inside the thread, and a worker that never answers would
      // otherwise make every later call wait out its whole budget until the process restarts: past the watchdog
      // time the thread is stopped and replaced after the cooldown.
      const watchdog = setTimeout(() => {
        if (this.pending.has(id)) this.retire(worker, new Error('reranker worker did not answer in time'), true)
      }, watchdogMs ?? this.watchdogMs)
      watchdog.unref()
      this.pending.set(id, { resolve, reject, watchdog })
      try {
        worker.postMessage({ id, query, passages, ...(maxLength !== undefined ? { maxLength } : {}) })
      } catch (err) {
        clearTimeout(watchdog)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async dispose(): Promise<void> {
    // Final: a rerank that arrives after this (the flush runs for up to a second while the server still answers)
    // must not start a new worker that the exit then kills halfway.
    this.disposed = true
    const worker = this.worker
    this.worker = null
    this.failPending(new Error('reranker worker stopped'))
    if (worker) await worker.terminate()
  }

  private ensureWorker(): WorkerLike {
    if (this.disposed) throw new RerankUnavailableError('reranker worker is stopped')
    if (this.worker) return this.worker
    if (this.now() < this.downUntil) throw new RerankUnavailableError('reranker worker is cooling down after a crash')
    const worker = this.opts.spawn()
    this.worker = worker
    this.loaded = false
    this.everSpawned = true
    // The worker must never keep the process alive on its own.
    worker.unref()
    worker.on('message', (msg) => this.onMessage(worker, msg))
    worker.on('error', (err) => this.onGone(worker, err))
    worker.on('exit', (code) => this.onGone(worker, new Error(`reranker worker exited with code ${code}`)))
    if (!this.flushRegistered) {
      this.flushRegistered = true
      // A thread stopped mid-inference at process exit can take native runtime state down with it; stop it first.
      registerSigtermFlush('reranker-worker', () => this.dispose())
    }
    return worker
  }

  private onMessage(from: WorkerLike, msg: RerankReply): void {
    if (from !== this.worker) return
    if ('type' in msg) {
      this.loaded = true
      this.loadMs = msg.ms
      logger.info({ loadMs: msg.ms }, 'reranker worker: model loaded')
      return
    }
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.pending.delete(msg.id)
    clearTimeout(entry.watchdog)
    if ('error' in msg) entry.reject(new Error(msg.error))
    else entry.resolve(msg.scores)
  }

  private onGone(which: WorkerLike, err: Error): void {
    this.retire(which, err, false)
  }

  /**
   * The worker is gone (crashed, or hung and stopped here): fail what waits on it and start the cooldown.
   * 'error' is followed by 'exit' for the same worker, and dispose() clears this.worker first: act once, and
   * never on a worker that was already replaced.
   */
  private retire(which: WorkerLike, err: Error, terminate: boolean): void {
    if (which !== this.worker) return
    this.worker = null
    this.loaded = false
    this.downUntil = this.now() + this.cooldownMs
    logger.warn({ err: err.message, cooldownMs: this.cooldownMs }, 'reranker worker is gone, falling back to the RRF order')
    this.failPending(err)
    // Not awaited: stopping a thread that sits in native code may take long, and the callers are waiting on a
    // fallback, not on this. Its late events are ignored, it is no longer this.worker.
    if (terminate) which.terminate().catch((e: unknown) => logger.warn({ err: e }, 'reranker worker: terminate failed'))
  }

  private failPending(err: Error): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) { clearTimeout(entry.watchdog); entry.reject(err) }
  }
}

// The compiled worker sits next to this file in dist/. Under tsx and vitest only the .ts source exists, and a
// Worker cannot load that: those runs keep the model on the main thread, as before.
const WORKER_URL = new URL('./reranker-worker.js', import.meta.url)

export function createDefaultRerankBackend(): RerankBackend {
  if (!existsSync(fileURLToPath(WORKER_URL))) return new InProcessRerankBackend()
  return new WorkerRerankBackend({ spawn: () => new Worker(WORKER_URL) as unknown as WorkerLike })
}
