// Characterization of db/overview.ts: every read aggregate, on an empty table, with one row and with the tenant
// filter. Written before the module moved onto the facade, so a lost await or a changed filter fails here and
// not only in the type checker.

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db.js'
import {
  countOverviewMemories,
  countOverviewMemoryCategories,
  countOverviewArtifacts,
  listOverviewLastActive,
  sumOverviewTokensSince,
  countOverviewPendingApprovals,
  countOverviewErrorSpansSince,
  listOverviewErrorSpansSince,
  countOverviewPendingMessages,
  countOverviewStuckScheduledTasks,
  listOverviewRecentMemories,
  listOverviewRecentMessages,
  listOverviewRecentApprovals,
} from '../db/overview.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

beforeEach(() => {
  db.prepare("INSERT OR IGNORE INTO tenants (id, display_name, created_at) VALUES ('default', 'Fleet', 0)").run()
  db.prepare("INSERT INTO tenants (id, display_name, created_at) VALUES ('acme', 'Acme', 1)").run()
})

function addMemory(content: string, category: string, createdAt: number, tenantId: string, agentId = 'zack'): void {
  db.prepare(
    `INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, agent_id, category, tenant_id)
     VALUES ('c', ?, 'semantic', ?, ?, ?, ?, ?)`
  ).run(content, createdAt, createdAt, agentId, category, tenantId)
}

function addUsage(agent: string, ts: number, input: number, output: number, tenantId: string): void {
  db.prepare(
    'INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, tenant_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(agent, 's1', ts, input, output, tenantId)
}

function addApproval(id: string, status: string, requestedAt: number, tenantId: string): void {
  db.prepare(
    `INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, tenant_id)
     VALUES (?, 'zack', 'email_send', ?, ?, ?, ?)`
  ).run(id, `act ${id}`, status, requestedAt, tenantId)
}

function addMessage(content: string, status: string, createdAt: number, tenantId: string): void {
  db.prepare(
    'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run('zack', 'jarvis', content, status, createdAt, tenantId)
}

function addSpan(spanId: string, status: string, startMs: number, endMs: number | null, operation: string, attributes: string | null): void {
  db.prepare(
    'INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms, end_ms, status, attributes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run('t1', spanId, 'zack', operation, startMs, endMs, status, attributes)
}

describe('the counts', () => {
  it('are zero on empty tables', async () => {
    expect(await countOverviewMemories(null)).toBe(0)
    expect(await countOverviewMemoryCategories(null)).toBe(0)
    expect(await countOverviewArtifacts(null)).toBe(0)
    expect(await countOverviewPendingApprovals(null)).toBe(0)
    expect(await countOverviewErrorSpansSince(0)).toBe(0)
    expect(await countOverviewPendingMessages(null)).toBe(0)
    expect(await countOverviewStuckScheduledTasks(1e12)).toBe(0)
  })

  it('memories: fleet-wide count, distinct categories, tenant narrowing', async () => {
    addMemory('a', 'hot', 10, 'default')
    addMemory('b', 'hot', 11, 'acme')
    addMemory('c', 'cold', 12, 'acme')
    expect(await countOverviewMemories(null)).toBe(3)
    expect(await countOverviewMemories('acme')).toBe(2)
    expect(await countOverviewMemories('default')).toBe(1)
    expect(await countOverviewMemories('nobody')).toBe(0)
    expect(await countOverviewMemoryCategories(null)).toBe(2)
    expect(await countOverviewMemoryCategories('default')).toBe(1)
    expect(await countOverviewMemoryCategories('acme')).toBe(2)
  })

  it('artifacts: fleet-wide count and tenant narrowing', async () => {
    const ins = db.prepare("INSERT INTO artifacts (agent_id, title, kind, content, tenant_id) VALUES ('zack', ?, 'text', 'x', ?)")
    ins.run('one', 'default')
    ins.run('two', 'acme')
    ins.run('three', 'acme')
    expect(await countOverviewArtifacts(null)).toBe(3)
    expect(await countOverviewArtifacts('acme')).toBe(2)
    expect(await countOverviewArtifacts('default')).toBe(1)
  })

  it('pending approvals: only status pending, tenant narrowing', async () => {
    addApproval('a1', 'pending', 5, 'default')
    addApproval('a2', 'approved', 6, 'default')
    addApproval('a3', 'pending', 7, 'acme')
    expect(await countOverviewPendingApprovals(null)).toBe(2)
    expect(await countOverviewPendingApprovals('acme')).toBe(1)
    expect(await countOverviewPendingApprovals('default')).toBe(1)
  })

  it('pending messages: only status pending, tenant narrowing', async () => {
    addMessage('m1', 'pending', 5, 'default')
    addMessage('m2', 'delivered', 6, 'default')
    addMessage('m3', 'pending', 7, 'acme')
    expect(await countOverviewPendingMessages(null)).toBe(2)
    expect(await countOverviewPendingMessages('acme')).toBe(1)
  })

  it('error spans: error and timeout since the cut-off, not ok or running', async () => {
    addSpan('s1', 'error', 1000, 1500, 'http.server', null)
    addSpan('s2', 'timeout', 2000, null, 'schedule.run', null)
    addSpan('s3', 'ok', 3000, 3100, 'http.server', null)
    addSpan('s4', 'running', 4000, null, 'http.server', null)
    addSpan('s5', 'error', 500, 600, 'http.server', null)
    expect(await countOverviewErrorSpansSince(0)).toBe(3)
    expect(await countOverviewErrorSpansSince(1000)).toBe(2)
    expect(await countOverviewErrorSpansSince(2001)).toBe(0)
  })

  it('stuck scheduled tasks: active and due before the cut-off', async () => {
    const ins = db.prepare("INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, status, created_at) VALUES (?, 'c', 'p', '* * * * *', ?, ?, 0)")
    ins.run('t1', 100, 'active')
    ins.run('t2', 200, 'active')
    ins.run('t3', 50, 'paused')
    expect(await countOverviewStuckScheduledTasks(150)).toBe(1)
    expect(await countOverviewStuckScheduledTasks(300)).toBe(2)
    expect(await countOverviewStuckScheduledTasks(100)).toBe(0)
  })
})

describe('token usage', () => {
  it('last active per agent is the newest timestamp, not tenant scoped', async () => {
    expect(await listOverviewLastActive()).toEqual([])
    addUsage('zack', 100, 1, 1, 'default')
    addUsage('zack', 300, 1, 1, 'default')
    addUsage('jarvis', 200, 1, 1, 'acme')
    const rows = (await listOverviewLastActive()).sort((x, y) => x.agent.localeCompare(y.agent))
    expect(rows).toEqual([{ agent: 'jarvis', last_active: 200 }, { agent: 'zack', last_active: 300 }])
  })

  it('sum since: input plus output from the cut-off on, tenant narrowing', async () => {
    expect(await sumOverviewTokensSince(0, null)).toBe(0)
    addUsage('zack', 100, 10, 5, 'default')
    addUsage('zack', 200, 20, 7, 'acme')
    addUsage('zack', 300, 1, 1, 'acme')
    expect(await sumOverviewTokensSince(0, null)).toBe(44)
    expect(await sumOverviewTokensSince(200, null)).toBe(29)
    expect(await sumOverviewTokensSince(0, 'acme')).toBe(29)
    expect(await sumOverviewTokensSince(0, 'default')).toBe(15)
    expect(await sumOverviewTokensSince(301, null)).toBe(0)
  })
})

describe('error span list', () => {
  it('is empty without spans', async () => {
    expect(await listOverviewErrorSpansSince(0, 10)).toEqual([])
  })

  it('newest first, limited, with duration and a detail label', async () => {
    addSpan('h1', 'error', 1000, 1250, 'http.server', JSON.stringify({ http_method: 'GET', http_route: '/api/x', http_status: 500, secret: 'no' }))
    addSpan('c1', 'timeout', 2000, null, 'schedule.run', JSON.stringify({ schedule: 'nightly' }))
    addSpan('b1', 'error', 3000, 2900, 'schedule.run', 'not json')
    addSpan('n1', 'error', 4000, 4001, 'schedule.run', null)
    addSpan('ok', 'ok', 5000, 5001, 'http.server', null)

    const all = await listOverviewErrorSpansSince(0, 10)
    expect(all.map(s => s.span_id)).toEqual(['n1', 'b1', 'c1', 'h1'])
    expect(all.find(s => s.span_id === 'h1')).toEqual({
      trace_id: 't1', span_id: 'h1', agent_id: 'zack', operation: 'http.server', status: 'error',
      start_ms: 1000, duration_ms: 250, detail: 'GET /api/x 500',
    })
    expect(all.find(s => s.span_id === 'c1')).toMatchObject({ status: 'timeout', duration_ms: null, detail: 'nightly' })
    expect(all.find(s => s.span_id === 'b1')).toMatchObject({ duration_ms: 0, detail: '' })
    expect(all.find(s => s.span_id === 'n1')).toMatchObject({ detail: '' })

    expect((await listOverviewErrorSpansSince(0, 2)).map(s => s.span_id)).toEqual(['n1', 'b1'])
    expect((await listOverviewErrorSpansSince(2500, 10)).map(s => s.span_id)).toEqual(['n1', 'b1'])
  })
})

describe('the recent lists', () => {
  it('are empty on empty tables', async () => {
    expect(await listOverviewRecentMemories(0, null)).toEqual([])
    expect(await listOverviewRecentMessages(0, null)).toEqual([])
  })

  it('memories: newest first, from the cut-off, tenant narrowing, capped at 20', async () => {
    addMemory('old', 'hot', 5, 'default')
    addMemory('mid', 'hot', 20, 'acme', 'jarvis')
    addMemory('new', 'hot', 30, 'default')
    expect(await listOverviewRecentMemories(10, null)).toEqual([
      { content: 'new', created_at: 30, agent_id: 'zack' },
      { content: 'mid', created_at: 20, agent_id: 'jarvis' },
    ])
    expect((await listOverviewRecentMemories(10, 'acme')).map(m => m.content)).toEqual(['mid'])
    for (let i = 0; i < 25; i++) addMemory(`bulk ${i}`, 'hot', 100 + i, 'default')
    expect(await listOverviewRecentMemories(0, null)).toHaveLength(20)
  })

  it('messages: newest first, from the cut-off, tenant narrowing, capped at 15', async () => {
    addMessage('old', 'pending', 5, 'default')
    addMessage('mid', 'done', 20, 'acme')
    addMessage('new', 'pending', 30, 'default')
    expect(await listOverviewRecentMessages(10, null)).toEqual([
      { from_agent: 'zack', to_agent: 'jarvis', content: 'new', created_at: 30 },
      { from_agent: 'zack', to_agent: 'jarvis', content: 'mid', created_at: 20 },
    ])
    expect((await listOverviewRecentMessages(10, 'acme')).map(m => m.content)).toEqual(['mid'])
    for (let i = 0; i < 20; i++) addMessage(`bulk ${i}`, 'done', 100 + i, 'default')
    expect(await listOverviewRecentMessages(0, null)).toHaveLength(15)
  })

  // Known defect, pinned so the move onto the facade does not change it silently: the query reads
  // approvals.created_at, the column is requested_at, so the call throws and the overview route drops the
  // approvals from its activity feed in its catch. A fix is its own change.
  it('approvals: the query names a column the table does not have', async () => {
    addApproval('a1', 'pending', 5, 'default')
    await expect(listOverviewRecentApprovals(0, null)).rejects.toThrow(/no such column: created_at/)
  })
})
