// Pure helpers for the recall/quality baseline harness (PostgreSQL migration, Phase 0 gate).
//
// The harness freezes what the CURRENT retrieval pipeline (FTS5 + sqlite-vec + RRF) returns for a
// fixed query set, so a later backend (PostgreSQL: tsvector + pgvector) can be compared against it
// with the accepted thresholds. Nothing here touches a database, the clock or the network.
//
// Metrics are COMPARISON metrics against the frozen baseline, not absolute IR quality: there are no
// human relevance judgements, so the baseline ranking itself is the (pseudo) ground truth.

import { createHash } from 'node:crypto'

export type CaseKind = 'memory' | 'doc' | 'artifact'

export interface QueryCase {
  id: string
  kind: CaseKind
  agentId?: string
  tenantId?: string
  text: string
  /** How the query was derived (keywords / phrase / question / noaccent / title). */
  style: string
}

/** Ordered result ids per pipeline stage, e.g. { fts, vec_prod, vec_exact, final }. */
export type Stages = Record<string, string[]>

export interface QueryRun {
  id: string
  kind: CaseKind
  stages: Stages
}

export interface SnapshotMeta {
  createdAt: string
  gitSha: string
  backend: string
  vecVersion?: string
  frozenNowSec: number
  rerankEnabled: boolean
  embedModel: string
  corpus: Record<string, number>
  querySetSha256: string
  notes?: string[]
}

export interface Snapshot {
  meta: SnapshotMeta
  runs: QueryRun[]
}

export interface Thresholds {
  /** recall@10 of the raw vector candidate list vs baseline (decision g: 0.99). */
  vecRecallAt10: number
  /** overlap of the final top-5 (decision g: 0.95). */
  finalTop5Overlap: number
  /** max allowed nDCG@10 drop of the final ranking (decision g: 0.01). */
  maxNdcgDrop: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  vecRecallAt10: 0.99,
  finalTop5Overlap: 0.95,
  maxNdcgDrop: 0.01,
}

// ---------------------------------------------------------------------------------------------
// Metrics. `base` is the baseline ranking (ground truth), `cand` the candidate ranking.
// ---------------------------------------------------------------------------------------------

/** |top-k(base) ∩ top-k(cand)| / |top-k(base)|. Undefined when the baseline list is empty. */
export function recallAtK(base: string[], cand: string[], k: number): number | undefined {
  const b = base.slice(0, k)
  if (b.length === 0) return undefined
  const c = new Set(cand.slice(0, k))
  return b.filter((id) => c.has(id)).length / b.length
}

/** Same set overlap, named for the final top-5 use. */
export function overlapAtK(base: string[], cand: string[], k: number): number | undefined {
  return recallAtK(base, cand, k)
}

/** Graded gain from the baseline: rank 1 -> k, rank 2 -> k-1 ... rank k -> 1, otherwise 0. */
function gainFromBaseline(base: string[], k: number): Map<string, number> {
  const gains = new Map<string, number>()
  base.slice(0, k).forEach((id, i) => gains.set(id, k - i))
  return gains
}

function dcg(ids: string[], gains: Map<string, number>, k: number): number {
  let sum = 0
  ids.slice(0, k).forEach((id, i) => {
    sum += (gains.get(id) ?? 0) / Math.log2(i + 2)
  })
  return sum
}

/**
 * nDCG@k of the candidate ranking with the baseline ranking as graded relevance.
 * 1.0 means the candidate reproduces the baseline top-k exactly and in order.
 */
export function ndcgAtK(base: string[], cand: string[], k: number): number | undefined {
  if (base.length === 0) return undefined
  const gains = gainFromBaseline(base, k)
  const ideal = dcg(base, gains, k)
  return ideal === 0 ? undefined : dcg(cand, gains, k) / ideal
}

/** Reciprocal rank of the baseline's top-1 inside the candidate list (0 when absent). */
export function mrrOfTop1(base: string[], cand: string[]): number | undefined {
  if (base.length === 0) return undefined
  const idx = cand.indexOf(base[0])
  return idx < 0 ? 0 : 1 / (idx + 1)
}

export function mean(values: (number | undefined)[]): number | undefined {
  const v = values.filter((x): x is number => typeof x === 'number')
  return v.length === 0 ? undefined : v.reduce((a, b) => a + b, 0) / v.length
}

// ---------------------------------------------------------------------------------------------
// Snapshot comparison
// ---------------------------------------------------------------------------------------------

export interface KindReport {
  kind: CaseKind
  queries: number
  skippedEmptyBaseline: number
  vecRecallAt10?: number
  finalTop5Overlap?: number
  finalNdcgAt10?: number
  finalMrr?: number
  ftsRecallAt10?: number
}

export interface CompareReport {
  kinds: KindReport[]
  pass: boolean
  failures: string[]
  worst: { id: string; kind: CaseKind; finalTop5Overlap?: number; finalNdcgAt10?: number }[]
  metaMismatch: string[]
}

/** The stage used as "raw vector candidates" per kind. Exact-filter stage preferred when present. */
function vecStageOf(stages: Stages): string[] | undefined {
  return stages.vec_exact ?? stages.vec ?? stages.vec_prod
}

export function compareSnapshots(
  base: Snapshot,
  cand: Snapshot,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): CompareReport {
  const metaMismatch: string[] = []
  if (base.meta.querySetSha256 !== cand.meta.querySetSha256) metaMismatch.push('querySetSha256 differs: not the same query set')
  if (base.meta.rerankEnabled !== cand.meta.rerankEnabled) metaMismatch.push('rerankEnabled differs')
  if (base.meta.embedModel !== cand.meta.embedModel) metaMismatch.push('embedModel differs')

  const candById = new Map(cand.runs.map((r) => [r.id, r]))
  const perQuery: { id: string; kind: CaseKind; vec?: number; fts?: number; top5?: number; ndcg?: number; mrr?: number }[] = []
  const skipped = new Map<CaseKind, number>()
  const missing: string[] = []

  for (const b of base.runs) {
    const c = candById.get(b.id)
    if (!c) {
      missing.push(b.id)
      continue
    }
    const bFinal = b.stages.final ?? []
    if (bFinal.length === 0) skipped.set(b.kind, (skipped.get(b.kind) ?? 0) + 1)
    const bVec = vecStageOf(b.stages)
    const cVec = vecStageOf(c.stages)
    perQuery.push({
      id: b.id,
      kind: b.kind,
      vec: bVec && cVec ? recallAtK(bVec, cVec, 10) : undefined,
      fts: b.stages.fts && c.stages.fts ? recallAtK(b.stages.fts, c.stages.fts, 10) : undefined,
      top5: overlapAtK(bFinal, c.stages.final ?? [], 5),
      ndcg: ndcgAtK(bFinal, c.stages.final ?? [], 10),
      mrr: mrrOfTop1(bFinal, c.stages.final ?? []),
    })
  }

  const kinds: KindReport[] = (['memory', 'doc', 'artifact'] as CaseKind[])
    .map((kind) => {
      const rows = perQuery.filter((r) => r.kind === kind)
      return {
        kind,
        queries: rows.length,
        skippedEmptyBaseline: skipped.get(kind) ?? 0,
        vecRecallAt10: mean(rows.map((r) => r.vec)),
        ftsRecallAt10: mean(rows.map((r) => r.fts)),
        finalTop5Overlap: mean(rows.map((r) => r.top5)),
        finalNdcgAt10: mean(rows.map((r) => r.ndcg)),
        finalMrr: mean(rows.map((r) => r.mrr)),
      }
    })
    .filter((k) => k.queries > 0)

  const failures: string[] = []
  if (missing.length) failures.push(`${missing.length} baseline queries missing from the candidate (e.g. ${missing[0]})`)
  for (const k of kinds) {
    if (k.vecRecallAt10 !== undefined && k.vecRecallAt10 < thresholds.vecRecallAt10)
      failures.push(`${k.kind}: vector recall@10 ${k.vecRecallAt10.toFixed(4)} < ${thresholds.vecRecallAt10}`)
    if (k.finalTop5Overlap !== undefined && k.finalTop5Overlap < thresholds.finalTop5Overlap)
      failures.push(`${k.kind}: final top-5 overlap ${k.finalTop5Overlap.toFixed(4)} < ${thresholds.finalTop5Overlap}`)
    if (k.finalNdcgAt10 !== undefined && 1 - k.finalNdcgAt10 > thresholds.maxNdcgDrop)
      failures.push(`${k.kind}: nDCG@10 drop ${(1 - k.finalNdcgAt10).toFixed(4)} > ${thresholds.maxNdcgDrop}`)
  }
  for (const m of metaMismatch) failures.push(`meta: ${m}`)

  const worst = perQuery
    .filter((r) => r.top5 !== undefined)
    .sort((a, b) => (a.top5! - b.top5!) || ((a.ndcg ?? 1) - (b.ndcg ?? 1)))
    .slice(0, 5)
    .map((r) => ({ id: r.id, kind: r.kind, finalTop5Overlap: r.top5, finalNdcgAt10: r.ndcg }))

  return { kinds, pass: failures.length === 0, failures, worst, metaMismatch }
}

// ---------------------------------------------------------------------------------------------
// Deterministic helpers (query-set generation, offline embeddings for CI)
// ---------------------------------------------------------------------------------------------

/** Cache key of a query embedding: model + the prompt exactly as production sends it (first 2000 chars). */
export function embedKey(prompt: string, model = 'nomic-embed-text'): string {
  return createHash('sha256').update(`${model}\n${prompt.slice(0, 2000)}`).digest('hex')
}

/** mulberry32: small seeded PRNG so the generated query set is reproducible. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ACCENT_MAP: Record<string, string> = {
  á: 'a', é: 'e', í: 'i', ó: 'o', ö: 'o', ő: 'o', ú: 'u', ü: 'u', ű: 'u',
  Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ö: 'O', Ő: 'O', Ú: 'U', Ü: 'U', Ű: 'U',
}

export function stripAccents(s: string): string {
  return s.replace(/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/g, (c) => ACCENT_MAP[c] ?? c)
}

function words(text: string): string[] {
  return text
    .replace(/[`*_#>\[\]()|]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => w.length > 0)
}

/** A contiguous span of `n` words starting at a seeded position (after the first `skip` words). */
export function phraseSpan(text: string, n: number, rng: () => number): string | undefined {
  const w = words(text)
  if (w.length < n) return undefined
  const start = Math.floor(rng() * (w.length - n + 1))
  return w.slice(start, start + n).join(' ')
}

/** The first `n` words of the text, as a natural-language-ish short query. */
export function leadingWords(text: string, n: number): string | undefined {
  const w = words(text)
  return w.length < 3 ? undefined : w.slice(0, n).join(' ')
}

/** Up to `n` keyword tokens from a comma/space separated keywords field. */
export function keywordQuery(keywords: string | null | undefined, n: number): string | undefined {
  if (!keywords) return undefined
  const toks = keywords
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
  return toks.length === 0 ? undefined : toks.slice(0, n).join(' ')
}

/** Deterministic pseudo-embedding for offline tests: hash of the text expanded to `dim` floats. */
export function syntheticEmbedding(text: string, dim = 768): number[] {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const rng = seededRng(h >>> 0)
  return Array.from({ length: dim }, () => rng() * 2 - 1)
}

/** Squared L2 over two equal-length vectors (monotonic with L2, enough for ranking). */
export function l2sq(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  return s
}
