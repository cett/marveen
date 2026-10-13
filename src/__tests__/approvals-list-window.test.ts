// GET /api/approvals reports the use window (APPROVAL_CONSUME_WINDOW_S) as `window_s`, so the dashboard can
// tell an approved request that is no longer usable from one that still is. The config value is mocked to
// a number that is not the default, so a route that printed a literal 1800 would fail here.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  APPROVAL_CONSUME_WINDOW_S: 777,
}))

import { initDatabase, createApproval } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'

interface Caller { auth?: RouteContext['auth']; role?: RouteContext['role']; tokenAgentId?: string; tenantId?: string | null }
const ADMIN: Caller = { auth: { kind: 'token', tokenName: 'op' }, role: 'admin' }
const MAIN: Caller = { auth: { kind: 'token', tokenName: 'main' }, role: 'fleet_agent', tokenAgentId: 'main-agent' }
const TENANT_SESSION: Caller = { auth: { kind: 'session', user: 'bob' } as RouteContext['auth'], role: 'agent', tenantId: 'tenant-b' }

async function list(caller: Caller, query = '') {
  const req = new EventEmitter() as any
  req.method = 'GET'
  req.headers = {}
  setImmediate(() => req.emit('end'))
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420/api/approvals${query}`)
  const ctx = { req, res, path: url.pathname, method: 'GET', url, auth: caller.auth, role: caller.role, tokenAgentId: caller.tokenAgentId, tenantId: caller.tenantId } as unknown as RouteContext
  expect(await tryHandleApprovals(ctx)).toBe(true)
  return out
}

beforeEach(() => {
  initDatabase(':memory:')
  createApproval({ id: 'a-1', agent_id: 'main-agent', category: 'deploy', action_description: 'x' })
  createApproval({ id: 'b-1', agent_id: 'worker', category: 'deploy', action_description: 'y', tenant_id: 'tenant-b' })
})

describe('GET /api/approvals window_s', () => {
  it('carries the configured use window for an admin, next to the page it always had', async () => {
    const out = await list(ADMIN)
    expect(out.status).toBe(200)
    expect(out.body.window_s).toBe(777)
    expect(out.body.items.map((a: any) => a.id).sort()).toEqual(['a-1', 'b-1'])
    expect(out.body).toMatchObject({ total: 2, offset: 0, limit: 25 })
    expect(out.body.counts.pending).toBe(2)
  })

  it('carries it for a fleet agent token too, which lists only its own requests and has no aggregates', async () => {
    const out = await list(MAIN)
    expect(out.status).toBe(200)
    expect(out.body.window_s).toBe(777)
    expect(out.body.items.map((a: any) => a.id)).toEqual(['a-1'])
    expect(out.body.counts).toEqual({})
    expect(out.body.oldest_pending).toBeNull()
  })

  it('carries it for a tenant session, scoped to that tenant', async () => {
    const out = await list(TENANT_SESSION)
    expect(out.status).toBe(200)
    expect(out.body.window_s).toBe(777)
    expect(out.body.items.map((a: any) => a.id)).toEqual(['b-1'])
  })

  it('is an integer number of seconds, present on an empty page as well', async () => {
    const out = await list(ADMIN, '?status=rejected')
    expect(out.body.items).toEqual([])
    expect(Number.isInteger(out.body.window_s)).toBe(true)
    expect(out.body.window_s).toBe(777)
  })

  it('is not added to a refused request', async () => {
    const out = await list({ auth: { kind: 'session', user: 'bob' } as RouteContext['auth'], role: 'agent', tenantId: null })
    expect(out.status).toBe(403)
    expect(out.body.window_s).toBeUndefined()
  })
})
