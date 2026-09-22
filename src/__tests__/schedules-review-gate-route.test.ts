// Route tests for the scheduled-task review-gate: POST /api/schedules
// stamps draft/live by caller identity, POST
// /api/schedules/:name/activate is human-admin-only, and POST
// /api/schedules/:name/run passes allowNotLive through to the runner based
// on the same isHumanAdmin() check. See src/web/routes/schedules.ts for the
// isHumanAdmin() rationale (shared fleet bearer token resolves to
// role==='admin' for every agent, so only auth.kind==='session' tells a
// human dashboard login apart from an agent's API call).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  rmSync: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'jarvis',
  currentBotName: () => 'Jarvis',
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue([]),
  readFileOr: vi.fn().mockReturnValue('{}'),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: '/tmp/mock-tasks',
  MAX_SCHEDULED_TASK_PROMPT_LEN: 10_000,
  listScheduledTasks: vi.fn().mockReturnValue([]),
  listScheduledTasksFromFiles: vi.fn().mockReturnValue([]),
  writeScheduledTask: vi.fn(),
  rowToTask: (row: { id: string }) => ({ name: row.id, ...row }),
}))

vi.mock('../web/sanitize.js', () => ({
  sanitizeScheduleName: (n: string) => n.replace(/[^a-z0-9-]/gi, '').toLowerCase(),
  safeJoin: (_b: string, n: string) => `/tmp/mock-tasks/${n}`,
}))

vi.mock('../web/cron.js', () => ({
  isValidCronShape: vi.fn().mockReturnValue(true),
}))

vi.mock('../web/schedule-runner.js', () => ({
  runScheduledTaskNow: vi.fn().mockResolvedValue({ ok: true, result: 'ran' }),
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

const mockCountSchedules = vi.fn().mockReturnValue(3)   // DB mode by default
const mockGetScheduleFromDb = vi.fn()
const mockActivateSchedule = vi.fn()

vi.mock('../db.js', () => ({
  listPendingTaskRetries: vi.fn().mockReturnValue([]),
  deletePendingTaskRetryById: vi.fn().mockReturnValue(true),
  listTaskRunHistory: vi.fn().mockReturnValue([]),
  countSchedules: (...a: unknown[]) => mockCountSchedules(...a),
  getScheduleFromDb: (...a: unknown[]) => mockGetScheduleFromDb(...a),
  listSchedulesFromDb: vi.fn().mockReturnValue([]),
  deleteSchedule: vi.fn(),
  setScheduleEnabled: vi.fn(),
  patchSchedule: vi.fn(),
  upsertSchedule: vi.fn(),
  activateSchedule: (...a: unknown[]) => mockActivateSchedule(...a),
}))

vi.mock('../agent.js', () => ({
  runAgent: vi.fn(),
}))

// ── makeCtx ───────────────────────────────────────────────────────────────────

function makeCtx(
  method: string,
  rawPath: string,
  body: object | undefined,
  opts: {
    role?: 'admin' | 'viewer' | 'read_only'
    tenantId?: string | null
    auth?: { kind: 'token' | 'session' | 'federation' | 'device' }
  } = {},
): { ctx: RouteContext; out: { status: number; body: Record<string, unknown> } } {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string>; destroy: () => void }
  req.method = method
  req.headers = {}
  req.destroy = () => {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      if (!b) return
      const str = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(str) as Record<string, unknown> } catch { /* ignore */ }
    },
  }
  const url = new URL(`http://localhost:3420${rawPath}`)
  return {
    ctx: {
      req, res, path: url.pathname, method, url,
      role: opts.role ?? 'admin',
      tenantId: opts.tenantId ?? null,
      auth: opts.auth,
    } as unknown as RouteContext,
    out,
  }
}

import { tryHandleSchedules } from '../web/routes/schedules.js'
import { writeScheduledTask } from '../web/scheduled-tasks-io.js'
import { runScheduledTaskNow } from '../web/schedule-runner.js'

const mockWriteScheduledTask = vi.mocked(writeScheduledTask)
const mockRunScheduledTaskNow = vi.mocked(runScheduledTaskNow)

beforeEach(() => {
  vi.clearAllMocks()
  mockCountSchedules.mockReturnValue(3)
  mockGetScheduleFromDb.mockReturnValue(undefined)
  mockRunScheduledTaskNow.mockResolvedValue({ ok: true, result: 'ran' })
})

// ── POST /api/schedules -- draft/live stamping ──────────────────────────────

describe('POST /api/schedules -- review-gate status stamping', () => {
  const body = { name: 'new-task', prompt: 'Do the thing', schedule: '0 9 * * *' }

  it('a human dashboard login (role admin + auth.kind session) creates status=live', async () => {
    const { ctx, out } = makeCtx('POST', '/api/schedules', body, { role: 'admin', auth: { kind: 'session' } })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ status: 'live' })
    expect(mockWriteScheduledTask).toHaveBeenCalledWith('new-task', expect.objectContaining({ status: 'live' }))
  })

  it('an agent token caller (role admin + auth.kind token) creates status=draft', async () => {
    const { ctx, out } = makeCtx('POST', '/api/schedules', body, { role: 'admin', auth: { kind: 'token' } })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ status: 'draft' })
    expect(mockWriteScheduledTask).toHaveBeenCalledWith('new-task', expect.objectContaining({ status: 'draft' }))
  })

  it('a non-admin viewer creates status=draft', async () => {
    const { ctx, out } = makeCtx('POST', '/api/schedules', body, { role: 'viewer', tenantId: 'tenant-a' })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ status: 'draft' })
  })

  it('an admin caller with no auth info at all (undefined auth.kind) creates status=draft', async () => {
    // No `auth` on ctx -- e.g. a request that never went through the session
    // gate. isHumanAdmin must fail closed, not treat missing auth as human.
    const { ctx, out } = makeCtx('POST', '/api/schedules', body, { role: 'admin' })
    await tryHandleSchedules(ctx)
    expect(out.body).toMatchObject({ status: 'draft' })
  })
})

// ── POST /api/schedules/:name/activate ──────────────────────────────────────

describe('POST /api/schedules/:name/activate', () => {
  it('403s a non-human-admin caller (agent token) without touching the DB', async () => {
    const { ctx, out } = makeCtx('POST', '/api/schedules/my-task/activate', undefined, { role: 'admin', auth: { kind: 'token' } })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('forbidden')
    expect(mockActivateSchedule).not.toHaveBeenCalled()
  })

  it('403s a non-admin human (session auth but role viewer)', async () => {
    const { ctx, out } = makeCtx('POST', '/api/schedules/my-task/activate', undefined, { role: 'viewer', auth: { kind: 'session' } })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(403)
    expect(mockActivateSchedule).not.toHaveBeenCalled()
  })

  it('404s an unknown schedule name for a human admin', async () => {
    mockActivateSchedule.mockReturnValue(null)
    const { ctx, out } = makeCtx('POST', '/api/schedules/does-not-exist/activate', undefined, { role: 'admin', auth: { kind: 'session' } })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('200s and flips status to live for a human admin on an existing draft', async () => {
    mockActivateSchedule.mockReturnValue({ id: 'my-task', status: 'live' })
    const { ctx, out } = makeCtx('POST', '/api/schedules/my-task/activate', undefined, { role: 'admin', auth: { kind: 'session' } })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, status: 'live' })
    expect(mockActivateSchedule).toHaveBeenCalledWith('my-task')
    expect(mockWriteScheduledTask).toHaveBeenCalledWith('my-task', { status: 'live' })
  })
})

// ── POST /api/schedules/:name/run -- review-gate bypass guard ──────────────

describe('POST /api/schedules/:name/run -- review-gate', () => {
  beforeEach(() => {
    mockGetScheduleFromDb.mockReturnValue({ id: 'draft-task', tenant_id: null, enabled: 1 })
  })

  it('409s not_live for a non-human-admin caller on a non-live task, without allowNotLive', async () => {
    mockRunScheduledTaskNow.mockResolvedValueOnce({ ok: false, error: 'not_live', hint: 'Schedule is not live -- an admin must activate it first' })
    const { ctx, out } = makeCtx('POST', '/api/schedules/draft-task/run', undefined, { role: 'admin', auth: { kind: 'token' } })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('not_live')
    expect(mockRunScheduledTaskNow).toHaveBeenCalledWith('draft-task', { allowNotLive: false })
  })

  it('succeeds for a human admin previewing a draft, passing allowNotLive: true', async () => {
    mockRunScheduledTaskNow.mockResolvedValueOnce({ ok: true, result: 'ran' })
    const { ctx, out } = makeCtx('POST', '/api/schedules/draft-task/run', undefined, { role: 'admin', auth: { kind: 'session' } })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, result: 'ran' })
    expect(mockRunScheduledTaskNow).toHaveBeenCalledWith('draft-task', { allowNotLive: true })
  })
})
