// Re-review of an approved schedule, through the REAL route + DB + task listing (no
// persistence mocks): a caller that is not a human admin and changes what a live task
// executes sends it back to pending_review, and the runner's own liveness check then
// refuses it. Each test names the write that must NOT leave the task live.
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

type Principal = { role: string; tenantId: string | null; auth: Record<string, unknown>; agentId?: string }
const human: Principal = { role: 'admin', tenantId: null, auth: { kind: 'session', user: 'owner' } }
const sharedToken = (claimed?: string): Principal => ({ role: 'admin', tenantId: null, auth: { kind: 'token' }, agentId: claimed })
const tenantUser = (tenant: string): Principal => ({ role: 'agent', tenantId: tenant, auth: { kind: 'session', user: 'tenant-user' } })
const scopedToken = (tenant: string): Principal => ({ role: 'agent', tenantId: tenant, auth: { kind: 'token', tokenName: 'ci-key' } })

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sched-rereview-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  route = await import('../web/routes/schedules.js')
  io = await import('../web/scheduled-tasks-io.js')

  dbMod.createTenant('tenant-b', 'Tenant B')
  dbMod.updateTenant('tenant-b', { main_agent_id: 'tenant-agent' })
  dbMod.setTenantAgentAvailability('tenant-b', 'tenant-agent', true)
  dbMod.setTenantAgentAvailability('tenant-b', 'shared-agent', true)
  dbMod.setTenantAgentAvailability('default', 'shared-agent', true)

  const base = { description: 'Daily', prompt: 'Summarise the day', schedule: '0 9 * * *', enabled: true, skip_if_busy: false, force_send: false }
  dbMod.upsertSchedule('t-live', { ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b', status: 'live' })
  dbMod.upsertSchedule('t-draft', { ...base, agent: 'tenant-agent', type: 'task', tenant_id: 'tenant-b', status: 'draft' })
  dbMod.upsertSchedule('t-other', { ...base, agent: 'fleet-agent', type: 'task', tenant_id: 'default', status: 'live' })
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
  req.headers = {}
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
const put = (name: string, body: object, who: Principal) => call('PUT', `/api/schedules/${name}`, body, who)

const stored = (name: string) => dbMod.getScheduleFromDb(name)!
// The runner's own question, asked of the real task listing: would this task be fired?
const runnerWouldFire = (name: string) => {
  const task = io.listScheduledTasks().find(t => t.name === name)
  return !!task && io.isTaskLive(task)
}
const auditRows = (name: string) => dbMod.getDb()
  .prepare("SELECT agent_id, action, detail FROM agent_audit_log WHERE entity = 'schedule' AND entity_id = ? ORDER BY id")
  .all(name) as Array<{ agent_id: string; action: string; detail: string }>
const reviewMessages = () => dbMod.getDb()
  .prepare("SELECT to_agent, from_agent, content FROM agent_messages WHERE content LIKE '[SCHEDULE_REVIEW]%' ORDER BY id")
  .all() as Array<{ to_agent: string; from_agent: string; content: string }>

// What the dashboard sends on every save of an unchanged prompt task.
const dashboardSave = () => ({
  description: 'Daily', prompt: 'Summarise the day', schedule: '0 9 * * *', agent: 'tenant-agent', type: 'task',
  skipIfBusy: false, forceSend: false,
})

describe('a non-human edit of what a live task executes sends it back to review', () => {
  it.each([
    ['prompt', { prompt: 'Summarise the week' }],
    ['schedule', { schedule: '*/5 * * * *' }],
    ['type', { type: 'heartbeat' }],
    ['skipIfBusy', { skipIfBusy: true }],
    ['forceSend', { forceSend: true }],
    ['targetSession', { targetSession: 'agent-main' }],
  ])('%s, by a tenant user: pending_review and the runner will not fire it', async (field, patch) => {
    expect(runnerWouldFire('t-live')).toBe(true)
    const out = await put('t-live', patch, tenantUser('tenant-b'))
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, status: 'pending_review', review_required: true, changed: [field] })
    expect(stored('t-live').status).toBe('pending_review')
    expect(runnerWouldFire('t-live')).toBe(false)
  })

  it('a command task: a new command by a scoped token needs review', async () => {
    dbMod.upsertSchedule('t-cmd', {
      description: 'Backup', prompt: '', schedule: '0 3 * * *', agent: 'tenant-agent', type: 'command',
      command: 'echo ok', enabled: true, skip_if_busy: false, force_send: false, tenant_id: 'tenant-b', status: 'live',
    })
    const out = await put('t-cmd', { command: 'echo changed', timeoutMs: 20000 }, scopedToken('tenant-b'))
    expect(out.body).toMatchObject({ review_required: true, changed: ['command', 'timeoutMs'] })
    expect(runnerWouldFire('t-cmd')).toBe(false)
  })

  it('an agent on the shared token (not a human) is held to the same rule, agent change included', async () => {
    const out = await put('t-live', { agent: 'shared-agent' }, sharedToken('shared-agent'))
    expect(out.body).toMatchObject({ status: 'pending_review', changed: ['agent'] })
    expect(stored('t-live').agent).toBe('shared-agent')
    expect(runnerWouldFire('t-live')).toBe(false)
  })

  it('the edit itself lands, so an admin reviews the new content, not a lost one', async () => {
    await put('t-live', { prompt: 'Summarise the week' }, tenantUser('tenant-b'))
    expect(stored('t-live').prompt).toBe('Summarise the week')
  })
})

describe('edits that must NOT send a task to review', () => {
  it('the dashboard re-sending every unchanged field is a no-op: still live, plain {ok:true}, no message', async () => {
    const out = await put('t-live', dashboardSave(), tenantUser('tenant-b'))
    expect(out.body).toEqual({ ok: true })
    expect(stored('t-live').status).toBe('live')
    expect(runnerWouldFire('t-live')).toBe(true)
    expect(reviewMessages()).toHaveLength(0)
  })

  it('description and enabled alone', async () => {
    const out = await put('t-live', { description: 'Renamed label', enabled: false }, tenantUser('tenant-b'))
    expect(out.body).toEqual({ ok: true })
    expect(stored('t-live')).toMatchObject({ status: 'live', description: 'Renamed label', enabled: 0 })
  })

  it('a human admin editing every executed field', async () => {
    const out = await put('t-live', { prompt: 'x', schedule: '1 1 * * *', agent: 'shared-agent', type: 'heartbeat' }, human)
    expect(out.body).toEqual({ ok: true })
    expect(stored('t-live').status).toBe('live')
    expect(runnerWouldFire('t-live')).toBe(true)
  })

  it('a task that is not live: the edit lands, the status does not move, nobody is told again', async () => {
    const out = await put('t-draft', { prompt: 'edited while a draft' }, tenantUser('tenant-b'))
    expect(out.body).toEqual({ ok: true })
    expect(stored('t-draft')).toMatchObject({ status: 'draft', prompt: 'edited while a draft' })
    expect(reviewMessages()).toHaveLength(0)
    expect(auditRows('t-draft').map(r => r.action)).toEqual(['update'])
  })

  it("another tenant's task is a 404 and is not touched", async () => {
    const before = stored('t-other')
    const out = await put('t-other', { prompt: 'hijack' }, tenantUser('tenant-b'))
    expect(out.status).toBe(404)
    expect(stored('t-other')).toEqual(before)
    expect(auditRows('t-other')).toHaveLength(0)
  })
})

describe('audit trail and notification', () => {
  it('a demotion writes exactly one review_requested row naming the field, the tenant and the actor', async () => {
    await put('t-live', { prompt: 'Summarise the week' }, tenantUser('tenant-b'))
    const rows = auditRows('t-live')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'tenant-user', action: 'review_requested' })
    const detail = JSON.parse(rows[0]!.detail)
    expect(detail).toMatchObject({ tenant: 'tenant-b', actor_kind: 'session', claimed_agent: null, changed: ['prompt'] })
    expect(detail.fields.prompt.preview).toBe('Summarise the week')
    expect(detail.fields.prompt.before_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(detail.fields.prompt.before_sha256).not.toBe(detail.fields.prompt.after_sha256)
  })

  it('the audit row keeps a preview of a long prompt, not the prompt', async () => {
    const long = 'A'.repeat(5000)
    await put('t-live', { prompt: long }, tenantUser('tenant-b'))
    const raw = auditRows('t-live')[0]!.detail
    expect(JSON.parse(raw).fields.prompt.preview).toHaveLength(200)
    expect(raw.length).toBeLessThan(1500)
  })

  it('a shared-token caller is recorded by its claim, marked as a claim', async () => {
    await put('t-live', { prompt: 'p2' }, sharedToken('shared-agent'))
    const [row] = auditRows('t-live')
    expect(row!.agent_id).toBe('claimed:shared-agent')
    expect(JSON.parse(row!.detail)).toMatchObject({ actor_kind: 'token', claimed_agent: 'shared-agent' })
  })

  it('a no-op or exempt-only save still leaves exactly one plain update row', async () => {
    await put('t-live', dashboardSave(), tenantUser('tenant-b'))
    const rows = auditRows('t-live')
    expect(rows.map(r => r.action)).toEqual(['update'])
    expect(JSON.parse(rows[0]!.detail).changed).toEqual([])
  })

  it('the main agent is told once per hour per task, with the changed fields and the actor', async () => {
    await put('t-live', { prompt: 'p2' }, tenantUser('tenant-b'))
    const [msg] = reviewMessages()
    expect(msg).toMatchObject({ from_agent: 'system', to_agent: 'main-agent' })
    expect(msg!.content).toBe('[SCHEDULE_REVIEW] task=t-live tenant=tenant-b reason=edited changed=[prompt] by=tenant-user')

    // An admin activates it, the tenant edits again within the hour: held again, not announced again.
    dbMod.activateSchedule('t-live')
    const second = await put('t-live', { prompt: 'p3' }, tenantUser('tenant-b'))
    expect(second.body).toMatchObject({ status: 'pending_review' })
    expect(reviewMessages()).toHaveLength(1)
    expect(auditRows('t-live').map(r => r.action)).toEqual(['review_requested', 'review_requested'])
  })

  it('a failing notification does not fail the save', async () => {
    const spy = vi.spyOn(dbMod, 'createAgentMessage').mockImplementation(() => { throw new Error('queue down') })
    const out = await put('t-live', { prompt: 'p2' }, tenantUser('tenant-b'))
    spy.mockRestore()
    expect(out.status).toBe(200)
    expect(stored('t-live').status).toBe('pending_review')
  })
})

describe('activation checks the content the admin looked at', () => {
  const listedHash = async (name: string) => {
    const out = await call('GET', '/api/schedules', undefined, human)
    const rows = out.body as unknown as Array<{ name: string; contentHash: string }>
    return rows.find(r => r.name === name)!.contentHash
  }

  it('the list carries a contentHash that moves when an executed field changes, and not for a label', async () => {
    const h0 = await listedHash('t-draft')
    await put('t-draft', { description: 'only a label' }, tenantUser('tenant-b'))
    expect(await listedHash('t-draft')).toBe(h0)
    await put('t-draft', { prompt: 'something else' }, tenantUser('tenant-b'))
    expect(await listedHash('t-draft')).not.toBe(h0)
  })

  it('activating with the hash the admin saw succeeds and the task runs', async () => {
    const hash = await listedHash('t-draft')
    const out = await call('POST', `/api/schedules/t-draft/activate?expected_hash=${hash}`, undefined, human)
    expect(out.status).toBe(200)
    expect(stored('t-draft').status).toBe('live')
    expect(runnerWouldFire('t-draft')).toBe(true)
  })

  it('a draft edited after the admin opened it is refused with 409 stale_revision and stays a draft', async () => {
    const hash = await listedHash('t-draft')
    await put('t-draft', { prompt: 'swapped after the admin looked' }, tenantUser('tenant-b'))
    const out = await call('POST', `/api/schedules/t-draft/activate?expected_hash=${hash}`, undefined, human)
    expect(out.status).toBe(409)
    expect(out.body).toMatchObject({ error: 'stale_revision', content_hash: await listedHash('t-draft') })
    expect(stored('t-draft').status).toBe('draft')
    expect(runnerWouldFire('t-draft')).toBe(false)
  })

  it('a held (pending_review) task is covered the same way, and the fresh hash then activates it', async () => {
    const seen = await listedHash('t-live')
    await put('t-live', { prompt: 'first edit' }, tenantUser('tenant-b'))
    expect((await call('POST', `/api/schedules/t-live/activate?expected_hash=${seen}`, undefined, human)).status).toBe(409)
    expect(stored('t-live').status).toBe('pending_review')
    const fresh = await listedHash('t-live')
    expect((await call('POST', `/api/schedules/t-live/activate?expected_hash=${fresh}`, undefined, human)).status).toBe(200)
    expect(stored('t-live').status).toBe('live')
  })

  it('without an expected_hash activation still works (a caller with no screen, e.g. the CRUD recipe)', async () => {
    expect((await call('POST', '/api/schedules/t-draft/activate', undefined, human)).status).toBe(200)
  })

  it('a non-human still cannot activate, with or without a hash', async () => {
    const hash = await listedHash('t-draft')
    expect((await call('POST', `/api/schedules/t-draft/activate?expected_hash=${hash}`, undefined, tenantUser('tenant-b'))).status).toBe(403)
    expect((await call('POST', '/api/schedules/t-draft/activate', undefined, sharedToken('x'))).status).toBe(403)
    expect(stored('t-draft').status).toBe('draft')
  })
})

describe('every other schedule write is audited too', () => {
  it('activate, toggle and delete each leave exactly one row, with the actor', async () => {
    await call('POST', '/api/schedules/t-draft/activate', undefined, human)
    await call('POST', '/api/schedules/t-draft/toggle', undefined, tenantUser('tenant-b'))
    await call('DELETE', '/api/schedules/t-draft', undefined, tenantUser('tenant-b'))
    const rows = auditRows('t-draft')
    expect(rows.map(r => [r.agent_id, r.action])).toEqual([
      ['owner', 'activate'], ['tenant-user', 'toggle'], ['tenant-user', 'delete'],
    ])
    expect(JSON.parse(rows[0]!.detail)).toMatchObject({ tenant: 'tenant-b', status_before: 'draft' })
    expect(JSON.parse(rows[1]!.detail)).toMatchObject({ enabled: false })
  })

  it("a refused write (another tenant's task) leaves no row", async () => {
    await call('POST', '/api/schedules/t-other/toggle', undefined, tenantUser('tenant-b'))
    await call('DELETE', '/api/schedules/t-other', undefined, tenantUser('tenant-b'))
    expect(auditRows('t-other')).toHaveLength(0)
    expect(stored('t-other')).toBeDefined()
  })

  it('a non-human create is a draft, is audited, and tells the main agent; a human create does not', async () => {
    const body = (n: string) => ({ name: n, prompt: 'do it', schedule: '0 9 * * *', agent: 'tenant-agent', type: 'task' })
    const asTenant = await call('POST', '/api/schedules', body('made-by-tenant'), tenantUser('tenant-b'))
    expect(asTenant.body).toMatchObject({ status: 'draft' })
    expect(auditRows('made-by-tenant').map(r => r.action)).toEqual(['create'])
    expect(reviewMessages().map(m => m.content)).toEqual([
      '[SCHEDULE_REVIEW] task=made-by-tenant tenant=tenant-b reason=created by=tenant-user',
    ])
    const asHuman = await call('POST', '/api/schedules', { ...body('made-by-human'), tenant_id: 'tenant-b' }, human)
    expect(asHuman.body).toMatchObject({ status: 'live' })
    expect(auditRows('made-by-human').map(r => r.action)).toEqual(['create'])
    expect(reviewMessages()).toHaveLength(1)
  })
})
