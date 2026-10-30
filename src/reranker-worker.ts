// Child process entry point for the cross-encoder reranker.
// Forked by WorkerRerankBackend (reranker-backend.ts). The model, the tokenizer and every forward pass live here,
// so the ONNX inference that used to stop the main thread's event loop for its whole duration (about 0.7 s for ten
// candidates, 4-5 s for fifty) stops only this process. It is a process and not a thread because a thread that is
// stopped (terminate(), or the process exiting) while onnxruntime is in the middle of a run takes the whole process
// down with SIGABRT; a child can simply be killed.
//
// Protocol (all messages are plain data, sent over the IPC channel):
//   in:  { id: number, query: string, passages: string[], maxLength?: number }
//   out: { type: 'loaded', ms: number }          once, when the model is ready (before the first reply)
//        { id, scores: number[] }                 the scores, in passage order
//        { id, error: string }                    load or inference failed

import { loadRanker, scorePairs } from './reranker-engine.js'

export interface RerankRequest { id: number; query: string; passages: string[]; maxLength?: number }
export type RerankReply =
  | { type: 'loaded'; ms: number }
  | { id: number; scores: number[] }
  | { id: number; error: string }

let loadedReported = false

/** Answers one request; `emit` receives the replies. Exported so tests can drive it without a real child. */
export async function serveRerankRequest(req: RerankRequest, emit: (reply: RerankReply) => void): Promise<void> {
  try {
    if (!loadedReported) {
      const started = Date.now()
      await loadRanker()
      loadedReported = true
      emit({ type: 'loaded', ms: Date.now() - started })
    }
    emit({ id: req.id, scores: await scorePairs(req.query, req.passages, req.maxLength) })
  } catch (err) {
    emit({ id: req.id, error: err instanceof Error ? err.message : String(err) })
  }
}

export function _resetWorkerForTests(): void {
  loadedReported = false
}

/** Env var the parent sets on the child it forks; the entry point below only wires itself when it is present. */
export const RERANK_CHILD_ENV = 'MARVEEN_RERANK_CHILD'

/** The slice of `process` the child entry uses; the tests pass a fake. */
export interface ChildProcessLike {
  onMessage(cb: (req: RerankRequest) => void): void
  onDisconnect(cb: () => void): void
  send(reply: RerankReply): void
  /** SIGKILL to itself. */
  killSelf(): void
}

/**
 * Serves requests arriving over the IPC channel of a forked child. When the parent goes away (channel closed) the
 * child kills itself with SIGKILL: exiting gracefully with an inference still running in onnxruntime aborts the
 * process (SIGABRT, a crash report), and an orphaned child must not linger holding the model's memory.
 */
export function wireChildProcess(proc: ChildProcessLike): void {
  proc.onMessage((req) => { void serveRerankRequest(req, reply => proc.send(reply)) })
  proc.onDisconnect(() => proc.killSelf())
}

// Only wired when this file runs as the forked child; imported anywhere else (tests, the dashboard process) it
// does nothing. `process.send` alone is not a safe test: vitest's own workers have it too.
if (process.env[RERANK_CHILD_ENV] === '1' && typeof process.send === 'function') {
  wireChildProcess({
    onMessage: (cb) => { process.on('message', cb) },
    onDisconnect: (cb) => { process.on('disconnect', cb) },
    send: (reply) => { process.send!(reply) },
    killSelf: () => { process.kill(process.pid, 'SIGKILL') },
  })
}
