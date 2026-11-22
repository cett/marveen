// A NAMED WEAK PIN (Rick, 6a W4, accepted): the PostgreSQL ts_rank weights are the literal '{1,1,1,1}' inside pgRankSql, so
// the weights are not a named constant. This cell only checks the SQL text: it does not check a ranking. A change of the
// weights in pgRankSql must change this pin too, and the rank cells in fts-rank-normalization.test.ts are the behaviour
// check. Pure unit test (no database), so it runs on the default suite only.
import { describe, expect, it } from 'vitest'
import { pgRankSql } from '../db/fts.js'

describe('weak source pin: the ts_rank weights are the literal {1,1,1,1} (named, accepted)', () => {
  it('pgRankSql carries the source literal {1,1,1,1} in its ts_rank call', () => {
    expect(pgRankSql('wd.fts', 'qq.q')).toContain("ts_rank('{1,1,1,1}', wd.fts, qq.q,")
  })
})
