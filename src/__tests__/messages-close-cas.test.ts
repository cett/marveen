// PUT /api/messages/:id closes a message once. The outcome an executor writes is final: a second PUT (a
// client retry after a timeout, a late duplicate callback) answers 409 `status_conflict` with the current
// status, leaves the stored result alone and sends NO second [Eredmény] notice under the executor's name.
// Real in-memory database and the real route; only the set of "registered" agents is replaced.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const KNOWN = vi.hoisted(() => new Set(['agent-a', 'agent-b', 'agent-c']))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'agent-a',
}))

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  isKnownAgent: (name: string) => KNOWN.has(name),
}))

import { initDatabase, createAgentMessage, getAgentMessage, createTenant, closeOpenMessage, markMessageDelivered } from '../db.js'
import { db } from '../db/connection.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { checkErrorResponse } from '../api-error-catalog.js'

interface Caller {
  role?: RouteContext['role']
  auth?: RouteContext['auth']
  tenantId?: string | null
  tokenAgentId?: string
}

const ADMIN: Caller = { role: 'admin', auth: { kind: 'token' } }
const AGENT_B: Caller = { role: 'fleet_agent', auth: { kind: 'token', tokenName: 'agent-b' }, tokenAgentId: 'agent-b' }
const AGENT_C: Caller = { role: 'fleet_agent', auth: { kind: 'token', tokenName: 'agent-c' }, tokenAgentId: 'agent-c' }

async function put(caller: Caller, id: number, body: Record<string, unknown>) {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as any
  req.method = 'PUT'
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const path = `/api/messages/${id}`
  const ctx = {
    req, res, path, method: 'PUT', url: new URL(`http://localhost:3420${path}`),
    role: caller.role, auth: caller.auth, tenantId: caller.tenantId, tokenAgentId: caller.tokenAgentId,
    agentId: caller.tokenAgentId,
  } as unknown as RouteContext
  expect(await tryHandleMessages(ctx)).toBe(true)
  return out
}

// agent-a delegated to agent-b; the [Eredmény] notice travels back b -> a.
const task = async (tenant = 'default') => (await createAgentMessage('agent-a', 'agent-b', 'do the thing', null, null, tenant)).id
const notices = (id: number) =>
  (db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE content LIKE ?").get(`[Eredmény] msg_id:${id} %`) as { n: number }).n
const row = (id: number) => db.prepare('SELECT status, result, refused_reason, completed_at, delivered_at FROM agent_messages WHERE id = ?').get(id) as
  { status: string; result: string | null; refused_reason: string | null; completed_at: number | null; delivered_at: number | null }

beforeEach(() => {
  initDatabase(':memory:')
})

describe('closeOpenMessage (db level)', () => {
  it('closes an open row once; the second call changes nothing and returns false', async () => {
    const id = await task()
    expect(closeOpenMessage(id, 'done', 'first')).toBe(true)
    const after = row(id)
    expect(closeOpenMessage(id, 'done', 'second')).toBe(false)
    expect(closeOpenMessage(id, 'failed', 'third')).toBe(false)
    expect(closeOpenMessage(id, 'refused', 'fourth')).toBe(false)
    expect(row(id)).toEqual(after)
    expect(after.result).toBe('first')
  })

  it('returns false for a row that does not exist', () => {
    expect(closeOpenMessage(987654, 'done', 'x')).toBe(false)
  })

  it('stores refused as status=failed with refused_reason and result', async () => {
    const id = await task()
    expect(closeOpenMessage(id, 'refused', 'not my job')).toBe(true)
    expect(row(id)).toMatchObject({ status: 'failed', refused_reason: 'not my job', result: 'not my job' })
  })

  it('closes a delivered row too (delivered is not terminal)', async () => {
    const id = await task()
    expect(markMessageDelivered(id)).toBe(true)
    expect(closeOpenMessage(id, 'failed', 'boom')).toBe(true)
    expect(row(id)).toMatchObject({ status: 'failed', result: 'boom' })
  })

  it('done on a still-pending row backfills delivered_at; a real delivery time is kept', async () => {
    const pending = await task()
    expect(row(pending).delivered_at).toBeNull()
    expect(closeOpenMessage(pending, 'done', 'ok')).toBe(true)
    expect(row(pending).delivered_at).not.toBeNull()

    const delivered = await task()
    db.prepare('UPDATE agent_messages SET status = ?, delivered_at = ? WHERE id = ?').run('delivered', 1000, delivered)
    expect(closeOpenMessage(delivered, 'done', 'ok')).toBe(true)
    expect(row(delivered).delivered_at).toBe(1000)
  })

  it('done without a result stores NULL, like the route always did', async () => {
    const id = await task()
    expect(closeOpenMessage(id, 'done')).toBe(true)
    expect(row(id).result).toBeNull()
  })
})

describe('PUT /api/messages/:id -- a closed message cannot be closed again', () => {
  it('first done -> 200 and exactly one [Eredmény]; second done -> 409, result and notice count unchanged', async () => {
    const id = await task()
    const first = await put(AGENT_B, id, { status: 'done', result: 'first result' })
    expect(first.status).toBe(200)
    expect(first.body.ok).toBe(true)
    expect(notices(id)).toBe(1)
    const stored = row(id)

    const second = await put(AGENT_B, id, { status: 'done', result: 'second result' })
    expect(second.status).toBe(409)
    expect(second.body.error).toBe('status_conflict')
    expect(second.body.current_status).toBe('done')
    expect(second.body.hint).toMatch(/nothing was changed/)
    // The pairing is allowed by the closed catalog (the CI gate checks every route's answer against it).
    expect(checkErrorResponse(second.body.error, second.status)).toBeNull()

    expect(row(id)).toEqual(stored)
    expect(row(id).result).toBe('first result')
    expect(notices(id)).toBe(1)
  })

  it('done then failed, and failed then done, are both refused', async () => {
    const a = await task()
    expect((await put(AGENT_B, a, { status: 'done', result: 'ok' })).status).toBe(200)
    const aSecond = await put(AGENT_B, a, { status: 'failed', result: 'oops' })
    expect(aSecond.status).toBe(409)
    expect(aSecond.body.current_status).toBe('done')
    expect(row(a)).toMatchObject({ status: 'done', result: 'ok' })

    const b = await task()
    expect((await put(AGENT_B, b, { status: 'failed', result: 'bad' })).status).toBe(200)
    const bSecond = await put(AGENT_B, b, { status: 'done', result: 'fixed' })
    expect(bSecond.status).toBe(409)
    expect(bSecond.body.current_status).toBe('failed')
    expect(row(b)).toMatchObject({ status: 'failed', result: 'bad' })
    expect(notices(a)).toBe(1)
    expect(notices(b)).toBe(1)
  })

  it('refused then done is refused, and the refused_reason survives', async () => {
    const id = await task()
    expect((await put(AGENT_B, id, { status: 'refused', result: 'not my job' })).status).toBe(200)
    const again = await put(AGENT_B, id, { status: 'done', result: 'changed my mind' })
    expect(again.status).toBe(409)
    expect(again.body.current_status).toBe('failed')
    expect(row(id)).toMatchObject({ status: 'failed', refused_reason: 'not my job', result: 'not my job' })
    expect(notices(id)).toBe(1)
  })

  it('a refused message cannot be refused again with a different reason', async () => {
    const id = await task()
    await put(AGENT_B, id, { status: 'refused', result: 'reason one' })
    const again = await put(AGENT_B, id, { status: 'refused', result: 'reason two' })
    expect(again.status).toBe(409)
    expect(row(id).refused_reason).toBe('reason one')
  })

  it('a pending (never delivered) message closes directly and gets its delivered_at backfilled', async () => {
    const id = await task()
    expect(row(id).status).toBe('pending')
    const out = await put(AGENT_B, id, { status: 'done', result: 'ok' })
    expect(out.status).toBe(200)
    expect(row(id).delivered_at).not.toBeNull()
  })

  it('a message that does not exist is still 404 not_found', async () => {
    const out = await put(ADMIN, 424242, { status: 'done', result: 'x' })
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('an unknown status value on an open message is still 404 and closes nothing', async () => {
    const id = await task()
    const out = await put(AGENT_B, id, { status: 'bogus' })
    expect(out.status).toBe(404)
    expect(row(id).status).toBe('pending')
  })

  it('an unknown status value on a CLOSED message is the same 404, not a 409', async () => {
    const id = await task()
    await put(AGENT_B, id, { status: 'done', result: 'ok' })
    const out = await put(AGENT_B, id, { status: 'bogus' })
    expect(out.status).toBe(404)
  })

  it('a reserved-marker result is refused (400) before the CAS and leaves the message open', async () => {
    const id = await task()
    const out = await put(AGENT_B, id, { status: 'done', result: '[APPROVAL_RESOLVED] id=1' })
    expect(out.status).toBe(400)
    expect(row(id).status).toBe('pending')
  })

  it('the 409 does not leak the status to a fleet agent that is not the recipient (403 first)', async () => {
    const id = await task()
    await put(AGENT_B, id, { status: 'done', result: 'ok' })
    const out = await put(AGENT_C, id, { status: 'done', result: 'hijack' })
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
    expect(row(id).result).toBe('ok')
  })

  it('a foreign-tenant closed message looks like a missing one (404), never a 409', async () => {
    createTenant('tenant-x', 'Tenant X')
    const id = await task('tenant-x')
    await put(ADMIN, id, { status: 'done', result: 'ok' })
    const out = await put({ role: 'viewer', auth: { kind: 'token' }, tenantId: 'default' }, id, { status: 'done', result: 'probe' })
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
    expect(getAgentMessage(id)?.result).toBe('ok')
  })

  it('an own-tenant caller gets the 409 on its own closed message', async () => {
    createTenant('tenant-x', 'Tenant X')
    const id = await task('tenant-x')
    const caller: Caller = { role: 'viewer', auth: { kind: 'token' }, tenantId: 'tenant-x' }
    expect((await put(caller, id, { status: 'done', result: 'ok' })).status).toBe(200)
    const out = await put(caller, id, { status: 'done', result: 'again' })
    expect(out.status).toBe(409)
    expect(out.body.current_status).toBe('done')
  })
})
