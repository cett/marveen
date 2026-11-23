import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// The per-item tenant block of the schedule runner (row-level security): the writes that belong to ONE task (its `schedules`
// last-run stamp and its `task_runs` row) run in a short block of that task's tenant, the stamp handed down so the block and
// the stamp cannot disagree; the GLOBAL writes of the tick (the liveness stamp and the run-log TTL prune) stay in the job's
// own `system` context. The real tick runs; the db layer is replaced by recorders that note the db context of each call.

type Seen = { fn: string; args: unknown[]; ctx: unknown }
const mockSeen: Seen[] = []
let mockCtx: () => unknown = () => undefined
const mockListScheduledTasks = vi.fn<() => Promise<ScheduledTask[]>>()
const mockPrune = vi.fn<(now: number) => Promise<number>>()
// A queued retry is the quietest way to drive one real fire through the tick (no cron occurrence is needed).
let mockPending: unknown[] = []
let mockReady = false
type Runner = typeof import('../web/schedule-runner.js')
let runnerModule: Runner | undefined

const rec = (fn: string) => (...args: unknown[]) => { mockSeen.push({ fn, args, ctx: mockCtx() }); return Promise.resolve(true) }

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))

vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => rec('appendTaskRun')(...a),
  pruneTaskRuns: (now: number) => { mockSeen.push({ fn: 'pruneTaskRuns', args: [now], ctx: mockCtx() }); return mockPrune(now) },
  listPendingTaskRetries: () => Promise.resolve(mockPending),
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => Promise.resolve(true)),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => Promise.resolve(false)),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
  upsertBlackboard: vi.fn(() => Promise.resolve({ id: 'bb000001', agent_id: 'agent-a', task_ref: null, status: 'active', summary: 'fixture', updated_at: 0 })),
  findActiveKanbanCardByTitle: vi.fn(),
  findBlackboardRowByAgent: vi.fn(() => Promise.resolve(undefined)),
  updateScheduleLastRun: (...a: unknown[]) => rec('updateScheduleLastRun')(...a),
  clearScheduleLastRunIfMatches: vi.fn(() => Promise.resolve(true)),
  getSystemConfig: vi.fn(() => undefined),
  setSystemConfig: (...a: unknown[]) => rec('setSystemConfig')(...a),
  writeAgentAuditLog: vi.fn(() => Promise.resolve()),
}))

// The (tenant, agent) pairing rule is its own unit (schedule-tenant); here every pair is a valid one.
vi.mock('../web/schedule-tenant.js', () => ({ createPairOrphanChecker: () => () => Promise.resolve(false) }))

vi.mock('../web/command-task.js', () => ({ runCommandTask: vi.fn(() => Promise.resolve()) }))

vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async () => {}),
  sendTelegramPhoto: vi.fn(async () => {}),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  listDbRunnableTaskNames: () => Promise.resolve([]),
  syncTaskConfigEnabledFromDb: vi.fn().mockResolvedValue([]),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-tenant-block-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
  isTaskLive: (task: { status?: string }) => task.status === undefined || task.status === 'live',
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => Promise.resolve(mockReady),
  sendPromptToSession: vi.fn(() => 'sent'),
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'tmux unavailable' })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => Promise.resolve(true)),
}))

import { logger } from '../logger.js'

const START = new Date('2026-10-26T10:30:00.000Z')

function task(name: string, over: Partial<ScheduledTask> & { status?: string } = {}): ScheduledTask {
  return {
    name, description: '', prompt: 'p', schedule: '* * * * *', agent: 'agent-a', enabled: true,
    createdAt: 0, type: 'command', command: 'true', skipIfBusy: false, forceSend: false, status: 'live',
    ...over,
  } as ScheduledTask
}

async function loadRunner(): Promise<Runner> {
  vi.resetModules()
  const runner = await import('../web/schedule-runner.js')
  runnerModule = runner
  // the runner's own module graph owns the AsyncLocalStorage of the db context
  mockCtx = (await import('../db/context.js')).currentDbContext
  return runner
}

async function startRunner(): Promise<NodeJS.Timeout> {
  return (await loadRunner()).startScheduleRunner()
}

// A pre-check script that answers SKIP: the operator business gate that skips a tick without the LLM.
const SCRIPT_DIR = mkdtempSync(join(tmpdir(), 'tenant-block-precheck-'))
const SKIP_SCRIPT = join(SCRIPT_DIR, 'skip.sh')
writeFileSync(SKIP_SCRIPT, 'echo SKIP\n')

const callsOf = (fn: string): Seen[] => mockSeen.filter((s) => s.fn === fn)

describe('schedule runner: per-task writes run in the tenant block of the task', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    mockSeen.length = 0
    vi.useFakeTimers()
    vi.setSystemTime(START)
    mockPrune.mockResolvedValue(0)
    mockListScheduledTasks.mockResolvedValue([])
    mockPending = []
    mockReady = false
    runnerModule = undefined
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  afterAll(() => { rmSync(SCRIPT_DIR, { recursive: true, force: true }) })

  it('the last-run stamp of each task is written in a block of ITS tenant; a task without one is the default tenant (pinned)', async () => {
    mockListScheduledTasks.mockResolvedValue([
      task('cmd-a', { tenantId: 'tenant-a' }),
      task('cmd-b', { tenantId: 'tenant-b' }),
      task('cmd-none'),
    ])
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000)
    clearInterval(stop)
    const stamped = Object.fromEntries(callsOf('updateScheduleLastRun').map((s) => [s.args[0] as string, s.ctx]))
    expect(stamped).toEqual({
      'cmd-a': { role: 'tenant', tenantId: 'tenant-a' },
      'cmd-b': { role: 'tenant', tenantId: 'tenant-b' },
      'cmd-none': { role: 'tenant', tenantId: 'default' },
    })
  })

  it('a held-back occurrence of a task leaves its run row stamped and written in a block of the task tenant', async () => {
    mockListScheduledTasks.mockResolvedValue([
      task('draft-a', { tenantId: 'tenant-a', status: 'draft' }),
      task('draft-b', { tenantId: 'tenant-b', status: 'draft', agent: 'agent-b' }),
      task('draft-none', { status: 'draft' }),
      task('cmd-a', { tenantId: 'tenant-a' }),
      task('cmd-b', { tenantId: 'tenant-b' }),
      task('cmd-c', { tenantId: 'tenant-b' }),
    ])
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000)
    clearInterval(stop)
    const rows = callsOf('appendTaskRun')
    const byTask = Object.fromEntries(rows.map((s) => [s.args[0] as string, { agent: s.args[1], tenant: s.args[3], ctx: s.ctx }]))
    expect(byTask['draft-a']).toEqual({ agent: 'agent-a', tenant: 'tenant-a', ctx: { role: 'tenant', tenantId: 'tenant-a' } })
    expect(byTask['draft-b']).toEqual({ agent: 'agent-b', tenant: 'tenant-b', ctx: { role: 'tenant', tenantId: 'tenant-b' } })
    // no tenant on the task: the existing fallback, the default tenant (pinned)
    expect(byTask['draft-none']).toEqual({ agent: 'agent-a', tenant: 'default', ctx: { role: 'tenant', tenantId: 'default' } })
  })

  // The run-now path of a command task: the stamp is the task's tenant write too, not only the cron path's.
  it('run-now of a command task stamps its last run in a block of the task tenant', async () => {
    mockListScheduledTasks.mockResolvedValue([task('cmd-b', { tenantId: 'tenant-b' })])
    const runner = await loadRunner()
    expect(await runner.runScheduledTaskNow('cmd-b')).toMatchObject({ ok: true })
    expect(callsOf('updateScheduleLastRun').map((s) => [s.args[0], s.ctx])).toEqual([['cmd-b', { role: 'tenant', tenantId: 'tenant-b' }]])
  })

  // A queued retry whose pre-check now says SKIP: the retry row goes and a 'skipped' run row is written for the task.
  it('the retry loop skip row of a pending retry is stamped and written in a block of the task tenant', async () => {
    vi.setSystemTime(new Date('2026-08-14T10:30:00.000Z'))
    mockListScheduledTasks.mockResolvedValue([task('hb-b', { tenantId: 'tenant-b', type: 'heartbeat', schedule: '0 8 * * *', preCheck: SKIP_SCRIPT })])
    mockPending = [{ task_name: 'hb-b', agent_name: 'agent-a', first_attempt: Date.now() - 60_000, last_attempt: Date.now() - 15_000, attempt_count: 4, last_reason: 'busy', alerted_at: null }]
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000)
    clearInterval(stop)
    expect(callsOf('appendTaskRun').map((s) => [s.args.slice(0, 4), s.ctx])).toEqual([
      [['hb-b', 'agent-a', 'skipped', 'tenant-b'], { role: 'tenant', tenantId: 'tenant-b' }],
    ])
  })

  // A due short-cadence task whose session is busy and that opted in to skipIfBusy: the tick is dropped with a 'skipped' row.
  it('the skipIfBusy skip row of a busy session is stamped and written in a block of the task tenant', async () => {
    mockReady = false
    mockListScheduledTasks.mockResolvedValue([task('hb-b', { tenantId: 'tenant-b', type: 'heartbeat', skipIfBusy: true, targetSession: 'fixture-session' })])
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000)
    clearInterval(stop)
    expect(callsOf('appendTaskRun').map((s) => [s.args.slice(0, 4), s.ctx])).toEqual([
      [['hb-b', 'agent-a', 'skipped', 'tenant-b'], { role: 'tenant', tenantId: 'tenant-b' }],
    ])
  })

  // One REAL fire (a queued retry of a heartbeat, the session ready): the last-run stamp and the 'fired' row are the task's
  // tenant writes, and the in-flight entry carries the tenant for the watchdog's 'lost' branch, which has no task in hand.
  it('a fired task: the stamp and the run row in its tenant block, the in-flight entry carries the tenant', async () => {
    mockReady = true
    // an old quiet moment: the cron of the fixture does not match, only the retry queue acts
    vi.setSystemTime(new Date('2026-08-14T10:30:00.000Z'))
    mockListScheduledTasks.mockResolvedValue([task('hb-a', { tenantId: 'tenant-a', type: 'heartbeat', schedule: '0 8 * * *', targetSession: 'fixture-session' })])
    mockPending = [{ task_name: 'hb-a', agent_name: 'agent-a', first_attempt: Date.now() - 60_000, last_attempt: Date.now() - 15_000, attempt_count: 4, last_reason: 'busy', alerted_at: null }]
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000)
    clearInterval(stop)
    const inBlock = { role: 'tenant', tenantId: 'tenant-a' }
    expect(callsOf('updateScheduleLastRun').map((s) => [s.args[0], s.ctx])).toEqual([['hb-a', inBlock]])
    expect(callsOf('appendTaskRun').map((s) => [s.args.slice(0, 4), s.ctx])).toEqual([[['hb-a', 'agent-a', 'fired', 'tenant-a'], inBlock]])
    expect(runnerModule!.listInflightEntries().map((e) => [e.taskName, e.tenantId])).toEqual([['hb-a', 'tenant-a']])
  })

  it('the liveness stamp and the run-log prune run in the job system context, never in a tenant block, and open no escalation', async () => {
    mockListScheduledTasks.mockResolvedValue([task('cmd-a', { tenantId: 'tenant-a' })])
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000)
    clearInterval(stop)
    expect(callsOf('setSystemConfig').map((s) => s.ctx)).toEqual([{ role: 'system', name: 'schedule-runner' }])
    expect(callsOf('pruneTaskRuns').map((s) => s.ctx)).toEqual([{ role: 'system', name: 'schedule-runner' }])
    const { getDbContextStats } = await import('../db/context.js')
    expect(getDbContextStats().escalations).toBe(0)
  })

  it('the prune runs once per interval like the liveness stamp (not once per 15 s tick), with the tick time', async () => {
    mockListScheduledTasks.mockResolvedValue([])
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(100_000)
    clearInterval(stop)
    // ticks at 5 s, 15 s, 30 s ... 90 s: at 5 s and again once 60 s have passed (75 s)
    expect(callsOf('pruneTaskRuns')).toHaveLength(2)
    expect(callsOf('pruneTaskRuns')[0]!.args).toEqual([START.getTime() + 5_000])
  })

  it('a failed prune is logged and the loop carries on: the liveness stamp was written, the next ticks still scan', async () => {
    mockPrune.mockRejectedValueOnce(new Error('db locked'))
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'schedule-runner: task_runs TTL prune failed',
    )
    expect(callsOf('setSystemConfig')).toHaveLength(1)
    const scans = mockListScheduledTasks.mock.calls.length
    await vi.advanceTimersByTimeAsync(15_000)
    clearInterval(stop)
    expect(mockListScheduledTasks.mock.calls.length).toBeGreaterThan(scans)
  })
})
