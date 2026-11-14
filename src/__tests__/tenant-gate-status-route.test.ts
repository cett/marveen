// GET /api/admin/tenant-gate-status: the database-side facts behind the tenant skill gate rollout
// report. Real in-memory SQLite, the real route handler.

import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createTenant, setTenantAgentAvailability, setChannelBinding, getTenantGateStatus, dbx } from '../db.js'
import { tryHandleTenantGateStatus } from '../web/routes/tenant-gate-status.js'
import type { RouteContext } from '../web/routes/types.js'
import { testDbMode, useTestDb } from './helpers/with-test-db.js'

useTestDb()

// The gate migrations are SQLite migration numbers (64 and 65). A migrated SQLite database has a schema_version row for
// each. The PostgreSQL baseline folds both tables into file 0001 and its schema_version holds the file numbers, so on a
// fresh PostgreSQL database `applied` is false while the tables exist: the report's `applied` follows the rows of the
// ACTIVE backend, `table_exists` is the fact that is the same on both.
const APPLIED_ON_FRESH_DB = testDbMode() !== 'pg'
const GATE_VERSIONS = [64, 65]

async function gateRows(): Promise<number[]> {
  return ((await dbx.all('SELECT version FROM schema_version WHERE version IN (64, 65) ORDER BY version')) as { version: number }[]).map((r) => r.version)
}
async function markApplied(version: number, on: boolean): Promise<void> {
  if (on) await dbx.run("INSERT INTO schema_version (version, applied_at, description) VALUES (?, 1, 'test') ON CONFLICT (version) DO NOTHING", version)
  else await dbx.run('DELETE FROM schema_version WHERE version = ?', version)
}

beforeEach(async () => {
  await createTenant('acme', 'Acme')
  await createTenant('beta', 'Beta')
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
  const ctx = { req, res, path: url.pathname, method, url, role: 'admin', tenantId: null, auth: { kind: 'token' } } as unknown as RouteContext
  return tryHandleTenantGateStatus(ctx).then((handled) => ({ handled, status: out.status, body: out.body }))
}

describe('GET /api/admin/tenant-gate-status', () => {
  it('reports both gate migrations as applied with their tables on a migrated database', async () => {
    const r = await call('GET', '/api/admin/tenant-gate-status')
    expect(r.handled).toBe(true)
    expect(await gateRows()).toEqual(APPLIED_ON_FRESH_DB ? GATE_VERSIONS : [])
    expect(r.body.migrations).toEqual([
      { version: 64, table: 'tenant_channel_bindings', applied: APPLIED_ON_FRESH_DB, table_exists: true },
      { version: 65, table: 'agent_tenant_context', applied: APPLIED_ON_FRESH_DB, table_exists: true },
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
    await dbx.run("INSERT INTO agent_tenant_context (agent_id, tenant_id, status, source, session_id, updated_at) VALUES ('a1','acme','bound','s','',100)")
    const r = await call('GET', '/api/admin/tenant-gate-status')
    expect(r.body.contexts).toEqual([{ agent_id: 'a1', status: 'bound', tenant_id: 'acme', updated_at: 100 }])
  })

  it('lists an agent enabled for 2+ live tenants, with and without a channel binding', async () => {
    await setTenantAgentAvailability('acme', 'm1', true)
    await setTenantAgentAvailability('beta', 'm1', true)
    await setTenantAgentAvailability('acme', 's1', true)
    expect((await getTenantGateStatus()).multi_tenant_agents).toEqual([{ agent_id: 'm1', tenant_count: 2, has_binding: false }])
    await setChannelBinding('m1', 'telegram', '1', 'acme', 'admin')
    expect((await getTenantGateStatus()).multi_tenant_agents).toEqual([{ agent_id: 'm1', tenant_count: 2, has_binding: true }])
  })

  it('a disabled tenant does not count towards multi-tenancy', async () => {
    await setTenantAgentAvailability('acme', 'm1', true)
    await setTenantAgentAvailability('beta', 'm1', true)
    await dbx.run("UPDATE tenants SET disabled_at = 5 WHERE id = 'beta'")
    expect((await getTenantGateStatus()).multi_tenant_agents).toEqual([])
  })

  it('applied follows the schema_version rows of the active backend, table_exists follows the table', async () => {
    for (const v of GATE_VERSIONS) await markApplied(v, false)
    expect((await getTenantGateStatus()).migrations.map((m) => [m.version, m.applied, m.table_exists])).toEqual([[64, false, true], [65, false, true]])
    await markApplied(64, true)
    expect((await getTenantGateStatus()).migrations.map((m) => [m.version, m.applied])).toEqual([[64, true], [65, false]])
    await markApplied(65, true)
    expect((await getTenantGateStatus()).migrations.map((m) => [m.version, m.applied])).toEqual([[64, true], [65, true]])
  })

  it('reports a missing gate table rather than failing', async () => {
    await markApplied(64, true)
    await dbx.exec('DROP TABLE agent_tenant_context')
    await markApplied(65, false)
    const m = (await getTenantGateStatus()).migrations
    expect(m[1]).toEqual({ version: 65, table: 'agent_tenant_context', applied: false, table_exists: false })
    expect(m[0]!.applied).toBe(true)
    expect((await getTenantGateStatus()).contexts).toEqual([])
  })
})
