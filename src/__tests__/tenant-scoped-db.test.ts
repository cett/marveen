// Direct checks of db/tenant-scoped.ts: the tenant is a required first
// parameter and the only thing that decides which rows a call can see or
// change. (tenant-scope.test.ts covers the same contract through the facade.)
import { describe, it, expect, beforeEach } from 'vitest'
import { getDb } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'
import {
  listTenantKanbanCards,
  countTenantKanbanCards,
  getTenantKanbanCard,
  insertTenantKanbanCard,
  updateTenantKanbanCard,
  deleteTenantKanbanCard,
  listTenantMemories,
  insertTenantMemory,
  deleteTenantMemory,
  listTenantMessagesFor,
  insertTenantMessage,
} from '../db/tenant-scoped.js'

useTestDb()
beforeEach(() => {
  for (const id of ['t-a', 't-b']) {
    getDb().prepare('INSERT OR IGNORE INTO tenants (id, display_name) VALUES (?, ?)').run(id, id)
  }
})

describe('kanban cards: the shape and order the board gets from a tenant list', () => {
  it('carries the card number (seq) on every card, in the list and on a single card', async () => {
    await insertTenantKanbanCard('t-a', 'a-0', 'A 0')
    await insertTenantKanbanCard('t-a', 'a-1', 'A 1')
    const cards = await listTenantKanbanCards('t-a')
    expect(cards.map(c => typeof c.seq)).toEqual(['number', 'number'])
    expect(new Set(cards.map(c => c.seq)).size).toBe(2)
    expect((await getTenantKanbanCard('t-a', 'a-1'))?.seq).toBe(cards.find(c => c.id === 'a-1')?.seq)
  })

  it('orders by the manual sort_order first, newest first within the same order (the admin board order)', async () => {
    for (const [id, order, created] of [['x', 3, 100], ['y', 1, 100], ['z', 1, 200], ['w', 2, 50]] as const) {
      await insertTenantKanbanCard('t-a', id, id)
      getDb().prepare('UPDATE kanban_cards SET sort_order = ?, created_at = ? WHERE id = ?').run(order, created, id)
    }
    expect((await listTenantKanbanCards('t-a')).map(c => c.id)).toEqual(['z', 'y', 'w', 'x'])
    expect((await listTenantKanbanCards('t-a', 'planned')).map(c => c.id)).toEqual(['z', 'y', 'w', 'x'])
    expect((await listTenantKanbanCards('t-a', 'planned', 2, 1)).map(c => c.id)).toEqual(['y', 'w'])
  })
})

describe('kanban cards: the status-filtered list stays inside the tenant', () => {
  it('never returns the other tenant\'s cards of the same status, with or without paging', async () => {
    for (let i = 0; i < 3; i++) await insertTenantKanbanCard('t-a', `a-${i}`, `A ${i}`, 'in_progress')
    for (let i = 0; i < 2; i++) await insertTenantKanbanCard('t-b', `b-${i}`, `B ${i}`, 'in_progress')
    await insertTenantKanbanCard('t-a', 'a-done', 'A done', 'done')
    await insertTenantKanbanCard('t-b', 'b-done', 'B done', 'done')

    const idsOf = async (tenant: string, status: string, limit?: number, offset?: number) =>
      (await listTenantKanbanCards(tenant, status, limit, offset)).map(c => c.id).sort()

    expect(await idsOf('t-a', 'in_progress')).toEqual(['a-0', 'a-1', 'a-2'])
    expect(await idsOf('t-b', 'in_progress')).toEqual(['b-0', 'b-1'])
    expect(await idsOf('t-a', 'done')).toEqual(['a-done'])
    expect(await idsOf('t-b', 'done')).toEqual(['b-done'])
    // a page larger than the tenant's own rows must not be filled from the other tenant
    expect(await idsOf('t-b', 'in_progress', 10, 0)).toEqual(['b-0', 'b-1'])
    expect(await idsOf('t-b', 'in_progress', 10, 1)).toHaveLength(1)
    expect(await listTenantKanbanCards('t-nobody', 'in_progress')).toEqual([])
  })

  it('leaves out the tenant\'s archived cards of that status', async () => {
    await insertTenantKanbanCard('t-a', 'a-live', 'live', 'planned')
    await insertTenantKanbanCard('t-a', 'a-old', 'old', 'planned')
    getDb().prepare('UPDATE kanban_cards SET archived_at = 1 WHERE id = ?').run('a-old')
    expect((await listTenantKanbanCards('t-a', 'planned')).map(c => c.id)).toEqual(['a-live'])
  })
})

describe('kanban cards', () => {
  it('lists, counts and paginates only the given tenant', async () => {
    for (let i = 0; i < 5; i++) await insertTenantKanbanCard('t-a', `a-${i}`, `A ${i}`)
    await insertTenantKanbanCard('t-b', 'b-0', 'B 0')

    expect(await listTenantKanbanCards('t-a')).toHaveLength(5)
    expect(await countTenantKanbanCards('t-a')).toBe(5)
    expect(await listTenantKanbanCards('t-a', undefined, 2, 4)).toHaveLength(1)
    expect((await listTenantKanbanCards('t-b')).map((c) => c.id)).toEqual(['b-0'])
    expect(await listTenantKanbanCards('t-nobody')).toEqual([])
    expect(await countTenantKanbanCards('t-nobody')).toBe(0)
  })

  it('cannot read, update or delete another tenant\'s card', async () => {
    await insertTenantKanbanCard('t-a', 'card-a', 'A')
    expect(await getTenantKanbanCard('t-b', 'card-a')).toBeNull()
    expect(await updateTenantKanbanCard('t-b', 'card-a', { title: 'hijacked' })).toBe(false)
    expect(await deleteTenantKanbanCard('t-b', 'card-a')).toBe(false)
    expect((await getTenantKanbanCard('t-a', 'card-a'))?.title).toBe('A')
  })

  it('treats an empty patch as a no-op', async () => {
    await insertTenantKanbanCard('t-a', 'card-a', 'A')
    expect(await updateTenantKanbanCard('t-a', 'card-a', {})).toBe(false)
  })
})

describe('memories', () => {
  it('stamps the tenant on insert and never lists it for another tenant', async () => {
    const id = await insertTenantMemory('t-a', 'agent-1', 'warm', 'only for a', 'kw')
    expect((await listTenantMemories('t-a', 'agent-1')).map((m) => m.id)).toEqual([id])
    expect(await listTenantMemories('t-b', 'agent-1')).toEqual([])
  })

  it('does not delete a row that belongs to another tenant', async () => {
    const id = await insertTenantMemory('t-a', 'agent-1', 'warm', 'keep me')
    expect(await deleteTenantMemory('t-b', id)).toBe(false)
    expect(await listTenantMemories('t-a', 'agent-1')).toHaveLength(1)
    expect(await deleteTenantMemory('t-a', id)).toBe(true)
  })
})

describe('agent messages', () => {
  it('lists a target agent\'s messages per tenant', async () => {
    await insertTenantMessage('t-a', 'x', 'y', 'for a')
    await insertTenantMessage('t-b', 'x', 'y', 'for b')
    expect((await listTenantMessagesFor('t-a', 'y')).map((m) => m.content)).toEqual(['for a'])
    expect(await listTenantMessagesFor('t-b', 'y', 'done')).toEqual([])
  })
})
