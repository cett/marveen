// OTLP log records carry the trace and span of the request they were written in, as LogRecord fields, through the
// same id mapping the span export uses. The key test: a record and the http.server span of the same request share
// one OTLP trace id and span id.
//
// Privacy: neutral fixtures only (agent-a, user-a, card-a, task-a).

import { describe, it, expect } from 'vitest'
import {
  getOtelLogBatch, upsertOtelSpan, closeOtelSpan, getOtelTrace,
  writeAgentAuditLog, insertHookAuditLog, logConfigChange, insertRbacShadowRow, recordApprovalEvent, insertBlackboardHistory, createKanbanCard,
} from '../db.js'
import { runAs, withTrace } from '../db/context.js'
import { spansToOtelJson } from '../otel-exporter.js'
import { toHexId } from '../otel-ids.js'
import { mapLogBatch, logsToOtelJson, traceFields, appLogsToRecords, type OtelLogRecord } from '../otel-logs.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const SERVER_TRACE = { traceId: 'a1'.repeat(16), spanId: 'b2'.repeat(8) } // a server-generated request id
const HEX = '4bf92f3577b34da6a3ce929d0e0e4736'
const W3C_TRACE = { traceId: `w3c-${HEX}`, spanId: 'c3'.repeat(8) } // a traceparent that came with credentials
const SALT = 'salt-for-tests'

const traced = <T>(t: { traceId: string; spanId: string } | null, fn: () => Promise<T>) =>
  runAs.system('job-a', () => (t ? withTrace(t, fn) : fn()))

// One write per exported source, through the application's writers. `n` keeps the rows apart.
const WRITES: Array<[string, (n: number) => Promise<unknown>]> = [
  ['approval_events', (n) => recordApprovalEvent({ approval_id: `ap-${n}`, event: 'consumed' })],
  ['rbac_shadow_log', (n) => insertRbacShadowRow({ ts: 1_800_000_000, tenantId: 'default', principalKind: 'user', principal: 'user-a', role: 'viewer', method: 'GET', route: `/api/x/${n}`, permission: 'x:read', decision: 'would-deny', reason: 'role_lacks_permission' })],
  ['config_change_log', (n) => logConfigChange(`key-${n}`, 'old', 'new', 'user-a')],
  ['agent_audit_log', (n) => writeAgentAuditLog({ agent_id: 'agent-a', entity: 'memory', action: 'create', entity_id: `m-${n}`, tenant_id: 'default' })],
  ['hook_audit_log', (n) => insertHookAuditLog({ agent_id: 'agent-a', hook_type: 'pre', verdict: 'deny', reason: 'blocked', session_id: `s-${n}` })],
  ['fleet_blackboard_history', (n) => insertBlackboardHistory({ agent_id: 'agent-a', task_ref: null, status: 'active', summary: `sum-${n}` })],
  ['kanban_card_events', (n) => createKanbanCard({ id: `card-a-${n}`, title: 'x', status: 'in_progress' })],
]

async function exported(): Promise<OtelLogRecord[]> {
  return mapLogBatch(await getOtelLogBatch(100), SALT).records
}
// createKanbanCard also writes an agent_audit_log row (its own audit), so the kanban source is picked by its event name.
const only = (records: OtelLogRecord[], source: string) =>
  source === 'kanban_card_events' ? records.filter((r) => r.body.stringValue === 'marveen.kanban.card.moved') : records

/** Seeds the cursors at the current heads (the export starts after the existing rows), then runs the writes. */
async function withFreshCursors(writes: () => Promise<void>): Promise<OtelLogRecord[]> {
  await getOtelLogBatch(1) // creates every cursor at the current highest id
  await writes()
  return exported()
}

describe('a log record of a traced row carries the trace fields', () => {
  for (const [source, write] of WRITES) {
    it(`${source}: traceId / spanId are the OTLP ids of the stored trace`, async () => {
      const records = only(await withFreshCursors(async () => { await traced(SERVER_TRACE, () => write(1)) }), source)
      expect(records).toHaveLength(1)
      expect(records[0].traceId).toBe(toHexId(SERVER_TRACE.traceId, 16, true))
      expect(records[0].spanId).toBe(toHexId(SERVER_TRACE.spanId, 8))
      expect(records[0].traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(records[0].spanId).toMatch(/^[0-9a-f]{16}$/)
    })

    it(`${source}: a row written without a trace has no trace fields`, async () => {
      const records = only(await withFreshCursors(async () => { await traced(null, () => write(2)) }), source)
      expect(records).toHaveLength(1)
      expect(records[0]).not.toHaveProperty('traceId')
      expect(records[0]).not.toHaveProperty('spanId')
    })
  }

  it('the ids are record FIELDS, not attributes, and the raw stored id never leaves', async () => {
    const records = await withFreshCursors(async () => {
      await traced(W3C_TRACE, () => logConfigChange('key-a', 'old', 'new', 'user-a'))
      await traced(SERVER_TRACE, () => logConfigChange('key-b', 'old', 'new', 'user-a'))
    })
    const json = JSON.stringify(logsToOtelJson(records, 'ns', 'inst'))
    for (const raw of [W3C_TRACE.traceId, W3C_TRACE.spanId, SERVER_TRACE.traceId, SERVER_TRACE.spanId]) expect(json).not.toContain(`"${raw}"`)
    expect(json).not.toContain('w3c-')
    for (const r of records) expect(r.attributes.map((a) => a.key).filter((k) => /trace|span/i.test(k))).toEqual([])
  })
})

describe('a log record and the http.server span of one request share one OTLP trace', () => {
  async function spanJson(trace: { traceId: string; spanId: string }) {
    // what recordHttpRequest writes for a failed or slow request
    await upsertOtelSpan({ trace_id: trace.traceId, span_id: trace.spanId, parent_span_id: null, agent_id: 'dashboard', operation: 'http.server', start_ms: 1000, attributes: null })
    await closeOtelSpan(trace.traceId, trace.spanId, 2000, 'error')
    const spans = await getOtelTrace(trace.traceId)
    const out = spansToOtelJson(spans, 'ns')
    return (out.resourceSpans[0] as any).scopeSpans[0].spans[0] as { traceId: string; spanId: string }
  }

  for (const [label, trace] of [['a server-generated id', SERVER_TRACE], ['a w3c- id from a traceparent', W3C_TRACE]] as const) {
    it(`${label}: the record's traceId and spanId equal the span's`, async () => {
      const span = await spanJson(trace)
      const records = await withFreshCursors(async () => { await traced(trace, () => logConfigChange('key-a', 'old', 'new', 'user-a')) })
      expect(records).toHaveLength(1)
      expect(records[0].traceId).toBe(span.traceId)
      expect(records[0].spanId).toBe(span.spanId)
    })
  }

  it('a w3c- trace goes out as the traceparent\'s own hex, which is the id the caller knows', async () => {
    const records = await withFreshCursors(async () => { await traced(W3C_TRACE, () => logConfigChange('key-a', 'old', 'new', 'user-a')) })
    expect(records[0].traceId).toBe(HEX)
  })
})

describe('traceFields', () => {
  it('has no trace without a trace id, also when a span id is there (a span alone is no valid correlation)', () => {
    expect(traceFields({ trace_id: null, span_id: 'x' })).toEqual({})
    expect(traceFields({ trace_id: '', span_id: 'x' })).toEqual({})
    expect(traceFields({ trace_id: null, span_id: null })).toEqual({})
  })

  it('has a trace id alone when the span id is missing', () => {
    expect(traceFields({ trace_id: 'session-a', span_id: null })).toEqual({ traceId: toHexId('session-a', 16, true) })
    expect(traceFields({ trace_id: 'session-a', span_id: '' })).toEqual({ traceId: toHexId('session-a', 16, true) })
  })

  it('hashes a w3c- value that is not a well-formed 32 hex id instead of passing it through', () => {
    for (const bad of ['w3c-short', `w3c-${HEX.toUpperCase()}`, `w3c-${HEX}00`, 'w3c-']) {
      const out = traceFields({ trace_id: bad, span_id: null })
      expect(out.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(out.traceId).toBe(toHexId(bad, 16))
      expect(out.traceId).not.toBe(bad.slice(4))
    }
  })

  it('maps an agent session id like the session spans do (sha256 prefix)', () => {
    expect(traceFields({ trace_id: 'session-a', span_id: 'span-a' })).toEqual({ traceId: toHexId('session-a', 16), spanId: toHexId('span-a', 8) })
  })
})

describe('the application-log records are untouched', () => {
  it('carry no trace fields (they get their own card)', () => {
    const [r] = appLogsToRecords([{ level: 50, message: 'boom', exceptionType: null, errorCode: null, count: 1, firstMs: 1000 } as never])
    expect(r).not.toHaveProperty('traceId')
  })
})

describe('the export still reads no content column', () => {
  it('the batch rows hold the two trace columns and nothing new besides', async () => {
    await getOtelLogBatch(1)
    await traced(SERVER_TRACE, () => logConfigChange('key-a', 'secret-old-value', 'secret-new-value', 'user-a'))
    const batch = await getOtelLogBatch(10)
    expect(Object.keys(batch.config_change_log[0]).sort()).toEqual(['actor', 'created_at', 'id', 'key', 'span_id', 'trace_id'])
    expect(JSON.stringify(batch)).not.toContain('secret-')
  })
})

