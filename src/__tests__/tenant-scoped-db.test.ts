// Direct checks of db/tenant-scoped.ts: the tenant is a required first
// parameter and the only thing that decides which rows a call can see or
// change. (tenant-scope.test.ts covers the same contract through the facade.)
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
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

beforeEach(() => {
  initDatabase(':memory:')
  for (const id of ['t-a', 't-b']) {
    getDb().prepare('INSERT OR IGNORE INTO tenants (id, display_name) VALUES (?, ?)').run(id, id)
  }
})

describe('kanban cards', () => {
  it('lists, counts and paginates only the given tenant', () => {
    for (let i = 0; i < 5; i++) insertTenantKanbanCard('t-a', `a-${i}`, `A ${i}`)
    insertTenantKanbanCard('t-b', 'b-0', 'B 0')

    expect(listTenantKanbanCards('t-a')).toHaveLength(5)
    expect(countTenantKanbanCards('t-a')).toBe(5)
    expect(listTenantKanbanCards('t-a', undefined, 2, 4)).toHaveLength(1)
    expect(listTenantKanbanCards('t-b').map((c) => c.id)).toEqual(['b-0'])
    expect(listTenantKanbanCards('t-nobody')).toEqual([])
    expect(countTenantKanbanCards('t-nobody')).toBe(0)
  })

  it('cannot read, update or delete another tenant\'s card', () => {
    insertTenantKanbanCard('t-a', 'card-a', 'A')
    expect(getTenantKanbanCard('t-b', 'card-a')).toBeNull()
    expect(updateTenantKanbanCard('t-b', 'card-a', { title: 'hijacked' })).toBe(false)
    expect(deleteTenantKanbanCard('t-b', 'card-a')).toBe(false)
    expect(getTenantKanbanCard('t-a', 'card-a')?.title).toBe('A')
  })

  it('treats an empty patch as a no-op', () => {
    insertTenantKanbanCard('t-a', 'card-a', 'A')
    expect(updateTenantKanbanCard('t-a', 'card-a', {})).toBe(false)
  })
})

describe('memories', () => {
  it('stamps the tenant on insert and never lists it for another tenant', () => {
    const id = insertTenantMemory('t-a', 'agent-1', 'warm', 'only for a', 'kw')
    expect(listTenantMemories('t-a', 'agent-1').map((m) => m.id)).toEqual([id])
    expect(listTenantMemories('t-b', 'agent-1')).toEqual([])
  })

  it('does not delete a row that belongs to another tenant', () => {
    const id = insertTenantMemory('t-a', 'agent-1', 'warm', 'keep me')
    expect(deleteTenantMemory('t-b', id)).toBe(false)
    expect(listTenantMemories('t-a', 'agent-1')).toHaveLength(1)
    expect(deleteTenantMemory('t-a', id)).toBe(true)
  })
})

describe('agent messages', () => {
  it('lists a target agent\'s messages per tenant', () => {
    insertTenantMessage('t-a', 'x', 'y', 'for a')
    insertTenantMessage('t-b', 'x', 'y', 'for b')
    expect(listTenantMessagesFor('t-a', 'y').map((m) => m.content)).toEqual(['for a'])
    expect(listTenantMessagesFor('t-b', 'y', 'done')).toEqual([])
  })
})
