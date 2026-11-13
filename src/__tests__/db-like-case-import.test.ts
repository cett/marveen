// searchImportMemories (db/import.ts) matches the query against the content, the keywords and the file name with one
// LIKE group, in the item list and in the count. SQLite's LIKE folds ASCII case, PostgreSQL's does not: the group goes
// through likeNoCase. Upper and lower case on purpose, each column on its own; runs on both engines (useTestDb).
import { describe, it, expect, beforeEach } from 'vitest'
import { dbx, insertImportSource, searchImportMemories } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

beforeEach(async () => {
  await dbx.run('DELETE FROM import_memories')
  await dbx.run('DELETE FROM import_sources')
  await insertImportSource({
    id: 's-a', type: 'local', path: '/docs/a', label: 'a', intervalHours: 4, enabled: true, now: 100,
    tenantId: 't-a', vaultTokenRef: null, confluenceEmail: null, baseUrl: null,
  })
})

async function row(id: string, content: string, keywords: string | null = null, fileName = 'f.md'): Promise<void> {
  await dbx.run(
    `INSERT INTO import_memories (id, source_id, file_path, file_name, content, keywords, content_hash, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 100, 100)`,
    id, 's-a', `/docs/a/${id}/${fileName}`, fileName, content, keywords, `h-${id}`,
  )
}

/** The item ids and the count for one query: both statements are asserted, they are two separate SQL texts. */
async function search(q: string): Promise<{ total: number; ids: string[] }> {
  const r = await searchImportMemories(q, 't-a', 10, 0)
  return { total: r.total, ids: (r.items as Array<{ id: string }>).map((i) => i.id).sort() }
}

describe('searchImportMemories: each column ignores ASCII case, in the list and in the count', () => {
  // Each text is in ONE column of ONE row (the other columns of that row do not contain it).
  it('content only', async () => {
    await row('c1', 'Has ZzContentOnly in it')
    await row('c2', 'unrelated')
    expect(await search('zzcontentonly')).toEqual({ total: 1, ids: ['c1'] })
    expect(await search('ZZCONTENTONLY')).toEqual({ total: 1, ids: ['c1'] })
  })

  it('keywords only', async () => {
    await row('k1', 'body', 'Alpha,ZzKeyOnly')
    await row('k2', 'body')
    expect(await search('zzkeyonly')).toEqual({ total: 1, ids: ['k1'] })
    expect(await search('ZZKEYONLY')).toEqual({ total: 1, ids: ['k1'] })
  })

  it('file name only', async () => {
    await row('f1', 'body', null, 'Report-ZzNameOnly.MD')
    await row('f2', 'body')
    expect(await search('zznameonly')).toEqual({ total: 1, ids: ['f1'] })
    expect(await search('report-zznameonly.md')).toEqual({ total: 1, ids: ['f1'] })
  })

  it('does not fold non-ASCII (the two engines agree) in any of the three columns', async () => {
    await row('n1', 'Őra jegyzet')
    await row('n2', 'body', 'Ékezet,Kulcs')
    await row('n3', 'body', null, 'Ünnep.md')
    for (const [lower, upper, id] of [['őra', 'Őra', 'n1'], ['ékezet', 'Ékezet', 'n2'], ['ünnep', 'Ünnep', 'n3']]) {
      expect(await search(lower), lower).toEqual({ total: 0, ids: [] })
      expect(await search(upper), upper).toEqual({ total: 1, ids: [id] })
    }
  })

  it('a % or _ in the query is a literal, in upper and lower case rows alike', async () => {
    await row('w1', 'rate is 50% TODAY')
    await row('w2', 'snake_Case name')
    await row('w3', 'plain')
    expect(await search('%')).toEqual({ total: 1, ids: ['w1'] })
    expect(await search('50% today')).toEqual({ total: 1, ids: ['w1'] })
    expect(await search('E_C')).toEqual({ total: 1, ids: ['w2'] })
    expect(await search('e_x')).toEqual({ total: 0, ids: [] })
  })

  // A decoy row differs only where a wildcard would match: a column whose ESCAPE clause is missing then finds nothing
  // (the backslash stays in the pattern) and goes red on SQLite; keywords and the file name are checked on their own.
  it('% and _ are literal in the keywords and in the file name too', async () => {
    await row('l1', 'body', 'zz_kw_only')
    await row('l2', 'body', 'zzxkwxonly')
    await row('l3', 'body', null, 'zz_name_only.md')
    await row('l4', 'body', null, 'zzxnamexonly.md')
    expect(await search('ZZ_KW')).toEqual({ total: 1, ids: ['l1'] })
    expect(await search('zz_NAME')).toEqual({ total: 1, ids: ['l3'] })
  })
})
