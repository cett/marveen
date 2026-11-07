// GET /api/admin/sender-route-audit: the real route handler, the real db query and the REAL audit writer
// (auditRouteVerdict) over an in-memory database, so the rows the endpoint counts are the rows the rule writes, not
// a hand-made shape. Neutral fixtures only (agent-a, agent-b, main-a, tenant-x).

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initDatabase, getDb, createAgentMessage } from '../db.js'
import { auditRouteVerdict, type RouteVerdict } from '../web/sender-routing-wire.js'
import { tryHandleSenderRouteAudit } from '../web/routes/sender-route-audit.js'
import { ENDPOINT_PERMISSION_TABLE, hasPermission, resolveRequiredPermission } from '../web/rbac.js'
import { SENDER_ROUTE_AUDIT_MAX_ROWS } from '../web/sender-route-audit.js'
import { normalizePath } from '../web/routes/versioning.js'
import type { Role } from '../web/rbac.js'
import type { RouteContext } from '../web/routes/types.js'

const PATH = '/api/admin/sender-route-audit'
const NOW = 1_800_000_000 // a fixed "now" in seconds

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
  getDb().exec("DELETE FROM agent_audit_log; DELETE FROM agent_messages;")
})
afterEach(() => { vi.useRealTimers() })

interface Over { role?: string; tenantId?: string | null; authKind?: string }
function call(method: string, pathWithQuery: string, over: Over = {}): Promise<{ handled: boolean; status: number; raw: string; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  const out = { status: 200, raw: '' }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) { if (b) out.raw = Buffer.isBuffer(b) ? b.toString('utf-8') : b },
  }
  const url = new URL(`http://localhost:3420${pathWithQuery}`)
  const ctx = {
    req, res, path: url.pathname, method, url,
    role: over.role ?? 'admin', tenantId: over.tenantId === undefined ? null : over.tenantId, auth: { kind: over.authKind ?? 'token' },
  } as unknown as RouteContext
  return tryHandleSenderRouteAudit(ctx).then((handled) => ({
    handled, status: out.status, raw: out.raw, body: out.raw ? JSON.parse(out.raw) : null,
  }))
}

/** A row exactly as auditRouteVerdict writes it, with a chosen age (seconds before NOW). */
async function write(v: Partial<RouteVerdict> & { stage?: 'route' | 'delivery'; entityId?: number }, ageSecs = 60): Promise<void> {
  const verdict: RouteVerdict = {
    mode: 'audit', lane: 'routed', senderClass: 'fleet_agent', senderId: 'agent-a', to: 'agent-b',
    decision: { ok: false, reason: 'not_trusted_peer' }, deny: false, ...v,
  }
  await auditRouteVerdict(verdict, v.stage ?? 'route', { ...(v.entityId !== undefined ? { entityId: v.entityId } : {}), principal: 'principal-a', principalSource: 'token' })
  getDb().prepare("UPDATE agent_audit_log SET created_at = ? WHERE id = (SELECT MAX(id) FROM agent_audit_log)").run(NOW - ageSecs)
}

describe('who may ask', () => {
  it('refuses every caller that is not a global admin, with no counts in the body', async () => {
    await write({})
    for (const role of ['agent', 'read_only', 'viewer', 'fleet_agent']) {
      const r = await call('GET', PATH, { role })
      expect(r.handled, role).toBe(true)
      expect(r.status, role).toBe(403)
      expect(r.body.error, role).toBe('forbidden')
      expect(r.body.by_stage, role).toBeUndefined()
      expect(r.body.pairs, role).toBeUndefined()
    }
    const tenantAdmin = await call('GET', PATH, { role: 'admin', tenantId: 'tenant-x' })
    expect(tenantAdmin.status).toBe(403)
    expect(tenantAdmin.body.by_stage).toBeUndefined()
  })

  it('both prefixes reach the same handler through the real path normalisation, and a non-admin gets 403 on each', async () => {
    for (const raw of [PATH, '/api/v1/admin/sender-route-audit']) {
      const { path } = normalizePath(raw)
      expect(path, raw).toBe(PATH)
      for (const role of ['agent', 'read_only', 'viewer', 'fleet_agent']) {
        const r = await call('GET', path, { role })
        expect(r.status, `${raw} ${role}`).toBe(403)
        expect(r.body.by_stage, `${raw} ${role}`).toBeUndefined()
      }
      expect((await call('GET', path)).status, raw).toBe(200)
    }
  })

  it('answers a global admin, by token and by session', async () => {
    expect((await call('GET', PATH)).status).toBe(200)
    expect((await call('GET', PATH, { authKind: 'session' })).status).toBe(200)
    expect((await call('GET', PATH, { tenantId: 'default' })).status).toBe(200)
  })

  it('only handles GET on its own path', async () => {
    expect((await call('POST', PATH)).handled).toBe(false)
    expect((await call('GET', `${PATH}s`)).handled).toBe(false)
    expect((await call('GET', '/api/admin/sender-route')).handled).toBe(false)
  })

  it('is named in the RBAC table on both prefixes, as admin:all, and no other role holds that permission', () => {
    for (const p of [PATH, '/api/v1/admin/sender-route-audit']) {
      const hit = ENDPOINT_PERMISSION_TABLE.find((e) => 'pathPattern' in e && e.pathPattern === p && !e.prefix)
      expect(hit, p).toMatchObject({ method: 'GET', permission: 'admin:all' })
      const need = resolveRequiredPermission('GET', p)
      expect(need, p).toBe('admin:all')
      for (const r of ['agent', 'read_only', 'viewer', 'fleet_agent'] as Role[]) expect(hasPermission(r, need!), `${p} ${r}`).toBe(false)
      expect(hasPermission('admin', need!), p).toBe(true)
    }
  })

  it('the handler is registered in web.ts and reads the audit rows (not a stub)', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const web = readFileSync(join(here, '../web.ts'), 'utf-8')
    expect(web).toContain("import { tryHandleSenderRouteAudit } from './web/routes/sender-route-audit.js'")
    expect(web).toContain('.add(tryHandleSenderRouteAudit)')
    expect(readFileSync(join(here, '../web/routes/sender-route-audit.ts'), 'utf-8')).toContain('listSenderRouteChecks(')
  })
})

describe('the days parameter', () => {
  it('defaults to 7 and answers the window start', async () => {
    const r = await call('GET', PATH)
    expect(r.status).toBe(200)
    expect(r.body.days).toBe(7)
    expect(r.body.since).toBe(NOW - 7 * 86400)
  })

  it('takes a whole number from 1 to 90', async () => {
    for (const d of ['1', '30', '90']) {
      const r = await call('GET', `${PATH}?days=${d}`)
      expect(r.status, d).toBe(200)
      expect(r.body.days, d).toBe(Number(d))
      expect(r.body.since, d).toBe(NOW - Number(d) * 86400)
    }
  })

  it('refuses anything else with invalid_value and the field name, and reads nothing', async () => {
    for (const d of ['0', '91', '-1', '1.5', 'abc', '7d', '%207', '1e1', '0x5', '999999999999999999999']) {
      const r = await call('GET', `${PATH}?days=${d}`)
      expect(r.status, d).toBe(400)
      expect(r.body.error, d).toBe('invalid_value')
      expect(r.body.field, d).toBe('days')
      expect(r.body.by_stage, d).toBeUndefined()
    }
  })

  it('an empty value is the default', async () => {
    const r = await call('GET', `${PATH}?days=`)
    expect(r.status).toBe(200)
    expect(r.body.days).toBe(7)
  })

  it('the documented edge cases: a missing or empty value is 7, and when it is given more than once the first one counts', async () => {
    for (const q of ['', '?days=', '?days=7&days=abc']) {
      const r = await call('GET', `${PATH}${q}`)
      expect(r.status, q).toBe(200)
      expect(r.body.days, q).toBe(7)
      expect(r.body.since, q).toBe(NOW - 7 * 86400)
    }
    const first = await call('GET', `${PATH}?days=3&days=90`)
    expect(first.status).toBe(200)
    expect(first.body.days).toBe(3)
    // the first one counts also when it is the bad one
    const bad = await call('GET', `${PATH}?days=abc&days=7`)
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: 'invalid_value', field: 'days' })
  })
})

describe('the window', () => {
  it('a row exactly at the start of the window is in, one second older is out', async () => {
    await write({}, 7 * 86400)       // exactly at since
    await write({}, 7 * 86400 + 1)   // one second before
    const r = await call('GET', PATH)
    expect(r.body.by_stage.route.total).toBe(1)
  })

  it('the days parameter moves the start', async () => {
    await write({}, 3600)             // 1 hour old
    await write({}, 2 * 86400)        // 2 days old
    await write({}, 5 * 86400)        // 5 days old
    expect((await call('GET', `${PATH}?days=1`)).body.by_stage.route.total).toBe(1)
    expect((await call('GET', `${PATH}?days=3`)).body.by_stage.route.total).toBe(2)
    expect((await call('GET', `${PATH}?days=7`)).body.by_stage.route.total).toBe(3)
  })

  it('rows of other actions and other entities are not counted, even with a verdict-shaped detail', async () => {
    await write({})
    const db = getDb()
    const detail = JSON.stringify({ stage: 'route', mode: 'audit', lane: 'routed', senderClass: 'fleet_agent', from: 'agent-a', to: 'agent-b', ok: false, reason: 'not_trusted_peer', denied: false })
    db.prepare("INSERT INTO agent_audit_log (agent_id, entity, action, detail, created_at) VALUES ('agent-a', 'message', 'create', ?, ?)").run(detail, NOW - 10)
    db.prepare("INSERT INTO agent_audit_log (agent_id, entity, action, detail, created_at) VALUES ('agent-a', 'memory', 'sender_route_checked', ?, ?)").run(detail, NOW - 10)
    const r = await call('GET', PATH)
    expect(r.body.by_stage.route.total).toBe(1)
  })
})

describe('what is counted', () => {
  it('there is no top-level total, would_deny, denied, by_reason or by_mode: the two stages are two blocks', async () => {
    await write({ mode: 'audit' })
    await write({ stage: 'delivery', entityId: 601 })
    const r = await call('GET', PATH)
    for (const k of ['total', 'would_deny', 'denied', 'by_reason', 'by_mode']) expect(r.body, k).not.toHaveProperty(k)
    expect(Object.keys(r.body.by_stage).sort()).toEqual(['delivery', 'route'])
  })

  it('audit mode: a not-ok route verdict is a would_deny and denied stays 0', async () => {
    await write({ mode: 'audit' })
    const r = await call('GET', PATH)
    expect(r.body.truncated).toBe(false)
    expect(r.body.by_stage.route).toEqual({
      total: 1, would_deny: 1, denied: 0,
      by_reason: { not_trusted_peer: 1 },
      by_mode: { audit: { total: 1, would_deny: 1, denied: 0 } },
    })
    expect(r.body.by_stage.delivery).toMatchObject({ total: 0, would_deny: 0, denied: 0, by_reason: {}, by_mode: {} })
  })

  it('enforce mode: a refusal is a would_deny and a denied', async () => {
    await write({ mode: 'enforce', deny: true })
    const r = await call('GET', PATH)
    expect(r.body.by_stage.route).toMatchObject({ total: 1, would_deny: 1, denied: 1 })
    expect(r.body.by_stage.route.by_mode.enforce).toEqual({ total: 1, would_deny: 1, denied: 1 })
  })

  it('an allowed verdict is counted in total only', async () => {
    await write({ decision: { ok: true } })
    expect((await call('GET', PATH)).body.by_stage.route).toMatchObject({ total: 1, would_deny: 0, denied: 0, by_reason: {} })
  })

  it('audit mode: a not-ok route row and the delivery row of the same message are one unit in each block and are added nowhere', async () => {
    const m = await createAgentMessage('agent-a', 'agent-b', 'same message', null, null, 'default')
    await write({ stage: 'route', mode: 'audit' })
    await write({ stage: 'delivery', mode: 'audit', entityId: m.id })
    const r = await call('GET', PATH)
    expect(r.body.by_stage.route).toMatchObject({ total: 1, would_deny: 1 })
    expect(r.body.by_stage.delivery).toMatchObject({ total: 1, would_deny: 1 })
    expect(r.body).not.toHaveProperty('total')
    expect(r.body.pairs.map((p: { stage: string; count: number }) => `${p.stage}:${p.count}`).sort()).toEqual(['delivery:1', 'route:1'])
  })

  it('delivery block: the rows of one message id and mode are one unit; the same id in two modes is two units, by mode', async () => {
    for (let i = 0; i < 3; i++) await write({ stage: 'delivery', entityId: 501 })
    await write({ stage: 'delivery', entityId: 501, mode: 'enforce', deny: true }, 10)
    await write({ stage: 'delivery', entityId: 502 })
    const d = (await call('GET', PATH)).body.by_stage.delivery
    expect(d.total).toBe(3)
    expect(d.by_mode.audit.total).toBe(2)
    expect(d.by_mode.enforce).toEqual({ total: 1, would_deny: 1, denied: 1 })
  })

  it('route block: route rows carry no message id, each is a unit of its own; the self-message count reads from its pairs', async () => {
    await write({ stage: 'route' })
    await write({ stage: 'route' })
    await write({ stage: 'route', senderId: 'agent-b', to: 'agent-b', decision: { ok: true } })
    await write({ stage: 'delivery', senderId: 'agent-b', to: 'agent-b', decision: { ok: false, reason: 'not_trusted_peer' }, entityId: 700 })
    const r = await call('GET', PATH)
    expect(r.body.by_stage.route.total).toBe(3)
    const selfRoute = r.body.pairs.filter((p: { from: string; to: string; stage: string }) => p.from === p.to && p.stage === 'route')
    expect(selfRoute).toHaveLength(1)
    expect(selfRoute[0]).toMatchObject({ ok: true, count: 1 })
    expect(r.body.pairs.find((p: { from: string; stage: string }) => p.from === 'agent-a' && p.stage === 'route').count).toBe(2)
  })
})

describe('what is not in the answer', () => {
  it('no message content, no message id, no principal, no entity id', async () => {
    const m = await createAgentMessage('agent-a', 'agent-b', 'content-marker-a: do not echo', null, null, 'default')
    await write({ stage: 'delivery', entityId: m.id })
    await write({ stage: 'route' })
    const r = await call('GET', PATH)
    expect(r.raw).not.toContain('content-marker-a')
    expect(r.raw).not.toContain('principal-a')
    expect(r.raw).not.toContain('entity_id')
    expect(r.raw).not.toContain('"id"')
    expect(Object.keys(r.body).sort()).toEqual(['by_stage', 'days', 'pairs', 'pairs_truncated', 'since', 'truncated', 'unreadable'])
    expect(Object.keys(r.body.by_stage.route).sort()).toEqual(['by_mode', 'by_reason', 'denied', 'total', 'would_deny'])
  })
})

describe('the row limit', () => {
  it('a window with exactly the limit is not truncated; one more is, and the newest rows are kept', async () => {
    const db = getDb()
    const detail = JSON.stringify({ stage: 'route', mode: 'audit', lane: 'routed', senderClass: 'fleet_agent', from: 'agent-a', to: 'agent-b', ok: true, reason: null, denied: false })
    const oldDetail = detail.replace('"ok":true', '"ok":false')
    const ins = db.prepare("INSERT INTO agent_audit_log (agent_id, entity, action, detail, created_at) VALUES ('agent-a', 'message', 'sender_route_checked', ?, ?)")
    db.transaction(() => {
      ins.run(oldDetail, NOW - 100) // the oldest row: the one a truncated answer leaves out
      for (let i = 1; i < SENDER_ROUTE_AUDIT_MAX_ROWS; i++) ins.run(detail, NOW - 50)
    })()
    const exact = await call('GET', PATH)
    expect(exact.body.truncated).toBe(false)
    expect(exact.body.by_stage.route.total).toBe(SENDER_ROUTE_AUDIT_MAX_ROWS)
    expect(exact.body.by_stage.route.would_deny).toBe(1)

    ins.run(detail, NOW - 40)
    const over = await call('GET', PATH)
    expect(over.body.truncated).toBe(true)
    expect(over.body.by_stage.route.total).toBe(SENDER_ROUTE_AUDIT_MAX_ROWS)
    expect(over.body.by_stage.route.would_deny).toBe(0) // the oldest row (the only not-ok one) was cut
  }, 30_000)
})
