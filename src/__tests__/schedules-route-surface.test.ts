// Route-surface coverage for schedules.ts (#751 step 16): the file-mode
// GET/PUT/toggle/run/runs paths, the pending-retry GET/DELETE endpoints, the
// AI-backed expand-questions/expand-prompt routes, and the agents list --
// none of which were exercised by schedules-tenant.test.ts (DB-mode CRUD) or
// schedules-error-shapes.test.ts (validation/not-found shapes only).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
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

vi.mock('../web/sanitize.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/sanitize.js')>()
  return { ...orig }
})

vi.mock('../web/cron.js', () => ({
  isValidCronShape: vi.fn().mockReturnValue(true),
}))

vi.mock('../web/schedule-runner.js', () => ({
  runScheduledTaskNow: vi.fn().mockResolvedValue({ ok: true, result: 'ran' }),
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

const mockCountSchedules = vi.fn().mockReturnValue(0)
const mockGetScheduleFromDb = vi.fn()

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
}))

vi.mock('../agent.js', () => ({
  runAgent: vi.fn(),
}))

// ── makeCtx ───────────────────────────────────────────────────────────────────

function makeCtx(
  method: string,
  rawPath: string,
  body?: object | string,
  role: 'admin' | 'viewer' | 'read_only' = 'viewer',
  tenantId: string | null = 'default',
): { ctx: RouteContext; out: { status: number; body: Record<string, unknown> } } {
  const buf = body === undefined
    ? Buffer.alloc(0)
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
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
    ctx: { req, res, path: url.pathname, method, url, role, tenantId } as unknown as RouteContext,
    out,
  }
}

import { tryHandleSchedules } from '../web/routes/schedules.js'
import { existsSync } from 'node:fs'
import { runAgent } from '../agent.js'
import { listAgentNames, readFileOr } from '../web/agent-config.js'
import { listScheduledTasksFromFiles, writeScheduledTask } from '../web/scheduled-tasks-io.js'
import { listPendingTaskRetries, listTaskRunHistory } from '../db.js'
import { isValidCronShape } from '../web/cron.js'

const mockExistsSync = vi.mocked(existsSync)
const mockRunAgent = vi.mocked(runAgent)
const mockListAgentNames = vi.mocked(listAgentNames)
const mockReadFileOr = vi.mocked(readFileOr)
const mockListFromFiles = vi.mocked(listScheduledTasksFromFiles)
const mockWriteScheduledTask = vi.mocked(writeScheduledTask)
const mockListPendingTaskRetries = vi.mocked(listPendingTaskRetries)
const mockListTaskRunHistory = vi.mocked(listTaskRunHistory)
const mockIsValidCron = vi.mocked(isValidCronShape)

beforeEach(() => {
  vi.clearAllMocks()
  mockCountSchedules.mockReturnValue(0)
  mockIsValidCron.mockReturnValue(true)
  mockExistsSync.mockReturnValue(true)
})

// ── GET /api/schedules/agents ───────────────────────────────────────────────

describe('GET /api/schedules/agents', () => {
  it('returns the main agent first, then the sub-agents with avatar URLs', async () => {
    mockListAgentNames.mockReturnValue(['agent-b', 'agent-c'])
    const { ctx, out } = makeCtx('GET', '/api/schedules/agents')
    const handled = await tryHandleSchedules(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    const agents = out.body as unknown as Array<{ name: string; label: string; avatar: string }>
    expect(agents[0]).toEqual({ name: 'jarvis', label: 'Jarvis', avatar: '/api/marveen/avatar' })
    expect(agents[1]).toEqual({ name: 'agent-b', label: 'agent-b', avatar: '/api/agents/agent-b/avatar' })
    expect(agents[2]).toEqual({ name: 'agent-c', label: 'agent-c', avatar: '/api/agents/agent-c/avatar' })
  })
})

// ── POST /api/schedules/expand-questions ────────────────────────────────────

describe('POST /api/schedules/expand-questions', () => {
  it('returns required+prompt when prompt is missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/schedules/expand-questions', { prompt: '  ' })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('prompt')
  })

  it('parses the AI-generated question array on success', async () => {
    mockRunAgent.mockResolvedValueOnce({ text: '[{"question":"Mikor?","options":["Ma","Holnap"]}]' } as never)
    const { ctx, out } = makeCtx('POST', '/api/schedules/expand-questions', { prompt: 'napi jelentes', agent: 'jarvis' })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([{ question: 'Mikor?', options: ['Ma', 'Holnap'] }])
  })

  it('returns internal_error when the AI call fails', async () => {
    mockRunAgent.mockRejectedValueOnce(new Error('boom'))
    const { ctx, out } = makeCtx('POST', '/api/schedules/expand-questions', { prompt: 'napi jelentes' })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
  })
})

// ── POST /api/schedules/expand-prompt ───────────────────────────────────────

describe('POST /api/schedules/expand-prompt', () => {
  it('returns required+prompt when prompt is missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/schedules/expand-prompt', { prompt: '', answers: [] })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('prompt')
  })

  it('strips a code fence from the AI-expanded prompt on success', async () => {
    mockRunAgent.mockResolvedValueOnce({ text: '```\nReszletes utasitas.\n```' } as never)
    const { ctx, out } = makeCtx('POST', '/api/schedules/expand-prompt', {
      prompt: 'napi jelentes', answers: [{ question: 'Mikor?', answer: 'Ma' }],
    })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body.prompt).toBe('Reszletes utasitas.')
  })

  it('returns internal_error when the AI call fails', async () => {
    mockRunAgent.mockRejectedValueOnce(new Error('boom'))
    const { ctx, out } = makeCtx('POST', '/api/schedules/expand-prompt', { prompt: 'napi jelentes', answers: [] })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
  })
})

// ── GET /api/schedules (file-mode) ──────────────────────────────────────────

describe('GET /api/schedules -- file-mode (countSchedules === 0)', () => {
  it('returns listScheduledTasksFromFiles() verbatim', async () => {
    mockListFromFiles.mockReturnValue([{ name: 'morning-chain', schedule: '0 7 * * *' } as never])
    const { ctx, out } = makeCtx('GET', '/api/schedules')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([{ name: 'morning-chain', schedule: '0 7 * * *' }])
  })
})

// ── POST /api/schedules -- body too large ───────────────────────────────────

describe('POST /api/schedules -- request body too large', () => {
  it('returns 413 limit_exceeded before any JSON parsing', async () => {
    const hugeBody = JSON.stringify({ name: 'x', prompt: 'y'.repeat(300_000), schedule: '* * * * *' })
    const { ctx, out } = makeCtx('POST', '/api/schedules', hugeBody)
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(413)
    expect(out.body.error).toBe('limit_exceeded')
  })
})

// ── PUT /api/schedules/:name (file-mode) ────────────────────────────────────

describe('PUT /api/schedules/:name -- file-mode', () => {
  it('writes the update and returns ok:true', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/schedules/my-task', { description: 'updated' })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })
    expect(mockWriteScheduledTask).toHaveBeenCalledWith('my-task', { description: 'updated' })
  })

  it('returns 413 when the body is too large', async () => {
    const hugeBody = JSON.stringify({ prompt: 'y'.repeat(300_000) })
    const { ctx, out } = makeCtx('PUT', '/api/schedules/my-task', hugeBody)
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(413)
    expect(out.body.error).toBe('limit_exceeded')
  })

  it('returns invalid_value+schedule for a bad cron expression', async () => {
    mockIsValidCron.mockReturnValue(false)
    const { ctx, out } = makeCtx('PUT', '/api/schedules/my-task', { schedule: 'not-a-cron' })
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.field).toBe('schedule')
  })
})

describe('PUT /api/schedules/:name -- DB-mode cross-tenant guard', () => {
  it('returns not_found (not a leaked 403) when the schedule belongs to another tenant', async () => {
    mockCountSchedules.mockReturnValue(3)
    mockGetScheduleFromDb.mockReturnValue({ id: 'other-report', tenant_id: 'tenant-b' })
    const { ctx, out } = makeCtx('PUT', '/api/schedules/other-report', { description: 'x' }, 'viewer', 'tenant-a')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
    expect(mockWriteScheduledTask).not.toHaveBeenCalled()
  })
})

// ── POST /api/schedules/:name/toggle (file-mode) ────────────────────────────

describe('POST /api/schedules/:name/toggle -- file-mode', () => {
  it('reads the on-disk config and flips enabled', async () => {
    mockReadFileOr.mockReturnValue('{"enabled":false}')
    const { ctx, out } = makeCtx('POST', '/api/schedules/my-task/toggle')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, enabled: true })
    expect(mockWriteScheduledTask).toHaveBeenCalledWith('my-task', { enabled: true })
  })
})

// ── POST /api/schedules/:name/run ───────────────────────────────────────────

describe('POST /api/schedules/:name/run -- success', () => {
  it('returns the runner result', async () => {
    const { ctx, out } = makeCtx('POST', '/api/schedules/my-task/run')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, result: 'ran' })
  })
})

// ── GET /api/schedules/pending ───────────────────────────────────────────────

describe('GET /api/schedules/pending', () => {
  it('maps DB rows through toPendingRetryView', async () => {
    mockListPendingTaskRetries.mockReturnValue([{
      id: 1, task_name: 'my-task', agent_name: 'jarvis',
      first_attempt: 1000, last_attempt: 1000, attempt_count: 1,
      last_reason: 'busy', alert_sent_at: null,
    } as never])
    const { ctx, out } = makeCtx('GET', '/api/schedules/pending')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    const rows = out.body as unknown as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(1)
    expect(rows[0].taskName).toBe('my-task')
    expect(rows[0].attemptCount).toBe(1)
  })
})

// ── GET /api/schedules/:name/runs ───────────────────────────────────────────

describe('GET /api/schedules/:name/runs -- success', () => {
  it('returns the run history verbatim', async () => {
    mockListTaskRunHistory.mockReturnValue([{ id: 1, status: 'success' } as never])
    const { ctx, out } = makeCtx('GET', '/api/schedules/my-task/runs')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([{ id: 1, status: 'success' }])
    expect(mockListTaskRunHistory).toHaveBeenCalledWith('my-task', 10)
  })
})

// ── DELETE /api/schedules/pending/:id -- success ────────────────────────────

describe('DELETE /api/schedules/pending/:id -- success', () => {
  it('returns ok:true when the pending retry is removed', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/schedules/pending/42')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })
  })
})
