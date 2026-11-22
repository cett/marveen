// Pure cells of the PostgreSQL side of the recall harness : the FTS-stage comparison and its stop rule,
// the copy plan of the loader, the bytea conversion and the scratch-database guard. No database, no network.
import { describe, expect, it } from 'vitest'
import {
  assertScratchDatabaseName,
  buildFtsSnapshot,
  compareFtsStage,
  FTS_STOP_TOP10,
  planCopy,
  toPgValue,
} from '../eval/recall-eval-fts-stage.js'
import type { QueryRun, Snapshot } from '../eval/recall-eval-lib.js'

const ids = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)

function snap(runs: QueryRun[], querySetSha256 = 'sha-1'): Snapshot {
  return {
    meta: {
      createdAt: '2026-11-22T00:00:00.000Z',
      gitSha: 'x',
      backend: 'test',
      frozenNowSec: 1,
      rerankEnabled: false,
      embedModel: 'nomic-embed-text',
      corpus: {},
      querySetSha256,
    },
    runs,
  }
}

describe('compareFtsStage: identical lists', () => {
  it('a candidate equal to the baseline has overlap 1, no nDCG drop, no stop', () => {
    const base = snap([
      { id: 'memory:001', kind: 'memory', stages: { fts: ids(10) } },
      { id: 'doc:001', kind: 'doc', stages: { fts: ids(10, 'd') } },
    ])
    const rep = compareFtsStage(base, snap(base.runs))
    const mem = rep.kinds.find((k) => k.kind === 'memory')!
    expect(mem.top10).toBe(1)
    expect(mem.top5).toBe(1)
    expect(mem.ndcgAt10).toBeCloseTo(1, 12)
    expect(mem.ndcgDrop).toBeCloseTo(0, 12)
    expect(rep.stop).toBe(false)
    expect(rep.failures).toEqual([])
  })
})

describe('compareFtsStage: the stop rule (top-10 overlap below 0.85)', () => {
  it('nine of ten shared is 0.9: no stop', () => {
    const b = ids(10)
    const c = [...b.slice(0, 9), 'other']
    const rep = compareFtsStage(snap([{ id: 'memory:001', kind: 'memory', stages: { fts: b } }]), snap([{ id: 'memory:001', kind: 'memory', stages: { fts: c } }]))
    expect(rep.kinds[0].top10).toBeCloseTo(0.9, 12)
    expect(rep.stop).toBe(false)
  })

  it('eight of ten shared is 0.8: stop, and the reason names the kind and the number', () => {
    const b = ids(10)
    const c = [...b.slice(0, 8), 'x1', 'x2']
    const rep = compareFtsStage(snap([{ id: 'doc:001', kind: 'doc', stages: { fts: b } }]), snap([{ id: 'doc:001', kind: 'doc', stages: { fts: c } }]))
    expect(FTS_STOP_TOP10).toBe(0.85)
    expect(rep.stop).toBe(true)
    expect(rep.stopReason).toContain('doc')
    expect(rep.stopReason).toContain('0.8000')
  })

  it('the stop looks at the kind means: a good memory mean does not hide a bad doc mean', () => {
    const good = ids(10)
    const bad = ids(10, 'd')
    const base = snap([
      { id: 'memory:001', kind: 'memory', stages: { fts: good } },
      { id: 'doc:001', kind: 'doc', stages: { fts: bad } },
    ])
    const cand = snap([
      { id: 'memory:001', kind: 'memory', stages: { fts: good } },
      { id: 'doc:001', kind: 'doc', stages: { fts: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'd9', 'd10'] } },
    ])
    const rep = compareFtsStage(base, cand)
    expect(rep.kinds.find((k) => k.kind === 'memory')!.top10).toBe(1)
    expect(rep.kinds.find((k) => k.kind === 'doc')!.top10).toBeCloseTo(0.2, 12)
    expect(rep.stop).toBe(true)
  })
})

describe('compareFtsStage: bookkeeping', () => {
  it('a missing candidate query and a different query set are failures, the numbers still come out', () => {
    const base = snap([
      { id: 'memory:001', kind: 'memory', stages: { fts: ids(3) } },
      { id: 'memory:002', kind: 'memory', stages: { fts: ids(3) } },
    ], 'sha-base')
    const cand = snap([{ id: 'memory:001', kind: 'memory', stages: { fts: ids(3) } }], 'sha-cand')
    const rep = compareFtsStage(base, cand)
    expect(rep.failures.some((f) => f.includes('missing'))).toBe(true)
    expect(rep.failures.some((f) => f.includes('querySetSha256'))).toBe(true)
    expect(rep.kinds[0].queries).toBe(1)
  })

  it('an empty baseline list is counted as skipped, not as a zero overlap', () => {
    const base = snap([
      { id: 'memory:001', kind: 'memory', stages: { fts: [] } },
      { id: 'memory:002', kind: 'memory', stages: { fts: ids(4) } },
    ])
    const rep = compareFtsStage(base, snap(base.runs))
    const mem = rep.kinds[0]
    expect(mem.skippedEmptyBaseline).toBe(1)
    expect(mem.top10).toBe(1)
  })

  it('a kind the baseline has no fts stage for (artifacts today) is named as not compared', () => {
    const base = snap([
      { id: 'memory:001', kind: 'memory', stages: { fts: ids(2) } },
      { id: 'artifact:001', kind: 'artifact', stages: { vec_prod: ids(2, 'a') } },
    ])
    const rep = compareFtsStage(base, snap(base.runs))
    expect(rep.kinds.map((k) => k.kind)).toEqual(['memory'])
    expect(rep.examined).toEqual(['memory'])
    expect(rep.skipped).toEqual([{ kind: 'artifact', queries: 1, reason: expect.stringContaining('no fts stage') }])
  })

  it('a partly skipped kind is compared on the rest and names the skipped queries (never averaged in)', () => {
    const base = snap([
      { id: 'artifact:001', kind: 'artifact', stages: { fts: ids(3, 'a') } },
      { id: 'artifact:002', kind: 'artifact', stages: { vec_prod: ids(3, 'a') } },
      { id: 'artifact:003', kind: 'artifact', stages: { vec_prod: ids(3, 'a') } },
    ])
    const rep = compareFtsStage(base, snap(base.runs))
    expect(rep.examined).toEqual(['artifact'])
    expect(rep.kinds[0].queries).toBe(1)
    expect(rep.skipped).toEqual([{ kind: 'artifact', queries: 2, reason: expect.any(String) }])
    expect(rep.stop).toBe(false)
  })

  it('the worst queries come first, lowest top-10 overlap', () => {
    const b = ids(10)
    const base = snap([
      { id: 'memory:001', kind: 'memory', stages: { fts: b } },
      { id: 'memory:002', kind: 'memory', stages: { fts: b } },
    ])
    const cand = snap([
      { id: 'memory:001', kind: 'memory', stages: { fts: b } },
      { id: 'memory:002', kind: 'memory', stages: { fts: ['z1', 'z2', ...b.slice(2)] } },
    ])
    const rep = compareFtsStage(base, cand)
    expect(rep.worst[0].id).toBe('memory:002')
    expect(rep.worst[0].top10).toBeCloseTo(0.8, 12)
  })
})

describe('planCopy: which columns go where', () => {
  it('drops the SQLite-only columns, skips the generated one, keeps bytea columns apart', () => {
    const plan = planCopy(
      ['id', 'content', 'vec_side', 'fts', 'embedding_blob'],
      [
        { name: 'id', dataType: 'bigint', generated: false },
        { name: 'content', dataType: 'text', generated: false },
        { name: 'fts', dataType: 'tsvector', generated: true },
        { name: 'embedding_blob', dataType: 'bytea', generated: false },
      ],
    )
    expect(plan.columns).toEqual(['id', 'content', 'embedding_blob'])
    expect(plan.dropped).toEqual(['vec_side'])
    expect(plan.generated).toEqual(['fts'])
    expect(plan.byteaColumns).toEqual(['embedding_blob'])
  })
})

describe('toPgValue: a text value for a bytea column is its UTF-8 bytes', () => {
  it('a backslash text is not parsed as an escape string: the bytes are the text bytes', () => {
    const v = toPgValue('C:\\temp\\x', true)
    expect(Buffer.isBuffer(v)).toBe(true)
    expect((v as Buffer).toString('utf8')).toBe('C:\\temp\\x')
  })

  it('other values pass through unchanged', () => {
    expect(toPgValue('plain', false)).toBe('plain')
    expect(toPgValue(7, true)).toBe(7)
    const buf = Buffer.from([1, 2])
    expect(toPgValue(buf, true)).toBe(buf)
  })
})

describe('assertScratchDatabaseName: the loader and the snapshot write only to a scratch database', () => {
  it('accepts a loader name', () => {
    expect(() => assertScratchDatabaseName('marveen_eval_0a1b2c3d')).not.toThrow()
  })

  it('refuses the live name, the admin database and anything with an injection shape', () => {
    for (const bad of ['marveen', 'postgres', 'marveen_eval_', 'marveen_eval_ab', 'marveen_eval_AB12cd', 'marveen_eval_x"; DROP']) {
      expect(() => assertScratchDatabaseName(bad), bad).toThrow(/refusing database/)
    }
  })
})

describe('buildFtsSnapshot: the snapshot names what it does not compute', () => {
  it('the backend is postgres-fts, the rerank is off, the vec skip is in the notes', () => {
    const s = buildFtsSnapshot({ runs: [], corpus: { memories: 0 }, gitSha: 'g', frozenNowSec: 1_800_000_000, querySetSha256: 'q' })
    expect(s.meta.backend).toBe('postgres-fts')
    expect(s.meta.rerankEnabled).toBe(false)
    expect(s.meta.notes?.some((n) => /vec stages are NOT computed/.test(n))).toBe(true)
    expect(s.meta.createdAt).toBe(new Date(1_800_000_000 * 1000).toISOString())
  })
})
