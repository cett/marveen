// totalsByTokenShadowCategory sums a bigint counter per category. In PostgreSQL sum() of a bigint is numeric, which the
// driver hands back as a string ("123" + "456" is "123456" in JavaScript); the statement casts the sum, so the total is
// a number on both backends. Same file on SQLite (default suite) and in the PG module run (ported list).
import { describe, expect, it } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { bumpTokenShadow, totalsByTokenShadowCategory } from '../db/token-shadow.js'

const { dbx } = useTestDb()

const seed = (category: string, route: string, count: number, day = '2026-11-10') => dbx.run(
  `INSERT INTO token_usage_shadow (day, category, method, route, caller, caller_source, client, target, count, last_ts)
   VALUES (?, ?, 'GET', ?, '', 'none', 'none', '', ?, 1)`, day, category, route, count)

describe('totalsByTokenShadowCategory', () => {
  it('returns the total of a category as a number: two rows of one category add up, two categories add as numbers', async () => {
    await seed('cat-a', '/r1', 100)
    await seed('cat-a', '/r2', 23)
    await seed('cat-b', '/r1', 456)
    const rows = await totalsByTokenShadowCategory({ fromDay: '2026-11-01' })
    expect(rows).toEqual([{ category: 'cat-b', count: 456 }, { category: 'cat-a', count: 123 }])
    for (const r of rows) expect(typeof r.count).toBe('number')
    expect(rows[0].count + rows[1].count).toBe(579)
  })

  it('keeps the window and the route filter, and the counter bumped by the writer is part of the sum', async () => {
    await seed('cat-a', '/old', 1000, '2026-10-01')
    await seed('cat-a', '/keep', 5)
    await bumpTokenShadow({ day: '2026-11-10', category: 'cat-a', method: 'GET', route: '/keep', caller: '', callerSource: 'none', client: 'none', target: '' }, 2)
    expect(await totalsByTokenShadowCategory({ fromDay: '2026-11-01' })).toEqual([{ category: 'cat-a', count: 6 }])
    expect(await totalsByTokenShadowCategory({ fromDay: '2026-11-01', route: 'keep' })).toEqual([{ category: 'cat-a', count: 6 }])
    expect(await totalsByTokenShadowCategory({ fromDay: '2026-11-01', route: 'nothing' })).toEqual([])
  })
})
