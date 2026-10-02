// The approval deadline through the real route and a real in-memory DB (no mocks on db.js): a request
// always gets a bounded deadline, `timeout_seconds` can only shorten it, and an expired request cannot
// be approved even before the sweeper ran.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
}))
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { initDatabase, getDb, getApproval } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'

const NOW_MS = Date.UTC(2026, 9, 2, 12, 0, 0)
const NOW = Math.floor(NOW_MS / 1000)

async function call(method: string, path: string, body?: object): Promise<{ status: number; body: any }> {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  await tryHandleApprovals({ req, res, path: url.pathname, method, url, role: 'admin', auth: { kind: 'token' } } as RouteContext)
  return out
}

const create = (category: string, extra: object = {}) =>
  call('POST', '/api/approvals', { agent_id: 'agent-a', category, action_description: 'do it', ...extra })

describe('POST /api/approvals deadline', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW_MS)
  })
  afterEach(() => { vi.useRealTimers() })

  it('uses the category timeout (60 minutes after the migration)', async () => {
    const out = await create('email_send')
    expect(out.status).toBe(201)
    expect(out.body.timeout_at).toBe(NOW + 3600)
  })

  it('timeout_seconds shortens the category timeout', async () => {
    const out = await create('email_send', { timeout_seconds: 600 })
    expect(out.body.timeout_at).toBe(NOW + 600)
  })

  it('timeout_seconds cannot extend the category timeout', async () => {
    const out = await create('email_send', { timeout_seconds: 86400 })
    expect(out.body.timeout_at).toBe(NOW + 3600)
  })

  it('ignores a negative, zero, non-numeric or non-finite timeout_seconds', async () => {
    for (const bad of [-5, 0, '600', null, [], {}]) {
      const out = await create('email_send', { timeout_seconds: bad })
      expect(out.status).toBe(201)
      expect(out.body.timeout_at, JSON.stringify(bad)).toBe(NOW + 3600)
    }
  })

  it('an unknown category (no row) is bounded by the 24 h ceiling, not left open', async () => {
    const out = await create('github_pr')
    expect(out.status).toBe(201)
    expect(out.body.timeout_at).toBe(NOW + 86400)
  })

  it('a known category whose timeout_minutes is NULL is bounded by the 24 h ceiling', async () => {
    getDb().prepare("UPDATE autonomy_categories SET timeout_minutes = NULL WHERE key = 'email_send'").run()
    const out = await create('email_send')
    expect(out.body.timeout_at).toBe(NOW + 86400)
  })

  it('an operator-set category value is used as is, and timeout_seconds still only shortens it', async () => {
    getDb().prepare("UPDATE autonomy_categories SET timeout_minutes = 240 WHERE key = 'email_send'").run()
    expect((await create('email_send')).body.timeout_at).toBe(NOW + 240 * 60)
    expect((await create('email_send', { timeout_seconds: 3600 })).body.timeout_at).toBe(NOW + 3600)
  })

  it('the category is looked up trimmed, like it is stored', async () => {
    const out = await create('  email_send  ')
    expect(out.body.category).toBe('email_send')
    expect(out.body.timeout_at).toBe(NOW + 3600)
  })
})

describe('PATCH /api/approvals/:id on an expired request', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('answers 409 "expired" (not "Already resolved as pending") and leaves the request pending', async () => {
    getDb().prepare(
      "INSERT INTO approvals (id, agent_id, category, action_description, status, timeout_at, requested_at) VALUES ('old', 'agent-a', 'email_send', 'x', 'pending', ?, ?)",
    ).run(Math.floor(Date.now() / 1000) - 5, Math.floor(Date.now() / 1000) - 3600)
    const out = await call('PATCH', '/api/approvals/old', { status: 'approved', resolved_by: 'human' })
    expect(out.status).toBe(409)
    expect(out.body.hint).toBe('Approval has expired')
    expect(getApproval('old')?.status).toBe('pending')
  })

  it('still approves a request that has time left', async () => {
    getDb().prepare(
      "INSERT INTO approvals (id, agent_id, category, action_description, status, timeout_at, requested_at) VALUES ('fresh', 'agent-a', 'email_send', 'x', 'pending', ?, ?)",
    ).run(Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000))
    const out = await call('PATCH', '/api/approvals/fresh', { status: 'approved', resolved_by: 'human' })
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('approved')
  })

  it('an already decided request keeps answering "Already resolved as <status>"', async () => {
    getDb().prepare(
      "INSERT INTO approvals (id, agent_id, category, action_description, status, timeout_at, requested_at) VALUES ('d', 'agent-a', 'email_send', 'x', 'rejected', NULL, 1)",
    ).run()
    const out = await call('PATCH', '/api/approvals/d', { status: 'approved', resolved_by: 'human' })
    expect(out.status).toBe(409)
    expect(out.body.hint).toBe('Already resolved as rejected')
  })
})
