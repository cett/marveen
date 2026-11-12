// Who wrote and who activated a schedule, recorded by the REAL route + DB + file mirror (no persistence mocks).
// One cell per row of the write-path table: a human admin creating a live task, a tenant user creating a draft, a
// token creating a draft, a content edit, an edit that is not content, an activation, a tenant move. Each "stays as
// it was" cell has a positive pair in the same set-up (the same caller changes the content and the author moves).
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
let io: typeof import('../web/scheduled-tasks-io.js')
let ownerId: number
let tenantUserId: number

type Principal = { role: string; tenantId: string | null; auth: Record<string, unknown>; agentId?: string }
const human = (user = 'owner'): Principal => ({ role: 'admin', tenantId: null, auth: { kind: 'session', user } })
const sharedToken = (claimed?: string): Principal => ({ role: 'admin', tenantId: null, auth: { kind: 'token' }, agentId: claimed })
const tenantUser: Principal = { role: 'agent', tenantId: 'tenant-b', auth: { kind: 'session', user: 'tenant-user-a' } }
const scopedToken: Principal = { role: 'agent', tenantId: 'tenant-b', auth: { kind: 'token', tokenName: 'ci-key' } }

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sched-author-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  route = await import('../web/routes/schedules.js')
  io = await import('../web/scheduled-tasks-io.js')

  // The first dashboard user is the global admin; the second one is made a tenant user of tenant-b.
  ownerId = (await dbMod.createDashboardUser('owner', 'hash-a')).id
  tenantUserId = (await dbMod.createDashboardUser('tenant-user-a', 'hash-b')).id
  dbMod.getDb().prepare("UPDATE dashboard_users SET role = 'agent', tenant_id = 'tenant-b' WHERE id = ?").run(tenantUserId)

  await dbMod.createTenant('tenant-b', 'Tenant B')
  await dbMod.updateTenant('tenant-b', { main_agent_id: 'tenant-agent' })
  await dbMod.setTenantAgentAvailability('tenant-b', 'tenant-agent', true)
  await dbMod.setTenantAgentAvailability('tenant-b', 'shared-agent', true)
  await dbMod.setTenantAgentAvailability('default', 'shared-agent', true)

  const base = { description: 'Daily', prompt: 'Summarise the day', schedule: '0 9 * * *', enabled: true, skip_if_busy: false, force_send: false }
  // A live task of the tenant, written by the tenant user and activated by the owner earlier.
  await dbMod.upsertSchedule('t-live', {
    ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b', status: 'live',
    author: { userId: tenantUserId, label: 'tenant-user-a' }, activation: { by: 'owner', at: 1000 },
  })
  await dbMod.upsertSchedule('t-draft', {
    ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b', status: 'draft',
    author: { userId: tenantUserId, label: 'tenant-user-a' },
  })
  await dbMod.upsertSchedule('t-shared', {
    ...base, agent: 'shared-agent', type: 'task', tenant_id: 'tenant-b', status: 'live',
    author: { userId: tenantUserId, label: 'tenant-user-a' }, activation: { by: 'owner', at: 1000 },
  })
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
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
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
  return out
}
const post = (path: string, body: object | undefined, who: Principal) => call('POST', path, body, who)
const put = (name: string, body: object, who: Principal) => call('PUT', `/api/schedules/${name}`, body, who)

const authorOf = async (name: string) => {
  const r = (await dbMod.getScheduleFromDb(name))!
  return { userId: r.author_user_id, label: r.author_label, by: r.activated_by, at: r.activated_at, status: r.status }
}
const auditDetail = (name: string, action: string) => {
  const rows = dbMod.getDb()
    .prepare("SELECT detail FROM agent_audit_log WHERE entity = 'schedule' AND entity_id = ? AND action = ? ORDER BY id")
    .all(name, action) as Array<{ detail: string }>
  return JSON.parse(rows[rows.length - 1]!.detail) as Record<string, unknown>
}
const newTask = (name: string, over: object = {}) => ({ name, prompt: 'Do the thing', schedule: '0 9 * * *', tenant_id: 'tenant-b', agent: 'tenant-agent', ...over })

describe('creating a task records its author', () => {
  it('a human admin creating a live task is its author and its activator, now', async () => {
    const before = Math.floor(Date.now() / 1000)
    const r = await post('/api/schedules', newTask('c-human'), human())
    expect(r.status).toBe(200)
    const a = await authorOf('c-human')
    expect(a).toMatchObject({ userId: ownerId, label: 'owner', by: 'owner', status: 'live' })
    expect(a.at).toBeGreaterThanOrEqual(before)
    expect(a.at).toBeLessThanOrEqual(before + 5)
    expect(auditDetail('c-human', 'create')).toMatchObject({ author_label: 'owner', activated_by: 'owner' })
  })

  it('a tenant user creating a task makes a draft with the user as author and nobody as activator', async () => {
    const r = await post('/api/schedules', { name: 'c-tenant', prompt: 'Do the thing', schedule: '0 9 * * *', agent: 'tenant-agent' }, tenantUser)
    expect(r.status).toBe(200)
    expect(await authorOf('c-tenant')).toEqual({ userId: tenantUserId, label: 'tenant-user-a', by: null, at: null, status: 'draft' })
    expect(auditDetail('c-tenant', 'create')).toMatchObject({ author_label: 'tenant-user-a', activated_by: null })
  })

  it('a scoped token creating a task is a draft with no user id and the token as the label', async () => {
    const r = await post('/api/schedules', { name: 'c-token', prompt: 'Do the thing', schedule: '0 9 * * *', agent: 'tenant-agent' }, scopedToken)
    expect(r.status).toBe(200)
    expect(await authorOf('c-token')).toEqual({ userId: null, label: 'token:ci-key', by: null, at: null, status: 'draft' })
  })

  it('an agent on the shared token is a draft with no user id, even if a user of the same name exists', async () => {
    // A dashboard user called like the claimed agent: the claim is not a login and must not be matched to it.
    const lookalike = await dbMod.createDashboardUser('fleet-agent', 'hash-c')
    expect(lookalike.id).toBeGreaterThan(0)
    const r = await post('/api/schedules', newTask('c-claimed'), sharedToken('fleet-agent'))
    expect(r.status).toBe(200)
    expect(await authorOf('c-claimed')).toEqual({ userId: null, label: 'claimed:fleet-agent', by: null, at: null, status: 'draft' })
    // Positive pair: the same name as a real login does resolve.
    const r2 = await post('/api/schedules', newTask('c-login'), human('fleet-agent'))
    expect(r2.status).toBe(200)
    expect((await authorOf('c-login')).userId).toBe(lookalike.id)
  })

  it('a session whose user row is gone gets no id (and still a label), and the username lookup ignores case', async () => {
    await post('/api/schedules', newTask('c-ghost'), human('ghost-user'))
    expect(await authorOf('c-ghost')).toMatchObject({ userId: null, label: 'ghost-user' })
    await post('/api/schedules', newTask('c-case'), human('OWNER'))
    expect(await authorOf('c-case')).toMatchObject({ userId: ownerId, label: 'OWNER' })
  })
})

describe('a failing user lookup fails the write', () => {
  // A real database error, not a mock: with the users table gone the username lookup throws inside the route.
  const breakLookup = (): void => { dbMod.getDb().exec('DROP TABLE dashboard_users') }
  const rowCount = (): number => (dbMod.getDb().prepare('SELECT COUNT(*) AS c FROM schedules').get() as { c: number }).c

  it('a create by a session is not stored without an author when the lookup fails', async () => {
    const before = rowCount()
    breakLookup()
    await expect(post('/api/schedules', newTask('f1-create'), human())).rejects.toThrow()
    expect(rowCount()).toBe(before)
    expect(await dbMod.getScheduleFromDb('f1-create')).toBeUndefined()
  })

  it('a content edit by a session leaves the row as it was when the lookup fails', async () => {
    const before = await dbMod.getScheduleFromDb('t-live')
    breakLookup()
    await expect(put('t-live', { prompt: 'Rewritten while the lookup is down' }, human())).rejects.toThrow()
    expect(await dbMod.getScheduleFromDb('t-live')).toEqual(before)
  })

  it('an edit that names no reviewed field needs no lookup and still lands (the lookup is not asked for a toggle)', async () => {
    breakLookup()
    const r = await put('t-live', { enabled: false }, human())
    expect(r.status).toBe(200)
    expect((await dbMod.getScheduleFromDb('t-live'))!.enabled).toBe(0)
  })

  it('a caller that is not a session never asks the lookup, so a token create lands even when it is down', async () => {
    breakLookup()
    const r = await post('/api/schedules', { name: 'f1-token', prompt: 'Do the thing', schedule: '0 9 * * *', agent: 'tenant-agent' }, scopedToken)
    expect(r.status).toBe(200)
    expect(await authorOf('f1-token')).toMatchObject({ userId: null, label: 'token:ci-key', status: 'draft' })
  })

  it('positive pair: the same create and the same edit succeed while the lookup works', async () => {
    expect((await post('/api/schedules', newTask('f1-create'), human())).status).toBe(200)
    expect((await put('t-live', { prompt: 'Rewritten while the lookup works' }, human())).status).toBe(200)
    expect(await authorOf('f1-create')).toMatchObject({ userId: ownerId })
    expect(await authorOf('t-live')).toMatchObject({ userId: ownerId })
  })
})

describe('editing a task', () => {
  const dashboardSave = { description: 'Daily', prompt: 'Summarise the day', schedule: '0 9 * * *', agent: 'tenant-agent', type: 'task', skipIfBusy: false, forceSend: false }

  it('a content edit by a tenant user sends the task back to review and makes the user the author', async () => {
    // Start from a live task whose author is somebody else, so "the author moved" is visible.
    dbMod.getDb().prepare("UPDATE schedules SET author_user_id = ?, author_label = 'owner' WHERE id = 't-live'").run(ownerId)
    const r = await put('t-live', { prompt: 'Something else' }, tenantUser)
    expect(r.status).toBe(200)
    expect(await authorOf('t-live')).toEqual({ userId: tenantUserId, label: 'tenant-user-a', by: 'owner', at: 1000, status: 'pending_review' })
    expect(auditDetail('t-live', 'review_requested')).toMatchObject({ author_label: 'tenant-user-a', activated_by: 'owner' })
  })

  it('a content edit by a human admin makes the admin the author and keeps the status and the activator', async () => {
    const r = await put('t-live', { prompt: 'Admin wording' }, human())
    expect(r.status).toBe(200)
    expect(await authorOf('t-live')).toEqual({ userId: ownerId, label: 'owner', by: 'owner', at: 1000, status: 'live' })
    expect(auditDetail('t-live', 'update')).toMatchObject({ author_label: 'owner', activated_by: 'owner' })
  })

  it('a content edit by a token leaves no user id: the task is then not bound to any user', async () => {
    await put('t-live', { prompt: 'Token wording' }, scopedToken)
    expect(await authorOf('t-live')).toMatchObject({ userId: null, label: 'token:ci-key', status: 'pending_review' })
  })

  it.each([
    ['enabled', { enabled: false }],
    ['description', { description: 'New label' }],
    ['an unchanged dashboard save', dashboardSave],
  ])('an edit that is not a content change (%s) leaves the author, the activator and the status', async (_label, body) => {
    const r = await put('t-live', body, human())
    expect(r.status).toBe(200)
    expect(await authorOf('t-live')).toEqual({ userId: tenantUserId, label: 'tenant-user-a', by: 'owner', at: 1000, status: 'live' })
  })

  it('a tenant move keeps the author, clears the activator and sends the task back to draft', async () => {
    const r = await put('t-shared', { tenant_id: 'default' }, human())
    expect(r.status).toBe(200)
    expect(await authorOf('t-shared')).toEqual({ userId: tenantUserId, label: 'tenant-user-a', by: null, at: null, status: 'draft' })
    expect(auditDetail('t-shared', 'update')).toMatchObject({ author_label: 'tenant-user-a', activated_by: null, moved_to_tenant: 'default' })
  })

  it('a tenant move sent with the whole unchanged dashboard body still keeps the author (only a changed reviewed field counts)', async () => {
    // The dashboard sends every field on every save: the move lists tenantId and status as changed, the content is not.
    const r = await put('t-shared', { ...dashboardSave, agent: 'shared-agent', tenant_id: 'default' }, human())
    expect(r.status).toBe(200)
    expect(await authorOf('t-shared')).toEqual({ userId: tenantUserId, label: 'tenant-user-a', by: null, at: null, status: 'draft' })
  })

  it('a tenant move together with a content edit makes the caller the author (the content moved too)', async () => {
    await put('t-shared', { tenant_id: 'default', prompt: 'Moved and rewritten' }, human())
    expect(await authorOf('t-shared')).toEqual({ userId: ownerId, label: 'owner', by: null, at: null, status: 'draft' })
  })

  it('the toggle route, which mirrors through the same writer, does not blank the author', async () => {
    const r = await post('/api/schedules/t-live/toggle', undefined, human())
    expect(r.status).toBe(200)
    expect((await dbMod.getScheduleFromDb('t-live'))!.enabled).toBe(0)
    expect(await authorOf('t-live')).toEqual({ userId: tenantUserId, label: 'tenant-user-a', by: 'owner', at: 1000, status: 'live' })
  })

  it('writeScheduledTask with no author or activation (the file-mirror path) keeps both', async () => {
    await io.writeScheduledTask('t-live', { enabled: false })
    await io.writeScheduledTask('t-live', { prompt: 'Changed by a writer that names no author' })
    expect(await authorOf('t-live')).toEqual({ userId: tenantUserId, label: 'tenant-user-a', by: 'owner', at: 1000, status: 'live' })
  })
})

describe('the schedule list and the author user id', () => {
  const list = async (who: Principal) => (await call('GET', '/api/schedules', undefined, who)).body as unknown as Array<Record<string, unknown>>

  it('an admin sees the author id, the author label, the activator and the time; a tenant caller sees only the time', async () => {
    const asAdmin = (await list(human())).find(t => t['name'] === 't-live')!
    expect(asAdmin['authorUserId']).toBe(tenantUserId)
    expect(asAdmin['authorLabel']).toBe('tenant-user-a')
    expect(asAdmin['activatedBy']).toBe('owner')
    expect(asAdmin['activatedAt']).toBe(1000)

    for (const who of [tenantUser, scopedToken]) {
      const rows = await list(who)
      expect(rows.map(t => t['name']).sort()).toEqual(['t-draft', 't-live', 't-shared'])
      for (const t of rows) {
        for (const key of ['authorUserId', 'authorLabel', 'activatedBy']) expect(key in t, `${String(t['name'])} ${key}`).toBe(false)
      }
      expect(rows.find(t => t['name'] === 't-live')!['activatedAt']).toBe(1000)
    }
  })

  it('the content hash does not depend on whether the id is shown', async () => {
    const a = (await list(human())).find(t => t['name'] === 't-live')!['contentHash']
    const t = (await list(tenantUser)).find(x => x['name'] === 't-live')!['contentHash']
    expect(t).toBe(a)
  })
})

describe('a run-now refused by the author check', () => {
  it.each([['author_inactive', 409], ['author_unverifiable', 409], ['invalid_value', 400]])('%s answers %i', async (error, status) => {
    const runner = await import('../web/schedule-runner.js')
    vi.mocked(runner.runScheduledTaskNow).mockResolvedValue({ ok: false, error, hint: 'h' })
    const r = await post('/api/schedules/t-live/run', undefined, human())
    expect(r.status).toBe(status)
    expect(r.body['error']).toBe(error)
  })
})

describe('activating a task records the activator and leaves the author', () => {
  it('a human admin activating a draft is the activator, now; the author stays the tenant user', async () => {
    const before = Math.floor(Date.now() / 1000)
    const r = await post('/api/schedules/t-draft/activate', undefined, human())
    expect(r.status).toBe(200)
    const a = await authorOf('t-draft')
    expect(a).toMatchObject({ userId: tenantUserId, label: 'tenant-user-a', by: 'owner', status: 'live' })
    expect(a.at).toBeGreaterThanOrEqual(before)
    expect(a.at).toBeLessThanOrEqual(before + 5)
    expect(auditDetail('t-draft', 'activate')).toMatchObject({ author_label: 'tenant-user-a', activated_by: 'owner' })
  })

  it('a token cannot activate, and nothing is recorded', async () => {
    const r = await post('/api/schedules/t-draft/activate', undefined, sharedToken('fleet-agent'))
    expect(r.status).toBe(403)
    expect(await authorOf('t-draft')).toEqual({ userId: tenantUserId, label: 'tenant-user-a', by: null, at: null, status: 'draft' })
  })
})
