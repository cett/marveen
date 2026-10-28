// The kanban facade conversion (W3-3): what a synchronous write used to guarantee by running to the end
// without a yield now holds because the write is one statement or one transaction. Real in-memory database.
//   - the dispatch guard is claimed by ONE conditional UPDATE: of two dispatchers only one wins;
//   - the auto-breakdown (subtasks + parent comment) is one transaction: a failing subtask leaves nothing;
//   - the delete and the breakdown audits run in the same transaction, each in a savepoint: a failing audit is
//     logged and rolls back only itself, the card change stays.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, createKanbanCard, getKanbanCard, getKanbanComments, getChildCards, deleteKanbanCard,
  createKanbanSubtasks, markKanbanCardDispatched, releaseKanbanCardDispatch, markScheduledTaskKanbanWaiting, moveKanbanCard,
} from '../db.js'
import { db } from '../db/connection.js'

beforeEach(() => {
  initDatabase(':memory:')
})

const auditRows = (entity: string, action: string) =>
  (db.prepare('SELECT COUNT(*) AS c FROM agent_audit_log WHERE entity = ? AND action = ?').get(entity, action) as { c: number }).c
const blockAuditWrites = () =>
  db.exec(`CREATE TRIGGER block_audit BEFORE INSERT ON agent_audit_log BEGIN SELECT RAISE(ABORT, 'audit blocked'); END`)

describe('the dispatch guard', () => {
  it('is claimed by exactly one of two overlapping dispatchers', async () => {
    await createKanbanCard({ id: 'c1', title: 'Card', assignee: 'agent-a' })
    const results = await Promise.all([markKanbanCardDispatched('c1'), markKanbanCardDispatched('c1')])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await getKanbanCard('c1'))?.dispatched_at).not.toBeNull()
  })

  it('is false for a card that does not exist and for a card already claimed', async () => {
    expect(await markKanbanCardDispatched('nope')).toBe(false)
    await createKanbanCard({ id: 'c1', title: 'Card' })
    expect(await markKanbanCardDispatched('c1')).toBe(true)
    expect(await markKanbanCardDispatched('c1')).toBe(false)
  })

  it('can be claimed again once it was released (a wake-up that could not be sent)', async () => {
    await createKanbanCard({ id: 'c1', title: 'Card' })
    expect(await markKanbanCardDispatched('c1')).toBe(true)
    await releaseKanbanCardDispatch('c1')
    expect((await getKanbanCard('c1'))?.dispatched_at).toBeNull()
    expect(await markKanbanCardDispatched('c1')).toBe(true)
  })
})

describe('createKanbanSubtasks (auto-breakdown)', () => {
  const subtasks = [
    { title: 'First', description: 'a', assignee: 'agent-a', priority: 'high' },
    { title: 'Second', description: 'b', assignee: null, priority: 'normal' },
  ]

  it('writes the subtasks under the parent, with its tenant and project, and one summary comment', async () => {
    await createKanbanCard({ id: 'p1', title: 'Parent', project: 'proj', tenant_id: 'default' })
    const ids = await createKanbanSubtasks('p1', subtasks, 'bot')
    expect(ids).toHaveLength(2)
    const children = await getChildCards('p1')
    expect(children.map((c) => c.id).sort()).toEqual([...ids].sort())
    expect(children.every((c) => c.project === 'proj' && c.depth === 1)).toBe(true)
    const comments = await getKanbanComments('p1')
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({ author: 'bot' })
    expect(comments[0].content).toContain(ids.join(', '))
    expect(auditRows('kanban', 'create')).toBe(3) // the parent and the two subtasks
  })

  it('leaves no child and no comment when one subtask fails', async () => {
    await createKanbanCard({ id: 'p1', title: 'Parent' })
    db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON kanban_cards WHEN NEW.title = 'Second' BEGIN SELECT RAISE(ABORT, 'insert blocked'); END`)
    await expect(createKanbanSubtasks('p1', subtasks, 'bot')).rejects.toThrow(/insert blocked/)
    expect(await getChildCards('p1')).toHaveLength(0)
    expect(await getKanbanComments('p1')).toHaveLength(0)
  })

  it('keeps the subtasks when an audit write fails (the failure is logged, not rethrown)', async () => {
    await createKanbanCard({ id: 'p1', title: 'Parent' })
    blockAuditWrites()
    const ids = await createKanbanSubtasks('p1', subtasks, 'bot')
    expect(await getChildCards('p1')).toHaveLength(2)
    expect(await getKanbanComments('p1')).toHaveLength(1)
    expect(ids).toHaveLength(2)
  })

  it('throws for a parent that does not exist and writes nothing', async () => {
    await expect(createKanbanSubtasks('missing', subtasks, 'bot')).rejects.toThrow(/Parent card not found/)
    expect((db.prepare('SELECT COUNT(*) AS c FROM kanban_cards').get() as { c: number }).c).toBe(0)
  })
})

describe('deleteKanbanCard and its audit', () => {
  it('commits the delete and its audit row together', async () => {
    await createKanbanCard({ id: 'c1', title: 'Card', assignee: 'agent-a' })
    expect(await deleteKanbanCard('c1')).toBe(true)
    expect(await getKanbanCard('c1')).toBeUndefined()
    expect(auditRows('kanban', 'delete')).toBe(1)
  })

  it('keeps the delete when the audit write fails', async () => {
    await createKanbanCard({ id: 'c1', title: 'Card' })
    blockAuditWrites()
    expect(await deleteKanbanCard('c1')).toBe(true)
    expect(await getKanbanCard('c1')).toBeUndefined()
    expect(auditRows('kanban', 'delete')).toBe(0)
  })

  it('writes no audit row for a card that does not exist', async () => {
    expect(await deleteKanbanCard('nope')).toBe(false)
    expect(auditRows('kanban', 'delete')).toBe(0)
  })
})

describe('markScheduledTaskKanbanWaiting (the fire-timeout watchdog)', () => {
  it('moves the active card with that title to waiting and returns its id', async () => {
    await createKanbanCard({ id: 'c1', title: 'nightly-backup', status: 'in_progress' })
    expect(await markScheduledTaskKanbanWaiting('nightly-backup')).toBe('c1')
    expect((await getKanbanCard('c1'))?.status).toBe('waiting')
  })

  it('returns null when no active card has that title', async () => {
    expect(await markScheduledTaskKanbanWaiting('nope')).toBeNull()
  })

  it('does not drag a card back into waiting when it left its status meanwhile (compare-and-set)', async () => {
    await createKanbanCard({ id: 'c1', title: 'nightly-backup', status: 'in_progress' })
    // The CAS the watchdog relies on: a move that expects the status it read is refused for a card that moved on.
    await moveKanbanCard('c1', 'done', 0, 'owner')
    expect(await moveKanbanCard('c1', 'waiting', 0, 'scheduler', undefined, { expectedStatus: 'in_progress' })).toBe(false)
    expect((await getKanbanCard('c1'))?.status).toBe('done')
    // Overlapping with a move to done, the watchdog either runs first (the done move wins afterwards) or loses the CAS.
    await createKanbanCard({ id: 'c2', title: 'other-task', status: 'in_progress' })
    await Promise.all([moveKanbanCard('c2', 'done', 0, 'owner'), markScheduledTaskKanbanWaiting('other-task')])
    expect((await getKanbanCard('c2'))?.status).toBe('done')
  })
})
