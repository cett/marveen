// The retention sweep also covers the three journals that had no cleanup: approval_events, import_audit_log and
// restore_log. They go with the audit window (AUDIT_LOG_RETENTION_DAYS), in the same transaction as the rest and the
// journal row, and approval_events (read by the OTLP log export by cursor) reports how many of the rows it lost the
// cursor had not yet passed. kanban_card_events is NOT pruned (owner decision): the card timeline and the card token
// cost read it, so even a very old event survives the sweep.
//
// Privacy: neutral fixtures only (agent-a, card-a, approval-a, source-a).
import { describe, it, expect } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { getDb, getKanbanCardEvents, pruneAuditLogs, setSystemConfig } from '../db.js'

useTestDb()

const DAY = 86400
const nowSec = () => Math.floor(Date.now() / 1000)
// The window is 90 days; a minute either side of the cut keeps the clock out of the assertions.
const OLD = () => nowSec() - 90 * DAY - 60
const KEPT = () => nowSec() - 90 * DAY + 60

function count(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}

function insertApproval(createdAt: number): number {
  return Number(getDb().prepare("INSERT INTO approval_events (approval_id, tenant_id, event, created_at) VALUES ('approval-a', 'default', 'requested', ?)").run(createdAt).lastInsertRowid)
}
function insertKanban(createdAt: number): number {
  return Number(getDb().prepare("INSERT INTO kanban_card_events (card_id, from_status, to_status, actor, created_at) VALUES ('card-a', NULL, 'planned', 'agent-a', ?)").run(createdAt).lastInsertRowid)
}
function insertSource(): void {
  getDb().prepare("INSERT INTO import_sources (id, type, path, label, interval_hours, enabled, created_at, updated_at) VALUES ('source-a', 'local', '/x', 'a', 24, 1, 1, 1)").run()
}
function insertImportRun(runAt: number): void {
  getDb().prepare("INSERT INTO import_audit_log (source_id, run_at) VALUES ('source-a', ?)").run(runAt)
}
function insertRestore(restoredAt: number): void {
  getDb().prepare("INSERT INTO restore_log (archive_path, integrity_ok, restored_at) VALUES ('archive-a', 1, ?)").run(restoredAt)
}
function setCursor(source: string, lastId: number): void {
  getDb().prepare('INSERT INTO otel_logs_export_state (source, last_id) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET last_id = excluded.last_id').run(source, lastId)
}

describe('the three journals are pruned to the audit window', () => {
  it('deletes the rows older than the window and keeps the rest, per table', async () => {
    insertSource()
    insertApproval(OLD()); insertApproval(OLD()); insertApproval(KEPT()); insertApproval(nowSec())
    insertImportRun(OLD()); insertImportRun(OLD()); insertImportRun(OLD()); insertImportRun(nowSec())
    insertRestore(OLD()); insertRestore(KEPT())

    const r = await pruneAuditLogs()

    expect(r.deleted.approval_events).toBe(2)
    expect(r.deleted.import_audit_log).toBe(3)
    expect(r.deleted.restore_log).toBe(1)
    expect(count('approval_events')).toBe(2)
    expect(count('import_audit_log')).toBe(1)
    expect(count('restore_log')).toBe(1)
  })

  it('uses each table\'s own time column (a fresh run_at / restored_at is kept even with old ids)', async () => {
    insertSource()
    insertImportRun(nowSec()); insertImportRun(OLD())
    insertRestore(nowSec()); insertRestore(OLD())
    await pruneAuditLogs()
    expect(count('import_audit_log')).toBe(1)
    expect(count('restore_log')).toBe(1)
    const left = getDb().prepare('SELECT run_at FROM import_audit_log').get() as { run_at: number }
    expect(left.run_at).toBeGreaterThan(nowSec() - 60)
  })

  it('follows AUDIT_LOG_RETENTION_DAYS: a shorter window removes what the default kept', async () => {
    insertApproval(nowSec() - 10 * DAY)
    const keep = await pruneAuditLogs()
    expect(keep.deleted.approval_events).toBe(0)
    await setSystemConfig('AUDIT_LOG_RETENTION_DAYS', '5', 'db')
    const cut = await pruneAuditLogs()
    expect(cut.cutoffDays).toBe(5)
    expect(cut.deleted.approval_events).toBe(1)
  })

  it('reports the new tables with a zero count on an empty database', async () => {
    const r = await pruneAuditLogs()
    for (const t of ['approval_events', 'import_audit_log', 'restore_log']) expect(r.deleted[t]).toBe(0)
    expect(r.unexportedLogsDeleted).toEqual({ approval_events: 0 })
  })
})

describe('kanban_card_events is not pruned', () => {
  it('every event survives the sweep, a 200-day-old one and one 91 days old included', async () => {
    insertKanban(nowSec() - 200 * DAY); insertKanban(OLD()); insertKanban(KEPT()); insertKanban(nowSec())
    const r = await pruneAuditLogs()
    expect(count('kanban_card_events')).toBe(4)
    expect(Object.keys(r.deleted)).not.toContain('kanban_card_events')
    expect(Object.keys(r.unexportedLogsDeleted)).not.toContain('kanban_card_events')
  })

  it('stays out of the journal row and survives with an export cursor and a short window too', async () => {
    const k = insertKanban(nowSec() - 200 * DAY)
    setCursor('kanban_card_events', k - 1)
    await setSystemConfig('AUDIT_LOG_RETENTION_DAYS', '5', 'db')
    await pruneAuditLogs()
    expect(count('kanban_card_events')).toBe(1)
    const row = getDb().prepare("SELECT detail FROM agent_audit_log WHERE action = 'retention_prune'").get() as { detail: string }
    const detail = JSON.parse(row.detail)
    expect(Object.keys(detail.tables)).not.toContain('kanban_card_events')
    expect(Object.keys(detail.unexported_logs_deleted)).not.toContain('kanban_card_events')
  })

  it('the event timeline of an old card still reads in full', async () => {
    insertKanban(nowSec() - 300 * DAY)
    await pruneAuditLogs()
    const events = await getKanbanCardEvents('card-a')
    expect(events).toHaveLength(1)
  })
})

describe('the rows the OTLP log cursor had not passed', () => {
  it('without a cursor row every deleted row counts as never exported', async () => {
    insertApproval(OLD()); insertApproval(OLD()); insertApproval(KEPT())
    const r = await pruneAuditLogs()
    expect(r.unexportedLogsDeleted).toEqual({ approval_events: 2 })
  })

  it('only the rows above the cursor count; the ones it already passed were exported', async () => {
    const a = insertApproval(OLD()); const b = insertApproval(OLD()); insertApproval(OLD())
    setCursor('approval_events', b)
    expect(a).toBeLessThan(b)
    const r = await pruneAuditLogs()
    expect(r.deleted.approval_events).toBe(3)
    expect(r.unexportedLogsDeleted).toEqual({ approval_events: 1 })
  })

  it('a cursor at or beyond the last old row means nothing was lost', async () => {
    insertApproval(OLD()); const last = insertApproval(OLD())
    setCursor('approval_events', last + 10)
    const r = await pruneAuditLogs()
    expect(r.deleted.approval_events).toBe(2)
    expect(r.unexportedLogsDeleted.approval_events).toBe(0)
  })

  it('a young row above the cursor is not counted: only rows the cut removes are', async () => {
    insertApproval(OLD()); insertApproval(nowSec()); insertApproval(KEPT())
    setCursor('approval_events', 0)
    const r = await pruneAuditLogs()
    expect(r.unexportedLogsDeleted.approval_events).toBe(1)
  })

  it('the journal row carries the counts', async () => {
    insertApproval(OLD())
    await pruneAuditLogs()
    const row = getDb().prepare("SELECT detail FROM agent_audit_log WHERE action = 'retention_prune'").get() as { detail: string }
    const detail = JSON.parse(row.detail)
    expect(detail.unexported_logs_deleted).toEqual({ approval_events: 1 })
    expect(detail.tables.approval_events).toBe(1)
    expect(detail.tables.import_audit_log).toBe(0)
    expect(detail.tables.restore_log).toBe(0)
  })
})

describe('one transaction', () => {
  it('rolls the new deletes back with the rest when the journal row cannot be written', async () => {
    insertSource()
    insertApproval(OLD()); insertKanban(OLD()); insertImportRun(OLD()); insertRestore(OLD())
    getDb().exec(`CREATE TRIGGER block_prune_row BEFORE INSERT ON agent_audit_log WHEN NEW.action = 'retention_prune'
                  BEGIN SELECT RAISE(ABORT, 'journal refused'); END`)
    await expect(pruneAuditLogs()).rejects.toThrow(/journal refused/)
    expect(count('approval_events')).toBe(1)
    expect(count('kanban_card_events')).toBe(1)
    expect(count('import_audit_log')).toBe(1)
    expect(count('restore_log')).toBe(1)
  })
})
