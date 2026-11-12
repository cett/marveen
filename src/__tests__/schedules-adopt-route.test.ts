// Taking over a task (POST /api/schedules/:name/adopt) and the author state in the list, through the REAL route + DB
// (no persistence mocks). Every "stays as it was" cell has a positive pair in the same set-up: the same caller
// activates the same kind of task and the status DOES move, or adopts with the right hash and the author DOES change.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  currentBotName: () => 'Main',
}))
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: vi.fn().mockReturnValue(['shared-agent', 'tenant-agent', 'fleet-agent']),
}))
vi.mock('../web/schedule-runner.js', () => ({
  runScheduledTaskNow: vi.fn(),
  loadLastTickMs: vi.fn().mockReturnValue(null),
  computeTickStatus: vi.fn(),
}))

let tmp: string
let prevHome: string | undefined
let dbMod: typeof import('../db.js')
let route: typeof import('../web/routes/schedules.js')
let ownerId: number
let secondAdminId: number
let tenantUserId: number

type Principal = { role: string; tenantId: string | null; auth: Record<string, unknown>; agentId?: string }
const human = (user = 'owner'): Principal => ({ role: 'admin', tenantId: null, auth: { kind: 'session', user } })
const sharedToken: Principal = { role: 'admin', tenantId: null, auth: { kind: 'token' } }
const tenantUser: Principal = { role: 'agent', tenantId: 'tenant-b', auth: { kind: 'session', user: 'tenant-user-a' } }
const scopedToken: Principal = { role: 'agent', tenantId: 'tenant-b', auth: { kind: 'token', tokenName: 'ci-key' } }
const device: Principal = { role: 'agent', tenantId: 'default', auth: { kind: 'device', device: 'phone', deviceId: 1 } }

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sched-adopt-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  route = await import('../web/routes/schedules.js')

  ownerId = (await dbMod.createDashboardUser('owner', 'hash-a')).id
  secondAdminId = (await dbMod.createDashboardUser('admin-b', 'hash-b')).id
  tenantUserId = (await dbMod.createDashboardUser('tenant-user-a', 'hash-c')).id
  dbMod.getDb().prepare("UPDATE dashboard_users SET role = 'admin' WHERE id = ?").run(secondAdminId)
  dbMod.getDb().prepare("UPDATE dashboard_users SET role = 'agent', tenant_id = 'tenant-b' WHERE id = ?").run(tenantUserId)

  await dbMod.createTenant('tenant-b', 'Tenant B')
  await dbMod.updateTenant('tenant-b', { main_agent_id: 'tenant-agent' })
  await dbMod.setTenantAgentAvailability('tenant-b', 'tenant-agent', true)
  await dbMod.setTenantAgentAvailability('tenant-b', 'shared-agent', true)
  await dbMod.setTenantAgentAvailability('default', 'shared-agent', true)

  const base = { description: 'Daily', prompt: 'Summarise the day', schedule: '0 9 * * *', enabled: true, skip_if_busy: false, force_send: false }
  const byTenantUser = { userId: tenantUserId, label: 'tenant-user-a' }
  // live, written by the tenant user and activated by the owner earlier
  await dbMod.upsertSchedule('t-live', { ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b', status: 'live', author: byTenantUser, activation: { by: 'owner', at: 1000 } })
  // held for review after the tenant user changed it (the activation record is the earlier one)
  await dbMod.upsertSchedule('t-held', { ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b', status: 'pending_review', author: byTenantUser, activation: { by: 'owner', at: 1000 } })
  await dbMod.upsertSchedule('t-draft', { ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b', status: 'draft', author: byTenantUser })
  // paused live task of the fleet (default tenant), written by the owner
  await dbMod.upsertSchedule('f-paused', { ...base, enabled: false, agent: 'fleet-agent', type: 'task', tenant_id: 'default', status: 'live', author: { userId: ownerId, label: 'owner' }, activation: { by: 'owner', at: 2000 } })
  // a seed or a token-made task: no user-bound author
  await dbMod.upsertSchedule('f-seed', { ...base, agent: 'fleet-agent', type: 'task', tenant_id: 'default', status: 'live' })
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(tmp, { recursive: true, force: true })
})

async function call(method: string, pathAndQuery: string, body: object | undefined, who: Principal) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string>; destroy: () => void }
  req.method = method
  req.headers = who.agentId ? { 'x-agent-id': who.agentId } : {}
  req.destroy = () => {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out: { status: number; body: unknown } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) {
      if (!b) return
      try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) } catch { /* ignore */ }
    },
  }
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  await route.tryHandleSchedules({ req, res, path: url.pathname, method, url, ...who } as unknown as RouteContext)
  return out as { status: number; body: Record<string, unknown> }
}
const adopt = (name: string, who: Principal, query = '') => call('POST', `/api/schedules/${name}/adopt${query}`, undefined, who)
const activate = (name: string, who: Principal) => call('POST', `/api/schedules/${name}/activate`, undefined, who)
const list = async (who: Principal) => {
  const out = await call('GET', '/api/schedules', undefined, who)
  expect(out.status).toBe(200)
  return new Map((out.body as unknown as Array<Record<string, unknown>>).map(t => [t['name'] as string, t]))
}
const row = async (name: string) => (await dbMod.getScheduleFromDb(name))!
const disable = (id: number): void => { dbMod.getDb().prepare('UPDATE dashboard_users SET disabled = 1 WHERE id = ?').run(id) }
const auditRows = (name: string, action: string) => (dbMod.getDb()
  .prepare("SELECT agent_id, detail FROM agent_audit_log WHERE entity = 'schedule' AND entity_id = ? AND action = ? ORDER BY id")
  .all(name, action) as Array<{ agent_id: string; detail: string }>)

describe('adopt: a signed-in admin takes the task over', () => {
  it('the author becomes the caller; the status, the content, the activation record and the pause flag stay as they were', async () => {
    const before = await row('t-live')
    const r = await adopt('t-live', human('admin-b'))
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, status: 'live', author_label: 'admin-b' })
    const after = await row('t-live')
    expect(after.author_user_id).toBe(secondAdminId)
    expect(after.author_label).toBe('admin-b')
    // everything but the two author columns (and the write time) is the row it was
    const strip = (x: Record<string, unknown>) => { const { author_user_id: _a, author_label: _l, updated_at: _u, ...rest } = x; return rest }
    expect(strip(after as unknown as Record<string, unknown>)).toEqual(strip(before as unknown as Record<string, unknown>))
    expect(after.activated_by).toBe('owner')
    expect(after.activated_at).toBe(1000)
  })

  it('a held (pending_review) and a draft task stay held / draft after the adopt (adopt is not an approval); activate DOES move them', async () => {
    expect((await adopt('t-held', human())).status).toBe(200)
    expect((await adopt('t-draft', human())).status).toBe(200)
    expect((await row('t-held')).status).toBe('pending_review')
    expect((await row('t-draft')).status).toBe('draft')
    expect((await row('t-held')).author_user_id).toBe(ownerId)
    expect((await row('t-draft')).author_user_id).toBe(ownerId)
    // the activation record is still the earlier one, and a draft still has none
    expect((await row('t-held')).activated_at).toBe(1000)
    expect((await row('t-draft')).activated_by).toBeNull()
    // positive pair: the same caller activating the same tasks moves the status
    expect((await activate('t-held', human())).status).toBe(200)
    expect((await activate('t-draft', human())).status).toBe(200)
    expect((await row('t-held')).status).toBe('live')
    expect((await row('t-draft')).status).toBe('live')
  })

  it('a paused task stays paused', async () => {
    expect((await adopt('f-paused', human('admin-b'))).status).toBe(200)
    expect((await row('f-paused')).enabled).toBe(0)
    expect((await row('f-paused')).author_user_id).toBe(secondAdminId)
  })

  it('a task with no user-bound author gets one (the caller)', async () => {
    expect((await row('f-seed')).author_user_id).toBeNull()
    expect((await adopt('f-seed', human())).status).toBe(200)
    expect((await row('f-seed')).author_user_id).toBe(ownerId)
  })

  it('the content hash the screens show does not change with the adopt', async () => {
    const before = (await list(human())).get('t-live')!['contentHash']
    await adopt('t-live', human('admin-b'))
    expect((await list(human())).get('t-live')!['contentHash']).toBe(before)
  })

  it('one audit row, action adopt, by the caller, with who it was and who it is now', async () => {
    await adopt('t-live', human('admin-b'))
    const rows = auditRows('t-live', 'adopt')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.agent_id).toBe('admin-b')
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({
      tenant: 'tenant-b', status: 'live', hash_checked: false,
      author_before: tenantUserId, author_label_before: 'tenant-user-a', author_after: secondAdminId, author_label_after: 'admin-b',
    })
  })

  it('the user-name lookup ignores case, as it does for every other write', async () => {
    await adopt('t-live', human('ADMIN-B'))
    expect(await row('t-live')).toMatchObject({ author_user_id: secondAdminId, author_label: 'ADMIN-B' })
  })
})

describe('adopt: who may not', () => {
  it.each([
    ['the shared token', sharedToken],
    ['a scoped token', scopedToken],
    ['a tenant user', tenantUser],
    ['a device key', device],
  ])('%s gets 403, the row does not move and nothing is audited', async (_n, who) => {
    const before = await row('t-live')
    const r = await adopt('t-live', who)
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ error: 'forbidden' })
    expect(await row('t-live')).toEqual(before)
    expect(auditRows('t-live', 'adopt')).toEqual([])
    // positive pair: a signed-in admin, same task, same moment
    expect((await adopt('t-live', human())).status).toBe(200)
    expect(auditRows('t-live', 'adopt')).toHaveLength(1)
  })

  it('a signed-in non-admin of the default tenant gets 403 too', async () => {
    const before = await row('f-seed')
    expect((await adopt('f-seed', { role: 'agent', tenantId: 'default', auth: { kind: 'session', user: 'tenant-user-a' } })).status).toBe(403)
    expect(await row('f-seed')).toEqual(before)
  })

  it('an admin session whose user row is gone is refused and the author is NOT blanked (a NULL author would leave the check)', async () => {
    const before = await row('t-live')
    const r = await adopt('t-live', human('ghost-user'))
    expect(r.status).toBe(403)
    expect(await row('t-live')).toEqual(before)
    expect(auditRows('t-live', 'adopt')).toEqual([])
    // positive pair: a real login adopts
    expect((await adopt('t-live', human())).status).toBe(200)
  })
})

describe('adopt: the hash and the name', () => {
  it('a stale expected_hash is a 409 stale_revision with the current hash; the right hash adopts', async () => {
    const hash = (await list(human())).get('t-live')!['contentHash'] as string
    const before = await row('t-live')
    const stale = await adopt('t-live', human(), `?expected_hash=${'0'.repeat(hash.length)}`)
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ error: 'stale_revision', content_hash: hash })
    expect(await row('t-live')).toEqual(before)
    expect(auditRows('t-live', 'adopt')).toEqual([])
    // positive pair
    const ok = await adopt('t-live', human(), `?expected_hash=${hash}`)
    expect(ok.status).toBe(200)
    expect(JSON.parse(auditRows('t-live', 'adopt')[0]!.detail)).toMatchObject({ hash_checked: true })
  })

  it('a hash taken before the content changed is stale', async () => {
    const hash = (await list(human())).get('t-live')!['contentHash'] as string
    expect((await call('PUT', '/api/schedules/t-live', { prompt: 'Rewritten by the admin' }, human())).status).toBe(200)
    expect((await adopt('t-live', human('admin-b'), `?expected_hash=${hash}`)).status).toBe(409)
    expect((await row('t-live')).author_user_id).toBe(ownerId)
  })

  it('an unknown name is a 404 and writes nothing', async () => {
    const r = await adopt('no-such-task', human())
    expect(r.status).toBe(404)
    expect(await dbMod.getScheduleFromDb('no-such-task')).toBeUndefined()
    expect(auditRows('no-such-task', 'adopt')).toEqual([])
  })

  it('a name that is not a task name is a 404 as well', async () => {
    expect((await adopt('..%2Fescape', human())).status).toBe(404)
  })

  it('GET on the adopt path is not the route', async () => {
    const before = await row('t-live')
    await call('GET', '/api/schedules/t-live/adopt', undefined, human())
    expect(await row('t-live')).toEqual(before)
  })
})

describe('the list carries authorState', () => {
  it('none: a task with no user-bound author', async () => {
    expect((await list(human())).get('f-seed')!['authorState']).toBe('none')
  })

  it('ok / inactive: the verdict follows the author, whatever the gate mode', async () => {
    expect((await list(human())).get('t-live')!['authorState']).toBe('ok')
    expect((await list(human())).get('f-paused')!['authorState']).toBe('ok')
    disable(tenantUserId)
    const after = await list(human())
    expect(after.get('t-live')!['authorState']).toBe('inactive')
    expect(after.get('t-held')!['authorState']).toBe('inactive')
    expect(after.get('t-draft')!['authorState']).toBe('inactive')
    // the fleet's own task is judged by its own author, not by the tenant user
    expect(after.get('f-paused')!['authorState']).toBe('ok')
  })

  it('an admin author on a default-tenant task is ok (the NULL tenant of an admin is not another tenant)', async () => {
    dbMod.getDb().prepare('UPDATE dashboard_users SET tenant_id = NULL WHERE id = ?').run(ownerId)
    expect((await list(human())).get('f-paused')!['authorState']).toBe('ok')
  })

  it('an author who is no longer allowed to write schedules (demoted) is inactive', async () => {
    dbMod.getDb().prepare("UPDATE dashboard_users SET role = 'viewer' WHERE id = ?").run(ownerId)
    expect((await list(human('admin-b'))).get('f-paused')!['authorState']).toBe('inactive')
  })

  it('unverifiable: the user lookup fails (a real database error); a task with no author is none and does not need the lookup', async () => {
    dbMod.getDb().exec('DROP TABLE dashboard_users')
    const l = await list(sharedToken)
    expect(l.get('t-live')!['authorState']).toBe('unverifiable')
    expect(l.get('f-paused')!['authorState']).toBe('unverifiable')
    expect(l.get('f-seed')!['authorState']).toBe('none')
  })

  it('inactive -> adopt -> ok in the next list; the other tasks of the same author are untouched', async () => {
    disable(tenantUserId)
    expect((await list(human())).get('t-live')!['authorState']).toBe('inactive')
    expect((await adopt('t-live', human())).status).toBe(200)
    const after = await list(human())
    expect(after.get('t-live')!['authorState']).toBe('ok')
    expect(after.get('t-held')!['authorState']).toBe('inactive')
  })

  it('admin sees the author id, label and activator; a tenant caller gets the state word and the activation time, nothing else', async () => {
    disable(tenantUserId)
    const admin = (await list(human())).get('t-live')!
    expect(admin).toMatchObject({ authorUserId: tenantUserId, authorLabel: 'tenant-user-a', activatedBy: 'owner', activatedAt: 1000, authorState: 'inactive' })
    for (const who of [tenantUser, scopedToken]) {
      const t = (await list(who)).get('t-live')!
      expect(t['authorState']).toBe('inactive')
      expect(t['activatedAt']).toBe(1000)
      expect(t).not.toHaveProperty('authorUserId')
      expect(t).not.toHaveProperty('authorLabel')
      expect(t).not.toHaveProperty('activatedBy')
    }
  })

  it("a tenant caller does not see another tenant's tasks in the list", async () => {
    const names = [...(await list(tenantUser)).keys()]
    expect(names).toContain('t-live')
    expect(names).not.toContain('f-paused')
    expect(names).not.toContain('f-seed')
  })
})
