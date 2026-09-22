// Route-level tests for daily-log.ts (#751 step 14). Only db-extended*/
// fleet-transfer* tests touch appendDailyLog/getDailyLog/getDailyLogDates
// indirectly via db.js -- the route handler itself (tryHandleDailyLog) had
// zero direct tests: no coverage of the POST validation branch, the
// agent_id default-to-MAIN_AGENT_ID fallback on either verb, or the
// GET .../dates listing. Uses a real in-memory DB (like
// tool-log-otel-span.test.ts) rather than mocking db.js, since the route's
// only job is thin request parsing around three already-tested db.js calls.

import { describe, it, expect, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, createTenant, setTenantAgentAvailability } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleDailyLog } from '../web/routes/daily-log.js'
import type { RouteContext } from '../web/routes/types.js'

beforeAll(() => {
  initDatabase(':memory:')
})

function makeCtx(
  method: string,
  path: string,
  body?: object,
  authCtx?: { role?: RouteContext['role']; tenantId?: string | null },
): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url, role: authCtx?.role, tenantId: authCtx?.tenantId } as RouteContext, out }
}

describe('tryHandleDailyLog', () => {
  it('returns false for an unrelated path', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleDailyLog(ctx)).toBe(false)
  })

  it('POST rejects a missing content field with 400', async () => {
    const { ctx, out } = makeCtx('POST', '/api/daily-log', { agent_id: 'agent-a' })
    expect(await tryHandleDailyLog(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body).toEqual({ error: 'required', field: 'content', hint: 'Content required' })
  })

  it('POST rejects whitespace-only content with 400', async () => {
    const { ctx, out } = makeCtx('POST', '/api/daily-log', { agent_id: 'agent-a', content: '   ' })
    expect(await tryHandleDailyLog(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('POST appends a trimmed entry under the given agent_id and 200s', async () => {
    const { ctx, out } = makeCtx('POST', '/api/daily-log', { agent_id: 'agent-b', content: '  did the thing  ' })
    expect(await tryHandleDailyLog(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })

    const today = new Date().toISOString().split('T')[0]
    const { ctx: getCtx, out: getOut } = makeCtx('GET', `/api/daily-log?agent=agent-b&date=${today}`)
    expect(await tryHandleDailyLog(getCtx)).toBe(true)
    expect(getOut.body).toHaveLength(1)
    expect(getOut.body[0].content).toBe('did the thing')
  })

  it('POST falls back to MAIN_AGENT_ID when agent_id is omitted', async () => {
    const { ctx } = makeCtx('POST', '/api/daily-log', { content: 'main agent entry' })
    expect(await tryHandleDailyLog(ctx)).toBe(true)

    const today = new Date().toISOString().split('T')[0]
    const { ctx: getCtx, out: getOut } = makeCtx('GET', `/api/daily-log?date=${today}`)
    await tryHandleDailyLog(getCtx)
    expect(getOut.body.some((e: any) => e.content === 'main agent entry')).toBe(true)
    // Confirm it was actually filed under MAIN_AGENT_ID, not some other default.
    const { ctx: mainCtx, out: mainOut } = makeCtx('GET', `/api/daily-log?agent=${MAIN_AGENT_ID}&date=${today}`)
    await tryHandleDailyLog(mainCtx)
    expect(mainOut.body.some((e: any) => e.content === 'main agent entry')).toBe(true)
  })

  it('GET defaults date to today when omitted', async () => {
    const { ctx } = makeCtx('POST', '/api/daily-log', { agent_id: 'agent-c', content: 'no explicit date' })
    await tryHandleDailyLog(ctx)

    const { ctx: getCtx, out: getOut } = makeCtx('GET', '/api/daily-log?agent=agent-c')
    expect(await tryHandleDailyLog(getCtx)).toBe(true)
    expect(getOut.body.some((e: any) => e.content === 'no explicit date')).toBe(true)
  })

  it('GET returns an empty array for a date with no entries', async () => {
    const { ctx, out } = makeCtx('GET', '/api/daily-log?agent=agent-c&date=2000-01-01')
    expect(await tryHandleDailyLog(ctx)).toBe(true)
    expect(out.body).toEqual([])
  })

  it('GET /dates lists the distinct dates an agent has entries for', async () => {
    const { ctx } = makeCtx('POST', '/api/daily-log', { agent_id: 'agent-d', content: 'entry one' })
    await tryHandleDailyLog(ctx)

    const { ctx: datesCtx, out: datesOut } = makeCtx('GET', '/api/daily-log/dates?agent=agent-d')
    expect(await tryHandleDailyLog(datesCtx)).toBe(true)
    const today = new Date().toISOString().split('T')[0]
    expect(datesOut.body).toContain(today)
  })

  it('GET /dates falls back to MAIN_AGENT_ID when agent is omitted', async () => {
    const { ctx } = makeCtx('POST', '/api/daily-log', { content: 'main agent dates entry' })
    await tryHandleDailyLog(ctx)

    const { ctx: datesCtx, out: datesOut } = makeCtx('GET', '/api/daily-log/dates')
    await tryHandleDailyLog(datesCtx)
    const today = new Date().toISOString().split('T')[0]
    expect(datesOut.body).toContain(today)
  })

  it('GET /dates returns an empty array for an agent with no entries', async () => {
    const { ctx, out } = makeCtx('GET', '/api/daily-log/dates?agent=never-logged-agent')
    expect(await tryHandleDailyLog(ctx)).toBe(true)
    expect(out.body).toEqual([])
  })
})

// Tenant-IDOR guard (kanban 45d7a63a item 1A): a tenant-scoped caller must
// not read or write another tenant's daily log. Regression coverage for the
// bug as reported -- previously appendDailyLog/getDailyLog/getDailyLogDates
// had zero tenant checks, so any token-holder could read or write any
// agent's journal.
describe('tryHandleDailyLog: tenant-IDOR guard', () => {
  beforeAll(() => {
    createTenant('tenant-daily-a', 'Tenant Daily A')
    createTenant('tenant-daily-b', 'Tenant Daily B')
    setTenantAgentAvailability('tenant-daily-a', 'tenant-a-agent', true)
    setTenantAgentAvailability('tenant-daily-b', 'tenant-b-agent', true)
  })

  it('POST is blocked (403) when the target agent belongs to a different tenant', async () => {
    const { ctx, out } = makeCtx(
      'POST', '/api/daily-log',
      { agent_id: 'tenant-b-agent', content: 'cross-tenant write attempt' },
      { role: 'agent', tenantId: 'tenant-daily-a' },
    )
    expect(await tryHandleDailyLog(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ error: 'forbidden', hint: 'agent not in your tenant' })
  })

  it('POST succeeds when the target agent belongs to the caller\'s own tenant', async () => {
    const { ctx, out } = makeCtx(
      'POST', '/api/daily-log',
      { agent_id: 'tenant-a-agent', content: 'same-tenant write' },
      { role: 'agent', tenantId: 'tenant-daily-a' },
    )
    expect(await tryHandleDailyLog(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('GET is blocked (403) when reading another tenant\'s agent journal', async () => {
    const { ctx, out } = makeCtx(
      'GET', '/api/daily-log?agent=tenant-b-agent',
      undefined,
      { role: 'agent', tenantId: 'tenant-daily-a' },
    )
    expect(await tryHandleDailyLog(ctx)).toBe(true)
    expect(out.status).toBe(403)
  })

  it('GET /dates is blocked (403) when reading another tenant\'s agent journal', async () => {
    const { ctx, out } = makeCtx(
      'GET', '/api/daily-log/dates?agent=tenant-b-agent',
      undefined,
      { role: 'agent', tenantId: 'tenant-daily-a' },
    )
    expect(await tryHandleDailyLog(ctx)).toBe(true)
    expect(out.status).toBe(403)
  })

  it('admin role bypasses the tenant guard on all three verbs', async () => {
    const { ctx: postCtx, out: postOut } = makeCtx(
      'POST', '/api/daily-log',
      { agent_id: 'tenant-b-agent', content: 'admin cross-tenant write' },
      { role: 'admin' },
    )
    expect(await tryHandleDailyLog(postCtx)).toBe(true)
    expect(postOut.status).toBe(200)

    const { ctx: getCtx, out: getOut } = makeCtx('GET', '/api/daily-log?agent=tenant-b-agent', undefined, { role: 'admin' })
    await tryHandleDailyLog(getCtx)
    expect(getOut.status).toBe(200)

    const { ctx: datesCtx, out: datesOut } = makeCtx('GET', '/api/daily-log/dates?agent=tenant-b-agent', undefined, { role: 'admin' })
    await tryHandleDailyLog(datesCtx)
    expect(datesOut.status).toBe(200)
  })
})
