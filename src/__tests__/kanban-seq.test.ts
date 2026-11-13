// The running number (#N) of a kanban card on both backends: the SQLite rowid, the identity column seq in PostgreSQL.
// The same cells run in the default suite (SQLite) and in the PG module run (the file is in the ported list), so the
// number, its type and the "#N" search mean the same on both. The older kanban-search.test.ts opens the SQLite handle by
// hand and stays a SQLite-only unit test of the same function.
import { describe, expect, it } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import {
  archiveKanbanCard, createKanbanCard, findActiveKanbanCardByTitle, getKanbanCard, getSubtree, listKanbanCards, searchKanbanCards,
} from '../db/kanban.js'
import { getTenantKanbanCard, listTenantKanbanCards } from '../db/tenant-scoped.js'

const { dbx } = useTestDb()

async function seed(n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 1; i <= n; i++) {
    const id = `${String(i).padStart(2, '0')}aa1111`
    await createKanbanCard({ id, title: `card-${String.fromCharCode(96 + i)}` })
    ids.push(id)
  }
  return ids
}

describe('the running number (#N) of a kanban card', () => {
  it('is a number that counts up in insertion order, on every read path', async () => {
    const [a, b, c] = await seed(3)
    expect((await getKanbanCard(a))?.seq).toBe(1)
    expect((await getKanbanCard(c))?.seq).toBe(3)
    expect(typeof (await getKanbanCard(b))?.seq).toBe('number')
    expect((await listKanbanCards()).map((k) => [k.id, k.seq]).sort()).toEqual([[a, 1], [b, 2], [c, 3]])
    expect((await findActiveKanbanCardByTitle('card-b'))?.seq).toBe(2)
    expect((await getTenantKanbanCard('default', c))?.seq).toBe(3)
    expect((await listTenantKanbanCards('default')).map((k) => k.seq).sort()).toEqual([1, 2, 3])
    expect((await listTenantKanbanCards('default', 'planned', 1)).map((k) => k.seq)).toHaveLength(1)
    expect((await listTenantKanbanCards('default', 'planned')).map((k) => k.seq).sort()).toEqual([1, 2, 3])
    expect(typeof (await listTenantKanbanCards('default', 'planned', 1))[0].seq).toBe('number')
  })

  it('the subtree carries it too, and the card row has it exactly once', async () => {
    await createKanbanCard({ id: 'aaaa0001', title: 'parent' })
    await createKanbanCard({ id: 'aaaa0002', title: 'child', parent_id: 'aaaa0001' })
    const tree = await getSubtree('aaaa0001')
    expect(tree.map((k) => [k.id, k.seq])).toEqual([['aaaa0001', 1], ['aaaa0002', 2]])
    expect(Object.keys((await getKanbanCard('aaaa0001')) as object).filter((k) => k === 'seq')).toHaveLength(1)
  })

  it('is never reused after an archive or a delete', async () => {
    const [a, b] = await seed(2)
    await archiveKanbanCard(b)
    await dbx.run('DELETE FROM kanban_cards WHERE id = ?', a)
    await createKanbanCard({ id: 'ffff0003', title: 'third' })
    expect((await getKanbanCard('ffff0003'))?.seq).toBe(3)
  })
})

describe('searchKanbanCards: the "#N" and the id-prefix branches', () => {
  it('"#N" is an exact running-number match and nothing else', async () => {
    const ids = await seed(11)
    const hit = await searchKanbanCards({ q: '#2' })
    expect(hit.map((k) => [k.id, k.seq])).toEqual([[ids[1], 2]])
    expect(typeof hit[0].seq).toBe('number')
    // "#1" is card 1 only, not 10 or 11; no zero padding, no trailing text, no bare number, no second "#"
    expect((await searchKanbanCards({ q: '#1' })).map((k) => k.seq)).toEqual([1])
    expect((await searchKanbanCards({ q: '#11' })).map((k) => k.seq)).toEqual([11])
    for (const q of ['#02', '#2abc', '#', '##2', '2', '# 2', '#99']) expect(await searchKanbanCards({ q })).toEqual([])
  })

  it('an archived card is found by its number and flagged', async () => {
    const [a] = await seed(1)
    await archiveKanbanCard(a)
    const hit = await searchKanbanCards({ q: '#1' })
    expect(hit.map((k) => k.archived)).toEqual([true])
  })

  it('4+ characters that start with a hex digit match an id prefix; fewer, or a non-hex start, do not', async () => {
    await createKanbanCard({ id: 'cafe1234', title: 'target' })
    await createKanbanCard({ id: 'deadbeef', title: 'other' })
    expect((await searchKanbanCards({ q: 'cafe' })).map((k) => k.id)).toEqual(['cafe1234'])
    expect((await searchKanbanCards({ q: 'cafe1234' })).map((k) => k.id)).toEqual(['cafe1234'])
    expect(await searchKanbanCards({ q: 'caf' })).toEqual([])
    expect(await searchKanbanCards({ q: 'xafe' })).toEqual([])
  })

  it('an id prefix is only tried when the text starts with a hex digit (an id that does not start with one is not found by its prefix)', async () => {
    await createKanbanCard({ id: 'ghij5678', title: 'odd id' })
    expect(await searchKanbanCards({ q: 'ghij' })).toEqual([])
    expect((await searchKanbanCards({ q: 'odd' })).map((k) => k.id)).toEqual(['ghij5678'])
  })

  it('a wildcard in the text is literal in the id-prefix branch too', async () => {
    await createKanbanCard({ id: 'cafe1234', title: 'target' })
    expect(await searchKanbanCards({ q: 'caf%' })).toEqual([])
    expect(await searchKanbanCards({ q: 'ca_e' })).toEqual([])
  })

  it('an unrelated match is not suppressed by a shape guard that does not apply, and the tenant filter still holds', async () => {
    await createKanbanCard({ id: 'aaaa0001', title: 'release #1 notes' })
    expect((await searchKanbanCards({ q: 'release' })).map((k) => k.id)).toEqual(['aaaa0001'])
    expect(await searchKanbanCards({ q: 'release', tenantId: 'other-tenant' })).toEqual([])
    expect((await searchKanbanCards({ q: '#1', tenantId: 'default' })).map((k) => k.id)).toEqual(['aaaa0001'])
  })
})
