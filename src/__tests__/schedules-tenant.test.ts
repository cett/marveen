/**
 * Tenant-scoping tests for GET/POST/PUT/DELETE /api/schedules.
 * Mirrors the artifacts-routes.test.ts pattern: DB layer is mocked,
 * route logic is tested in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mock DB layer ────────────────────────────────────────────────────────────

const mockCountSchedules    = vi.fn().mockReturnValue(5)   // DB active
const mockListSchedulesDb   = vi.fn().mockReturnValue([])
const mockGetScheduleDb     = vi.fn()
const mockDeleteSchedule    = vi.fn()
const mockSetScheduleEnabled = vi.fn()

vi.mock('../db.js', () => ({
  listPendingTaskRetries:    vi.fn().mockReturnValue([]),
  deletePendingTaskRetryById: vi.fn(),
  listTaskRunHistory:        vi.fn().mockReturnValue([]),
  countSchedules:            (...a: unknown[]) => mockCountSchedules(...a),
  listSchedulesFromDb:       (...a: unknown[]) => mockListSchedulesDb(...a),
  getScheduleFromDb:         (...a: unknown[]) => mockGetScheduleDb(...a),
  deleteSchedule:            (...a: unknown[]) => mockDeleteSchedule(...a),
  setScheduleEnabled:        (...a: unknown[]) => mockSetScheduleEnabled(...a),
  patchSchedule:             vi.fn(),
  upsertSchedule:            vi.fn(),
  // Tenant lookups behind the create/edit rules: every tenant exists, every agent is a fleet agent.
  getTenant: vi.fn((id: string) => ({ id, disabled_at: null })),
  getTenantsForAgent: vi.fn().mockReturnValue([]),
  agentServesTenant: vi.fn().mockReturnValue(true),
  getServingTenant: vi.fn().mockReturnValue(null),
  resolveAgentTenant: vi.fn().mockReturnValue('default'),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR:         '/fake/tasks',
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
  listScheduledTasks:          vi.fn().mockReturnValue([]),
  listScheduledTasksFromFiles: vi.fn().mockReturnValue([]),
  writeScheduledTask:          vi.fn(),
  // Minimal id -> name mapping mirroring the real rowToTask, just enough
  // for the GET /api/schedules assertions below to see the shape the
  // frontend actually depends on.
  rowToTask:                   (row: { id: string }) => ({ name: row.id, ...row }),
}))

const mockLoadLastTickMs = vi.fn<() => number | null>().mockReturnValue(null)

vi.mock('../agent.js',        () => ({ runAgent: vi.fn() }))
// This module's own heavy transitive imports (schedule-mcp-precheck ->
// channel-coordinator/liveness -> config.js's STORE_DIR etc.) are why this
// file has always mocked schedule-runner.js wholesale rather than partially
// via importOriginal -- computeTickStatus's actual classification logic is
// unit-tested for real, unmocked, in schedule-tick-status.test.ts; here only
// the ROUTE's wiring (admin gate, calls loadLastTickMs + computeTickStatus,
// returns the result as JSON) is under test.
vi.mock('../web/schedule-runner.js', () => ({
  runScheduledTaskNow: vi.fn().mockResolvedValue({ ok: true, result: 'ok' }),
  loadLastTickMs: (...a: unknown[]) => mockLoadLastTickMs(...a as []),
  computeTickStatus: (lastTickMs: number | null, nowMs: number, thresholdMs = 3 * 60_000) => {
    if (lastTickMs == null) return { lastTickMs: null, ageSeconds: null, stale: true }
    const ageMs = Math.max(0, nowMs - lastTickMs)
    return { lastTickMs, ageSeconds: Math.round(ageMs / 1000), stale: ageMs > thresholdMs }
  },
}))
vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'jarvis',
  currentBotName: () => 'Jarvis',
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../web/cron.js',     () => ({ isValidCronShape: () => true }))
vi.mock('../web/sanitize.js', () => ({
  sanitizeScheduleName: (n: string) => n.replace(/[^a-z0-9-]/gi, '').toLowerCase(),
  safeJoin:             (_b: string, n: string) => `/fake/tasks/${n}`,
}))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue(['sub-a']),
  readFileOr:     vi.fn().mockReturnValue('{}'),
}))
vi.mock('../pending-retries.js', () => ({
  toPendingRetryView: vi.fn(),
}))

import { tryHandleSchedules } from '../web/routes/schedules.js'

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeCtx(
  method: string,
  rawPath: string,
  body?: object,
  role: 'admin' | 'viewer' | 'read_only' = 'viewer',
  tenantId: string | null = 'tenant-a',
): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader: vi.fn(),
    end(b?: string) {
      if (!b) return
      try { out.body = JSON.parse(b) } catch { out.body = b }
    },
  }
  const url = new URL(`http://localhost:3420${rawPath}`)
  const ctx = {
    req, res, path: url.pathname, method, url, role, tenantId,
  } as unknown as RouteContext
  return { ctx, out }
}

const fleetRow = { id: 'morning-chain', tenant_id: null, enabled: 1, schedule: '0 7 * * *', agent: 'jarvis', type: 'task' }
const tenantRow = { id: 'my-report', tenant_id: 'tenant-a', enabled: 1, schedule: '0 9 * * 1', agent: 'jarvis', type: 'task' }
const otherRow  = { id: 'other-report', tenant_id: 'tenant-b', enabled: 1, schedule: '0 9 * * 1', agent: 'jarvis', type: 'task' }

// ── GET /api/schedules ────────────────────────────────────────────────────────

describe('GET /api/schedules', () => {
  beforeEach(() => vi.clearAllMocks())

  it('admin with no filter gets all rows', async () => {
    mockListSchedulesDb.mockReturnValue([fleetRow, tenantRow])
    const { ctx, out } = makeCtx('GET', '/api/schedules', undefined, 'admin', null)
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(mockListSchedulesDb).toHaveBeenCalledWith()
  })


  it('non-admin gets only their tenant rows', async () => {
    mockListSchedulesDb.mockReturnValue([tenantRow])
    const { ctx, out } = makeCtx('GET', '/api/schedules', undefined, 'viewer', 'tenant-a')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(mockListSchedulesDb).toHaveBeenCalledWith({ tenantId: 'tenant-a' })
  })

  // Regression coverage: DB rows key on `id`, but the frontend (and the
  // file-based branch) key on `name` -- without mapping through rowToTask,
  // every row in the response is missing `name`, which breaks delete/
  // toggle/run/edit (they build the URL from task.name -> "/undefined").
  it('DB-mode rows are mapped to include `name` (= id), not just `id`', async () => {
    mockListSchedulesDb.mockReturnValue([tenantRow])
    const { ctx, out } = makeCtx('GET', '/api/schedules', undefined, 'viewer', 'tenant-a')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
    const rows = out.body as Array<{ name?: string; id?: string }>
    expect(rows[0].name).toBe('my-report')
  })
})

// ── GET /api/schedules/tick-status ──────────────────────────────────────────

describe('GET /api/schedules/tick-status', () => {
  beforeEach(() => { vi.clearAllMocks(); mockLoadLastTickMs.mockReturnValue(null) })

  it('non-admin is refused with 403, no status leaked', async () => {
    mockLoadLastTickMs.mockReturnValue(Date.now())
    const { ctx, out } = makeCtx('GET', '/api/schedules/tick-status', undefined, 'viewer', 'tenant-a')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(403)
    expect(out.body).not.toHaveProperty('lastTickMs')
  })

  it('admin sees a fresh stamp as not stale', async () => {
    mockLoadLastTickMs.mockReturnValue(Date.now())
    const { ctx, out } = makeCtx('GET', '/api/schedules/tick-status', undefined, 'admin', null)
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    const body = out.body as { lastTickMs: number; ageSeconds: number; stale: boolean }
    expect(body.stale).toBe(false)
    expect(body.ageSeconds).toBeLessThan(5)
  })

  it('admin sees a stamp older than the staleness threshold as stale', async () => {
    mockLoadLastTickMs.mockReturnValue(Date.now() - 10 * 60_000)
    const { ctx, out } = makeCtx('GET', '/api/schedules/tick-status', undefined, 'admin', null)
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    const body = out.body as { stale: boolean }
    expect(body.stale).toBe(true)
  })

  it('admin with no stamp at all (fresh install) is treated as stale, not healthy', async () => {
    mockLoadLastTickMs.mockReturnValue(null)
    const { ctx, out } = makeCtx('GET', '/api/schedules/tick-status', undefined, 'admin', null)
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    const body = out.body as { lastTickMs: null; ageSeconds: null; stale: boolean }
    expect(body.lastTickMs).toBeNull()
    expect(body.ageSeconds).toBeNull()
    expect(body.stale).toBe(true)
  })
})

// ── POST /api/schedules ───────────────────────────────────────────────────────

describe('POST /api/schedules', () => {
  beforeEach(() => vi.clearAllMocks())

  it('non-admin: creates with their tenant_id auto-stamped', async () => {
    mockGetScheduleDb.mockReturnValue(undefined)
    const { writeScheduledTask } = await import('../web/scheduled-tasks-io.js')
    const { ctx } = makeCtx('POST', '/api/schedules', {
      name: 'my-report', prompt: 'Do the thing', schedule: '0 9 * * 1', agent: 'sub-a',
    }, 'viewer', 'tenant-a')
    await tryHandleSchedules(ctx)
    expect(vi.mocked(writeScheduledTask)).toHaveBeenCalledWith('my-report', expect.objectContaining({ tenantId: 'tenant-a' }))
  })

  it('admin: can pass explicit tenant_id', async () => {
    mockGetScheduleDb.mockReturnValue(undefined)
    const { writeScheduledTask } = await import('../web/scheduled-tasks-io.js')
    const { ctx } = makeCtx('POST', '/api/schedules', {
      name: 'admin-task', prompt: 'Do admin stuff', schedule: '0 9 * * 1', tenant_id: 'tenant-b', agent: 'sub-a',
    }, 'admin', null)
    await tryHandleSchedules(ctx)
    expect(vi.mocked(writeScheduledTask)).toHaveBeenCalledWith('admin-task', expect.objectContaining({ tenantId: 'tenant-b' }))
  })

})

// ── DELETE /api/schedules/:name ───────────────────────────────────────────────

describe('DELETE /api/schedules/:name', () => {
  beforeEach(() => vi.clearAllMocks())

  it('non-admin can delete their own tenant schedule', async () => {
    mockGetScheduleDb.mockReturnValue(tenantRow)
    const { ctx, out } = makeCtx('DELETE', '/api/schedules/my-report', undefined, 'viewer', 'tenant-a')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(mockDeleteSchedule).toHaveBeenCalledWith('my-report')
  })

  it('non-admin cannot delete another tenants schedule (404)', async () => {
    mockGetScheduleDb.mockReturnValue(otherRow)
    const { ctx, out } = makeCtx('DELETE', '/api/schedules/other-report', undefined, 'viewer', 'tenant-a')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(404)
    expect(mockDeleteSchedule).not.toHaveBeenCalled()
  })

  it('non-admin cannot delete fleet schedule (404)', async () => {
    mockGetScheduleDb.mockReturnValue(fleetRow)
    const { ctx, out } = makeCtx('DELETE', '/api/schedules/morning-chain', undefined, 'viewer', 'tenant-a')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(404)
    expect(mockDeleteSchedule).not.toHaveBeenCalled()
  })

  it('admin can delete fleet schedule', async () => {
    mockGetScheduleDb.mockReturnValue(fleetRow)
    const { ctx, out } = makeCtx('DELETE', '/api/schedules/morning-chain', undefined, 'admin', null)
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(mockDeleteSchedule).toHaveBeenCalledWith('morning-chain')
  })
})

// ── Toggle ────────────────────────────────────────────────────────────────────

describe('POST /api/schedules/:name/toggle', () => {
  beforeEach(() => vi.clearAllMocks())

  it('non-admin cannot toggle fleet task (404)', async () => {
    mockGetScheduleDb.mockReturnValue(fleetRow)
    const { ctx, out } = makeCtx('POST', '/api/schedules/morning-chain/toggle', undefined, 'viewer', 'tenant-a')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(404)
    expect(mockSetScheduleEnabled).not.toHaveBeenCalled()
  })

  it('non-admin can toggle their own tenant task', async () => {
    mockGetScheduleDb.mockReturnValue(tenantRow)
    const { ctx, out } = makeCtx('POST', '/api/schedules/my-report/toggle', undefined, 'viewer', 'tenant-a')
    await tryHandleSchedules(ctx)
    expect(out.status).toBe(200)
    expect(mockSetScheduleEnabled).toHaveBeenCalledWith('my-report', false) // enabled=1 -> toggles to false
  })
})
