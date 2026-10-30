/**
 * The real reranker child (the compiled dist/reranker-worker.js with the real model), killed while onnxruntime is in
 * the middle of a run. The same stop on a worker thread aborts the whole process with SIGABRT (exit 134, measured:
 * SIGTERM with a rerank in flight, and worker.terminate() mid-run), which for the dashboard is a crash on every
 * deploy that lands during a search. With the child the host survives and the child ends with SIGKILL (137).
 *
 * Needs a build (`npm run build`) and the model in the transformers cache; skips itself without them, so a CI run
 * without either stays green. A regression to a thread would take this test process down, not fail an assertion.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ChildProcessWorker, childEnv } from '../reranker-backend.js'
import type { RerankReply } from '../reranker-worker.js'

const WORKER = fileURLToPath(new URL('../../dist/reranker-worker.js', import.meta.url))
const MODEL = fileURLToPath(new URL('../../node_modules/@huggingface/transformers/.cache/Xenova/bge-reranker-base/onnx', import.meta.url))

describe.skipIf(!existsSync(WORKER) || !existsSync(MODEL))('the real reranker child', () => {
  it('is killed with SIGKILL in the middle of an inference and the host process survives', async () => {
    const child = fork(WORKER, [], { env: childEnv(process.env), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] })
    const worker = new ChildProcessWorker(child)
    const replies: RerankReply[] = []
    worker.on('message', (m) => replies.push(m))
    const reply = (id: number) => new Promise<void>((resolve) => {
      const timer = setInterval(() => { if (replies.some(r => 'id' in r && r.id === id)) { clearInterval(timer); resolve() } }, 20)
    })

    worker.postMessage({ id: 1, query: 'rate limits', passages: ['a', 'b'], maxLength: 256 })
    await reply(1)
    expect(replies.some(r => 'type' in r)).toBe(true)

    const long = Array.from({ length: 40 }, (_, i) => `passage ${i} about rate limits and settings ${'lorem ipsum '.repeat(60)}`)
    worker.postMessage({ id: 2, query: 'rate limits', passages: long, maxLength: 512 })
    await new Promise(r => setTimeout(r, 300))
    expect(replies.some(r => 'id' in r && r.id === 2)).toBe(false)   // still running

    expect(await worker.terminate()).toBe(137)
    expect(child.signalCode).toBe('SIGKILL')
  }, 120_000)
})
