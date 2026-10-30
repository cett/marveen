/**
 * The worker backend (src/reranker-backend.ts) against a fake Worker, and the worker's request handler
 * (src/reranker-worker.ts) against a mocked model. The real thread is not started here: a Worker cannot load a .ts
 * file, so the thread itself is checked by the measurement on the compiled build.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

const { mockTokenizerFn, mockModelFn, registerSigtermFlush } = vi.hoisted(() => ({
  mockTokenizerFn: vi.fn().mockReturnValue({}),
  mockModelFn: vi.fn(),
  registerSigtermFlush: vi.fn(),
}))

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: { from_pretrained: vi.fn().mockResolvedValue(mockTokenizerFn) },
  AutoModelForSequenceClassification: { from_pretrained: vi.fn().mockResolvedValue(mockModelFn) },
}))
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/sigterm-flush.js', () => ({ registerSigtermFlush }))

import { WorkerRerankBackend, RerankUnavailableError, type WorkerLike } from '../reranker-backend.js'
import { serveRerankRequest, _resetWorkerForTests, type RerankReply, type RerankRequest } from '../reranker-worker.js'
import { _resetEngineForTests } from '../reranker-engine.js'

class FakeWorker extends EventEmitter {
  posted: RerankRequest[] = []
  unrefCalled = false
  terminated = false
  postMessage(msg: RerankRequest) { this.posted.push(msg) }
  terminate() { this.terminated = true; return Promise.resolve(1) }
  unref() { this.unrefCalled = true }
  reply(msg: RerankReply) { this.emit('message', msg) }
}

function setup(cooldownMs = 1000, watchdogMs?: number) {
  const workers: FakeWorker[] = []
  let now = 10_000
  const backend = new WorkerRerankBackend({
    spawn: () => { const w = new FakeWorker(); workers.push(w); return w as unknown as WorkerLike },
    cooldownMs,
    ...(watchdogMs !== undefined ? { watchdogMs } : {}),
    now: () => now,
  })
  return { backend, workers, advance: (ms: number) => { now += ms } }
}

beforeEach(() => {
  registerSigtermFlush.mockClear()
  _resetEngineForTests()
  _resetWorkerForTests()
  mockTokenizerFn.mockClear()
  mockModelFn.mockReset()
})

describe('WorkerRerankBackend', () => {
  it('starts no worker until the first score, then keeps one, unref-ed', async () => {
    const { backend, workers } = setup()
    expect(workers).toHaveLength(0)
    expect(backend.state()).toEqual({ workerState: 'not-started', loadMs: null })
    const first = backend.score('q', ['a', 'b'])
    expect(workers).toHaveLength(1)
    expect(workers[0].unrefCalled).toBe(true)
    expect(workers[0].posted).toEqual([{ id: 1, query: 'q', passages: ['a', 'b'] }])
    expect(backend.state().workerState).toBe('loading')
    workers[0].reply({ type: 'loaded', ms: 900 })
    expect(backend.state()).toEqual({ workerState: 'ready', loadMs: 900 })
    workers[0].reply({ id: 1, scores: [0.2, 0.8] })
    expect(await first).toEqual([0.2, 0.8])
    const second = backend.score('q2', ['c'])
    expect(workers).toHaveLength(1)
    workers[0].reply({ id: 2, scores: [0.5] })
    expect(await second).toEqual([0.5])
  })

  it('puts the token limit in the request only when there is one', () => {
    const { backend, workers } = setup()
    void backend.score('q', ['a'], 256).catch(() => {})
    void backend.score('q', ['b']).catch(() => {})
    expect(workers[0].posted[0]).toEqual({ id: 1, query: 'q', passages: ['a'], maxLength: 256 })
    expect(workers[0].posted[1]).toEqual({ id: 2, query: 'q', passages: ['b'] })
  })

  it('rejects with the worker error text', async () => {
    const { backend, workers } = setup()
    const p = backend.score('q', ['a'])
    workers[0].reply({ id: 1, error: 'model not found' })
    await expect(p).rejects.toThrow('model not found')
  })

  it('fails what is pending when the worker dies, refuses during the cooldown, then starts a new worker', async () => {
    const { backend, workers, advance } = setup(1000)
    const p = backend.score('q', ['a'])
    workers[0].emit('error', new Error('boom'))
    workers[0].emit('exit', 1)   // the exit that follows an error is the same event
    await expect(p).rejects.toThrow('boom')
    expect(backend.state().workerState).toBe('down')
    await expect(backend.score('q', ['a'])).rejects.toBeInstanceOf(RerankUnavailableError)
    expect(workers).toHaveLength(1)
    advance(1001)
    const again = backend.score('q', ['a'])
    expect(workers).toHaveLength(2)
    workers[1].reply({ id: 2, scores: [0.7] })
    expect(await again).toEqual([0.7])
  })

  it('ignores late events of a worker it already replaced', async () => {
    const { backend, workers, advance } = setup(1000)
    void backend.score('q', ['a']).catch(() => {})
    workers[0].emit('exit', 1)
    advance(1001)
    const p = backend.score('q', ['a'])
    workers[0].emit('exit', 1)
    workers[0].reply({ id: 2, scores: [0.1] })
    workers[1].reply({ id: 2, scores: [0.9] })
    expect(await p).toEqual([0.9])
    expect(backend.state().workerState).toBe('loading')
  })

  it('registers one SIGTERM flush that terminates the worker', async () => {
    const { backend, workers } = setup()
    void backend.score('q', ['a']).catch(() => {})
    void backend.score('q', ['b']).catch(() => {})
    expect(registerSigtermFlush).toHaveBeenCalledTimes(1)
    expect(registerSigtermFlush.mock.calls[0][0]).toBe('reranker-worker')
    await (registerSigtermFlush.mock.calls[0][1] as () => Promise<void>)()
    expect(workers[0].terminated).toBe(true)
  })
})

describe('WorkerRerankBackend, a hung worker', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('stops a worker whose request outlasts the watchdog, fails the call and cools down', async () => {
    const { backend, workers, advance } = setup(1000)
    const p = backend.score('q', ['a'], undefined, 100)
    const failed = expect(p).rejects.toThrow('did not answer in time')
    vi.advanceTimersByTime(101)
    await failed
    expect(workers[0].terminated).toBe(true)
    expect(backend.state().workerState).toBe('down')
    await expect(backend.score('q', ['a'], undefined, 100)).rejects.toBeInstanceOf(RerankUnavailableError)
    expect(workers).toHaveLength(1)
    // What the stopped thread still emits is not the live worker's business.
    workers[0].emit('exit', 1)
    workers[0].reply({ id: 1, scores: [0.4] })
    advance(1001)
    const again = backend.score('q', ['a'], undefined, 100)
    expect(workers).toHaveLength(2)
    workers[1].reply({ id: 2, scores: [0.7] })
    expect(await again).toEqual([0.7])
  })

  it('leaves a worker alone that answers inside the watchdog time', async () => {
    const { backend, workers } = setup()
    const p = backend.score('q', ['a'], undefined, 100)
    vi.advanceTimersByTime(60)
    workers[0].reply({ id: 1, scores: [0.4] })
    expect(await p).toEqual([0.4])
    vi.advanceTimersByTime(1000)
    expect(workers[0].terminated).toBe(false)
    expect(backend.state().workerState).toBe('loading')
  })

  it('uses its own default when the call brings no watchdog time', async () => {
    const { backend, workers } = setup(1000, 50)
    const failed = expect(backend.score('q', ['a'])).rejects.toThrow('did not answer in time')
    vi.advanceTimersByTime(51)
    await failed
    expect(workers[0].terminated).toBe(true)
  })

  it('fails every call that waits on the hung worker, not only the oldest', async () => {
    const { backend } = setup()
    const a = expect(backend.score('q', ['a'], undefined, 100)).rejects.toThrow('did not answer in time')
    const b = expect(backend.score('q', ['b'], undefined, 5000)).rejects.toThrow('did not answer in time')
    vi.advanceTimersByTime(101)
    await Promise.all([a, b])
  })
})

describe('WorkerRerankBackend, after dispose()', () => {
  it('fails the call that is pending', async () => {
    const { backend, workers } = setup()
    const p = backend.score('q', ['a'])
    const stopped = backend.dispose()
    await expect(p).rejects.toThrow('reranker worker stopped')
    await stopped
    expect(workers[0].terminated).toBe(true)
  })

  it('starts no new worker for a rerank that arrives late', async () => {
    const { backend, workers } = setup()
    void backend.score('q', ['a']).catch(() => {})
    await backend.dispose()
    await expect(backend.score('q2', ['b'])).rejects.toBeInstanceOf(RerankUnavailableError)
    expect(workers).toHaveLength(1)
    expect(workers[0].posted).toHaveLength(1)
  })

  it('does not start a worker either when none was ever started', async () => {
    const { backend, workers } = setup()
    await backend.dispose()
    await expect(backend.score('q', ['a'])).rejects.toBeInstanceOf(RerankUnavailableError)
    expect(workers).toHaveLength(0)
  })
})

describe('serveRerankRequest (the worker side)', () => {
  it('loads the model once, reports it, and answers with the scores in passage order', async () => {
    mockModelFn.mockResolvedValue({ logits: { tolist: () => [[3], [-3]] } })
    const out: RerankReply[] = []
    await serveRerankRequest({ id: 7, query: 'q', passages: ['good', 'bad'] }, r => out.push(r))
    await serveRerankRequest({ id: 8, query: 'q', passages: ['good', 'bad'] }, r => out.push(r))
    expect(out.map(r => ('type' in r ? r.type : r.id))).toEqual(['loaded', 7, 8])
    const scores = (out[1] as { scores: number[] }).scores
    expect(scores[0]).toBeGreaterThan(0.9)
    expect(scores[1]).toBeLessThan(0.1)
    expect(mockTokenizerFn).toHaveBeenCalledWith(['q', 'q'], { text_pair: ['good', 'bad'], padding: true, truncation: true })
  })

  it('cuts the pairs at the requested token limit, and at the model limit when none is given', async () => {
    mockModelFn.mockResolvedValue({ logits: { tolist: () => [[0]] } })
    await serveRerankRequest({ id: 1, query: 'q', passages: ['a'], maxLength: 256 }, () => {})
    await serveRerankRequest({ id: 2, query: 'q', passages: ['a'] }, () => {})
    expect(mockTokenizerFn.mock.calls[0][1]).toMatchObject({ max_length: 256, truncation: true, padding: true })
    expect(mockTokenizerFn.mock.calls[1][1]).not.toHaveProperty('max_length')
  })

  it('answers with an error instead of throwing when inference fails', async () => {
    mockModelFn.mockRejectedValue(new Error('ONNX runtime error'))
    const out: RerankReply[] = []
    await serveRerankRequest({ id: 1, query: 'q', passages: ['a'] }, r => out.push(r))
    expect(out[out.length - 1]).toEqual({ id: 1, error: 'ONNX runtime error' })
  })
})
