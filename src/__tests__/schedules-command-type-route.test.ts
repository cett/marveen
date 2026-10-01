// Command-type scheduled tasks through the REAL schedules route + DB (no mocks
// of the persistence layer), with the schedule files redirected to a tmp HOME so
// nothing touches the operator's real task directory.
//
// Regression: the Edit dialog only knew task/heartbeat. Opening a command task
// (the nightly backup) showed it as a prompt task and saving PUT `type:'task'`,
// silently turning a shell command into a prompt for an LLM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'
import { buildSchedulePayload } from '../../web/modules/schedule-payload.js'

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

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'sched-cmd-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmp
  process.env['MARVEEN_STORE_DIR'] = join(tmp, 'store')
  vi.resetModules()
  dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  io = await import('../web/scheduled-tasks-io.js')
  route = await import('../web/routes/schedules.js')
  // A live nightly backup, shaped like the real row: type command, 120 s timeout, alert on the 1st failure.
  dbMod.upsertSchedule('nightly-backup', {
    prompt: 'Legacy LLM prompt that the command task ignores',
    description: 'Nightly data backup at 03:00',
    schedule: '0 3 * * *',
    agent: 'main-agent',
    type: 'command',
    enabled: true,
    skip_if_busy: false,
    force_send: false,
    command: 'bash /opt/app/scripts/backup.sh',
    timeout_ms: 120000,
    fail_threshold: 1,
    status: 'live',
    tenant_id: 'default',
  })
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']; else process.env['HOME'] = prevHome
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(tmp, { recursive: true, force: true })
})

async function call(method: string, path: string, body?: object, auth: 'session' | 'token' = 'session') {
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
      try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) as Record<string, unknown> } catch { /* ignore */ }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, role: 'admin', tenantId: null, auth: { kind: auth } } as unknown as RouteContext
  await route.tryHandleSchedules(ctx)
  return out
}

const row = (name: string) => {
  const r = dbMod.getScheduleFromDb(name)
  if (!r) return undefined
  const { updated_at: _u, ...rest } = r as unknown as Record<string, unknown>
  return rest
}

/** What openEditSchedule puts into the modal for a stored task, saved untouched. */
function dialogPayloadFor(name: string) {
  const task = io.rowToTask(dbMod.getScheduleFromDb(name)!)
  const built = buildSchedulePayload({
    name: task.name, description: task.description, prompt: task.prompt, schedule: task.schedule,
    agent: task.agent, type: task.type === 'heartbeat' || task.type === 'command' ? task.type : 'task',
    skipIfBusy: !!task.skipIfBusy, forceSend: !!task.forceSend, targetSession: task.targetSession ?? '',
    command: task.command ?? '', timeoutMs: task.timeoutMs != null ? String(task.timeoutMs) : '',
    failThreshold: task.failThreshold != null ? String(task.failThreshold) : '',
  }, { editing: true })
  if (!built.ok) throw new Error('dialog refused its own stored task: ' + built.focus)
  return built.body
}

describe('PUT from the Edit dialog leaves a command task exactly as it was', () => {
  it('saving the untouched nightly-backup changes no field of the stored row', async () => {
    const before = row('nightly-backup')
    const out = await call('PUT', '/api/schedules/nightly-backup', dialogPayloadFor('nightly-backup'))
    expect(out.status).toBe(200)
    expect(row('nightly-backup')).toEqual(before)
    expect(before).toMatchObject({ type: 'command', timeout_ms: 120000, fail_threshold: 1, command: 'bash /opt/app/scripts/backup.sh' })
  })

  it('an edited timeout / threshold lands, everything else stays', async () => {
    const before = row('nightly-backup')
    const payload = { ...dialogPayloadFor('nightly-backup'), timeoutMs: 300000, failThreshold: 3 }
    expect((await call('PUT', '/api/schedules/nightly-backup', payload)).status).toBe(200)
    expect(row('nightly-backup')).toEqual({ ...before, timeout_ms: 300000, fail_threshold: 3 })
  })
})

describe('PUT refuses an implicit type change away from command', () => {
  it.each(['task', 'heartbeat'])('type %s without allowTypeChange -> 400 and the row is untouched', async type => {
    const before = row('nightly-backup')
    const out = await call('PUT', '/api/schedules/nightly-backup', { type, prompt: 'p' })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'type' })
    expect(row('nightly-backup')).toEqual(before)
  })

  it('an explicit allowTypeChange:true goes through', async () => {
    const out = await call('PUT', '/api/schedules/nightly-backup', { type: 'task', prompt: 'now a prompt', allowTypeChange: true })
    expect(out.status).toBe(200)
    expect(row('nightly-backup')).toMatchObject({ type: 'task', prompt: 'now a prompt' })
  })

  it('sending type:command again is not a change', async () => {
    expect((await call('PUT', '/api/schedules/nightly-backup', { type: 'command', description: 'renamed' })).status).toBe(200)
    expect(row('nightly-backup')).toMatchObject({ type: 'command', description: 'renamed' })
  })

  it('a PUT that clears the command of a command task -> 400', async () => {
    const out = await call('PUT', '/api/schedules/nightly-backup', { command: '  ' })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'required', field: 'command' })
  })

  it.each([0, -1, 1.5, 'x'])('timeoutMs %s -> 400', async v => {
    const out = await call('PUT', '/api/schedules/nightly-backup', { timeoutMs: v })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'timeoutMs' })
  })

  it('converting a prompt task to a command task needs a command', async () => {
    dbMod.upsertSchedule('plain', {
      prompt: 'p', description: '', schedule: '0 9 * * *', agent: 'main-agent', type: 'task',
      enabled: true, skip_if_busy: false, force_send: false, status: 'live', tenant_id: 'default',
    })
    expect((await call('PUT', '/api/schedules/plain', { type: 'command' })).status).toBe(400)
    expect((await call('PUT', '/api/schedules/plain', { type: 'command', command: 'echo hi' })).status).toBe(200)
    expect(row('plain')).toMatchObject({ type: 'command', command: 'echo hi' })
  })
})

describe('POST /api/schedules with type=command', () => {
  const body = { name: 'cmd-job', schedule: '*/10 * * * *', type: 'command', command: 'echo ok', timeoutMs: 60000, failThreshold: 2 }

  it('creates it without a prompt', async () => {
    const out = await call('POST', '/api/schedules', body)
    expect(out.status).toBe(200) // the route has always answered 200 on create
    expect(out.body).toMatchObject({ ok: true, name: 'cmd-job', status: 'live' })
    expect(row('cmd-job')).toMatchObject({ type: 'command', command: 'echo ok', timeout_ms: 60000, fail_threshold: 2, prompt: '' })
  })

  it('without a command -> 400 (required, field command)', async () => {
    const out = await call('POST', '/api/schedules', { ...body, command: undefined })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'required', field: 'command' })
    expect(row('cmd-job')).toBeUndefined()
  })

  it('a blank command -> 400', async () => {
    expect((await call('POST', '/api/schedules', { ...body, command: '   ' })).status).toBe(400)
  })

  it('a bad failThreshold -> 400', async () => {
    const out = await call('POST', '/api/schedules', { ...body, failThreshold: 0 })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'failThreshold' })
  })

  it('an agent-token caller still gets draft (the review gate applies to command tasks too)', async () => {
    const out = await call('POST', '/api/schedules', { ...body, tenant_id: 'default' }, 'token')
    expect(out.body).toMatchObject({ status: 'draft' })
  })

  it('a prompt task still needs its prompt', async () => {
    const out = await call('POST', '/api/schedules', { name: 'p1', schedule: '0 9 * * *' })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'required', field: 'prompt' })
  })
})
