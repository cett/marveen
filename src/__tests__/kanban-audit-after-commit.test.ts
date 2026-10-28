// The kanban audit entries are written after the card rows are committed (an await inside a synchronous
// better-sqlite3 transaction would end it early), best effort: a failing audit write never undoes the card.
// Real in-memory database, no mocks. Each test names the line it protects in src/db/kanban.ts.
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
    expect(getKanbanCard('c1')?.title).toBe('Root')
    const rows = auditRows('create')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'agent-a', entity_id: 'c1' })
    expect(JSON.parse(rows[0].detail)).toEqual({ title: 'Root', status: 'planned', priority: 'high' })
  })

  it('a failing audit write leaves the card in place and does not reject', async () => {
    blockAuditWrites()
    await expect(createKanbanCard({ id: 'c1', title: 'Root' })).resolves.toBeUndefined()
    expect(getKanbanCard('c1')?.title).toBe('Root')
    expect(auditRows('create')).toEqual([])
  })

  it('the synchronous half writes the rows and no audit entry; the entry it returns is written by the caller afterwards', async () => {
    const entry = insertKanbanCardRows({ id: 'c1', title: 'Root', assignee: 'agent-a' })
    expect(getKanbanCard('c1')?.title).toBe('Root')
    expect(auditRows('create')).toEqual([])
    await writeKanbanCreateAudit(entry)
    expect(auditRows('create').map((r) => r.entity_id)).toEqual(['c1'])
  })
})

describe('deleteKanbanCard', () => {
  it('deletes the card and writes one delete audit entry for the assignee, after the commit', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root', assignee: 'agent-a' })
    expect(await deleteKanbanCard('c1')).toBe(true)
    expect(getKanbanCard('c1')).toBeUndefined()
    const rows = auditRows('delete')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'agent-a', entity_id: 'c1' })
    expect(JSON.parse(rows[0].detail)).toEqual({ title: 'Root' })
  })

  it('a card that does not exist: false and no audit entry', async () => {
    expect(await deleteKanbanCard('missing')).toBe(false)
    expect(auditRows('delete')).toEqual([])
  })

  it('a failing audit write does not undo the delete or reject', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root' })
    blockAuditWrites()
    await expect(deleteKanbanCard('c1')).resolves.toBe(true)
    expect(getKanbanCard('c1')).toBeUndefined()
  })

  it('a card without an assignee is audited as system', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root' })
    await deleteKanbanCard('c1')
    expect(auditRows('delete').map((r) => r.agent_id)).toEqual(['system'])
  })
})
