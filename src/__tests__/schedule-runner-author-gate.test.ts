// The run-time author check, through the REAL tick, retry loop and run-now of the schedule runner (only the edges are
// mocked: the database calls, the task list, the agent session, the command runner). A task whose author is a
// dashboard user is fired only while that user may still write schedules; every "does not run" cell has its positive
// pair in the same set-up (the same task with an active author runs), or a fail-open / skipped check would be green too.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

type MockUser = { disabled: number; role: string; tenant_id: string | null }
const mockUsers = new Map<number, MockUser>()
const mockLookup = vi.fn<(id: number) => Promise<MockUser | undefined>>()
const mockListScheduledTasks = vi.fn<() => Promise<ScheduledTask[]>>()
const mockPending = vi.fn<() => Promise<unknown[]>>()

// The Telegram settings come from the env file, not the process environment, so they are set here. The gate mode is a
// live getter over `cfg.gate`, which a test sets (the runner reads it through the config module at run time).
const cfg = vi.hoisted(() => ({ gate: '' }))
vi.mock('../config.js', async (orig) => Object.defineProperty(
  { ...(await orig<typeof import('../config.js')>()), TELEGRAM_BOT_TOKEN: 'test-token', ALLOWED_CHAT_ID: '1' },
  'SCHEDULE_AUTHOR_GATE', { enumerable: true, get: () => cfg.gate },
))
vi.mock('../logger.js', () =>({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../db.js', () => ({
  appendTaskRun: vi.fn().mockResolvedValue(undefined),
  listPendingTaskRetries: () => mockPending(),
  deletePendingTaskRetry: vi.fn().mockResolvedValue(undefined),
  updatePendingTaskRetry: vi.fn().mockResolvedValue(true),
  insertPendingTaskRetryIfNew: vi.fn().mockResolvedValue(undefined),
  markPendingTaskRetryAlert: vi.fn().mockResolvedValue(false),
  clearPendingTaskRetryAlert: vi.fn().mockResolvedValue(undefined),
  markScheduledTaskKanbanWaiting: vi.fn(),
  upsertBlackboard: vi.fn(),
  findActiveKanbanCardByTitle: vi.fn(),
  findBlackboardRowByAgent: vi.fn(),
  updateScheduleLastRun: vi.fn().mockResolvedValue(true),
  clearScheduleLastRunIfMatches: vi.fn().mockResolvedValue(true),
  getSystemConfig: vi.fn(() => undefined),
  setSystemConfig: vi.fn().mockResolvedValue(undefined),
  writeAgentAuditLog: vi.fn().mockResolvedValue(undefined),
  getDashboardUserById: (id: number) => mockLookup(id),
}))
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(() => Promise.resolve()),
  sendTelegramPhoto: vi.fn(() => Promise.resolve()),
}))
vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  listDbRunnableTaskNames: () => Promise.resolve([]),
  syncTaskConfigEnabledFromDb: vi.fn().mockResolvedValue([]),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-author-gate-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
  isTaskLive: (task: { status?: string }) => task.status === undefined || task.status === 'live',
}))
vi.mock('../web/schedule-tenant.js', () => ({ createPairOrphanChecker: () => () => Promise.resolve(false) }))
vi.mock('../web/command-task.js', () => ({ runCommandTask: vi.fn() }))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: vi.fn(() => Promise.resolve(true)),
  sendPromptToSession: vi.fn(() => 'sent'),
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'tmux unavailable' })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => Promise.resolve(true)),
}))

import { logger } from '../logger.js'
import * as dbMock from '../db.js'
import * as procMock from '../web/agent-process.js'
import * as cmdMock from '../web/command-task.js'
import * as telegramMock from '../web/telegram.js'

const START = new Date('2026-10-26T10:30:00.000Z')
const ADMIN = 1
const TENANT_USER = 2

function task(name: string, over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    name, description: '', prompt: 'p', schedule: '*/30 * * * *', agent: 'agent-a', enabled: true,
    createdAt: 0, type: 'task', skipIfBusy: false, forceSend: false, status: 'live', tenantId: 'default',
    authorUserId: ADMIN, authorLabel: 'admin-a', ...over,
  } as ScheduledTask
}

type Runner = typeof import('../web/schedule-runner.js')
async function load(): Promise<Runner> {
  vi.resetModules()
  return import('../web/schedule-runner.js')
}
async function tick(ms = 5_000): Promise<void> {
  const { startScheduleRunner } = await load()
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(ms)
  clearInterval(stop)
}

const runs = () => vi.mocked(dbMock.appendTaskRun).mock.calls.map(c => `${String(c[0])}|${String(c[1])}|${String(c[2])}`)
const skippedAuthor = () => runs().filter(r => r.includes('|skipped_author_'))
const injections = () => vi.mocked(procMock.sendPromptToSession).mock.calls.length
const commandRuns = () => vi.mocked(cmdMock.runCommandTask).mock.calls.map(c => (c[0] as ScheduledTask).name)
const auditActions = () => vi.mocked(dbMock.writeAgentAuditLog).mock.calls.map(c => (c[0] as { action: string }).action)
const telegramSent = () => vi.mocked(telegramMock.sendTelegramMessage).mock.calls.length

beforeEach(() => {
  vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
  cfg.gate = ''
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token')
  vi.stubEnv('ALLOWED_CHAT_ID', '1')
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(START)
  mockUsers.clear()
  mockUsers.set(ADMIN, { disabled: 0, role: 'admin', tenant_id: null })
  mockUsers.set(TENANT_USER, { disabled: 0, role: 'agent', tenant_id: 'tenant-a' })
  mockLookup.mockReset().mockImplementation((id) => Promise.resolve(mockUsers.get(id)))
  mockPending.mockReset().mockResolvedValue([])
  mockListScheduledTasks.mockReset().mockResolvedValue([task('t1')])
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})


// An attempt to fire = the runner asked the agent session whether it can take a prompt (the mocked session answers
// ready, the downstream outcome is irrelevant here). A skipped occurrence leaves a skipped_author_* row instead.
const attempts = () => vi.mocked(procMock.isSessionReadyForPrompt).mock.calls.length
const lastRunStamps = () => vi.mocked(dbMock.updateScheduleLastRun).mock.calls.length
const MASS_SKIP_LOG = 'schedule-runner: most enabled tasks are held back at once (disabled / not live) -- occurrences are being recorded as skipped'

async function session() {
  const { startScheduleRunner } = await load()
  const stop = startScheduleRunner()
  return { advance: (ms: number) => vi.advanceTimersByTimeAsync(ms), stop: () => clearInterval(stop) }
}
const disable = (id: number): void => { mockUsers.set(id, { ...mockUsers.get(id)!, disabled: 1 }) }
const enable = (id: number): void => { mockUsers.set(id, { ...mockUsers.get(id)!, disabled: 0 }) }

describe('tick: a task whose author is inactive does not run', () => {
  it('inactive author: no attempt, one skipped_author_inactive row, the task row is not stamped; active author: runs', async () => {
    disable(ADMIN)
    await tick()
    expect(attempts()).toBe(0)
    expect(skippedAuthor()).toEqual(['t1|agent-a|skipped_author_inactive'])
    expect(runs().filter(r => r.endsWith('|error'))).toEqual([])
    expect(lastRunStamps()).toBe(0)
    // positive pair
    enable(ADMIN)
    vi.clearAllMocks()
    await tick()
    expect(attempts()).toBe(1)
    expect(skippedAuthor()).toEqual([])
  })

  it('a user row that is gone, a demoted role and an agent of another tenant are inactive; the same user active runs', async () => {
    for (const arrange of [
      () => mockUsers.delete(ADMIN),
      () => mockUsers.set(ADMIN, { disabled: 0, role: 'viewer', tenant_id: null }),
      () => { mockUsers.set(ADMIN, { disabled: 0, role: 'agent', tenant_id: 'tenant-b' }); mockListScheduledTasks.mockResolvedValue([task('t1', { tenantId: 'tenant-a' })]) },
    ]) {
      vi.clearAllMocks()
      mockUsers.set(ADMIN, { disabled: 0, role: 'admin', tenant_id: null })
      arrange()
      await tick()
      expect(attempts()).toBe(0)
      expect(skippedAuthor()).toEqual(['t1|agent-a|skipped_author_inactive'])
    }
  })

  it('a command task with an inactive author is not run; with an active author it is', async () => {
    mockListScheduledTasks.mockResolvedValue([task('c1', { type: 'command', command: 'echo hi' })])
    disable(ADMIN)
    await tick()
    expect(commandRuns()).toEqual([])
    expect(skippedAuthor()).toEqual(['c1|agent-a|skipped_author_inactive'])
    enable(ADMIN)
    vi.clearAllMocks()
    await tick()
    expect(commandRuns()).toEqual(['c1'])
  })

  it('a failing lookup is skipped_author_unverifiable and does not run; a working lookup runs', async () => {
    mockLookup.mockRejectedValue(new Error('db gone'))
    await tick()
    expect(attempts()).toBe(0)
    expect(skippedAuthor()).toEqual(['t1|agent-a|skipped_author_unverifiable'])
    mockLookup.mockImplementation((id) => Promise.resolve(mockUsers.get(id)))
    vi.clearAllMocks()
    await tick()
    expect(attempts()).toBe(1)
  })

  it('a task with no user-bound author is never looked up, and runs even when the lookup is down', async () => {
    mockLookup.mockRejectedValue(new Error('db gone'))
    mockListScheduledTasks.mockResolvedValue([task('seed', { authorUserId: undefined, authorLabel: undefined })])
    await tick()
    expect(mockLookup).not.toHaveBeenCalled()
    expect(attempts()).toBe(1)
    expect(skippedAuthor()).toEqual([])
  })

  it('heals by itself: the next occurrence after the user is back runs, and the recorded one is not replayed', async () => {
    disable(ADMIN)
    const s = await session()
    await s.advance(5_000)
    expect(skippedAuthor()).toHaveLength(1)
    enable(ADMIN)
    await s.advance(5 * 60_000)           // no new occurrence yet: the recorded one must not come back
    expect(attempts()).toBe(0)
    expect(skippedAuthor()).toHaveLength(1)
    await s.advance(30 * 60_000)          // the next :00 / :30 occurrence
    s.stop()
    expect(attempts()).toBe(1)
    expect(skippedAuthor()).toHaveLength(1)
  })

  it('an agent: all task leaves one row per target agent and injects into none', async () => {
    mockListScheduledTasks.mockResolvedValue([task('everyone', { agent: 'all' })])
    disable(ADMIN)
    await tick()
    expect(attempts()).toBe(0)
    const rows = skippedAuthor()
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(new Set(rows.map(r => r.split('|')[1])).size).toBe(rows.length)
  })

  it('one lookup per author in a tick: ten tasks of one author, then ten tasks of two authors', async () => {
    mockListScheduledTasks.mockResolvedValue(Array.from({ length: 10 }, (_, i) => task(`m${i}`)))
    await tick()
    expect(mockLookup).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()
    mockListScheduledTasks.mockResolvedValue(Array.from({ length: 10 }, (_, i) => task(`m${i}`, { authorUserId: i % 2 === 0 ? ADMIN : TENANT_USER, tenantId: 'tenant-a' })))
    await tick()
    expect(mockLookup).toHaveBeenCalledTimes(2)
  })

  it('five tasks of one inactive author count as held in the mass-skip alert', async () => {
    mockListScheduledTasks.mockResolvedValue(Array.from({ length: 5 }, (_, i) => task(`m${i}`)))
    disable(ADMIN)
    await tick()
    expect(vi.mocked(logger.error).mock.calls.filter(c => c[1] === MASS_SKIP_LOG)).toHaveLength(1)
    expect(skippedAuthor()).toHaveLength(5)
  })

  it('tells the owner once per task over many ticks, and again after the task was fine in between', async () => {
    disable(ADMIN)
    const s = await session()
    await s.advance(100_000)              // several ticks
    expect(telegramSent()).toBe(1)
    expect(auditActions().filter(a => a === 'skip_author_inactive')).toHaveLength(1)
    enable(ADMIN)
    await s.advance(31_000)               // ok again: forgotten
    disable(ADMIN)
    await s.advance(31_000)
    s.stop()
    expect(telegramSent()).toBe(2)
  })

  it('the not-live and tenant precedence: a draft with an inactive author is skipped_not_live only', async () => {
    mockListScheduledTasks.mockResolvedValue([task('d1', { status: 'draft' })])
    disable(ADMIN)
    await tick()
    expect(runs().filter(r => r.startsWith('d1|'))).toEqual(['d1|agent-a|skipped_not_live'])
  })
})

describe('shadow mode', () => {
  it('shadow: the task still runs, one audit row per task (not per tick), no skipped row, no Telegram', async () => {
    cfg.gate = 'shadow'
    disable(ADMIN)
    const s = await session()
    await s.advance(100_000)
    s.stop()
    expect(attempts()).toBeGreaterThanOrEqual(1)
    expect(skippedAuthor()).toEqual([])
    expect(auditActions().filter(a => a === 'author_gate_shadow')).toHaveLength(1)
    expect(telegramSent()).toBe(0)
  })

  it.each(['', 'enforce', 'shadwo', 'off', 'false', '0'])('the value %j is enforce: the task does not run', async (value) => {
    cfg.gate = value
    disable(ADMIN)
    await tick()
    expect(attempts()).toBe(0)
    expect(skippedAuthor()).toEqual(['t1|agent-a|skipped_author_inactive'])
  })

  it('shadow with an active author writes nothing', async () => {
    cfg.gate = 'shadow'
    await tick()
    expect(attempts()).toBe(1)
    expect(auditActions()).not.toContain('author_gate_shadow')
  })
})

describe('retry queue', () => {
  const now = START.getTime()
  const pending = [{ id: 1, task_name: 't1', agent_name: 'agent-a', first_attempt: now - 60_000, last_attempt: now - 30_000, attempt_count: 2, last_reason: 'busy', alert_sent_at: null }]
  beforeEach(() => {
    mockListScheduledTasks.mockResolvedValue([task('t1', { schedule: '0 0 1 1 *' })])   // no cron occurrence: only the retry can fire
    mockPending.mockResolvedValue(pending)
  })

  it('a queued retry of a task whose author is now inactive is dropped with an audit row and does not inject', async () => {
    disable(ADMIN)
    await tick()
    expect(attempts()).toBe(0)
    expect(vi.mocked(dbMock.deletePendingTaskRetry)).toHaveBeenCalledWith('t1', 'agent-a')
    const audit = vi.mocked(dbMock.writeAgentAuditLog).mock.calls.map(c => c[0] as { action: string; detail: { reason?: string; cause?: string } })
    expect(audit.find(a => a.action === 'skip_not_live')?.detail).toEqual({ reason: 'retry_dropped', cause: 'author_inactive' })
  })

  it('positive pair: the same retry with an active author is attempted and not dropped', async () => {
    await tick()
    expect(attempts()).toBe(1)
    expect(vi.mocked(dbMock.deletePendingTaskRetry)).not.toHaveBeenCalled()
  })

  it('a retry is dropped as author_unverifiable when the lookup fails', async () => {
    mockLookup.mockRejectedValue(new Error('db gone'))
    await tick()
    expect(attempts()).toBe(0)
    const audit = vi.mocked(dbMock.writeAgentAuditLog).mock.calls.map(c => c[0] as { detail: { cause?: string } })
    expect(audit.some(a => a.detail.cause === 'author_unverifiable')).toBe(true)
  })
})

describe('run now', () => {
  it('a live task with an inactive author is refused for everyone, a failed lookup too; an active author runs', async () => {
    const { runScheduledTaskNow } = await load()
    disable(ADMIN)
    expect(await runScheduledTaskNow('t1', { allowNotLive: true })).toMatchObject({ ok: false, error: 'author_inactive' })
    expect(attempts()).toBe(0)
    enable(ADMIN)
    mockLookup.mockRejectedValue(new Error('db gone'))
    expect(await runScheduledTaskNow('t1')).toMatchObject({ ok: false, error: 'author_unverifiable' })
    mockLookup.mockImplementation((id) => Promise.resolve(mockUsers.get(id)))
    expect((await runScheduledTaskNow('t1')).ok).toBe(true)
    expect(attempts()).toBe(1)
  })

  it('a command task is refused too, and runs with an active author', async () => {
    mockListScheduledTasks.mockResolvedValue([task('c1', { type: 'command', command: 'echo hi' })])
    const { runScheduledTaskNow } = await load()
    disable(ADMIN)
    expect(await runScheduledTaskNow('c1')).toMatchObject({ ok: false, error: 'author_inactive' })
    expect(commandRuns()).toEqual([])
    enable(ADMIN)
    expect((await runScheduledTaskNow('c1')).ok).toBe(true)
    expect(commandRuns()).toEqual(['c1'])
  })

  it('a draft previewed by a human admin (allowNotLive) is not checked', async () => {
    mockListScheduledTasks.mockResolvedValue([task('d1', { status: 'draft' })])
    const { runScheduledTaskNow } = await load()
    disable(ADMIN)
    expect((await runScheduledTaskNow('d1', { allowNotLive: true })).ok).toBe(true)
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('shadow: the manual run goes through and the verdict is noted', async () => {
    cfg.gate = 'shadow'
    const { runScheduledTaskNow } = await load()
    disable(ADMIN)
    expect((await runScheduledTaskNow('t1')).ok).toBe(true)
    expect(auditActions()).toContain('author_gate_shadow')
  })
})

describe('production shape: 28 live tasks of the default tenant, authored by the global admin (NULL tenant)', () => {
  // 9 command, 12 heartbeat, 7 task; the morning chain are named members of the set.
  const CHAIN = ['dream-engine', 'morning-report', 'morning-briefing']
  const fleet = (): ScheduledTask[] => [
    ...CHAIN.map(n => task(n, { type: 'task' })),
    ...Array.from({ length: 4 }, (_, i) => task(`task-${i}`, { type: 'task' })),
    ...Array.from({ length: 12 }, (_, i) => task(`beat-${i}`, { type: 'heartbeat' })),
    ...Array.from({ length: 9 }, (_, i) => task(`cmd-${i}`, { type: 'command', command: 'echo hi' })),
  ]

  it('all 28 pass the gate on one tick: 19 attempts, 9 command runs, no skipped row, no shadow audit, one lookup', async () => {
    mockListScheduledTasks.mockResolvedValue(fleet())
    expect(fleet()).toHaveLength(28)
    await tick()
    expect(attempts()).toBe(19)
    expect(commandRuns()).toHaveLength(9)
    expect(skippedAuthor()).toEqual([])
    expect(auditActions()).not.toContain('author_gate_shadow')
    expect(mockLookup).toHaveBeenCalledTimes(1)
    expect(CHAIN.every(n => !runs().some(r => r.startsWith(`${n}|skipped`)))).toBe(true)
  })

  it('positive pair: the same fleet with the admin disabled loses all 28, the chain included', async () => {
    mockListScheduledTasks.mockResolvedValue(fleet())
    disable(ADMIN)
    await tick()
    expect(attempts()).toBe(0)
    expect(commandRuns()).toEqual([])
    expect(skippedAuthor()).toHaveLength(28)
    expect(CHAIN.every(n => runs().includes(`${n}|agent-a|skipped_author_inactive`))).toBe(true)
  })
})
