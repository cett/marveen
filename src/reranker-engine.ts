import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers'

// bge-reranker-base (Xenova ONNX): ~180 MB q8, mBERT base (104 languages incl. hu).
// Scores (query, passage) pairs for relevance. Lazy singleton. Xenova conversion provides the onnx/ folder needed
// by transformers.js.
//
// This is the model side only: it runs wherever it is imported, which is the child process in production
// (reranker-worker.ts) and the main thread in dev and tests (InProcessRerankBackend). It must not import anything
// that touches the database or the logger, so the child stays light.
export const RERANKER_MODEL = 'Xenova/bge-reranker-base'

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>
type Model = Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>

let tokenizerInstance: Tokenizer | null = null
let modelInstance: Model | null = null
let loadPromise: Promise<void> | null = null

async function getRanker(): Promise<{ tokenizer: Tokenizer; model: Model }> {
  if (tokenizerInstance && modelInstance) return { tokenizer: tokenizerInstance, model: modelInstance }
  if (!loadPromise) {
    loadPromise = Promise.all([
      AutoTokenizer.from_pretrained(RERANKER_MODEL),
      AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL, { dtype: 'q8' }),
    ]).then(([tok, mod]) => {
      tokenizerInstance = tok as Tokenizer
      modelInstance = mod as Model
    }).catch(err => {
      loadPromise = null
      throw err
    })
  }
  await loadPromise
  return { tokenizer: tokenizerInstance!, model: modelInstance! }
}

/**
 * Relevance of each passage to the query, 0..1, in passage order.
 *
 * Uses AutoTokenizer + AutoModelForSequenceClassification directly so that (query, passage) pairs are tokenized as
 * [CLS] query [SEP] passage [SEP] sequences. The single output logit per pair is passed through sigmoid. A pair the
 * model returned no logit row for scores 0. `maxLength` caps the tokens of a (query, passage) pair.
 */
export async function scorePairs(query: string, passages: string[], maxLength?: number): Promise<number[]> {
  if (passages.length === 0) return []
  const { tokenizer, model } = await getRanker()

  // The text_pair array route is the only correct way to get sentence-pair tokenization from transformers.js --
  // passing {text, text_pair} objects to a pipeline._call() does NOT work (it expects flat strings).
  const queries = passages.map(() => query)
  // A batch is padded to its longest pair and a pair is cut at the model's own limit (512) unless told otherwise:
  // most memories are short, but the long tail makes nearly every batch 512 tokens wide, and the cost grows with it.
  const inputs = tokenizer(queries, {
    text_pair: passages,
    padding: true,
    truncation: true,
    ...(maxLength !== undefined ? { max_length: maxLength } : {}),
  })

  const outputs = await (model as (inputs: unknown) => Promise<{ logits: { tolist(): number[][] } }>)(inputs)
  // logits shape: [batch_size, 1] -- one relevance logit per (query, passage) pair
  const logitRows = outputs.logits.tolist()
  return passages.map((_, i) => 1 / (1 + Math.exp(-(logitRows[i]?.[0] ?? 0))))
}

/** Loads the model without scoring anything; resolves when it is ready. */
export async function loadRanker(): Promise<void> {
  await getRanker()
}

// Exposed for testing only -- allows resetting the singleton between tests.
export function _resetEngineForTests(): void {
  tokenizerInstance = null
  modelInstance = null
  loadPromise = null
}
