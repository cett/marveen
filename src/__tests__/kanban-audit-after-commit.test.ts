// The kanban audit entries are best effort: a failing audit write never undoes the card. The card delete and its
// audit entry are ONE facade transaction (the audit in its own savepoint); a card create writes its rows first and its
// entry second. Real in-memory database, no mocks. Each test names the line it protects in src/db/kanban.ts.
// (Kept under its old file name; the delete/breakdown/promote atomicity is pinned in kanban-facade-overlap.test.ts.)
import { describe, it, expect } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { db, createKanbanCard, deleteKanbanCard, getKanbanCard } from '../db.js'
import { insertKanbanCardRows, writeKanbanCreateAudit } from '../db/kanban.js'

useTestDb()

const auditRows = (action: string) =>
  db.prepare("SELECT agent_id, entity_id, detail FROM agent_audit_log WHERE entity = 'kanban' AND action = ? ORDER BY id").all(action) as
    { agent_id: string; entity_id: string; detail: string }[]
const blockAuditWrites = () =>
  db.exec("CREATE TRIGGER audit_blocked BEFORE INSERT ON agent_audit_log BEGIN SELECT RAISE(ABORT, 'blocked'); END")

describe('createKanbanCard', () => {
  it('writes the card and exactly one create audit entry with the title, status and priority', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root', assignee: 'agent-a', priority: 'high' })
    expect((await getKanbanCard('c1'))?.title).toBe('Root')
    const rows = auditRows('create')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'agent-a', entity_id: 'c1' })
    expect(JSON.parse(rows[0].detail)).toEqual({ title: 'Root', status: 'planned', priority: 'high' })
  })

  it('a failing audit write leaves the card in place and does not reject', async () => {
    blockAuditWrites()
    await expect(createKanbanCard({ id: 'c1', title: 'Root' })).resolves.toBeUndefined()
    expect((await getKanbanCard('c1'))?.title).toBe('Root')
    expect(auditRows('create')).toEqual([])
  })

  it('the synchronous half writes the rows and no audit entry; the entry it returns is written by the caller afterwards', async () => {
    const entry = await insertKanbanCardRows({ id: 'c1', title: 'Root', assignee: 'agent-a' })
    expect((await getKanbanCard('c1'))?.title).toBe('Root')
    expect(auditRows('create')).toEqual([])
    await writeKanbanCreateAudit(entry)
    expect(auditRows('create').map((r) => r.entity_id)).toEqual(['c1'])
  })
})

describe('deleteKanbanCard', () => {
  it('deletes the card and writes one delete audit entry for the assignee, in the same transaction', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root', assignee: 'agent-a' })
    expect(await deleteKanbanCard('c1')).toBe(true)
    expect(await getKanbanCard('c1')).toBeUndefined()
    const rows = auditRows('delete')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'agent-a', entity_id: 'c1' })
    expect(JSON.parse(rows[0].detail)).toEqual({ title: 'Root' })
  })

  it('a card that does not exist: false and no audit entry', async () => {
    expect(await deleteKanbanCard('missing')).toBe(false)
    expect(auditRows('delete')).toEqual([])
  })

  it('a failing audit write does not undo the delete or reject, and leaves no audit row behind', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root' })
    blockAuditWrites()
    await expect(deleteKanbanCard('c1')).resolves.toBe(true)
    expect(await getKanbanCard('c1')).toBeUndefined()
    expect(auditRows('delete')).toEqual([])
  })

  it('two overlapping deletes of the same card: one true, one false, exactly one audit entry', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root', assignee: 'agent-a' })
    const results = await Promise.all([deleteKanbanCard('c1'), deleteKanbanCard('c1')])
    expect(results.slice().sort()).toEqual([false, true])
    expect(auditRows('delete').map((r) => r.entity_id)).toEqual(['c1'])
  })

  it('a delete that removes 0 rows returns false and writes no audit entry', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root' })
    db.exec("CREATE TRIGGER keep_card BEFORE DELETE ON kanban_cards BEGIN SELECT RAISE(IGNORE); END")
    expect(await deleteKanbanCard('c1')).toBe(false)
    expect((await getKanbanCard('c1'))?.title).toBe('Root')
    expect(auditRows('delete')).toEqual([])
  })

  it('a card without an assignee is audited as system', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root' })
    await deleteKanbanCard('c1')
    expect(auditRows('delete').map((r) => r.agent_id)).toEqual(['system'])
  })
})
