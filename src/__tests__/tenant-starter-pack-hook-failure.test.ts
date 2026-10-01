// A failing starter-task reconcile must not fail PUT /api/admin/agent-availability.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const reconcile = vi.hoisted(() => vi.fn(() => { throw new Error('reconcile exploded') }))
vi.mock('../web/tenant-starter-pack.js', () => ({
  reconcileStarterPack: reconcile,
  createStarterPack: vi.fn(),
  describeStarterPack: vi.fn(),
}))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  isKnownAgent: (n: string) => n === 'beta-one',
}))
vi.mock('../web/skill-regen.js', () => ({ regenTenantSkillFiles: vi.fn() }))
vi.mock('../web/mcp-risk-policy.js', () => ({ getHighRiskMcpServersForAgent: () => [] }))

let tmp: string
let prevHome: string | undefined

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'starter-hook-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
})
afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(tmp, { recursive: true, force: true })
})

describe('availability PUT with a failing reconcile', () => {
  it('still answers 200 and keeps the availability change', async () => {
    vi.resetModules()
    const dbMod = await import('../db.js')
    dbMod.initDatabase(':memory:')
    dbMod.createTenant('solo', 'Solo')
    const admin = await import('../web/routes/admin-b2b.js')

    const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string>; destroy: () => void }
    req.method = 'PUT'; req.headers = {}; req.destroy = () => {}
    const buf = Buffer.from(JSON.stringify({ tenant_id: 'solo', agent_id: 'beta-one', enabled: true }))
    setImmediate(() => { req.emit('data', buf); req.emit('end') })
    let status = 0
    const res = { writeHead(s: number) { status = s }, setHeader() {}, end() {} }
    const url = new URL('http://localhost:3420/api/admin/agent-availability')
    const ctx = { req, res, path: url.pathname, method: 'PUT', url, role: 'admin', tenantId: null, auth: { kind: 'session', user: 'root' } } as unknown as RouteContext
    await admin.tryHandleAdminB2b(ctx)

    expect(reconcile).toHaveBeenCalled()
    expect(status).toBe(200)
    expect(dbMod.isTenantAgentEnabled('solo', 'beta-one')).toBe(true)
  })
})
