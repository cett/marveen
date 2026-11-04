// GET /api/messages/backlog answers with the VALUE of getPendingBacklogByAgent (async since the agents module
// moved onto the db facade): a dropped await would serialize a Promise as {}.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const backlog = vi.hoisted(() => ({ fn: vi.fn() }))

vi.mock('../db.js', () => ({
  getPendingBacklogByAgent: backlog.fn,
  COMPLETION_REPORT_PREFIX: '[Eredmeny]',
}))
vi.mock('../channel-coordinator/ingest.js', () => ({ COORDINATOR_AGENT_ID: 'telegram-coordinator' }))
vi.mock('../prompt-safety.js', () => ({
  sanitizeAgentIdent: vi.fn().mockImplementation((s: string) => s),
  scrubPiiFromContent: vi.fn().mockImplementation((s: string) => s),
}))
vi.mock('../web/agent-config.js', () => ({ isKnownAgent: vi.fn().mockReturnValue(true) }))
vi.mock('../web/kanban-ref-normalize.js', () => ({ normalizeKanbanRefs: vi.fn() }))
vi.mock('../web/federation/address.js', () => ({ parseQualifiedId: vi.fn().mockReturnValue(null), formatQualifiedId: vi.fn() }))
vi.mock('../web/federation/config.js', () => ({ getFederationConfig: vi.fn().mockReturnValue({ peers: [] }) }))

import { tryHandleMessages } from '../web/routes/messages.js'

function makeCtx(method: string, path: string): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', Buffer.alloc(0)); req.emit('end') })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { out.body = JSON.parse(b || '{}') },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('GET /api/messages/backlog', () => {
  it('answers with the resolved backlog rows, also when the db answers late', async () => {
    const rows = [{ agent: 'a1', pending: 3, oldest_age_s: 42 }]
    backlog.fn.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(rows), 20)))
    const { ctx, out } = makeCtx('GET', '/api/messages/backlog')
    expect(await tryHandleMessages(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual(rows)
  })

  it('an empty backlog is an empty array, not an empty object', async () => {
    backlog.fn.mockResolvedValueOnce([])
    const { ctx, out } = makeCtx('GET', '/api/messages/backlog')
    await tryHandleMessages(ctx)
    expect(out.body).toEqual([])
  })
})
