// The kanban audit entries are best effort: a failing audit write never undoes the card. The card delete and its
// audit entry are ONE facade transaction (the audit in its own savepoint); a card create writes its rows first and its
// entry second. Real in-memory database, no mocks. Each test names the line it protects in src/db/kanban.ts.
// (Kept under its old file name; the delete/breakdown/promote atomicity is pinned in kanban-facade-overlap.test.ts.)
import { describe, it, expect } from 'vitest'
import { useTestDb, testDbMode, testDdl } from './helpers/with-test-db.js'
import { refuseWrite } from './helpers/refuse-write.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'
import { dbx, createKanbanCard, deleteKanbanCard, getKanbanCard } from '../db.js'
import { insertKanbanCardRows, writeKanbanCreateAudit } from '../db/kanban.js'

useTestDb()

const auditRows = (action: string) =>
  dbx.all<{ agent_id: string; entity_id: string; detail: string }>(
    "SELECT agent_id, entity_id, detail FROM agent_audit_log WHERE entity = 'kanban' AND action = ? ORDER BY id", action,
  )
const blockAuditWrites = () => refuseWrite(dbx, { name: 'kanban_audit_blocked', table: 'agent_audit_log', message: 'blocked' })
// A delete that removes nothing and leaves the row: SQLite RAISE(IGNORE); PostgreSQL a BEFORE trigger that returns NULL.
const keepCard = async (): Promise<void> => {
  if (testDbMode() === 'pg') {
    await testDdl(dbx, 'CREATE FUNCTION keep_card_fn() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NULL; END $fn$')
    await testDdl(dbx, 'CREATE TRIGGER keep_card BEFORE DELETE ON kanban_cards FOR EACH ROW EXECUTE FUNCTION keep_card_fn()')
  } else {
    await testDdl(dbx, "CREATE TRIGGER keep_card BEFORE DELETE ON kanban_cards BEGIN SELECT RAISE(IGNORE); END")
  }
}

describe('createKanbanCard', () => {
  it('writes the card and exactly one create audit entry with the title, status and priority', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root', assignee: 'agent-a', priority: 'high' })
    expect((await getKanbanCard('c1'))?.title).toBe('Root')
    const rows = await auditRows('create')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'agent-a', entity_id: 'c1' })
    expect(JSON.parse(rows[0].detail)).toEqual({ title: 'Root', status: 'planned', priority: 'high' })
  })

  it('a failing audit write leaves the card in place and does not reject', async () => {
    await blockAuditWrites()
    await expect(createKanbanCard({ id: 'c1', title: 'Root' })).resolves.toBeUndefined()
    expect((await getKanbanCard('c1'))?.title).toBe('Root')
    expect(await auditRows('create')).toEqual([])
  })

  it('the synchronous half writes the rows and no audit entry; the entry it returns is written by the caller afterwards', async () => {
    const entry = await insertKanbanCardRows({ id: 'c1', title: 'Root', assignee: 'agent-a' })
    expect((await getKanbanCard('c1'))?.title).toBe('Root')
    expect(await auditRows('create')).toEqual([])
    await writeKanbanCreateAudit(entry)
    expect((await auditRows('create')).map((r) => r.entity_id)).toEqual(['c1'])
  })
})

describe('deleteKanbanCard', () => {
  it('deletes the card and writes one delete audit entry for the assignee, in the same transaction', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root', assignee: 'agent-a' })
    expect(await deleteKanbanCard('c1')).toBe(true)
    expect(await getKanbanCard('c1')).toBeUndefined()
    const rows = await auditRows('delete')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'agent-a', entity_id: 'c1' })
    expect(JSON.parse(rows[0].detail)).toEqual({ title: 'Root' })
  })

  it('a card that does not exist: false and no audit entry', async () => {
    expect(await deleteKanbanCard('missing')).toBe(false)
    expect(await auditRows('delete')).toEqual([])
  })

  it('a failing audit write does not undo the delete or reject, and leaves no audit row behind', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root' })
    await blockAuditWrites()
    await expect(deleteKanbanCard('c1')).resolves.toBe(true)
    expect(await getKanbanCard('c1')).toBeUndefined()
    expect(await auditRows('delete')).toEqual([])
  })

  // Holder cell (PostgreSQL, two real connections): the first delete is parked after its card delete and audit entry.
  // The second delete waits on the card row, finds nothing once the first one commits, and writes no audit entry of its own.
  it.runIf(testDbMode() === 'pg')('two overlapping deletes of the same card: one true, one false, exactly one audit entry (two real connections)', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root', assignee: 'agent-a' })
    const il = interleave()
    il.hold('first-delete-parked')
    const holder = dbx.tx(async (tx) => {
      await tx.run('DELETE FROM kanban_cards WHERE id = ?', 'c1')
      await tx.run(
        "INSERT INTO agent_audit_log (agent_id, entity, action, entity_id, detail, created_at) VALUES ('agent-a', 'kanban', 'delete', 'c1', ?, ?)",
        JSON.stringify({ title: 'Root' }), Math.floor(Date.now() / 1000),
      )
      await il.pass('first-delete-parked')
    })
    await il.reached('first-delete-parked')
    const waiting = deleteKanbanCard('c1')
    try {
      await waitBlockedOnLock(dbx, 1, 'pg')
    } finally {
      il.open('first-delete-parked')
      await holder
    }
    expect(await waiting).toBe(false)
    expect((await auditRows('delete')).map((r) => r.entity_id)).toEqual(['c1'])
  })

  // Weak (end state, both engines): a second delete of a card that is gone returns false and writes no audit entry.
  it('a second delete of a card that is already gone: false and no second audit entry', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root', assignee: 'agent-a' })
    expect(await deleteKanbanCard('c1')).toBe(true)
    expect(await deleteKanbanCard('c1')).toBe(false)
    expect((await auditRows('delete')).map((r) => r.entity_id)).toEqual(['c1'])
  })

  it('a delete that removes 0 rows returns false and writes no audit entry', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root' })
    await keepCard()
    expect(await deleteKanbanCard('c1')).toBe(false)
    expect((await getKanbanCard('c1'))?.title).toBe('Root')
    expect(await auditRows('delete')).toEqual([])
  })

  it('a card without an assignee is audited as system', async () => {
    await createKanbanCard({ id: 'c1', title: 'Root' })
    await deleteKanbanCard('c1')
    expect((await auditRows('delete')).map((r) => r.agent_id)).toEqual(['system'])
  })
})
