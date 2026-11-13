// upsertOtelSpan keeps the export mark (exported_at) of a span that is written again unchanged and clears it when the
// end or the status changed, so the exporter sends the changed span again. The "changed?" test is null-safe (a span that
// is still running has no end: NULL against NULL is "unchanged"). Same cells on SQLite and PostgreSQL (ported list).
import { describe, expect, it } from 'vitest'
import { useTestDb } from './helpers/with-test-db.js'
import { upsertOtelSpan } from '../db/observability.js'

const { dbx } = useTestDb()

const base = { trace_id: 'trace-a', span_id: 'span-a', parent_span_id: null, agent_id: 'agent-a', operation: 'tool.read', start_ms: 1000, attributes: null }
const mark = async (): Promise<number | null> => ((await dbx.get('SELECT exported_at FROM otel_spans WHERE span_id = ?', 'span-a')) as { exported_at: number | null }).exported_at
const markExported = () => dbx.run('UPDATE otel_spans SET exported_at = 777 WHERE span_id = ?', 'span-a')

describe('upsertOtelSpan and the export mark', () => {
  it('a running span written again unchanged (end NULL on both sides) keeps the mark', async () => {
    await upsertOtelSpan({ ...base, end_ms: null })
    await markExported()
    await upsertOtelSpan({ ...base, end_ms: null })
    expect(await mark()).toBe(777)
  })

  it('a span that gets its end clears the mark (NULL becomes a value)', async () => {
    await upsertOtelSpan({ ...base, end_ms: null })
    await markExported()
    await upsertOtelSpan({ ...base, end_ms: 2000, status: 'ok' })
    expect(await mark()).toBeNull()
  })

  it('the same end and status written again keeps the mark; a changed end or status clears it', async () => {
    await upsertOtelSpan({ ...base, end_ms: 2000, status: 'ok' })
    await markExported()
    await upsertOtelSpan({ ...base, end_ms: 2000, status: 'ok' })
    expect(await mark()).toBe(777)
    await upsertOtelSpan({ ...base, end_ms: 2500, status: 'ok' })
    expect(await mark()).toBeNull()
    await markExported()
    await upsertOtelSpan({ ...base, end_ms: 2500, status: 'error' })
    expect(await mark()).toBeNull()
  })

  it('a span that loses its end (value becomes NULL) clears the mark', async () => {
    await upsertOtelSpan({ ...base, end_ms: 2000, status: 'ok' })
    await markExported()
    await upsertOtelSpan({ ...base, end_ms: null, status: 'ok' })
    expect(await mark()).toBeNull()
  })
})
