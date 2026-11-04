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

// ---- closeOtelSpan: the "changed?" test must behave like SQLite's null-safe `IS NOT ?` for EVERY combination ----------
describe('closeOtelSpan null-safe change test (end_ms and status, NULLs included)', () => {
  const base = { trace_id: 't9', parent_span_id: null, agent_id: 'agent-a', operation: 'turn', start_ms: 1000, attributes: null }
  const exportedAt = (id: string) => (getDb().prepare('SELECT exported_at FROM otel_spans WHERE span_id = ?').get(id) as { exported_at: number | null }).exported_at
  // Reference semantics (the old `end_ms IS NOT ? OR status IS NOT ?`): equal-or-both-NULL is "not changed".
  const changed = (oldEnd: number | null, oldStatus: string, end: number | null, status: string) => oldEnd !== end || oldStatus !== status
  const OLD_ENDS: Array<number | null> = [null, 2000]
  const OLD_STATUSES = ['running', 'ok', 'error', 'timeout']
  const NEW_ENDS: Array<number | null> = [null, 1999, 2000, 2001]
  const NEW_STATUSES = ['ok', 'error']

  it('every (old end, old status, new end, new status) combination keeps or clears the export mark exactly as the null-safe compare says', async () => {
    let n = 0
    for (const oldEnd of OLD_ENDS) for (const oldStatus of OLD_STATUSES) for (const end of NEW_ENDS) for (const status of NEW_STATUSES) {
      const id = `m-${n++}`
      await upsertOtelSpan({ ...base, span_id: id, end_ms: oldEnd, status: oldStatus as never })
      await markOtelSpansExported([{ trace_id: 't9', span_id: id }], 5000)
      await closeOtelSpan('t9', id, end as never, status as never)
      const want = changed(oldEnd, oldStatus, end, status) ? null : 5000
      expect({ oldEnd, oldStatus, end, status, exported: exportedAt(id) }).toEqual({ oldEnd, oldStatus, end, status, exported: want })
    }
    expect(n).toBe(OLD_ENDS.length * OLD_STATUSES.length * NEW_ENDS.length * NEW_STATUSES.length)
  })

  it('a span that was never exported stays unexported whatever the close values are', async () => {
    await upsertOtelSpan({ ...base, span_id: 'never', end_ms: 2000, status: 'ok' })
    await closeOtelSpan('t9', 'never', 2001, 'error')
    expect(exportedAt('never')).toBeNull()
  })

  it('a NULL end closes an already closed, exported span as a CHANGE: the stale export mark is dropped (the request body is not validated)', async () => {
    await upsertOtelSpan({ ...base, span_id: 'nul', end_ms: 2000, status: 'ok' })
    await markOtelSpansExported([{ trace_id: 't9', span_id: 'nul' }], 5000)
    expect(await closeOtelSpan('t9', 'nul', null as never, 'ok')).toBe(true)
    expect(exportedAt('nul')).toBeNull()
    const row = getDb().prepare('SELECT end_ms FROM otel_spans WHERE span_id = ?').get('nul') as { end_ms: number | null }
    expect(row.end_ms).toBeNull()
    // and a NULL end on a span that is already open (NULL end) is NOT a change
    await upsertOtelSpan({ ...base, span_id: 'nul2', end_ms: null, status: 'ok' })
    await markOtelSpansExported([{ trace_id: 't9', span_id: 'nul2' }], 6000)
    await closeOtelSpan('t9', 'nul2', null as never, 'ok')
    expect(exportedAt('nul2')).toBe(6000)
  })

  it('an open span (NULL end, status ok) closed with ok drops the export mark', async () => {
    await upsertOtelSpan({ ...base, span_id: 'open', end_ms: null, status: 'ok' })
    await markOtelSpansExported([{ trace_id: 't9', span_id: 'open' }], 5000)
    await closeOtelSpan('t9', 'open', 2000, 'ok')
    expect(exportedAt('open')).toBeNull()
  })

  it('a LOWER end is a change too (2000 -> 1999), not only a higher one', async () => {
    await upsertOtelSpan({ ...base, span_id: 'low', end_ms: 2000, status: 'ok' })
    await markOtelSpansExported([{ trace_id: 't9', span_id: 'low' }], 5000)
    await closeOtelSpan('t9', 'low', 1999, 'ok')
    expect(exportedAt('low')).toBeNull()
  })

  it('a NULL status is refused by the column (NOT NULL): the call rejects and the span is untouched', async () => {
    await upsertOtelSpan({ ...base, span_id: 'ns', end_ms: 2000, status: 'ok' })
    await markOtelSpansExported([{ trace_id: 't9', span_id: 'ns' }], 5000)
    await expect(closeOtelSpan('t9', 'ns', 2001, null as never)).rejects.toThrow()
    expect(exportedAt('ns')).toBe(5000)
    expect((getDb().prepare('SELECT end_ms FROM otel_spans WHERE span_id = ?').get('ns') as { end_ms: number }).end_ms).toBe(2000)
  })

  it('the statement uses IS DISTINCT FROM, so PostgreSQL types both parameters from their columns, and passes the portability shapes', async () => {
    await upsertOtelSpan({ ...base, span_id: 'shape', end_ms: 2000, status: 'ok' })
    const statements = await sqlOf(async () => { await closeOtelSpan('t9', 'shape', 2000, 'ok') })
    expectPortable(statements)
    expect(statements[0]?.sql).toMatch(/end_ms IS DISTINCT FROM \?/)
    expect(statements[0]?.sql).toMatch(/status IS DISTINCT FROM \?/)
  })

  it('the bundled SQLite supports IS DISTINCT FROM (3.39+), the minimum this statement needs', () => {
    const v = (getDb().prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
    const [maj, min] = v.split('.').map(Number) as [number, number]
    expect(maj * 1000 + min).toBeGreaterThanOrEqual(3 * 1000 + 39)
  })
})

describe('logSkillUsage with an empty-string session', () => {
  it('"" is a session of its own (session_id = ?), not a missing one: the second call is swallowed, a missing session is a different key', async () => {
    expect(await logSkillUsage('agent-c', 'skill-c', 'tool_call', '')).toBe(true)
    expect(await logSkillUsage('agent-c', 'skill-c', 'tool_call', '')).toBe(false)
    // NULL and '' do not dedup against each other
    expect(await logSkillUsage('agent-c', 'skill-c', 'tool_call', null)).toBe(true)
    expect(await logSkillUsage('agent-c', 'skill-c', 'tool_call', null)).toBe(false)
  })
})

describe('getMonthlyTokenSpend: the agent filter reaches BOTH sources (rolled-up months and raw rows)', () => {
  const NOW = Math.floor(new Date('2026-06-15T10:00:00Z').getTime() / 1000)
  const month = (nowSec: number) => (getDb().prepare("SELECT strftime('%Y-%m', ?, 'unixepoch', 'localtime') AS m").get(nowSec) as { m: string }).m
  beforeEach(() => {
    const raw = getDb().prepare(`INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, tenant_id)
      VALUES (?, ?, ?, ?, 0, 0, 0, 0, 'default')`)
    raw.run('agent-a', 's1', NOW - 100, 10)
    raw.run('agent-b', 's2', NOW - 200, 5)
    const monthly = getDb().prepare(`INSERT INTO token_usage_monthly (month, agent, model, input_tokens) VALUES (?, ?, '', ?)`)
    monthly.run(month(NOW), 'agent-a', 100)
    monthly.run(month(NOW), 'agent-b', 1000)
    monthly.run('2020-01', 'agent-a', 7777) // another month: never counted
  })

  it('one agent: its raw rows plus its own rolled-up month, nothing of the other agent from either source', async () => {
    expect(await getMonthlyTokenSpend({ agent: 'agent-a' }, NOW)).toBe(110)
    expect(await getMonthlyTokenSpend({ agent: 'agent-b' }, NOW)).toBe(1005)
    expect(await getMonthlyTokenSpend({ agent: 'agent-none' }, NOW)).toBe(0)
  })

  it('no agent: every agent, both sources, this month only', async () => {
    expect(await getMonthlyTokenSpend({}, NOW)).toBe(1115)
  })

  it('both subqueries carry the agent condition in the SQL', async () => {
    const statements = await sqlOf(async () => { await getMonthlyTokenSpend({ agent: 'agent-a' }, NOW) })
    expect((statements[0]?.sql.match(/agent = @agent/g) ?? []).length).toBe(2)
  })
})
