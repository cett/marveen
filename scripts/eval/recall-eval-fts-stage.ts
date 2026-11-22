// Pure helpers for the PostgreSQL side of the recall harness (the full-text stage comparison,
// the copy plan of the eval loader and the snapshot shape. Nothing here touches a database, the clock or the network.
//
// The FTS stage is compared on its own: the vector stages do not exist on PostgreSQL until the vector step, so the final-stage
// thresholds (top-5 overlap 0.95, nDCG drop 0.01) cannot be measured here. The comparison reports the FTS-stage numbers and
// stops if the top-10 overlap falls below FTS_STOP_TOP10 (a ranking question, not a tuning one).

import { mean, ndcgAtK, overlapAtK, recallAtK, type CaseKind, type QueryRun, type Snapshot } from './recall-eval-lib.js'

/** Stop and report to the architect when the FTS-stage top-10 overlap of any kind is below this. */
export const FTS_STOP_TOP10 = 0.85

/** The stage name both engines use for the full-text candidates. */
export const FTS_STAGE = 'fts'

/** Scratch databases created by the loader carry this prefix; the snapshot refuses any other name. */
export const SCRATCH_DB_PREFIX = 'marveen_eval_'

export interface FtsStageKindReport {
  kind: CaseKind
  /** Queries compared (the baseline has an fts stage for them). */
  queries: number
  /** Baseline queries whose fts list is empty: they carry no overlap signal and are left out of the means. */
  skippedEmptyBaseline: number
  top10?: number
  top5?: number
  ndcgAt10?: number
  ndcgDrop?: number
}

/** A group of queries left out of the comparison, with the reason (never silent). */
export interface FtsStageSkipped {
  kind: CaseKind
  queries: number
  reason: string
}

export interface FtsStageReport {
  /** One row per compared kind (never averaged across kinds). */
  kinds: FtsStageKindReport[]
  /** The kinds that were examined: the same list as `kinds`, named for the report. */
  examined: CaseKind[]
  /** Queries left out of the comparison, per kind, with the reason. */
  skipped: FtsStageSkipped[]
  /** Hard problems: missing queries, a different query set. The numbers are still printed. */
  failures: string[]
  /** True when a compared kind's mean top-10 overlap is below the stop threshold. */
  stop: boolean
  stopReason?: string
  worst: { id: string; kind: CaseKind; top10?: number; top5?: number }[]
}

const KINDS: CaseKind[] = ['memory', 'doc', 'artifact']

/**
 * Compares the FTS stage of a candidate snapshot (PostgreSQL) with the baseline snapshot (SQLite): top-10 and top-5
 * overlap of the candidate list against the baseline list, nDCG@10 with the baseline as graded relevance, per kind.
 * The baseline ranking is the pseudo ground truth (see recall-eval-lib.ts).
 */
export function compareFtsStage(base: Snapshot, cand: Snapshot, stopBelow: number = FTS_STOP_TOP10): FtsStageReport {
  const failures: string[] = []
  if (base.meta.querySetSha256 !== cand.meta.querySetSha256) failures.push('querySetSha256 differs: not the same query set')

  const candById = new Map(cand.runs.map((r) => [r.id, r] as const))
  const rows: { id: string; kind: CaseKind; top10?: number; top5?: number; ndcg?: number; emptyBase: boolean }[] = []
  const comparedKinds = new Set<CaseKind>()
  const skippedNoBase = new Map<CaseKind, number>()
  let missing = 0
  let noCandStage = 0

  for (const b of base.runs) {
    const bFts = b.stages[FTS_STAGE]
    if (!bFts) {
      skippedNoBase.set(b.kind, (skippedNoBase.get(b.kind) ?? 0) + 1)
      continue
    }
    const c: QueryRun | undefined = candById.get(b.id)
    if (!c) {
      missing++
      continue
    }
    const cFts = c.stages[FTS_STAGE]
    if (!cFts) {
      noCandStage++
      continue
    }
    comparedKinds.add(b.kind)
    rows.push({
      id: b.id,
      kind: b.kind,
      top10: recallAtK(bFts, cFts, 10),
      top5: overlapAtK(bFts, cFts, 5),
      ndcg: ndcgAtK(bFts, cFts, 10),
      emptyBase: bFts.length === 0,
    })
  }
  if (missing) failures.push(`${missing} baseline queries missing from the candidate`)
  if (noCandStage) failures.push(`${noCandStage} candidate queries have no fts stage`)

  const kinds: FtsStageKindReport[] = KINDS.filter((k) => comparedKinds.has(k)).map((kind) => {
    const of = rows.filter((r) => r.kind === kind)
    const ndcg = mean(of.map((r) => r.ndcg))
    return {
      kind,
      queries: of.length,
      skippedEmptyBaseline: of.filter((r) => r.emptyBase).length,
      top10: mean(of.map((r) => r.top10)),
      top5: mean(of.map((r) => r.top5)),
      ndcgAt10: ndcg,
      ndcgDrop: ndcg === undefined ? undefined : 1 - ndcg,
    }
  })

  const skipped: FtsStageSkipped[] = KINDS.filter((k) => skippedNoBase.has(k)).map((kind) => ({
    kind,
    queries: skippedNoBase.get(kind)!,
    reason: 'the baseline run has no fts stage (regenerate the baseline with the fts stage)',
  }))
  const below = kinds.find((k) => k.top10 !== undefined && k.top10 < stopBelow)
  const stop = below !== undefined
  const stopReason = below
    ? `${below.kind}: fts-stage top-10 overlap ${below.top10!.toFixed(4)} < ${stopBelow} (ranking, not tuning, is the question)`
    : undefined

  const worst = rows
    .filter((r) => r.top10 !== undefined)
    .sort((a, b) => (a.top10! - b.top10!) || ((a.top5 ?? 1) - (b.top5 ?? 1)))
    .slice(0, 5)
    .map((r) => ({ id: r.id, kind: r.kind, top10: r.top10, top5: r.top5 }))

  return { kinds, examined: kinds.map((k) => k.kind), skipped, failures, stop, stopReason, worst }
}

// ---------------------------------------------------------------------------------------------
// Loader: which columns of the SQLite eval copy go into which PostgreSQL column
// ---------------------------------------------------------------------------------------------

export interface PgColumnInfo {
  name: string
  /** information_schema data_type, e.g. 'text', 'bigint', 'bytea'. */
  dataType: string
  /** A generated column (the full-text index): PostgreSQL computes it, the loader never writes it. */
  generated: boolean
}

export interface CopyPlan {
  /** Columns written, in the SQLite order (they exist in PostgreSQL and are not generated). */
  columns: string[]
  /** Columns that exist only in the SQLite copy (for example the vec0 side columns): not copied, named in the report. */
  dropped: string[]
  /** Columns PostgreSQL computes itself (the fts index): skipped on purpose. */
  generated: string[]
  /** Written columns of type bytea: a text value there is converted to its UTF-8 bytes (never parsed as an escape string). */
  byteaColumns: string[]
}

export function planCopy(sqliteColumns: string[], pgColumns: PgColumnInfo[]): CopyPlan {
  const pg = new Map(pgColumns.map((c) => [c.name, c] as const))
  const columns: string[] = []
  const dropped: string[] = []
  const generated: string[] = []
  const byteaColumns: string[] = []
  for (const name of sqliteColumns) {
    const info = pg.get(name)
    if (!info) {
      dropped.push(name)
    } else if (info.generated) {
      generated.push(name)
    } else {
      columns.push(name)
      if (info.dataType === 'bytea') byteaColumns.push(name)
    }
  }
  return { columns, dropped, generated, byteaColumns }
}

/** A SQLite value as a PostgreSQL parameter: a text value bound for a bytea column becomes its UTF-8 bytes. */
export function toPgValue(value: unknown, isBytea: boolean): unknown {
  if (isBytea && typeof value === 'string') return Buffer.from(value, 'utf8')
  return value
}

/** Throws unless the name is a scratch database name made by the loader (the live database is never a target). */
export function assertScratchDatabaseName(name: string): void {
  if (!/^marveen_eval_[a-z0-9_]{4,40}$/.test(name)) {
    throw new Error(`refusing database "${name}": the eval snapshot runs only on a scratch database named ${SCRATCH_DB_PREFIX}<suffix>`)
  }
}

// ---------------------------------------------------------------------------------------------
// Snapshot shape of the PostgreSQL FTS stage (the same JSON schema as the SQLite baseline)
// ---------------------------------------------------------------------------------------------

export interface FtsSnapshotInput {
  runs: QueryRun[]
  corpus: Record<string, number>
  gitSha: string
  frozenNowSec: number
  querySetSha256: string
  createdAtIso?: string
}

export function buildFtsSnapshot(input: FtsSnapshotInput): Snapshot {
  return {
    meta: {
      createdAt: input.createdAtIso ?? new Date(input.frozenNowSec * 1000).toISOString(),
      gitSha: input.gitSha,
      backend: 'postgres-fts',
      frozenNowSec: input.frozenNowSec,
      rerankEnabled: false,
      embedModel: 'nomic-embed-text',
      corpus: input.corpus,
      querySetSha256: input.querySetSha256,
      notes: [
        'stages: fts only (the PostgreSQL full-text stage of the production search functions, )',
        'vec stages are NOT computed on PostgreSQL until the vector step: skipped, not silent',
        'no rerank and no fusion: the fts list is compared before the final stage',
      ],
    },
    runs: input.runs,
  }
}
