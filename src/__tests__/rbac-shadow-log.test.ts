// Persistent RBAC shadow log: migration 0068, the recorder, the gate wiring (runRbacGate),
// retention, the query/summary helpers and the admin-only GET /api/v1/rbac/shadow-log route.
// Real DB (migrations applied to :memory:), real gate, real route handler. No persistence mocks.
//
// Privacy: neutral fixtures only (user-a, token-a, device-a, peer-a, tenant-a/b).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import type Database from 'better-sqlite3'
import type { AuthResult } from '../web/auth-gate.js'
import type { RouteContext } from '../web/routes/types.js'
import type { Role } from '../web/rbac.js'

let dbMod: typeof import('../db.js')
let log: typeof import('../web/rbac-shadow-log.js')
let route: typeof import('../web/routes/rbac-shadow-log.js')
let db: Database.Database

const NOW = 1_800_000_000
const DAY = 86_400

beforeEach(async () => {
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  db = dbMod.getDb()
  log = await import('../web/rbac-shadow-log.js')
  route = await import('../web/routes/rbac-shadow-log.js')
  log.resetPruneThrottleForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const session = (role?: Role, tenantId?: string | null): AuthResult => ({ kind: 'session', user: 'user-a', role, tenantId })
const rows = () => db.prepare('SELECT * FROM rbac_shadow_log ORDER BY id').all() as Array<Record<string, unknown>>
const res = () => {
  const out = { status: 0, body: '' }
  const r = {
    writeHead: vi.fn((s: number) => { out.status = s }),
    setHeader: vi.fn(),
    end: vi.fn((b?: string) => { out.body = b ?? '' }),
  }
  return { r: r as unknown as http.ServerResponse, out }
}

/** Direct insert with explicit ts, bypassing the recorder (and its prune). */
function seed(over: Partial<{ ts: number; tenant_id: string | null; principal_kind: string; principal: string; role: string; method: string; route: string; permission: string; decision: string; reason: string }> = {}) {
  const v = { ts: NOW, tenant_id: 'tenant-a', principal_kind: 'session', principal: 'user-a', role: 'viewer', method: 'POST', route: '/api/kanban/cards', permission: 'kanban:write', decision: 'would-deny', reason: 'r', ...over }
  db.prepare(
    'INSERT INTO rbac_shadow_log (ts, tenant_id, principal_kind, principal, role, method, route, permission, decision, reason) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(v.ts, v.tenant_id, v.principal_kind, v.principal, v.role, v.method, v.route, v.permission, v.decision, v.reason)
}

describe('migration 0068', () => {
  it('creates the table with the decision CHECK constraint', () => {
    expect(() => seed({ decision: 'bogus' })).toThrow(/CHECK/i)
    expect(() => seed({ decision: 'would-deny' })).not.toThrow()
    expect(() => seed({ decision: 'denied' })).not.toThrow()
    expect(() => seed({ decision: 'permitted' })).not.toThrow()
  })

  it('creates the ts and decision+ts indexes the retention prune and the filters rely on', () => {
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='rbac_shadow_log'").all() as Array<{ name: string }>).map(r => r.name)
    expect(idx).toEqual(expect.arrayContaining(['idx_rbac_shadow_log_ts', 'idx_rbac_shadow_log_decision_ts']))
  })
})

describe('recordRbacDecision', () => {
  it('stores the caller, tenant, role, required permission and reason', () => {
    expect(log.recordRbacDecision(session('viewer', 'tenant-a'), 'POST', '/api/kanban/cards', 'would-deny', 'role lacks permission', NOW)).toBe(true)
    expect(rows()).toEqual([
      expect.objectContaining({
        ts: NOW, tenant_id: 'tenant-a', principal_kind: 'session', principal: 'user-a', role: 'viewer',
        method: 'POST', route: '/api/kanban/cards', permission: 'kanban:write', decision: 'would-deny', reason: 'role lacks permission',
      }),
    ])
  })

  it.each([
    ['token with a name', { kind: 'token', role: 'agent', tenantId: 'tenant-b', tokenName: 'token-a' } as AuthResult, 'token', 'token-a', 'tenant-b'],
    ['legacy file token (no name, defaults to the default tenant)', { kind: 'token' } as AuthResult, 'token', '', 'default'],
    ['device', { kind: 'device', device: 'device-a', deviceId: 1 } as AuthResult, 'device', 'device-a', 'default'],
    ['federation peer', { kind: 'federation', peer: 'peer-a' } as AuthResult, 'federation', 'peer-a', 'default'],
  ])('principal label: %s', (_n, auth, kind, name, tenant) => {
    log.recordRbacDecision(auth, 'GET', '/api/memories', 'permitted', '', NOW)
    expect(rows()[0]).toMatchObject({ principal_kind: kind, principal: name, tenant_id: tenant })
  })

  it('a global-scope session (tenantId null) is stored as NULL, not as a tenant', () => {
    log.recordRbacDecision(session('viewer', null), 'GET', '/api/memories', 'permitted', '', NOW)
    expect(rows()[0]!['tenant_id']).toBeNull()
  })

  it('an unmapped route is recorded with the strictest permission, admin:all', () => {
    log.recordRbacDecision(session('viewer'), 'GET', '/api/no-such-route-anywhere', 'would-deny', 'x', NOW)
    expect(rows()[0]!['permission']).toBe('admin:all')
  })

  it('unauthenticated principals are never recorded', () => {
    expect(log.recordRbacDecision({ kind: 'none' }, 'GET', '/api/memories', 'permitted', '', NOW)).toBe(false)
    expect(rows()).toHaveLength(0)
  })

  it('a failed insert never throws into the request path and says so', async () => {
    const { logger } = await import('../logger.js')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    db.exec('DROP TABLE rbac_shadow_log')
    let ok: boolean | undefined
    expect(() => { ok = log.recordRbacDecision(session('viewer'), 'GET', '/api/memories', 'permitted', '', NOW) }).not.toThrow()
    expect(ok).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ decision: 'permitted' }), expect.stringContaining('insert failed'))
  })
})

describe('retention', () => {
  it('prunes strictly older than 30 days: the boundary second survives, one second older goes', () => {
    const cutoff = NOW - log.RETENTION_DAYS * DAY
    seed({ ts: cutoff - 1, route: '/old' })
    seed({ ts: cutoff, route: '/boundary' })
    seed({ ts: NOW, route: '/new' })
    expect(log.pruneShadowLog(NOW)).toBe(1)
    expect((rows().map(r => r['route']))).toEqual(['/boundary', '/new'])
  })

  it('retention is 30 days', () => {
    expect(log.RETENTION_DAYS).toBe(30)
  })

  it('a record opportunistically prunes old rows', () => {
    seed({ ts: NOW - 31 * DAY, route: '/old' })
    log.recordRbacDecision(session('viewer'), 'GET', '/api/memories', 'permitted', '', NOW)
    expect(rows().map(r => r['route'])).toEqual(['/api/memories'])
  })

  it('the opportunistic prune is throttled to once per interval', () => {
    log.recordRbacDecision(session('viewer'), 'GET', '/api/memories', 'permitted', '', NOW) // prunes, arms the throttle
    seed({ ts: NOW - 31 * DAY, route: '/old' })
    log.recordRbacDecision(session('viewer'), 'GET', '/api/memories', 'permitted', '', NOW + log.PRUNE_INTERVAL_SEC - 1)
    expect(rows().some(r => r['route'] === '/old')).toBe(true) // still inside the interval: not pruned
    log.recordRbacDecision(session('viewer'), 'GET', '/api/memories', 'permitted', '', NOW + log.PRUNE_INTERVAL_SEC)
    expect(rows().some(r => r['route'] === '/old')).toBe(false)
  })
})

describe('runRbacGate (the web.ts wiring)', () => {
  it('shadow: a viewer write is let through and recorded as would-deny', () => {
    const { r } = res()
    expect(log.runRbacGate(session('viewer', 'tenant-a'), 'POST', '/api/kanban/cards', r, 'shadow')).toBe(true)
    expect(rows()).toEqual([expect.objectContaining({ decision: 'would-deny', permission: 'kanban:write', role: 'viewer' })])
    expect(r.writeHead).not.toHaveBeenCalled()
  })

  it('enforce: the same request is refused with 403 and recorded as denied (the refusal is persisted)', () => {
    const { r, out } = res()
    expect(log.runRbacGate(session('viewer', 'tenant-a'), 'POST', '/api/kanban/cards', r, 'enforce')).toBe(false)
    expect(out.status).toBe(403)
    expect(rows()).toEqual([expect.objectContaining({ decision: 'denied', permission: 'kanban:write' })])
  })

  it.each(['shadow', 'enforce'] as const)('%s: a permitted non-admin request is recorded as permitted', (mode) => {
    const { r } = res()
    expect(log.runRbacGate(session('viewer', 'tenant-a'), 'GET', '/api/memories', r, mode)).toBe(true)
    expect(rows()).toEqual([expect.objectContaining({ decision: 'permitted', role: 'viewer', reason: '' })])
  })

  it.each(['shadow', 'enforce'] as const)('%s: admin traffic (bearer token and admin session) writes nothing', (mode) => {
    for (const auth of [{ kind: 'token' } as AuthResult, session('admin', null)]) {
      expect(log.runRbacGate(auth, 'POST', '/api/kanban/cards', res().r, mode)).toBe(true)
    }
    expect(rows()).toHaveLength(0)
  })

  it('would-deny and permitted are mutually exclusive: one row per request', () => {
    log.runRbacGate(session('viewer'), 'POST', '/api/kanban/cards', res().r, 'shadow')
    log.runRbacGate(session('viewer'), 'GET', '/api/memories', res().r, 'shadow')
    expect(rows().map(r => r['decision'])).toEqual(['would-deny', 'permitted'])
  })

  it('a logging fault does not change the gate decision (enforce still refuses, shadow still passes)', () => {
    db.exec('DROP TABLE rbac_shadow_log')
    const { r, out } = res()
    expect(log.runRbacGate(session('viewer'), 'POST', '/api/kanban/cards', r, 'enforce')).toBe(false)
    expect(out.status).toBe(403)
    expect(log.runRbacGate(session('viewer'), 'POST', '/api/kanban/cards', res().r, 'shadow')).toBe(true)
  })
})

describe('queryShadowLog', () => {
  beforeEach(() => {
    seed({ ts: NOW - 30, tenant_id: 'tenant-a', principal: 'user-a', role: 'viewer', route: '/api/kanban/cards', permission: 'kanban:write', decision: 'would-deny' })
    seed({ ts: NOW - 20, tenant_id: 'tenant-b', principal: 'user-b', role: 'agent', route: '/api/memories', permission: 'memories:read', decision: 'permitted' })
    seed({ ts: NOW - 10, tenant_id: 'tenant-a', principal: 'user-a', role: 'viewer', route: '/api/schedules/x', permission: 'schedules:write', decision: 'denied' })
  })

  it('returns newest first with the total', () => {
    const r = log.queryShadowLog({})
    expect(r.total).toBe(3)
    expect(r.entries.map(e => e.route)).toEqual(['/api/schedules/x', '/api/memories', '/api/kanban/cards'])
  })

  it('same-second rows are ordered newest id first', () => {
    seed({ ts: NOW, route: '/first' })
    seed({ ts: NOW, route: '/second' })
    expect(log.queryShadowLog({}).entries.slice(0, 2).map(e => e.route)).toEqual(['/second', '/first'])
  })

  it.each([
    [{ decision: 'would-deny' as const }, ['/api/kanban/cards']],
    [{ decision: 'denied' as const }, ['/api/schedules/x']],
    [{ tenantId: 'tenant-b' }, ['/api/memories']],
    [{ principal: 'user-a' }, ['/api/schedules/x', '/api/kanban/cards']],
    [{ role: 'agent' }, ['/api/memories']],
    [{ permission: 'schedules:write' }, ['/api/schedules/x']],
    [{ route: 'schedules' }, ['/api/schedules/x']],
    [{ from: NOW - 20 }, ['/api/schedules/x', '/api/memories']],
    [{ to: NOW - 20 }, ['/api/kanban/cards']], // `to` is exclusive
    [{ from: NOW - 25, to: NOW - 5, decision: 'permitted' as const }, ['/api/memories']],
  ])('filter %j', (filter, expected) => {
    const r = log.queryShadowLog(filter)
    expect(r.entries.map(e => e.route)).toEqual(expected)
    expect(r.total).toBe(expected.length)
  })

  it('the route filter is a literal substring: LIKE wildcards in the input match nothing special', () => {
    expect(log.queryShadowLog({ route: '%' }).total).toBe(0)
    expect(log.queryShadowLog({ route: '_pi' }).total).toBe(0)
  })

  it('a filter that matches nothing returns an empty page, not an error', () => {
    expect(log.queryShadowLog({ principal: 'nobody' })).toMatchObject({ entries: [], total: 0 })
  })

  it('paginates and clamps the limit to [1, MAX_LIMIT] and the offset to >= 0', () => {
    expect(log.queryShadowLog({ limit: 1, offset: 1 }).entries.map(e => e.route)).toEqual(['/api/memories'])
    expect(log.queryShadowLog({ limit: 0 }).limit).toBe(1)
    expect(log.queryShadowLog({ limit: 100_000 }).limit).toBe(log.MAX_LIMIT)
    expect(log.queryShadowLog({ offset: -5 }).offset).toBe(0)
    expect(log.queryShadowLog({}).limit).toBe(log.DEFAULT_LIMIT)
  })
})

describe('summarizeShadowLog', () => {
  it('an empty table yields zeros, not nulls', () => {
    expect(log.summarizeShadowLog()).toEqual({
      from: null, to: null, total: 0,
      by_decision: { 'would-deny': 0, denied: 0, permitted: 0 },
      top_denials: [], denied_principals: [],
    })
  })

  it('counts by decision and ranks denial shapes; permitted rows are not a denial signal', () => {
    for (let i = 0; i < 3; i++) seed({ route: '/api/kanban/cards', decision: 'would-deny', principal: 'user-a' })
    seed({ route: '/api/schedules/x', permission: 'schedules:write', decision: 'denied', principal: 'user-b', role: 'agent' })
    for (let i = 0; i < 5; i++) seed({ route: '/api/memories', permission: 'memories:read', decision: 'permitted', principal: 'user-c' })
    const s = log.summarizeShadowLog()
    expect(s.by_decision).toEqual({ 'would-deny': 3, denied: 1, permitted: 5 })
    expect(s.total).toBe(9)
    expect(s.top_denials).toEqual([
      { method: 'POST', route: '/api/kanban/cards', permission: 'kanban:write', role: 'viewer', decision: 'would-deny', count: 3 },
      { method: 'POST', route: '/api/schedules/x', permission: 'schedules:write', role: 'agent', decision: 'denied', count: 1 },
    ])
    expect(s.denied_principals.map(p => [p.principal, p.count])).toEqual([['user-a', 3], ['user-b', 1]])
    expect(s.top_denials.some(d => d.route === '/api/memories')).toBe(false)
  })

  it('respects the time window and the tenant filter in every aggregate', () => {
    seed({ ts: NOW - 100, decision: 'would-deny', tenant_id: 'tenant-a', principal: 'user-old' })
    seed({ ts: NOW - 5, decision: 'would-deny', tenant_id: 'tenant-a', principal: 'user-a' })
    seed({ ts: NOW - 5, decision: 'would-deny', tenant_id: 'tenant-b', principal: 'user-b' })
    const windowed = log.summarizeShadowLog({ from: NOW - 10 })
    expect(windowed.by_decision['would-deny']).toBe(2)
    expect(windowed.denied_principals.map(p => p.principal).sort()).toEqual(['user-a', 'user-b'])
    const scoped = log.summarizeShadowLog({ from: NOW - 10, tenantId: 'tenant-b' })
    expect(scoped.by_decision['would-deny']).toBe(1)
    expect(scoped.denied_principals.map(p => p.principal)).toEqual(['user-b'])
    expect(windowed.from).toBe(NOW - 10)
  })

  it('caps the ranked lists at 20 entries', () => {
    for (let i = 0; i < 25; i++) seed({ route: `/api/r${i}`, principal: `user-${i}` })
    const s = log.summarizeShadowLog()
    expect(s.top_denials).toHaveLength(20)
    expect(s.denied_principals).toHaveLength(20)
    expect(s.by_decision['would-deny']).toBe(25)
  })
})

describe('GET /api/v1/rbac/shadow-log', () => {
  async function call(query = '', over: Partial<{ role: Role | undefined; method: string; path: string }> = {}) {
    const { r, out } = res()
    const url = new URL(`http://localhost:3420/api/rbac/shadow-log${query}`)
    const ctx = {
      req: {}, res: r, path: over.path ?? '/api/rbac/shadow-log', method: over.method ?? 'GET', url,
      role: 'role' in over ? over.role : 'admin', tenantId: null, auth: { kind: 'session', user: 'user-a' },
    } as unknown as RouteContext
    const claimed = await route.tryHandleRbacShadowLog(ctx)
    return { claimed, status: out.status, body: out.body ? JSON.parse(out.body) as Record<string, any> : {} }
  }

  it.each(['viewer', 'agent', 'read_only', undefined] as const)('non-admin (%s) gets 403 and no data, even in shadow mode', async (role) => {
    seed()
    const r = await call('', { role })
    expect(r.status).toBe(403)
    expect(r.body).toEqual({ error: 'forbidden', hint: expect.any(String) })
    expect(r.body['entries']).toBeUndefined()
  })

  it('an admin lists rows with filters', async () => {
    seed({ route: '/api/a', decision: 'would-deny' })
    seed({ route: '/api/b', decision: 'permitted' })
    const r = await call('?decision=permitted')
    expect(r.status).toBe(200)
    expect(r.body['total']).toBe(1)
    expect(r.body['entries'][0]).toMatchObject({ route: '/api/b', decision: 'permitted' })
  })

  it('?summary=1 returns the aggregate, not rows', async () => {
    seed({ decision: 'would-deny' })
    const r = await call('?summary=1')
    expect(r.status).toBe(200)
    expect(r.body['by_decision']).toMatchObject({ 'would-deny': 1 })
    expect(r.body['entries']).toBeUndefined()
  })

  it('since_hours windows by the clock', async () => {
    const now = Math.floor(Date.now() / 1000)
    seed({ ts: now - 3 * 3600, route: '/api/old' })
    seed({ ts: now - 60, route: '/api/recent' })
    const r = await call('?since_hours=1')
    expect(r.body['entries'].map((e: { route: string }) => e.route)).toEqual(['/api/recent'])
  })

  it.each([
    ['?decision=nope', 'decision'],
    ['?from=abc', 'from'],
    ['?from=-1', 'from'],
    ['?to=1.5', 'to'],
    ['?since_hours=x', 'since_hours'],
    ['?since_hours=2&from=5', 'since_hours'],
    ['?limit=0', 'limit'],
    ['?limit=abc', 'limit'],
    ['?offset=-1', 'offset'],
  ])('%s -> 400 invalid_value on %s', async (query, field) => {
    const r = await call(query)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'invalid_value', field })
  })

  it('does not claim other methods or paths', async () => {
    expect((await call('', { method: 'POST' })).claimed).toBe(false)
    expect((await call('', { path: '/api/rbac/other' })).claimed).toBe(false)
  })
})

describe('RBAC table row', () => {
  it('the whole /api/rbac/ namespace needs admin:all (legacy and canonical spelling reach it as /api/rbac)', async () => {
    const { resolveRequiredPermission } = await import('../web/rbac.js')
    expect(resolveRequiredPermission('GET', '/api/rbac/shadow-log')).toBe('admin:all')
    expect(resolveRequiredPermission('POST', '/api/rbac/anything')).toBe('admin:all')
  })
})
