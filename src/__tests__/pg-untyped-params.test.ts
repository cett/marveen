// SQL parameters PostgreSQL cannot type, and the SQLite-only `IS <value>` null-safe compare (a syntax error there).
// Each query that used one now builds its condition into the SQL text, or compares with a plain operator, so the
// statement it sends has no `? IS NULL`, `@name IS NULL`, `IS ?` or `IS NOT ?`. Real in-memory database: the
// behaviour of both branches is checked as well as the shape of the SQL.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initDatabase, getDb, createKanbanCard, listKanbanProjects, getMonthlyTokenSpend, logSkillUsage,
  upsertOtelSpan, closeOtelSpan, markOtelSpansExported,
} from '../db.js'
import { dbx } from '../db/facade.js'

// The forbidden shapes, on the SQL text a statement actually runs with.
const UNTYPED = /(\?|@\w+|:\w+)\s+IS\s+(NOT\s+)?NULL/i
const SQLITE_IS_VALUE = /\bIS\s+(NOT\s+)?(\?|@\w+)/i
const CASE_PARAM = /CASE\s+WHEN\s+\?\s+THEN/i

/** Every statement `fn` sends through the facade (reads and writes), as { sql, params }. */
async function sqlOf(fn: () => Promise<unknown>): Promise<Array<{ sql: string; params: unknown[] }>> {
  const seen: Array<{ sql: string; params: unknown[] }> = []
  const spies = (['all', 'get', 'run'] as const).map((m) => {
    const real = (dbx[m] as (...a: unknown[]) => Promise<unknown>).bind(dbx)
    return vi.spyOn(dbx, m as 'all').mockImplementation(((sql: string, ...params: unknown[]) => { seen.push({ sql, params }); return real(sql, ...params) }) as never)
  })
  try { await fn() } finally { for (const s of spies) s.mockRestore() }
  return seen
}
function expectPortable(statements: Array<{ sql: string; params: unknown[] }>): void {
  expect(statements.length).toBeGreaterThan(0)
  for (const { sql, params } of statements) {
    expect(sql, sql).not.toMatch(UNTYPED)
    expect(sql, sql).not.toMatch(SQLITE_IS_VALUE)
    expect(sql, sql).not.toMatch(CASE_PARAM)
    // positional statements: one value per `?`
    if (params.length > 0 && typeof params[0] !== 'object') expect((sql.match(/\?/g) ?? []).length, sql).toBe(params.length)
  }
}

beforeEach(() => { initDatabase(':memory:') })

describe('listKanbanProjects', () => {
  beforeEach(async () => {
    await createKanbanCard({ id: 'c-a1', title: 'A1', tenant_id: 'tenant-a', project: 'alpha' } as never)
    await createKanbanCard({ id: 'c-b1', title: 'B1', tenant_id: 'tenant-b', project: 'beta' } as never)
    await createKanbanCard({ id: 'c-b2', title: 'B2', tenant_id: 'tenant-b', project: 'gamma' } as never)
  })

  it('without a tenant every tenant\'s projects come back, and the SQL has no tenant condition', async () => {
    let result: string[] = []
    const statements = await sqlOf(async () => { result = await listKanbanProjects() })
    expect(result).toEqual(['alpha', 'beta', 'gamma'])
    expectPortable(statements)
    expect(statements[0]?.sql).not.toMatch(/tenant_id/)
    expect(await listKanbanProjects(null)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('with a tenant only that tenant\'s projects come back', async () => {
    let result: string[] = []
    const statements = await sqlOf(async () => { result = await listKanbanProjects('tenant-b') })
    expect(result).toEqual(['beta', 'gamma'])
    expectPortable(statements)
    expect(statements[0]?.params).toEqual(['tenant-b'])
    expect(await listKanbanProjects('tenant-none')).toEqual([])
  })
})

describe('getMonthlyTokenSpend (agent total)', () => {
  const NOW = Math.floor(new Date('2026-06-15T10:00:00Z').getTime() / 1000)
  beforeEach(() => {
    const ins = getDb().prepare(`INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, tenant_id)
      VALUES (?, ?, ?, ?, 0, 0, 0, 0, 'default')`)
    ins.run('agent-a', 's1', NOW - 100, 10)
    ins.run('agent-b', 's2', NOW - 200, 5)
  })

  it('with an agent only its tokens count; without one every agent\'s do; the SQL carries the condition only when asked for', async () => {
    let one = -1
    const withAgent = await sqlOf(async () => { one = await getMonthlyTokenSpend({ agent: 'agent-a' }, NOW) })
    expect(one).toBe(10)
    expectPortable(withAgent)
    expect(withAgent.every((s) => /agent = @agent/.test(s.sql))).toBe(true)
    let all = -1
    const noAgent = await sqlOf(async () => { all = await getMonthlyTokenSpend({}, NOW) })
    expect(all).toBe(15)
    expectPortable(noAgent)
    expect(noAgent.some((s) => /@agent/.test(s.sql))).toBe(false)
  })
})

describe('logSkillUsage dedup on the session', () => {
  it('no session: the second call inside the window is swallowed (session_id IS NULL), a call with a session is not', async () => {
    let first = false
    const statements = await sqlOf(async () => { first = await logSkillUsage('agent-a', 'skill-a', 'tool_call', null) })
    expect(first).toBe(true)
    expectPortable(statements)
    expect(await logSkillUsage('agent-a', 'skill-a', 'tool_call', undefined)).toBe(false)
    expect(await logSkillUsage('agent-a', 'skill-a', 'tool_call', 'session-1')).toBe(true)
  })

  it('a session: the same session is swallowed, another one is not', async () => {
    let first = false
    const statements = await sqlOf(async () => { first = await logSkillUsage('agent-b', 'skill-b', 'tool_call', 'session-1') })
    expect(first).toBe(true)
    expectPortable(statements)
    expect(statements.some((s) => /session_id = \?/.test(s.sql))).toBe(true)
    expect(await logSkillUsage('agent-b', 'skill-b', 'tool_call', 'session-1')).toBe(false)
    expect(await logSkillUsage('agent-b', 'skill-b', 'tool_call', 'session-2')).toBe(true)
  })
})

describe('closeOtelSpan: the export mark is dropped only when the closing values differ', () => {
  const base = { trace_id: 't1', span_id: 'sp1', parent_span_id: null, agent_id: 'agent-a', operation: 'turn', start_ms: 1000, attributes: null }
  const exportedAt = (id: string) => (getDb().prepare('SELECT exported_at FROM otel_spans WHERE span_id = ?').get(id) as { exported_at: number | null }).exported_at

  it('the same end and status keep exported_at; another end, another status, or a span that was still open clear it', async () => {
    await upsertOtelSpan({ ...base, end_ms: 2000, status: 'ok' })
    await markOtelSpansExported([{ trace_id: 't1', span_id: 'sp1' }], 5000)
    expect(exportedAt('sp1')).toBe(5000)
    const statements = await sqlOf(async () => { await closeOtelSpan('t1', 'sp1', 2000, 'ok') })
    expectPortable(statements)
    expect(exportedAt('sp1')).toBe(5000)
    await closeOtelSpan('t1', 'sp1', 2001, 'ok')
    expect(exportedAt('sp1')).toBeNull()

    await markOtelSpansExported([{ trace_id: 't1', span_id: 'sp1' }], 6000)
    await closeOtelSpan('t1', 'sp1', 2001, 'error')
    expect(exportedAt('sp1')).toBeNull()

    await upsertOtelSpan({ ...base, span_id: 'sp2' })
    await markOtelSpansExported([{ trace_id: 't1', span_id: 'sp2' }], 7000)
    await closeOtelSpan('t1', 'sp2', 3000, 'ok')
    expect(exportedAt('sp2')).toBeNull()
  })
})
