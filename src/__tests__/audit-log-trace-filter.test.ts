// GET /api/audit-log?trace_id=: the rows written in one trace, from the sources that keep a trace (config, agent, hook),
// with the trace on every returned row of those sources. Index 0089 serves the lookup.
//
// Privacy: neutral fixtures only (agent-a, user-a).

import { describe, it, expect, vi } from 'vitest'
import type http from 'node:http'
import { dbx, writeAgentAuditLog, insertHookAuditLog, logConfigChange, queryAuditLog } from '../db.js'
import { runAs, withTrace } from '../db/context.js'
import { tryHandleAuditLog } from '../web/routes/audit-log.js'
import type { RouteContext } from '../web/routes/types.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const TA = { traceId: 'a'.repeat(32), spanId: '1'.repeat(16) }
const TB = { traceId: 'w3c-' + 'b'.repeat(32), spanId: '2'.repeat(16) }

// Ids of the other shapes a trace_id column holds: a session-style id with every character the route lets through.
const TC = { traceId: 'sess:a.b_c-1', spanId: '3'.repeat(16) }
const TD = { traceId: 'abc', spanId: '4'.repeat(16) }

const inTrace = <T>(t: { traceId: string; spanId: string } | null, fn: () => Promise<T>) =>
  runAs.system('job-a', () => (t ? withTrace(t, fn) : fn()))

async function seed() {
  await inTrace(TA, () => writeAgentAuditLog({ agent_id: 'agent-a', entity: 'memory', action: 'create', entity_id: 'm-a', tenant_id: 'default' }))
  await inTrace(TA, () => insertHookAuditLog({ agent_id: 'agent-a', hook_type: 'pre', verdict: 'allow', session_id: 's-a' }))
  await inTrace(TA, () => logConfigChange('key-a', 'old', 'new', 'user-a'))
  await inTrace(TB, () => writeAgentAuditLog({ agent_id: 'agent-a', entity: 'memory', action: 'update', entity_id: 'm-b', tenant_id: 'default' }))
  await inTrace(null, () => writeAgentAuditLog({ agent_id: 'agent-a', entity: 'memory', action: 'delete', entity_id: 'm-none', tenant_id: 'default' }))
  // a file-audit row and a diary row: the sources without a trace column
  await dbx.run("INSERT INTO store_file_audit (rel_path, event_type, is_sensitive, agent, created_at) VALUES ('f-a', 'create', 0, 'agent-a', 1)")
  await dbx.run("INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES ('agent-a', '2026-01-01', 'log-a', 1)")
}

describe('queryAuditLog with a trace_id', () => {
  it('returns only the rows of that trace, from config, agent and hook alike, and counts the same', async () => {
    await seed()
    const r = await queryAuditLog({ sources: [], trace_id: TA.traceId, limit: 50 })
    expect(r.entries.map((e) => [e.source, e.trace_id, e.span_id]).sort()).toEqual([
      ['agent', TA.traceId, TA.spanId], ['config', TA.traceId, TA.spanId], ['hook', TA.traceId, TA.spanId],
    ])
    expect(r.total).toBe(3)
  })

  it('finds a w3c- trace by its stored string and does not mix it with the other trace', async () => {
    await seed()
    const r = await queryAuditLog({ sources: [], trace_id: TB.traceId, limit: 50 })
    expect(r.entries.map((e) => [e.source, e.entity_id])).toEqual([['agent', 'm-b']])
  })

  it('never returns the sources that keep no trace, even when asked for them by name', async () => {
    await seed()
    const r = await queryAuditLog({ sources: ['store', 'diary', 'idea'], trace_id: TA.traceId, limit: 50 })
    expect(r.entries).toEqual([])
    expect(r.total).toBe(0)
  })

  it('an unknown trace returns nothing; rows without a trace are never matched', async () => {
    await seed()
    expect((await queryAuditLog({ sources: [], trace_id: 'nope', limit: 50 })).entries).toEqual([])
  })

  it('without a trace_id the rows of the three sources carry their (nullable) trace, the others carry none', async () => {
    await seed()
    const r = await queryAuditLog({ sources: [], limit: 50 })
    const agentRows = r.entries.filter((e) => e.source === 'agent')
    expect(agentRows).toHaveLength(3)
    expect(agentRows.map((e) => e.trace_id).sort()).toEqual([null, TA.traceId, TB.traceId].sort())
    expect(r.entries.find((e) => e.source === 'store')).not.toHaveProperty('trace_id')
  })

  it('the idea source keeps no trace: it never answers a trace lookup, alone or with the others (and does answer without one)', async () => {
    await seed()
    await dbx.run("INSERT INTO idea_status_log (idea_id, to_status, actor, created_at) VALUES ('idea-a', 'open', 'user-a', 1)")
    expect((await queryAuditLog({ sources: ['idea'], limit: 50 })).total).toBe(1) // the control: the row is there
    for (const sources of [['idea'], ['store', 'diary', 'idea']] as const) {
      const r = await queryAuditLog({ sources: [...sources], trace_id: TA.traceId, limit: 50 })
      expect(r.entries).toEqual([])
      expect(r.total).toBe(0)
    }
    // with no source named, the idea row is not mixed into the answer either
    const all = await queryAuditLog({ sources: [], trace_id: TA.traceId, limit: 50 })
    expect(all.entries.some((e) => e.source === 'idea')).toBe(false)
    expect(all.total).toBe(3)
  })

  it('is served by the partial indexes of migration 0089: a SEARCH on trace_id through the index, never a scan', async () => {
    for (const [table, index] of [['config_change_log', 'idx_config_change_log_trace'], ['agent_audit_log', 'idx_agent_audit_log_trace'], ['hook_audit_log', 'idx_hook_audit_log_trace']] as const) {
      const plan = ((await dbx.all(`EXPLAIN QUERY PLAN SELECT id FROM ${table} WHERE trace_id = ?`, 'x')) as Array<{ detail: string }>).map((p) => p.detail)
      expect(plan, table).toHaveLength(1)
      expect(plan[0], table).toMatch(new RegExp(`^SEARCH ${table} USING (COVERING )?INDEX ${index} \\(trace_id=\\?\\)$`))
    }
  })

  it('the indexes are partial: only the rows that have a trace are in them', async () => {
    for (const index of ['idx_config_change_log_trace', 'idx_agent_audit_log_trace', 'idx_hook_audit_log_trace']) {
      const row = await dbx.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", index)
      expect(row?.sql, index).toContain('WHERE trace_id IS NOT NULL')
    }
  })
})

describe('GET /api/audit-log?trace_id=', () => {
  const call = async (query: string) => {
    const out = { status: 0, body: '' }
    const res = {
      writeHead: vi.fn((s: number) => { out.status = s }),
      setHeader: vi.fn(),
      end: vi.fn((b?: string) => { out.body = b ?? '' }),
    } as unknown as http.ServerResponse
    const ctx = { req: { url: `/api/audit-log${query}` } as http.IncomingMessage, res, path: '/api/audit-log', method: 'GET' } as unknown as RouteContext
    await tryHandleAuditLog(ctx)
    return { status: out.status || 200, json: JSON.parse(out.body) as { entries?: Array<{ source: string }>; total?: number; error?: string; field?: string } }
  }

  it('answers with the rows of the trace', async () => {
    await seed()
    const r = await call(`?trace_id=${TA.traceId}`)
    expect(r.status).toBe(200)
    expect(r.json.total).toBe(3)
  })

  it.each(['a b', 'x'.repeat(129), 'a;b', "a'b", 'a/b', '%20'])('refuses a malformed trace_id %j', async (bad) => {
    const r = await call(`?trace_id=${encodeURIComponent(bad)}`)
    expect(r.status).toBe(400)
    expect(r.json).toMatchObject({ error: 'invalid_value', field: 'trace_id' })
  })

  it('answers a w3c- trace id (the dash is allowed): only the rows of that trace', async () => {
    await seed()
    const r = await call(`?trace_id=${TB.traceId}`)
    expect(r.status).toBe(200)
    expect(r.json.total).toBe(1)
    expect(r.json.entries!.map((e) => e.source)).toEqual(['agent'])
  })

  it('answers a session-style trace id with a colon, a dot, an underscore and a dash (URL-encoded)', async () => {
    await inTrace(TC, () => writeAgentAuditLog({ agent_id: 'agent-a', entity: 'memory', action: 'create', entity_id: 'm-c', tenant_id: 'default' }))
    await inTrace(TA, () => writeAgentAuditLog({ agent_id: 'agent-a', entity: 'memory', action: 'create', entity_id: 'm-other', tenant_id: 'default' }))
    const r = await call(`?trace_id=${encodeURIComponent(TC.traceId)}`)
    expect(r.status).toBe(200)
    expect(r.json.total).toBe(1)
    expect(r.json.entries!.map((e) => e.source)).toEqual(['agent'])
  })

  it('trims the trace id: surrounding spaces are not a malformed id, they are dropped', async () => {
    await inTrace(TD, () => writeAgentAuditLog({ agent_id: 'agent-a', entity: 'memory', action: 'create', entity_id: 'm-d', tenant_id: 'default' }))
    await inTrace(TA, () => writeAgentAuditLog({ agent_id: 'agent-a', entity: 'memory', action: 'create', entity_id: 'm-other', tenant_id: 'default' }))
    const r = await call(`?trace_id=${encodeURIComponent(' abc ')}`)
    expect(r.status).toBe(200)
    expect(r.json.total).toBe(1)
  })

  it('an empty trace_id is no filter', async () => {
    await seed()
    const r = await call('?trace_id=')
    expect(r.status).toBe(200)
    expect(r.json.entries!.some((e) => e.source === 'store')).toBe(true)
  })
})
