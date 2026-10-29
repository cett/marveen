// Worker thread entry point for the cross-encoder reranker.
// Spawned by WorkerRerankBackend (reranker-backend.ts). The model, the tokenizer and every forward pass live here,
// so the ONNX inference that used to stop the main thread's event loop for its whole duration (about 0.7 s for ten
// candidates, 4-5 s for fifty) stops only this thread.
//
// Protocol (all messages are plain structured-clone data):
//   in:  { id: number, query: string, passages: string[], maxLength?: number }
//   out: { type: 'loaded', ms: number }          once, when the model is ready (before the first reply)
//        { id, scores: number[] }                 the scores, in passage order
//        { id, error: string }                    load or inference failed

import { parentPort } from 'node:worker_threads'
import { loadRanker, scorePairs } from './reranker-engine.js'

export interface RerankRequest { id: number; query: string; passages: string[]; maxLength?: number }
export type RerankReply =
  | { type: 'loaded'; ms: number }
  | { id: number; scores: number[] }
  | { id: number; error: string }

let loadedReported = false

/** Answers one request; `emit` receives the replies. Exported so tests can drive it without a real Worker. */
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

// Only wired when this file runs as a worker; imported in the main thread (tests) it does nothing.
if (parentPort) {
  const port = parentPort
  port.on('message', (req: RerankRequest) => {
    void serveRerankRequest(req, reply => port.postMessage(reply))
  })
}
