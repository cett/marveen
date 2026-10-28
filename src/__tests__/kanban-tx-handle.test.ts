// The five kanban transactions (W3-3): every statement of a transaction body must run on the tx handle. A statement
// on the facade (dbx) would join the open transaction on SQLite by accident (one connection) and run OUTSIDE it on a
// pooled backend. The one statement allowed on the facade is the audit write (the audit module moves in W3-5; it runs
// in its own savepoint and is best effort by design).
// Pattern: notes/1017-w2-9-qa-probes. Real in-memory database.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  db, dbx, initDatabase, createKanbanCard, createKanbanSubtasks, deleteKanbanCard, moveKanbanCard, deleteLabel,
  promoteIdeaToKanban, createIdea, createLabel,
} from '../db.js'

beforeEach(() => { initDatabase(':memory:') })
afterEach(() => { vi.restoreAllMocks() })

// the audit write and the tenant lookup it makes (src/db/audit.ts, W3-5)
const AUDIT_SINK = /^(INSERT INTO agent_audit_log|SELECT tenant_id, status, updated_at FROM agent_tenant_context)/

/** Records the SQL of every facade statement from now on; the audit sink is left out of the record. */
function spyFacade(): string[] {
  const seen: string[] = []
  for (const m of ['get', 'run', 'all'] as const) {
    const real = dbx[m].bind(dbx) as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, m).mockImplementation((async (sql: string, ...a: unknown[]) => {
      const s = sql.replace(/\s+/g, ' ').trim()
      if (!AUDIT_SINK.test(s)) seen.push(s.slice(0, 70))
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
