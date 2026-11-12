// The five kanban transactions (W3-3): every statement of a transaction body must run on the tx handle. A statement
// on the facade (dbx) would join the open transaction on SQLite by accident (one connection) and run OUTSIDE it on a
// pooled backend. The audit rows are written on the handle of their savepoint too (kanban-tx-handle-audit.test.ts pins
// that, with the nested facade transaction and the failure paths).
// Pattern: notes/1017-w2-9-qa-probes. Real in-memory database.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  db, dbx, initDatabase, createKanbanCard, createKanbanSubtasks, deleteKanbanCard, moveKanbanCard, deleteLabel,
  promoteIdeaToKanban, createIdea, createLabel,
} from '../db.js'

beforeEach(() => { initDatabase(':memory:') })
afterEach(() => { vi.restoreAllMocks() })

/** Records the SQL of every facade statement that runs while a transaction is open. */
function spyFacade(): string[] {
  const seen: string[] = []
  let open = 0
  const realTx = dbx.tx.bind(dbx) as (fn: (tx: never) => Promise<unknown>) => Promise<unknown>
  vi.spyOn(dbx, 'tx').mockImplementation((async (fn: (tx: never) => Promise<unknown>) => {
    open++
    try { return await realTx(fn) } finally { open-- }
  }) as never)
  for (const m of ['get', 'run', 'all'] as const) {
    const real = dbx[m].bind(dbx) as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, m).mockImplementation((async (sql: string, ...a: unknown[]) => {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (open > 0) seen.push(s.slice(0, 70))
      return real(sql, ...a)
    }) as never)
  }
  return seen
}

describe('the statements of a kanban transaction body go through the tx handle, not the facade', () => {
  it('createKanbanSubtasks: subtask rows and the parent comment', async () => {
    await createKanbanCard({ id: 'p1', title: 'Parent' })
    const seen = spyFacade()
    await createKanbanSubtasks('p1', [{ title: 'A' }, { title: 'B' }], 'bot')
    expect(seen).toEqual([])
  })

  it('deleteKanbanCard: comment, label, child re-parenting, depth cascade and the delete', async () => {
    await createKanbanCard({ id: 'top', title: 'Top' })
    await createKanbanCard({ id: 'mid', title: 'Mid', parent_id: 'top' })
    await createKanbanCard({ id: 'leaf', title: 'Leaf', parent_id: 'mid' })
    const seen = spyFacade()
    // the reads before the transaction (the card, its grandparent) are allowed on the facade; the body is not
    await deleteKanbanCard('mid')
    expect(seen.filter((s) => !/^SELECT rowid AS seq, \* FROM kanban_cards WHERE id = \?$/.test(s))).toEqual([])
  })

  it('moveKanbanCard: the column renumber', async () => {
    await createKanbanCard({ id: 'c1', title: 'One' })
    await createKanbanCard({ id: 'c2', title: 'Two' })
    const seen = spyFacade()
    await moveKanbanCard('c1', 'done', 1, 'owner', ['c2', 'c1'])
    // the status read before the transaction is allowed on the facade; the update, the event row and the renumber are not
    expect(seen.filter((s) => s !== 'SELECT status FROM kanban_cards WHERE id=?')).toEqual([])
    expect((db.prepare('SELECT sort_order FROM kanban_cards WHERE id = ?').get('c2') as { sort_order: number }).sort_order).toBe(0)
  })

  it('deleteLabel: the links and the label', async () => {
    const label = await createLabel({ id: 'l1', name: 'L', color: '#fff' })
    const seen = spyFacade()
    await deleteLabel(label.id)
    expect(seen).toEqual([])
  })

  it('promoteIdeaToKanban: the cards, the idea and its status log', async () => {
    await createIdea({ id: 'i1', title: 'Idea', description: null, category: 'x', status: 'new', source: 'test', kanban_id: null, impact: null, effort: null, tenant_id: 'default' })
    const seen = spyFacade()
    await promoteIdeaToKanban('i1', [{ id: 'p1', title: 'Parent' }, { id: 'k1', title: 'Kid', parent_id: 'p1' }], { from: 'new', actor: 'bot', note: 'n' })
    expect(seen).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS c FROM kanban_cards').get() as { c: number }).c).toBe(2)
  })
})

describe('the tenant of the audit rows of a kanban transaction is resolved before it opens', () => {
  // In the order the rows were written. Without the ORDER BY the query is answered from idx_aal_entity
  // (entity, created_at DESC), so two rows written a second apart come back newest first and the order flips with
  // the wall clock.
  const auditTenants = (action: string) => (db.prepare('SELECT tenant_id FROM agent_audit_log WHERE entity = ? AND action = ? ORDER BY id').all('kanban', action) as { tenant_id: string | null }[]).map((r) => r.tenant_id)

  it('the rows of the subtasks and of a delete carry the tenant of the card agent', async () => {
    await createKanbanCard({ id: 'p1', title: 'Parent', assignee: 'agent-a' })
    await createKanbanSubtasks('p1', [{ title: 'A', assignee: 'agent-a' }, { title: 'B' }], 'bot')
    expect(auditTenants('create')).toEqual(['default', 'default', 'default'])
    expect(await deleteKanbanCard('p1')).toBe(true)
    expect(auditTenants('delete')).toEqual(['default'])
  })

  it('a failing tenant lookup stays best effort: the subtask is written with an unknown-tenant audit row, no lookup runs in the body', async () => {
    await createKanbanCard({ id: 'p1', title: 'Parent' })
    let open = 0
    const realTx = dbx.tx.bind(dbx) as (fn: (tx: never) => Promise<unknown>) => Promise<unknown>
    vi.spyOn(dbx, 'tx').mockImplementation((async (fn: (tx: never) => Promise<unknown>) => {
      open++
      try { return await realTx(fn) } finally { open-- }
    }) as never)
    let lookupsInBody = 0
    for (const m of ['get', 'run', 'all'] as const) {
      const real = dbx[m].bind(dbx) as (...a: unknown[]) => Promise<unknown>
      vi.spyOn(dbx, m).mockImplementation((async (sql: string, ...a: unknown[]) => {
        if (/FROM (tenants|tenant_agent_availability|agent_tenant_context)/.test(sql)) {
          if (open > 0) lookupsInBody++
          throw new Error('lookup down')
        }
        return real(sql, ...a)
      }) as never)
    }
    const ids = await createKanbanSubtasks('p1', [{ title: 'A' }], 'bot')
    expect(ids).toHaveLength(1)
    expect(lookupsInBody).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS c FROM kanban_cards WHERE parent_id = ?').get('p1') as { c: number }).c).toBe(1)
    // the parent's own create row (written before the lookup broke) is 'default', the subtask's is unknown
    expect(auditTenants('create')).toEqual(['default', null])
  })

  it('the order of the rows is the order they were written, whatever their timestamps are (the helper does not follow the index)', async () => {
    await createKanbanCard({ id: 'p1', title: 'Parent', assignee: 'agent-a' })
    await createKanbanSubtasks('p1', [{ title: 'A', assignee: 'agent-a' }, { title: 'B' }], 'bot')
    // the later the row, the newer its timestamp: an index scan on (entity, created_at DESC) now returns them newest first
    db.prepare("UPDATE agent_audit_log SET created_at = 1000000 + id WHERE entity = 'kanban'").run()
    db.prepare("UPDATE agent_audit_log SET tenant_id = CASE WHEN id = (SELECT MIN(id) FROM agent_audit_log WHERE entity = 'kanban') THEN NULL ELSE 'default' END WHERE entity = 'kanban'").run()
    expect(auditTenants('create')).toEqual([null, 'default', 'default'])
  })
})
