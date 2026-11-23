import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'
import type { TaskInflightEntry } from '../web/schedule-runner.js'

// The kanban card of a scheduled task belongs to the TENANT OF THAT TASK (row-level security, step S2b). Two places of the
// schedule runner look a card up by the task name: the blackboard task_ref of the tick, and the fire-timeout alert that moves
// the card to waiting. Both used a tenant-blind title match. The cells run the real tick on the real in-memory database
// with a recorder around the real function (the recorder proves the WRAPPER, the database proves WHICH ROWS); each cell
// first asserts its own construction (both cards exist, equal titles, different tenants) so it cannot pass for the wrong
// reason.

type Seen = { fn: string; args: unknown[]; ctx: unknown }
const mockSeen: Seen[] = []
let mockCtx: () => unknown = () => undefined
let mockReady = false
let mockPane: string | null = null
type Runner = typeof import('../web/schedule-runner.js')
type Db = typeof import('../db.js')
let runnerModule: Runner | undefined
let db: Db | undefined

const mockListScheduledTasks = vi.fn<() => Promise<ScheduledTask[]>>()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))

vi.mock('../db.js', async () => {
  const actual = await vi.importActual<typeof import('../db.js')>('../db.js')
  const spy = <A extends unknown[], R>(fn: string, real: (...a: A) => R) => (...args: A): R => {
    mockSeen.push({ fn, args, ctx: mockCtx() })
    return real(...args)
  }
  return {
    ...actual,
    findActiveKanbanCardByTitle: spy('findActiveKanbanCardByTitle', actual.findActiveKanbanCardByTitle),
    markScheduledTaskKanbanWaiting: spy('markScheduledTaskKanbanWaiting', actual.markScheduledTaskKanbanWaiting),
  }
})

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
  SCHEDULED_TASKS_DIR: '/tmp/marveen-kanban-tenant-no-tasks-dir',
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
  capturePane: () => mockPane,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => Promise.resolve(false)),
}))

// The pane "text" the tests hand out IS the state: 'idle' | 'busy' | ...
vi.mock('../pane-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pane-state.js')>()),
  detectPaneState: (pane: string) => pane,
}))

// The restore of the in-flight entries accepts only agents it knows.
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['agent-a'],
  readAgentRemoteHost: () => null,
  readAgentClaudeConfigDir: () => null,
}))

import { logger } from '../logger.js'
import { SCHEDULED_INFLIGHT_KEY } from '../web/schedule-inflight-store.js'

// A quiet moment of the fixture cron ('0 8 * * *'): only the retry queue and the watchdog act, no occurrence is due.
const QUIET = new Date('2026-08-14T10:30:00.000Z')
const TASK = 'nightly-job'

function task(name: string, over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    name, description: '', prompt: 'p', schedule: '0 8 * * *', agent: 'agent-a', enabled: true,
    createdAt: 0, type: 'heartbeat', skipIfBusy: false, forceSend: false, targetSession: 'fixture-session',
    ...over,
  } as ScheduledTask
}

async function loadRunner(): Promise<Runner> {
  vi.resetModules()
  runnerModule = await import('../web/schedule-runner.js')
  // the runner's own module graph owns the AsyncLocalStorage of the db context and the database of the cells
  mockCtx = (await import('../db/context.js')).currentDbContext
  db = await import('../db.js')
  db.initDatabase(':memory:')
  await db.createTenant('tenant-a', 'Tenant A')
  await db.createTenant('tenant-b', 'Tenant B')
  return runnerModule
}

const callsOf = (fn: string): Seen[] => mockSeen.filter((s) => s.fn === fn)

// One card per tenant, titled like the task; asserts that they exist, that the titles are equal and the tenants differ.
async function cardsOfTheTask(tenants: Array<[id: string, tenant: string]>): Promise<void> {
  const d = db!
  for (const [id, tenant] of tenants) await d.createKanbanCard({ id, title: TASK, status: 'in_progress', tenant_id: tenant })
  const rows = await Promise.all(tenants.map(([id]) => d.getKanbanCard(id)))
  expect(rows.map((r) => r?.title)).toEqual(tenants.map(() => TASK))
  expect(rows.map((r) => r?.tenant_id)).toEqual(tenants.map(([, t]) => t))
}

// An in-flight entry whose injection started `ageMs` ago.
function entryOf(over: Partial<TaskInflightEntry> = {}, ageMs = 400_000): TaskInflightEntry {
  return {
    taskName: TASK, agentName: 'agent-a', session: 'agent-agent-a', host: null, injectedAt: Date.now() - ageMs,
    alerted: false, sawTurn: false, workingDir: '/work/agent-a', configDir: undefined, timeoutMs: 300_000,
    blackboardSnapshot: undefined,
    ...over,
  }
}

describe('schedule runner: the kanban card of a task is the card of the task tenant', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    mockSeen.length = 0
    vi.useFakeTimers()
    vi.setSystemTime(QUIET)
    mockListScheduledTasks.mockResolvedValue([])
    mockReady = false
    mockPane = null
    runnerModule = undefined
    db = undefined
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  // One REAL fire through the retry queue (the quietest driver: no cron occurrence is needed).
  async function fireTask(taskTenant: string): Promise<void> {
    const d = db!
    await d.insertPendingTaskRetryIfNew(TASK, 'agent-a', Date.now() - 60_000, 'busy')
    for (let i = 1; i < 4; i++) await d.updatePendingTaskRetry(TASK, 'agent-a', Date.now() - 15_000, 'busy')
    mockSeen.length = 0
    mockListScheduledTasks.mockResolvedValue([task(TASK, { tenantId: taskTenant })])
    mockReady = true
    const stop = runnerModule!.startScheduleRunner()
    await vi.advanceTimersByTimeAsync(5_000)
    clearInterval(stop)
  }

  describe('the blackboard task_ref of the tick', () => {
    it('is the id of the card of the task tenant, never the id of the card another tenant titled the same', async () => {
      await loadRunner()
      // the card of the OTHER tenant is created first, so a tenant-blind LIMIT 1 would find it
      await cardsOfTheTask([['card-b', 'tenant-b'], ['card-a', 'tenant-a']])
      await fireTask('tenant-a')
      const calls = callsOf('findActiveKanbanCardByTitle')
      expect(calls.map((c) => c.args)).toEqual([[TASK, 'tenant-a']])
      expect(calls[0]!.ctx).toEqual({ role: 'tenant', tenantId: 'tenant-a' })
      expect((await db!.findBlackboardRowByAgent('agent-a'))?.task_ref).toBe('card-a')
    })

    it('is the card of the other task tenant for a task of THAT tenant (the lookup follows the task, not a constant)', async () => {
      await loadRunner()
      await cardsOfTheTask([['card-a', 'tenant-a'], ['card-b', 'tenant-b']])
      await fireTask('tenant-b')
      expect(callsOf('findActiveKanbanCardByTitle').map((c) => c.args)).toEqual([[TASK, 'tenant-b']])
      expect((await db!.findBlackboardRowByAgent('agent-a'))?.task_ref).toBe('card-b')
    })

    it('is null when the task tenant has no such card although another tenant has one', async () => {
      await loadRunner()
      await cardsOfTheTask([['card-b', 'tenant-b']])
      await fireTask('tenant-a')
      const row = await db!.findBlackboardRowByAgent('agent-a')
      expect(row).toBeDefined()
      expect(row!.status).toBe('active')
      expect(row!.task_ref ?? null).toBeNull()
    })

    it('is the default tenant card for a task without a tenant (the existing fallback, pinned)', async () => {
      await loadRunner()
      await cardsOfTheTask([['card-a', 'tenant-a'], ['card-d', 'default']])
      await fireTask(undefined as unknown as string)
      expect(callsOf('findActiveKanbanCardByTitle').map((c) => c.args)).toEqual([[TASK, 'default']])
      expect((await db!.findBlackboardRowByAgent('agent-a'))?.task_ref).toBe('card-d')
    })
  })

  describe('the fire-timeout alert of the watchdog', () => {
    // The sweep of the next tick finds a busy pane past the timeout and sends the alert.
    async function sweepWithAlert(runner: Runner): Promise<void> {
      mockPane = 'busy'
      mockListScheduledTasks.mockResolvedValue([task(TASK)])
      const stop = runner.startScheduleRunner()
      await vi.advanceTimersByTimeAsync(5_000)
      clearInterval(stop)
    }

    it('moves the card of the entry tenant, in a block of that tenant, and no card of another tenant', async () => {
      const runner = await loadRunner()
      await cardsOfTheTask([['card-b', 'tenant-b'], ['card-a', 'tenant-a']])
      await runner.trackInflight(entryOf({ tenantId: 'tenant-a' }))
      expect(runner.listInflightEntries().map((e) => [e.taskName, e.tenantId, e.restored ?? false])).toEqual([[TASK, 'tenant-a', false]])
      mockSeen.length = 0
      await sweepWithAlert(runner)
      const calls = callsOf('markScheduledTaskKanbanWaiting')
      expect(calls.map((c) => c.args)).toEqual([[TASK, 'tenant-a']])
      expect(calls[0]!.ctx).toEqual({ role: 'tenant', tenantId: 'tenant-a' })
      expect((await db!.getKanbanCard('card-a'))!.status).toBe('waiting')
      expect((await db!.getKanbanCard('card-b'))!.status).toBe('in_progress')
      expect(runner.listInflightEntries().map((e) => e.alerted)).toEqual([true])
      const { getDbContextStats } = await import('../db/context.js')
      expect(getDbContextStats().escalations).toBe(0)
    })

    it('an entry of a tenant with no such card moves nothing, although another tenant has one; the alert still completes', async () => {
      const runner = await loadRunner()
      await cardsOfTheTask([['card-b', 'tenant-b']])
      await runner.trackInflight(entryOf({ tenantId: 'tenant-a' }))
      mockSeen.length = 0
      await sweepWithAlert(runner)
      expect(callsOf('markScheduledTaskKanbanWaiting').map((c) => c.args)).toEqual([[TASK, 'tenant-a']])
      expect((await db!.getKanbanCard('card-b'))!.status).toBe('in_progress')
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ task: TASK }), expect.stringContaining('task-timeout alert'))
      expect(runner.listInflightEntries().map((e) => e.alerted)).toEqual([true])
    })

    // The restored shape, built the way a restart builds it: the entry is persisted (without its tenant), the modules and
    // the database are replaced, the stored value is put back and read through the real restore.
    async function restoreAfterRestart(): Promise<Runner> {
      const first = await loadRunner()
      await first.trackInflight(entryOf({ tenantId: 'tenant-a' }))
      const raw = db!.getSystemConfig(SCHEDULED_INFLIGHT_KEY)?.value
      expect(raw).toBeDefined()
      const second = await loadRunner()
      await db!.setSystemConfig(SCHEDULED_INFLIGHT_KEY, raw!)
      expect(second.restoreInflightFromStore(Date.now())).toBe(1)
      return second
    }

    it('a restored entry carries no tenant: the tenant is not persisted, so no restore path can fill it', async () => {
      const runner = await restoreAfterRestart()
      expect(runner.listInflightEntries().map((e) => [e.taskName, e.restored, e.tenantId])).toEqual([[TASK, true, undefined]])
    })

    it('a restored entry moves NO card, even when the default tenant has a card with the same title; the alert is still sent', async () => {
      const runner = await restoreAfterRestart()
      // the cards of the second database: the default tenant one is the card a `?? default` fallback would move
      await cardsOfTheTask([['card-d', 'default'], ['card-a', 'tenant-a']])
      mockSeen.length = 0
      await sweepWithAlert(runner)
      expect(callsOf('markScheduledTaskKanbanWaiting')).toHaveLength(0)
      expect((await db!.getKanbanCard('card-d'))!.status).toBe('in_progress')
      expect((await db!.getKanbanCard('card-a'))!.status).toBe('in_progress')
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ task: TASK }),
        expect.stringContaining('no kanban card moved'),
      )
      expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ task: TASK }), expect.stringContaining('task-timeout alert'))
      expect(runner.listInflightEntries().map((e) => [e.restored, e.alerted])).toEqual([[true, true]])
    })
  })
})
