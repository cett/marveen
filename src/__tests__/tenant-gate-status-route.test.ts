// GET /api/admin/tenant-gate-status: the database-side facts behind the tenant skill gate rollout
// report. Real in-memory SQLite, the real route handler.

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, createTenant, setTenantAgentAvailability, setChannelBinding, db, getTenantGateStatus } from '../db.js'
import { tryHandleTenantGateStatus } from '../web/routes/tenant-gate-status.js'
import type { RouteContext } from '../web/routes/types.js'

beforeEach(() => {
  initDatabase(':memory:')
  createTenant('acme', 'Acme')
  createTenant('beta', 'Beta')
})

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
  return tryHandleTenantGateStatus(ctx).then((handled) => ({ handled, status: out.status, body: out.body }))
}

describe('GET /api/admin/tenant-gate-status', () => {
  it('reports both gate migrations as applied with their tables on a migrated database', async () => {
    const r = await call('GET', '/api/admin/tenant-gate-status')
    expect(r.handled).toBe(true)
    expect(r.body.migrations).toEqual([
      { version: 64, table: 'tenant_channel_bindings', applied: true, table_exists: true },
      { version: 65, table: 'agent_tenant_context', applied: true, table_exists: true },
    ])
    expect(r.body.contexts).toEqual([])
    expect(r.body.multi_tenant_agents).toEqual([])
    expect(typeof r.body.now).toBe('number')
  })

  it('only handles GET on its own path', async () => {
    expect((await call('POST', '/api/admin/tenant-gate-status')).handled).toBe(false)
    expect((await call('GET', '/api/admin/tenants')).handled).toBe(false)
  })

  it('lists the per-agent context rows the prompt hook wrote', async () => {
    db.prepare("INSERT INTO agent_tenant_context (agent_id, tenant_id, status, source, session_id, updated_at) VALUES ('a1','acme','bound','s','',100)").run()
    const r = await call('GET', '/api/admin/tenant-gate-status')
    expect(r.body.contexts).toEqual([{ agent_id: 'a1', status: 'bound', tenant_id: 'acme', updated_at: 100 }])
  })

  it('lists an agent enabled for 2+ live tenants, with and without a channel binding', async () => {
    setTenantAgentAvailability('acme', 'm1', true)
    setTenantAgentAvailability('beta', 'm1', true)
    setTenantAgentAvailability('acme', 's1', true)
    expect(getTenantGateStatus().multi_tenant_agents).toEqual([{ agent_id: 'm1', tenant_count: 2, has_binding: false }])
    setChannelBinding('m1', 'telegram', '1', 'acme', 'admin')
    expect(getTenantGateStatus().multi_tenant_agents).toEqual([{ agent_id: 'm1', tenant_count: 2, has_binding: true }])
  })

  it('a disabled tenant does not count towards multi-tenancy', async () => {
    setTenantAgentAvailability('acme', 'm1', true)
    setTenantAgentAvailability('beta', 'm1', true)
    db.prepare("UPDATE tenants SET disabled_at = 5 WHERE id = 'beta'").run()
    expect(getTenantGateStatus().multi_tenant_agents).toEqual([])
  })

  it('reports a missing gate table rather than failing', async () => {
    db.exec('DROP TABLE agent_tenant_context')
    db.prepare('DELETE FROM schema_version WHERE version = 65').run()
    const m = getTenantGateStatus().migrations
    expect(m[1]).toEqual({ version: 65, table: 'agent_tenant_context', applied: false, table_exists: false })
    expect(m[0]!.applied).toBe(true)
    expect(getTenantGateStatus().contexts).toEqual([])
  })
})
