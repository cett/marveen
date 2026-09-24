// Unit coverage for searchKanbanCards(): the dual-ID (rowid + hash) unified
// text search that backs both the sidebar global search and the archived
// view's search field.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb, createKanbanCard, archiveKanbanCard, searchKanbanCards } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('searchKanbanCards', () => {
  it('matches "#N" against the exact rowid', () => {
    createKanbanCard({ id: 'aaaa1111', title: 'first card' })
    createKanbanCard({ id: 'bbbb2222', title: 'second card' })

    const results = searchKanbanCards({ q: '#2' })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('bbbb2222')
    expect(results[0].seq).toBe(2)
  })

  it('does not treat a bare number (no #) as a rowid match', () => {
    createKanbanCard({ id: 'aaaa1111', title: 'card one' })

    expect(searchKanbanCards({ q: '1' })).toHaveLength(0)
  })

  it('matches a 4+ char hex prefix against the id', () => {
    createKanbanCard({ id: 'cafe1234', title: 'hex prefix target' })
    createKanbanCard({ id: 'deadbeef', title: 'other card' })

    const results = searchKanbanCards({ q: 'cafe' })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('cafe1234')
  })

  it('matches title substring case-insensitively', () => {
    createKanbanCard({ id: 'aaaa1111', title: 'Telepítő javítás' })
    createKanbanCard({ id: 'bbbb2222', title: 'Unrelated card' })

    const results = searchKanbanCards({ q: 'telepítő' })

    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('aaaa1111')
  })

  it('matches project and assignee substrings', () => {
    createKanbanCard({ id: 'aaaa1111', title: 'x', project: 'Marveen dev' })
    createKanbanCard({ id: 'bbbb2222', title: 'y', assignee: 'agent-a' })
    createKanbanCard({ id: 'cccc3333', title: 'z' })

    expect(searchKanbanCards({ q: 'Marveen' }).map((c) => c.id)).toEqual(['aaaa1111'])
    expect(searchKanbanCards({ q: 'agent-a' }).map((c) => c.id)).toEqual(['bbbb2222'])
  })

  it('ranks active cards before archived ones for the same match, most recent first within each group', () => {
    createKanbanCard({ id: 'aaaa1111', title: 'shared term one' })
    createKanbanCard({ id: 'bbbb2222', title: 'shared term two' })
    createKanbanCard({ id: 'cccc3333', title: 'shared term three' })
    // Stagger updated_at so the recency ordering within the active group is
    // deterministic -- createKanbanCard stamps all three with "now" (same
    // second), which leaves ties broken arbitrarily by SQLite otherwise.
    const db = getDb()
    db.prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(100, 'aaaa1111')
    db.prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(200, 'bbbb2222')
    db.prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(300, 'cccc3333')
    archiveKanbanCard('aaaa1111')

    const results = searchKanbanCards({ q: 'shared term' })

    expect(results.map((c) => c.id)).toEqual(['cccc3333', 'bbbb2222', 'aaaa1111'])
    expect(results.map((c) => c.archived)).toEqual([false, false, true])
  })

  it('includes archived cards in the results (unlike the plain active-board list)', () => {
    createKanbanCard({ id: 'aaaa1111', title: 'archived target' })
    archiveKanbanCard('aaaa1111')

    const results = searchKanbanCards({ q: 'archived target' })

    expect(results).toHaveLength(1)
    expect(results[0].archived).toBe(true)
  })

  it('respects the limit', () => {
    for (let i = 0; i < 5; i++) {
      createKanbanCard({ id: `card${i}000`, title: 'bulk match' })
    }

    expect(searchKanbanCards({ q: 'bulk match', limit: 2 })).toHaveLength(2)
  })

  it('scopes results to the given tenant when tenantId is set', () => {
    createKanbanCard({ id: 'aaaa1111', title: 'tenant scoped card', tenant_id: 'eszter' })
    createKanbanCard({ id: 'bbbb2222', title: 'tenant scoped card', tenant_id: 'default' })

    const scoped = searchKanbanCards({ q: 'tenant scoped', tenantId: 'eszter' })
    expect(scoped.map((c) => c.id)).toEqual(['aaaa1111'])

    const unscoped = searchKanbanCards({ q: 'tenant scoped', tenantId: null })
    expect(unscoped).toHaveLength(2)
  })
})
