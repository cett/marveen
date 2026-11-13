// getRecentToolCalls orders the tool-call spans by INSERTION (the SQLite rowid, the identity column seq in PostgreSQL),
// not by the derived start_ms: two calls logged a millisecond apart with very different durations can invert on start_ms.
// The same cells run on both backends (the file is in the ported list).
import { describe, expect, it } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { getRecentToolCalls } from '../db/audit.js'
import { upsertOtelSpan } from '../db/observability.js'

useTestDb()

const now = Date.now()
const span = (id: string, startOffsetMs: number, extra: { end_ms?: number | null; operation?: string } = {}) => ({
  trace_id: 'trace-a', span_id: id, parent_span_id: null, agent_id: 'agent-a',
  operation: extra.operation ?? 'tool.read', start_ms: now - startOffsetMs, end_ms: extra.end_ms ?? null, attributes: null,
})

describe('getRecentToolCalls order', () => {
  it('follows the insertion order, not start_ms', async () => {
    // inserted c, a, b; start_ms order would be a (oldest), b, c
    await upsertOtelSpan(span('c', 1000))
    await upsertOtelSpan(span('a', 5000))
    await upsertOtelSpan(span('b', 3000))
    const calls = await getRecentToolCalls(60)
    expect(calls.map((c) => c.trace_id)).toEqual(['c', 'a', 'b'])
    expect(calls.map((c) => c.id)).toEqual([0, 1, 2])
  })

  it('a span that is updated (the end of a running call) keeps its place', async () => {
    await upsertOtelSpan(span('first', 4000))
    await upsertOtelSpan(span('second', 3000))
    await upsertOtelSpan({ ...span('first', 4000), end_ms: now - 100, status: 'ok' })
    const calls = await getRecentToolCalls(60)
    expect(calls.map((c) => c.trace_id)).toEqual(['first', 'second'])
    expect(calls[0].duration_ms).toBe(3900)
  })

  it('ties on start_ms keep the insertion order, and only tool.* spans inside the window count', async () => {
    await upsertOtelSpan(span('t3', 2000))
    await upsertOtelSpan(span('t1', 2000))
    await upsertOtelSpan(span('t2', 2000))
    await upsertOtelSpan(span('other', 1500, { operation: 'agent.turn' }))
    await upsertOtelSpan(span('old', 400_000))
    expect((await getRecentToolCalls(60)).map((c) => c.trace_id)).toEqual(['t3', 't1', 't2'])
  })
})
