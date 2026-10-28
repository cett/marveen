// The daily-log and recall routes against db functions that settle LATER (as the async facade's do). A route that
// forgets an await answers before the write has landed, or serialises a pending Promise as `{}`; the sync mocks
// of the other route tests cannot tell. Here each db call is held open until the test releases it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const m = vi.hoisted(() => ({
  appendDailyLog: vi.fn(),
  getDailyLog: vi.fn(),
  getDailyLogDates: vi.fn(),
  recallByDateRange: vi.fn(),
  recallSearch: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendDailyLog: m.appendDailyLog,
  getDailyLog: m.getDailyLog,
  getDailyLogDates: m.getDailyLogDates,
  recallByDateRange: m.recallByDateRange,
  recallSearch: m.recallSearch,
  appLocalDate: () => '2026-10-26',
  resolveAgentTenant: () => Promise.resolve('default'),
}))
vi.mock('../config.js', () => ({ MAIN_AGENT_ID: 'main-agent', APP_TZ: 'Europe/Budapest' }))

import { tryHandleDailyLog } from '../web/routes/daily-log.js'
import { tryHandleRecall } from '../web/routes/recall.js'

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function makeCtx(method: string, path: string, body?: object) {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 0, body: undefined as any, ended: false }
  const res = {
    setHeader() {},
    writeHead(s: number) { out.status = s },
    end(b?: string) { out.ended = true; try { out.body = JSON.parse(b || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url, role: 'admin' } as unknown as RouteContext, out }
}

// Let every already-settled promise chain run, so "has not answered yet" is a statement about the route.
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

beforeEach(() => { for (const fn of Object.values(m)) fn.mockReset() })

describe('daily-log routes wait for the db', () => {
  it('POST answers only after the append has settled', async () => {
    const write = deferred<void>()
    m.appendDailyLog.mockReturnValue(write.promise)
    const { ctx, out } = makeCtx('POST', '/api/daily-log', { agent_id: 'agent-a', content: 'entry' })
    const done = tryHandleDailyLog(ctx)
    await flush()
    expect(m.appendDailyLog).toHaveBeenCalledWith('agent-a', 'entry')
    expect(out.ended).toBe(false)
    write.resolve()
    await done
    expect(out.ended).toBe(true)
    expect(out.body).toEqual({ ok: true })
  })

  it('POST does not answer ok when the append fails', async () => {
    m.appendDailyLog.mockRejectedValue(new Error('disk full'))
    const { ctx, out } = makeCtx('POST', '/api/daily-log', { agent_id: 'agent-a', content: 'entry' })
    await expect(tryHandleDailyLog(ctx)).rejects.toThrow('disk full')
    expect(out.ended).toBe(false)
  })

  it('GET /api/daily-log serialises the rows, not the pending Promise', async () => {
    const rows = deferred<{ id: number; content: string; created_at: number }[]>()
    m.getDailyLog.mockReturnValue(rows.promise)
    const { ctx, out } = makeCtx('GET', '/api/daily-log?agent=agent-a&date=2026-10-26')
    const done = tryHandleDailyLog(ctx)
    await flush()
    expect(out.ended).toBe(false)
    rows.resolve([{ id: 1, content: 'x', created_at: 1 }])
    await done
    expect(out.body).toEqual([{ id: 1, content: 'x', created_at: 1 }])
  })

  it('GET /api/daily-log/dates serialises the dates, not the pending Promise', async () => {
    const dates = deferred<string[]>()
    m.getDailyLogDates.mockReturnValue(dates.promise)
    const { ctx, out } = makeCtx('GET', '/api/daily-log/dates?agent=agent-a')
    const done = tryHandleDailyLog(ctx)
    await flush()
    expect(out.ended).toBe(false)
    dates.resolve(['2026-10-26'])
    await done
    expect(out.body).toEqual(['2026-10-26'])
  })
})

describe('recall routes wait for the db', () => {
  const result = { logs: [{ id: 1 }], memories: [{ id: 2 }], dateRange: { from: '2026-10-26', to: '2026-10-26' } }

  it('a search answers with the settled result', async () => {
    const found = deferred<typeof result>()
    m.recallSearch.mockReturnValue(found.promise)
    const { ctx, out } = makeCtx('GET', '/api/recall?q=kanban')
    const done = tryHandleRecall(ctx)
    await flush()
    expect(m.recallSearch).toHaveBeenCalled()
    expect(out.ended).toBe(false)
    found.resolve(result)
    await done
    expect(out.status).toBe(200)
    expect(out.body.logs.map((l: { id: number }) => l.id)).toEqual([1])
    expect(out.body.summary.logCount).toBe(1)
  })

  it('a date range answers with the settled result', async () => {
    const found = deferred<typeof result>()
    m.recallByDateRange.mockReturnValue(found.promise)
    const { ctx, out } = makeCtx('GET', '/api/recall?date=2026-10-26')
    const done = tryHandleRecall(ctx)
    await flush()
    expect(m.recallByDateRange).toHaveBeenCalled()
    expect(out.ended).toBe(false)
    found.resolve(result)
    await done
    expect(out.body.memories.map((x: { id: number }) => x.id)).toEqual([2])
    expect(out.body.summary.memoryCount).toBe(1)
  })

  it('the dates listing answers with the settled dates', async () => {
    const dates = deferred<string[]>()
    m.getDailyLogDates.mockReturnValue(dates.promise)
    const { ctx, out } = makeCtx('GET', '/api/recall/dates')
    const done = tryHandleRecall(ctx)
    await flush()
    expect(out.ended).toBe(false)
    dates.resolve(['2026-10-25'])
    await done
    expect(out.body).toEqual(['2026-10-25'])
  })
})
