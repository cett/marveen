// Unit coverage for the pure metric / comparison helpers of the recall baseline harness.
import { describe, it, expect } from 'vitest'
import {
  recallAtK,
  overlapAtK,
  ndcgAtK,
  mrrOfTop1,
  mean,
  compareSnapshots,
  DEFAULT_THRESHOLDS,
  seededRng,
  stripAccents,
  phraseSpan,
  leadingWords,
  keywordQuery,
  syntheticEmbedding,
  l2sq,
  type Snapshot,
  type QueryRun,
} from '../eval/recall-eval-lib.js'

const ids = (n: number, prefix = 'm') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)

describe('recallAtK / overlapAtK', () => {
  it('is 1 for an identical list and 0 for a disjoint one', () => {
    expect(recallAtK(ids(10), ids(10), 10)).toBe(1)
    expect(recallAtK(ids(10), ids(10, 'x'), 10)).toBe(0)
  })
  it('counts only the baseline top-k as the denominator', () => {
    // baseline has 3 hits only; candidate returns all 3 plus noise -> still 1
    expect(recallAtK(['a', 'b', 'c'], ['a', 'b', 'c', 'x', 'y'], 10)).toBe(1)
  })
  it('ignores candidate items beyond k', () => {
    const cand = [...ids(5, 'x'), 'm1']
    expect(recallAtK(['m1'], cand, 5)).toBe(0)
    expect(recallAtK(['m1'], cand, 6)).toBe(1)
  })
  it('is undefined (not 0 or 1) for an empty baseline', () => {
    expect(recallAtK([], ids(3), 10)).toBeUndefined()
    expect(overlapAtK([], [], 5)).toBeUndefined()
  })
  it('partial overlap is the exact fraction', () => {
    expect(overlapAtK(ids(5), ['m1', 'm2', 'm3', 'x', 'y'], 5)).toBeCloseTo(0.6)
  })
})

describe('ndcgAtK', () => {
  it('is 1 when the candidate reproduces the baseline order', () => {
    expect(ndcgAtK(ids(10), ids(10), 10)).toBeCloseTo(1)
  })
  it('drops when the top item is demoted, more than when the last two swap', () => {
    const base = ids(10)
    const topDemoted = ['m2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm1']
    const tailSwapped = [...base.slice(0, 8), 'm10', 'm9']
    const a = ndcgAtK(base, topDemoted, 10)!
    const b = ndcgAtK(base, tailSwapped, 10)!
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(1)
  })
  it('is below 1 when baseline items are missing', () => {
    expect(ndcgAtK(ids(10), ids(5), 10)!).toBeLessThan(1)
  })
  it('is 0 for a fully disjoint candidate and undefined for an empty baseline', () => {
    expect(ndcgAtK(ids(10), ids(10, 'x'), 10)).toBe(0)
    expect(ndcgAtK([], ids(3), 10)).toBeUndefined()
  })
})

describe('mrrOfTop1', () => {
  it('uses the baseline top-1 position in the candidate', () => {
    expect(mrrOfTop1(['a', 'b'], ['a'])).toBe(1)
    expect(mrrOfTop1(['a', 'b'], ['x', 'y', 'a'])).toBeCloseTo(1 / 3)
    expect(mrrOfTop1(['a'], ['x'])).toBe(0)
    expect(mrrOfTop1([], ['x'])).toBeUndefined()
  })
})

describe('mean', () => {
  it('skips undefined values and returns undefined for nothing', () => {
    expect(mean([1, undefined, 0])).toBe(0.5)
    expect(mean([undefined])).toBeUndefined()
  })
})

function run(id: string, stages: Record<string, string[]>, kind: QueryRun['kind'] = 'memory'): QueryRun {
  return { id, kind, stages }
}
function snap(runs: QueryRun[], over: Partial<Snapshot['meta']> = {}): Snapshot {
  return {
    meta: {
      createdAt: '2026-10-08T00:00:00Z',
      gitSha: 'x',
      backend: 'sqlite',
      frozenNowSec: 1,
      rerankEnabled: false,
      embedModel: 'nomic-embed-text',
      corpus: {},
      querySetSha256: 'q',
      ...over,
    },
    runs,
  }
}
const goodStages = () => ({ fts: ids(10), vec_exact: ids(10), final: ids(10) })

describe('compareSnapshots', () => {
  it('passes an identical candidate', () => {
    const base = snap([run('q1', goodStages()), run('q2', goodStages())])
    const rep = compareSnapshots(base, snap([run('q1', goodStages()), run('q2', goodStages())]))
    expect(rep.pass).toBe(true)
    expect(rep.kinds[0].vecRecallAt10).toBe(1)
    expect(rep.kinds[0].finalNdcgAt10).toBeCloseTo(1)
  })

  it('fails when raw vector recall falls below the threshold', () => {
    const cand = goodStages()
    cand.vec_exact = [...ids(8), 'x1', 'x2'] // 0.8
    const rep = compareSnapshots(snap([run('q1', goodStages())]), snap([run('q1', cand)]))
    expect(rep.pass).toBe(false)
    expect(rep.failures.join('\n')).toMatch(/vector recall@10/)
  })

  it('fails on a top-5 overlap below 0.95 even when vector recall is fine', () => {
    const cand = goodStages()
    cand.final = ['m1', 'm2', 'm3', 'm4', 'x1', ...ids(10).slice(5)] // 4/5 = 0.8
    const rep = compareSnapshots(snap([run('q1', goodStages())]), snap([run('q1', cand)]))
    expect(rep.pass).toBe(false)
    expect(rep.failures.join('\n')).toMatch(/top-5 overlap/)
    expect(rep.failures.join('\n')).not.toMatch(/vector recall/)
  })

  it('fails on an nDCG drop above 0.01 with unchanged sets (pure re-ordering)', () => {
    const cand = goodStages()
    cand.final = ['m2', 'm1', ...ids(10).slice(2)] // same top-5 set, swapped head
    const rep = compareSnapshots(snap([run('q1', goodStages())]), snap([run('q1', cand)]))
    expect(rep.kinds[0].finalTop5Overlap).toBe(1)
    expect(rep.pass).toBe(false)
    expect(rep.failures.join('\n')).toMatch(/nDCG@10 drop/)
  })

  it('fails when baseline queries are missing from the candidate', () => {
    const rep = compareSnapshots(snap([run('q1', goodStages()), run('q2', goodStages())]), snap([run('q1', goodStages())]))
    expect(rep.pass).toBe(false)
    expect(rep.failures.join('\n')).toMatch(/missing/)
  })

  it('refuses a comparison across different query sets / rerank flag / embed model', () => {
    const base = snap([run('q1', goodStages())])
    for (const over of [{ querySetSha256: 'other' }, { rerankEnabled: true }, { embedModel: 'other' }]) {
      const rep = compareSnapshots(base, snap([run('q1', goodStages())], over))
      expect(rep.pass, JSON.stringify(over)).toBe(false)
      expect(rep.metaMismatch.length).toBeGreaterThan(0)
    }
  })

  it('does not count an empty-baseline query as a pass or a fail, and reports it', () => {
    const empty = { fts: [], vec_exact: [], final: [] }
    const rep = compareSnapshots(snap([run('q1', goodStages()), run('q2', empty)]), snap([run('q1', goodStages()), run('q2', empty)]))
    expect(rep.pass).toBe(true)
    expect(rep.kinds[0].skippedEmptyBaseline).toBe(1)
    expect(rep.kinds[0].finalTop5Overlap).toBe(1)
  })

  it('reports the worst queries first', () => {
    const bad = goodStages()
    bad.final = ids(10, 'x')
    const rep = compareSnapshots(
      snap([run('good', goodStages()), run('bad', goodStages())]),
      snap([run('good', goodStages()), run('bad', bad)]),
    )
    expect(rep.worst[0].id).toBe('bad')
  })

  it('computes per kind, so a perfect memory kind cannot hide a failing doc kind', () => {
    const bad = goodStages()
    bad.final = ids(10, 'x')
    const rep = compareSnapshots(
      snap([run('m', goodStages()), run('d', goodStages(), 'doc')]),
      snap([run('m', goodStages()), run('d', bad, 'doc')]),
    )
    expect(rep.pass).toBe(false)
    expect(rep.failures.join('\n')).toMatch(/^doc:|\ndoc:/)
  })

  it('exposes the accepted thresholds (decision g)', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ vecRecallAt10: 0.99, finalTop5Overlap: 0.95, maxNdcgDrop: 0.01 })
  })
})

describe('deterministic helpers', () => {
  it('seededRng is reproducible and differs across seeds', () => {
    const a = seededRng(7), b = seededRng(7), c = seededRng(8)
    const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()]
    expect(sa).toEqual(sb)
    expect(sa).not.toEqual(sc)
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true)
  })
  it('stripAccents handles Hungarian double-acute letters', () => {
    expect(stripAccents('Árvíztűrő tükörfúrógép, őrült Ő')).toBe('Arvizturo tukorfurogep, orult O')
  })
  it('phraseSpan returns n contiguous words, or undefined for short text', () => {
    const rng = seededRng(1)
    const p = phraseSpan('egy ket harom negy ot hat het', 4, rng)!
    expect(p.split(' ').length).toBe(4)
    expect('egy ket harom negy ot hat het').toContain(p)
    expect(phraseSpan('rovid szoveg', 4, rng)).toBeUndefined()
  })
  it('leadingWords and keywordQuery degrade to undefined on thin input', () => {
    expect(leadingWords('egy ket', 5)).toBeUndefined()
    expect(leadingWords('egy ket harom negy ot hat', 4)).toBe('egy ket harom negy')
    expect(keywordQuery(null, 3)).toBeUndefined()
    expect(keywordQuery('ab, postgres, pgvector; migráció', 2)).toBe('postgres pgvector')
  })
  it('syntheticEmbedding is deterministic, 768-dim by default and text-dependent', () => {
    const a = syntheticEmbedding('alma'), b = syntheticEmbedding('alma'), c = syntheticEmbedding('korte')
    expect(a.length).toBe(768)
    expect(a).toEqual(b)
    expect(l2sq(a, c)).toBeGreaterThan(0)
    expect(l2sq(a, b)).toBe(0)
  })
})
