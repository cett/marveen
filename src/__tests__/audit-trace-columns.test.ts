// Migration 0088 and the central audit writers: every journal row carries the trace of the context it was written in
// (NULL outside any traced context), and the value is the server's own (the context), never an argument.
//
// Privacy: neutral fixtures only (agent-a, user-a, card-a, task-a).

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { applyMigrations } from '../db-migrations.js'
import {
  dbx, writeAgentAuditLog, writeAdminAuditLog, insertHookAuditLog, logConfigChange, insertRbacShadowRow,
  recordApprovalEvent, insertBlackboardHistory, createKanbanCard, moveKanbanCard, propagateStatus,
} from '../db.js'
import { runAs, withTrace } from '../db/context.js'
import { systemJob, runAsAgentJob } from '../db/background-jobs.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const TABLES = [
  'agent_audit_log', 'hook_audit_log', 'approval_events', 'rbac_shadow_log', 'config_change_log',
  'fleet_blackboard_history', 'kanban_card_events',
] as const
type Table = (typeof TABLES)[number]

const T1 = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
let seq = 0
const uniq = (p: string) => `${p}-${++seq}`

// One writer per journal table, through the public function the application uses.
const WRITERS: Array<{ table: Table; name: string; write: () => Promise<unknown> }> = [
  { table: 'agent_audit_log', name: 'writeAgentAuditLog', write: () => writeAgentAuditLog({ agent_id: 'agent-a', entity: 'memory', action: 'create', entity_id: uniq('m'), tenant_id: 'default' }) },
  { table: 'agent_audit_log', name: 'writeAdminAuditLog', write: () => writeAdminAuditLog('user-a', 'tenant_create', uniq('t'), { k: 'v' }) },
  { table: 'hook_audit_log', name: 'insertHookAuditLog', write: () => insertHookAuditLog({ agent_id: 'agent-a', hook_type: 'pre', verdict: 'allow', session_id: uniq('s') }) },
  { table: 'approval_events', name: 'recordApprovalEvent', write: () => recordApprovalEvent({ approval_id: uniq('ap'), event: 'consumed' }) },
  {
    table: 'rbac_shadow_log', name: 'insertRbacShadowRow',
    write: () => insertRbacShadowRow({ ts: 1_800_000_000, tenantId: 'default', principalKind: 'user', principal: 'user-a', role: 'viewer', method: 'GET', route: '/api/x', permission: 'x:read', decision: 'would-deny', reason: uniq('r') }),
  },
  { table: 'config_change_log', name: 'logConfigChange', write: () => logConfigChange(uniq('key'), 'old', 'new', 'user-a') },
  { table: 'fleet_blackboard_history', name: 'insertBlackboardHistory', write: () => insertBlackboardHistory({ agent_id: 'agent-a', task_ref: null, status: 'active', summary: uniq('sum') }) },
  { table: 'kanban_card_events', name: 'createKanbanCard (straight into in_progress)', write: () => createKanbanCard({ id: uniq('card-a'), title: 'x', status: 'in_progress' }) },
  {
    table: 'kanban_card_events', name: 'moveKanbanCard (single card)',
    write: async () => {
      const id = uniq('card-a')
      await createKanbanCard({ id, title: 'x' })
      return moveKanbanCard(id, 'in_progress', 0, 'user-a')
    },
  },
  {
    table: 'kanban_card_events', name: 'moveKanbanCard (whole column order, inside a transaction)',
    write: async () => {
      const id = uniq('card-a')
      await createKanbanCard({ id, title: 'x' })
      return moveKanbanCard(id, 'in_progress', 0, 'user-a', [id])
    },
  },
  {
    table: 'kanban_card_events', name: 'propagateStatus (the parent follows its done children)',
    write: async () => {
      const parent = uniq('card-p')
      const child = uniq('card-c')
      await createKanbanCard({ id: parent, title: 'x' })
      await createKanbanCard({ id: child, title: 'x', parent_id: parent, status: 'done' })
      await propagateStatus(child)
    },
  },
  {
    table: 'kanban_card_events', name: 'propagateStatus (a done parent reverts when a child is not done)',
    write: async () => {
      const parent = uniq('card-p')
      const done = uniq('card-c')
      const open = uniq('card-c')
      await createKanbanCard({ id: parent, title: 'x' })
      await createKanbanCard({ id: done, title: 'x', parent_id: parent, status: 'done' })
      await propagateStatus(done)
      await createKanbanCard({ id: open, title: 'x', parent_id: parent })
      await propagateStatus(open)
    },
  },
]

const newest = (table: Table) => dbx.get<{ trace_id: string | null; span_id: string | null }>(`SELECT trace_id, span_id FROM ${table} ORDER BY rowid DESC LIMIT 1`)

describe('migration 0088', () => {
  it('adds a nullable trace_id and span_id to the seven journal tables, with no default', async () => {
    for (const table of TABLES) {
      const cols = (await dbx.all(`PRAGMA table_info(${table})`)) as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>
      for (const name of ['trace_id', 'span_id']) {
        const c = cols.find((x) => x.name === name)
        expect(c, `${table}.${name}`).toBeDefined()
        expect(c).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
      }
    }
  })

  it('is nothing but plain ADD COLUMN statements (the runner tolerates a half-applied run only for those)', () => {
    const sql = readFileSync(new URL('../migrations/0088_audit_trace_columns.sql', import.meta.url), 'utf8')
    const statements = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)
    expect(statements).toHaveLength(14)
    for (const s of statements) expect(s).toMatch(/^ALTER TABLE [a-z_]+ ADD COLUMN (trace_id|span_id) TEXT$/)
    // every table of the list, both columns, once
    expect(new Set(statements).size).toBe(14)
    for (const t of TABLES) for (const c of ['trace_id', 'span_id']) expect(statements).toContain(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`)
  })

  it('runs again over a half-applied database without an error and keeps the old rows NULL', () => {
    const db = new Database(':memory:')
    try {
      applyMigrations(db)
      db.prepare("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ('k', 'a', 'b', 'user-a', 1)").run()
      db.prepare('DELETE FROM schema_version WHERE version = 88').run()
      expect(() => applyMigrations(db)).not.toThrow()
      expect(db.prepare('SELECT 1 FROM schema_version WHERE version = 88').get()).toBeTruthy()
      expect(db.prepare('SELECT trace_id, span_id FROM config_change_log').get()).toEqual({ trace_id: null, span_id: null })
    } finally {
      db.close()
    }
  })
})

describe('the central writers fill the trace columns from the context', () => {
  for (const { table, name, write } of WRITERS) {
    it(`${name} -> ${table}: the traced context's ids, NULL without a trace, NULL without any context`, async () => {
      await runAs.system('job-a', () => withTrace(T1, write))
      expect(await newest(table)).toEqual({ trace_id: T1.traceId, span_id: T1.spanId })

      await runAs.system('job-a', write)
      expect(await newest(table)).toEqual({ trace_id: null, span_id: null })

      await write()
      expect(await newest(table)).toEqual({ trace_id: null, span_id: null })
    })
  }

  it('a nested runAs (another identity) inside a traced request writes the same trace', async () => {
    const w = WRITERS.find((x) => x.name === 'writeAgentAuditLog')!
    await runAs.system('job-a', () => withTrace(T1, () => runAs.tenant('tenant-a', w.write)))
    expect(await newest('agent_audit_log')).toEqual({ trace_id: T1.traceId, span_id: T1.spanId })
  })

  // A job is not part of the request that created its timer (see the job openers in db/background-jobs.ts): the rows it
  // writes carry NULL, even when the opener is called from a traced request context.
  it('a writer inside a job opener writes NULL, called from a traced request; a plain nested runAs (the control) writes the trace', async () => {
    const w = WRITERS.find((x) => x.name === 'writeAgentAuditLog')!
    await runAs.system('job-a', () => withTrace(T1, () => runAs.system('job-b', w.write, { inheritTrace: false })))
    expect(await newest('agent_audit_log')).toEqual({ trace_id: null, span_id: null })

    await runAs.system('job-a', () => withTrace(T1, () => runAs.system('job-b', w.write)))
    expect(await newest('agent_audit_log')).toEqual({ trace_id: T1.traceId, span_id: T1.spanId })
  })

  it('the real openers (systemJob, runAsAgentJob) write NULL from a traced request context, on every journal table that has a writer', async () => {
    for (const { table, name, write } of WRITERS) {
      await runAs.tenant('tenant-a', () => withTrace(T1, async () => { await systemJob('message-router', write)() }))
      expect(await newest(table), `${name} via systemJob`).toEqual({ trace_id: null, span_id: null })

      await runAs.tenant('tenant-a', () => withTrace(T1, () => runAsAgentJob('auto-restart', 'agent-a', write)))
      expect(await newest(table), `${name} via runAsAgentJob`).toEqual({ trace_id: null, span_id: null })
    }
  })

  it('a write after an await inside the traced context still carries the trace', async () => {
    await runAs.system('job-a', () => withTrace(T1, async () => {
      await new Promise((r) => setTimeout(r, 2))
      await logConfigChange(uniq('key'), null, 'v', 'user-a')
    }))
    expect(await newest('config_change_log')).toEqual({ trace_id: T1.traceId, span_id: T1.spanId })
  })

  it('every journal table has a writer in this list (a new writer of one of them must not be missed)', () => {
    expect(new Set(WRITERS.map((w) => w.table))).toEqual(new Set(TABLES))
  })
})

describe('the RBAC gate decision row is written inside the request trace', () => {
  it('the dashboard handler runs runRbacGate in withTrace(requestTrace), before the route context opens', () => {
    const src = readFileSync(new URL('../web.ts', import.meta.url), 'utf8')
    expect(src).toContain('withTrace(requestTrace, () => runRbacGate(auth, method, path, res, getRbacMode()))')
    // and the trace exists before it: assigned right after the auth gate, ahead of the RBAC gate
    expect(src.indexOf('const requestTrace = assignRequestTrace(')).toBeGreaterThan(0)
    expect(src.indexOf('const requestTrace = assignRequestTrace(')).toBeLessThan(src.indexOf('withTrace(requestTrace, () => runRbacGate('))
  })
})
