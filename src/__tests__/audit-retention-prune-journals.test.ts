// The retention sweep also covers the three journals that had no cleanup: approval_events, import_audit_log and
// restore_log. import_audit_log and restore_log go with the audit window (AUDIT_LOG_RETENTION_DAYS, 90 days);
// approval_events, the security journal, has its OWN window (APPROVAL_EVENTS_RETENTION_DAYS, 365 days). All are
// deleted in the same transaction as the rest and the journal row, and approval_events (read by the OTLP log export
// by cursor) reports how many of the rows it lost the cursor had not yet passed, counted with the approval cut.
// kanban_card_events is NOT pruned (owner decision): the card timeline and the card token cost read it, so even a
// very old event survives the sweep.
//
// Privacy: neutral fixtures only (agent-a, card-a, approval-a, source-a).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useTestDb } from './helpers/with-test-db.js'
import { getDb, getKanbanCardEvents, pruneAuditLogs, setSystemConfig } from '../db.js'
import { getSettingDefinition, validateSettingValue } from '../config-registry.js'

useTestDb()

const DAY = 86400
const nowSec = () => Math.floor(Date.now() / 1000)
// The audit window is 90 days and the approval window 365; a minute either side of the cut keeps the clock out of
// the assertions. OLD / KEPT are for the audit-window tables, A_OLD / A_KEPT for approval_events.
const OLD = () => nowSec() - 90 * DAY - 60
const KEPT = () => nowSec() - 90 * DAY + 60
const A_OLD = () => nowSec() - 365 * DAY - 60
const A_KEPT = () => nowSec() - 365 * DAY + 60

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

describe('the three journals are pruned to their windows', () => {
  it('deletes the rows older than the window and keeps the rest, per table', async () => {
    insertSource()
    insertApproval(A_OLD()); insertApproval(A_OLD()); insertApproval(A_KEPT()); insertApproval(nowSec())
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

  it('a 100-day-old approval event survives while a 100-day-old import run and restore row are deleted', async () => {
    insertSource()
    insertApproval(nowSec() - 100 * DAY)
    insertImportRun(nowSec() - 100 * DAY)
    insertRestore(nowSec() - 100 * DAY)
    const r = await pruneAuditLogs()
    expect(r.deleted.approval_events).toBe(0)
    expect(r.deleted.import_audit_log).toBe(1)
    expect(r.deleted.restore_log).toBe(1)
    expect(count('approval_events')).toBe(1)
    expect(count('import_audit_log')).toBe(0)
    expect(count('restore_log')).toBe(0)
  })

  it('a 400-day-old approval event is deleted by the default window', async () => {
    insertApproval(nowSec() - 400 * DAY)
    const r = await pruneAuditLogs()
    expect(r.deleted.approval_events).toBe(1)
    expect(count('approval_events')).toBe(0)
  })

  it('import and restore follow AUDIT_LOG_RETENTION_DAYS: a shorter window removes what the default kept', async () => {
    insertSource()
    insertImportRun(nowSec() - 10 * DAY); insertRestore(nowSec() - 10 * DAY)
    const keep = await pruneAuditLogs()
    expect(keep.deleted.import_audit_log).toBe(0)
    expect(keep.deleted.restore_log).toBe(0)
    await setSystemConfig('AUDIT_LOG_RETENTION_DAYS', '5', 'db')
    const cut = await pruneAuditLogs()
    expect(cut.cutoffDays).toBe(5)
    expect(cut.deleted.import_audit_log).toBe(1)
    expect(cut.deleted.restore_log).toBe(1)
  })

  it('approval_events does NOT follow AUDIT_LOG_RETENTION_DAYS: a short audit window leaves a 100-day-old event', async () => {
    insertApproval(nowSec() - 100 * DAY)
    await setSystemConfig('AUDIT_LOG_RETENTION_DAYS', '5', 'db')
    const r = await pruneAuditLogs()
    expect(r.cutoffDays).toBe(5)
    expect(r.approvalCutoffDays).toBe(365)
    expect(r.deleted.approval_events).toBe(0)
    expect(count('approval_events')).toBe(1)
  })

  it('the approval cut moves with APPROVAL_EVENTS_RETENTION_DAYS: at 30 days the 100-day-old event goes', async () => {
    insertApproval(nowSec() - 100 * DAY); insertApproval(nowSec() - 10 * DAY)
    const keep = await pruneAuditLogs()
    expect(keep.deleted.approval_events).toBe(0)
    await setSystemConfig('APPROVAL_EVENTS_RETENTION_DAYS', '30', 'db')
    const cut = await pruneAuditLogs()
    expect(cut.approvalCutoffDays).toBe(30)
    expect(cut.deleted.approval_events).toBe(1)
    expect(count('approval_events')).toBe(1)
  })

  it('the approval cut is the clock minus the approval window, and the audit cut is untouched by it', async () => {
    await setSystemConfig('APPROVAL_EVENTS_RETENTION_DAYS', '30', 'db')
    const before = nowSec()
    const r = await pruneAuditLogs()
    const after = nowSec()
    expect(r.approvalCutoffTs).toBeGreaterThanOrEqual(before - 30 * DAY)
    expect(r.approvalCutoffTs).toBeLessThanOrEqual(after - 30 * DAY)
    expect(r.cutoffTs).toBeGreaterThanOrEqual(before - 90 * DAY)
    expect(r.cutoffTs).toBeLessThanOrEqual(after - 90 * DAY)
  })

  it('reports the new tables with a zero count on an empty database', async () => {
    const r = await pruneAuditLogs()
    for (const t of ['approval_events', 'import_audit_log', 'restore_log']) expect(r.deleted[t]).toBe(0)
    expect(r.unexportedLogsDeleted).toEqual({ approval_events: 0 })
  })
})

describe('the APPROVAL_EVENTS_RETENTION_DAYS setting', () => {
  const def = () => getSettingDefinition('APPROVAL_EVENTS_RETENTION_DAYS')!

  it('is registered in the audit module: int, default 365, 1 to 3650, not secret, no restart', () => {
    expect(def()).toBeDefined()
    expect(def().type).toBe('int')
    expect(def().default).toBe(365)
    expect(def().min).toBe(1)
    expect(def().max).toBe(3650)
    expect(def().module).toBe('audit')
    expect(def().secret).toBe(false)
    expect(def().requiresRestart).toBe(false)
  })

  it('accepts both bounds and rejects the values just outside them', () => {
    expect(validateSettingValue(def(), 1).ok).toBe(true)
    expect(validateSettingValue(def(), 3650).ok).toBe(true)
    expect(validateSettingValue(def(), 0).ok).toBe(false)
    expect(validateSettingValue(def(), 3651).ok).toBe(false)
    expect(validateSettingValue(def(), 'abc').ok).toBe(false)
  })

  it('the description no longer claims the approval events for the general audit window', () => {
    const audit = getSettingDefinition('AUDIT_LOG_RETENTION_DAYS')!.description
    expect(audit).toContain('APPROVAL_EVENTS_RETENTION_DAYS')
    expect(audit.split('Nem ide tartozik')[0]).not.toContain('jóváhagyási események')
  })

  it('both settings guides and both UI language files name the key', () => {
    const read = (p: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../..', p), 'utf-8')
    expect(read('docs/user-guide/en/11-settings.md')).toContain('| `APPROVAL_EVENTS_RETENTION_DAYS` |')
    expect(read('docs/user-guide/hu/11-beallitasok.md')).toContain('| `APPROVAL_EVENTS_RETENTION_DAYS` |')
    expect(read('web/lang/en.js')).toContain("'settings.desc.APPROVAL_EVENTS_RETENTION_DAYS'")
    expect(read('web/lang/hu.js')).toContain("'settings.desc.APPROVAL_EVENTS_RETENTION_DAYS'")
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
    await setSystemConfig('APPROVAL_EVENTS_RETENTION_DAYS', '1', 'db')
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
    insertApproval(A_OLD()); insertApproval(A_OLD()); insertApproval(A_KEPT())
    const r = await pruneAuditLogs()
    expect(r.unexportedLogsDeleted).toEqual({ approval_events: 2 })
  })

  it('only the rows above the cursor count; the ones it already passed were exported', async () => {
    const a = insertApproval(A_OLD()); const b = insertApproval(A_OLD()); insertApproval(A_OLD())
    setCursor('approval_events', b)
    expect(a).toBeLessThan(b)
    const r = await pruneAuditLogs()
    expect(r.deleted.approval_events).toBe(3)
    expect(r.unexportedLogsDeleted).toEqual({ approval_events: 1 })
  })

  it('a cursor at or beyond the last old row means nothing was lost', async () => {
    insertApproval(A_OLD()); const last = insertApproval(A_OLD())
    setCursor('approval_events', last + 10)
    const r = await pruneAuditLogs()
    expect(r.deleted.approval_events).toBe(2)
    expect(r.unexportedLogsDeleted.approval_events).toBe(0)
  })

  it('a young row above the cursor is not counted: only rows the cut removes are', async () => {
    insertApproval(A_OLD()); insertApproval(nowSec()); insertApproval(A_KEPT())
    setCursor('approval_events', 0)
    const r = await pruneAuditLogs()
    expect(r.unexportedLogsDeleted.approval_events).toBe(1)
  })

  it('the unexported count uses the approval cut, not the audit cut: a 100-day-old row above the cursor is not counted', async () => {
    insertApproval(nowSec() - 100 * DAY); insertApproval(A_OLD())
    setCursor('approval_events', 0)
    const r = await pruneAuditLogs()
    expect(r.deleted.approval_events).toBe(1)
    expect(r.unexportedLogsDeleted.approval_events).toBe(1)
  })

  it('the count follows APPROVAL_EVENTS_RETENTION_DAYS and equals what the delete removed', async () => {
    insertApproval(nowSec() - 100 * DAY); insertApproval(nowSec() - 100 * DAY); insertApproval(nowSec() - 5 * DAY)
    await setSystemConfig('APPROVAL_EVENTS_RETENTION_DAYS', '30', 'db')
    const r = await pruneAuditLogs()
    expect(r.deleted.approval_events).toBe(2)
    expect(r.unexportedLogsDeleted.approval_events).toBe(2)
  })

  it('the journal row carries the counts and the approval cut', async () => {
    insertApproval(A_OLD())
    const r = await pruneAuditLogs()
    const row = getDb().prepare("SELECT detail FROM agent_audit_log WHERE action = 'retention_prune'").get() as { detail: string }
    const detail = JSON.parse(row.detail)
    expect(detail.approval_cutoff_days).toBe(365)
    expect(detail.approval_cutoff_ts).toBe(r.approvalCutoffTs)
    expect(detail.cutoff_days).toBe(90)
    expect(detail.unexported_logs_deleted).toEqual({ approval_events: 1 })
    expect(detail.tables.approval_events).toBe(1)
    expect(detail.tables.import_audit_log).toBe(0)
    expect(detail.tables.restore_log).toBe(0)
  })
})

describe('one transaction', () => {
  it('rolls the new deletes back with the rest when the journal row cannot be written', async () => {
    insertSource()
    insertApproval(A_OLD()); insertKanban(OLD()); insertImportRun(OLD()); insertRestore(OLD())
    getDb().exec(`CREATE TRIGGER block_prune_row BEFORE INSERT ON agent_audit_log WHEN NEW.action = 'retention_prune'
                  BEGIN SELECT RAISE(ABORT, 'journal refused'); END`)
    await expect(pruneAuditLogs()).rejects.toThrow(/journal refused/)
    expect(count('approval_events')).toBe(1)
    expect(count('kanban_card_events')).toBe(1)
    expect(count('import_audit_log')).toBe(1)
    expect(count('restore_log')).toBe(1)
  })
})
