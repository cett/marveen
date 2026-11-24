// GET /api/admin/pg-runtime-status: the database backend and the schema state, versions only. Admin only (named in the RBAC
// table on both prefixes). The answer never carries the URL, a password, or the marker's value. The override is read
// from the process environment only.
//
// Privacy: neutral fixtures only (leakmarker, placeholder-pass).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { tryHandlePgRuntimeStatus } from '../web/routes/pg-runtime-status.js'
import { ENDPOINT_PERMISSION_TABLE, hasPermission, resolveRequiredPermission } from '../web/rbac.js'
import type { Role } from '../web/rbac.js'
import type { RouteContext } from '../web/routes/types.js'
import { loadPgMigrationFiles } from '../db-migrations-pg.js'

const PATH = '/api/admin/pg-runtime-status'
const LEAK = 'leakmarker'
// the shipped highest, counted from the files this build ships (the route must answer this, not the recorded state)
const SHIPPED = String(Math.max(0, ...loadPgMigrationFiles().map((f) => f.version))).padStart(4, '0')

// The recorded PostgreSQL state the route reads (set by a real boot; here a fixed value per cell).
const pgState = vi.hoisted(() => ({
  value: null as null | { backend: 'pg'; runningOnNewerDatabase: boolean; databaseHighest: number | null; shippedHighest: number | null },
}))
vi.mock('../db/pg-boot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pg-boot.js')>()
  return { ...actual, pgRuntimeStatus: () => pgState.value }
})

function call(method: string, path: string, role = 'admin'): Promise<{ handled: boolean; status: number; raw: string; body: any }> {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  const out = { status: 200, raw: '' }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) { if (b) out.raw = Buffer.isBuffer(b) ? b.toString('utf-8') : b },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, role, tenantId: null, auth: { kind: 'token' } } as unknown as RouteContext
  return tryHandlePgRuntimeStatus(ctx).then((handled) => ({
    handled, status: out.status, raw: out.raw, body: out.raw ? JSON.parse(out.raw) : null,
  }))
}

beforeEach(() => {
  pgState.value = null
  vi.stubEnv('MARVEEN_PG_ALLOW_NEWER_DATABASE', '')
  vi.stubEnv('MARVEEN_PG_CONFIGURED', '')
  vi.stubEnv('MARVEEN_PG_URL', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/admin/pg-runtime-status', () => {
  it('a recorded NEWER database: backend pg, runningOnNewerDatabase true, the database highest 9999 (padded)', async () => {
    pgState.value = { backend: 'pg', runningOnNewerDatabase: true, databaseHighest: 9999, shippedHighest: 999 }
    const r = await call('GET', PATH, 'admin')
    expect(r.status).toBe(200)
    expect(r.body.backend).toBe('pg')
    expect(r.body.runningOnNewerDatabase).toBe(true)
    expect(r.body.databaseHighest).toBe('9999')
    expect(r.body.shippedHighest).toBe(SHIPPED)
  })

  it('a recorded CURRENT database: backend pg, runningOnNewerDatabase false, the highest versions equal', async () => {
    pgState.value = { backend: 'pg', runningOnNewerDatabase: false, databaseHighest: 9, shippedHighest: 999 }
    const r = await call('GET', PATH, 'admin')
    expect(r.status).toBe(200)
    expect(r.body.backend).toBe('pg')
    expect(r.body.runningOnNewerDatabase).toBe(false)
    expect(r.body.databaseHighest).toBe('0009')
    // the shipped highest comes from the files this build ships, not from the recorded state (999 above)
    expect(r.body.shippedHighest).toBe(SHIPPED)
  })

  it('admin: 200 and exactly the documented shape; a SQLite install reports backend sqlite and no newer database', async () => {
    const r = await call('GET', PATH, 'admin')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(Object.keys(r.body).sort()).toEqual(['backend', 'databaseHighest', 'overrideEnabled', 'runningOnNewerDatabase', 'shippedHighest'])
    expect(r.body.backend).toBe('sqlite')
    expect(r.body.runningOnNewerDatabase).toBe(false)
    expect(r.body.databaseHighest).toBeNull()
    expect(r.body.shippedHighest).toMatch(/^\d{4}$/)
  })

  it('non-admin roles are refused with 403 and no payload', async () => {
    for (const role of ['agent', 'viewer', 'read_only', 'fleet_agent']) {
      const r = await call('GET', PATH, role)
      expect(r.handled, role).toBe(true)
      expect(r.status, role).toBe(403)
      expect(r.body.backend, role).toBeUndefined()
    }
  })

  it('the override is read from the process environment: off when unset or not 1, on when 1', async () => {
    expect((await call('GET', PATH)).body.overrideEnabled).toBe(false)
    vi.stubEnv('MARVEEN_PG_ALLOW_NEWER_DATABASE', '0')
    expect((await call('GET', PATH)).body.overrideEnabled).toBe(false)
    vi.stubEnv('MARVEEN_PG_ALLOW_NEWER_DATABASE', '1')
    expect((await call('GET', PATH)).body.overrideEnabled).toBe(true)
  })

  it('the answer carries no URL, no password, and no marker value, even with the URL and the marker set', async () => {
    vi.stubEnv('MARVEEN_PG_URL', `postgres://user:placeholder-pass@${LEAK}.invalid/db`)
    vi.stubEnv('MARVEEN_PG_CONFIGURED', '1')
    const r = await call('GET', PATH)
    expect(r.status).toBe(200)
    expect(r.raw).not.toContain(LEAK)
    expect(r.raw).not.toContain('placeholder-pass')
    expect(r.raw).not.toContain('postgres://')
  })

  it('is named in the RBAC table on both prefixes as admin:all, and only admin holds it', () => {
    for (const p of [PATH, '/api/v1/admin/pg-runtime-status']) {
      const need = resolveRequiredPermission('GET', p)
      expect(need, p).toBe('admin:all')
      for (const r of ['agent', 'viewer', 'read_only', 'fleet_agent'] as Role[]) expect(hasPermission(r, need!), `${p} ${r}`).toBe(false)
      expect(hasPermission('admin', need!), p).toBe(true)
    }
    expect(ENDPOINT_PERMISSION_TABLE.some((e) => e.pathPattern === PATH)).toBe(true)
  })

  it('an unrelated path or method is not handled', async () => {
    expect((await call('GET', '/api/admin/pg-runtime-status-other')).handled).toBe(false)
    expect((await call('POST', PATH)).handled).toBe(false)
  })
})
