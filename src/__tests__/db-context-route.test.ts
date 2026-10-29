// GET /api/admin/db-context: the measurement view of the db context counter, and its place in the RBAC table.

import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { dbx, runAs } from '../db.js'
import { tryHandleDbContext, DB_CONTEXT_TOP_SITES } from '../web/routes/db-context.js'
import { ENDPOINT_PERMISSION_TABLE } from '../web/rbac.js'
import type { RouteContext } from '../web/routes/types.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

function call(method: string, path: string): Promise<{ handled: boolean; status: number; body: any }> {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      if (!b) return
      const str = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(str) } catch { out.body = str }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, role: 'admin', tenantId: null } as unknown as RouteContext
  return tryHandleDbContext(ctx).then((handled) => ({ handled, status: out.status, body: out.body }))
}

describe('GET /api/admin/db-context', () => {
  it('splits the calls into expected, unexpected and anonymous and lists the sites without a context', async () => {
    await runAs.system('rbac-mode-refresh', async () => { await dbx.get('SELECT 1') })
    await runAs.system('http-public', async () => { await dbx.get('SELECT 2') })
    await dbx.get('SELECT 3')
    const r = await call('GET', '/api/admin/db-context')
    expect(r.handled).toBe(true)
    expect(r.body.kinds).toMatchObject({ expected: 1, anonymous: 1, unexpected: 1 })
    expect(r.body.total).toBe(3)
    expect(r.body.byJob).toMatchObject({ 'rbac-mode-refresh': 1, 'http-public': 1 })
    expect(r.body.sites[0].site).toContain('db-context-route.test')
    expect(r.body.bootEndedAt === null || typeof r.body.bootEndedAt === 'number').toBe(true)
    expect(typeof r.body.startedAt).toBe('number')
    expect(r.body.registeredJobs).toBeGreaterThan(20)
  })

  it('lists at most the top call sites', () => {
    expect(DB_CONTEXT_TOP_SITES).toBe(20)
  })

  it('only handles GET on its own path', async () => {
    expect((await call('POST', '/api/admin/db-context')).handled).toBe(false)
    expect((await call('GET', '/api/admin/db-contexts')).handled).toBe(false)
  })

  it('is named in the RBAC table as admin only, on both prefixes', () => {
    for (const p of ['/api/admin/db-context', '/api/v1/admin/db-context']) {
      const hit = ENDPOINT_PERMISSION_TABLE.find((e) => 'pathPattern' in e && e.pathPattern === p && !e.prefix)
      expect(hit, p).toMatchObject({ method: 'GET', permission: 'admin:all' })
    }
  })
})
