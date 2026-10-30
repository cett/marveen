import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// The skip tracker seeds its baseline ("what was runnable a tick ago") from the DB rows on its first scan. The DB read is
// async and the tracker's dependency is synchronous, so the tick settles the read before that first scan. These tests
// drive the real tick: a baseline that is not awaited, or is read on every tick, or whose failure stops the tick, shows
// in the mass-skip alert (logger.error) and in the number of reads.

const mockListDbRunnable = vi.fn<() => Promise<string[]>>()
const mockListScheduledTasks = vi.fn<() => Promise<ScheduledTask[]>>()

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: vi.fn().mockResolvedValue(undefined),
  listPendingTaskRetries: vi.fn().mockResolvedValue([]),
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
}))

vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(() => Promise.resolve()),
  sendTelegramPhoto: vi.fn(() => Promise.resolve()),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  listDbRunnableTaskNames: () => mockListDbRunnable(),
  syncTaskConfigEnabledFromDb: vi.fn().mockResolvedValue([]),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-skip-baseline-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
  isTaskLive: (task: { status?: string }) => task.status === undefined || task.status === 'live',
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => Promise.resolve(false),
  sendPromptToSession: vi.fn(() => 'sent'),
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'tmux unavailable' })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => Promise.resolve(true)),
}))

import { logger } from '../logger.js'

const START = new Date('2026-10-26T10:30:00.000Z')
const MASS_SKIP_LOG = 'schedule-runner: most enabled tasks are held back at once (disabled / not live) -- occurrences are being recorded as skipped'
const NAMES = ['t1', 't2', 't3', 't4', 't5']

// Disabled in the tick's own list, on a cron that never matches inside the test window.
function disabledTasks(): ScheduledTask[] {
  return NAMES.map(name => ({
    name, description: '', prompt: 'p', schedule: '0 0 1 1 *', agent: 'main', enabled: false,
    createdAt: 0, type: 'task', skipIfBusy: false, forceSend: false, status: 'live',
  }) as ScheduledTask)
}

async function startRunner(): Promise<NodeJS.Timeout> {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  return startScheduleRunner()
}

function massSkipAlerts(): number {
  return vi.mocked(logger.error).mock.calls.filter(c => c[1] === MASS_SKIP_LOG).length
}

describe('schedule runner: skip tracker baseline from the DB rows', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(START)
    mockListScheduledTasks.mockResolvedValue(disabledTasks())
    mockListDbRunnable.mockResolvedValue(NAMES)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('tasks the DB says are runnable but the tick list reads as disabled raise the mass-skip alert on the first tick', async () => {
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000)
    clearInterval(stop)
    expect(mockListDbRunnable).toHaveBeenCalledTimes(1)
    expect(massSkipAlerts()).toBe(1)
  })

  it('an empty baseline holds nothing back: disabled tasks that were never runnable are not a mass skip', async () => {
    mockListDbRunnable.mockResolvedValue([])
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000)
    clearInterval(stop)
    expect(mockListDbRunnable).toHaveBeenCalledTimes(1)
    expect(massSkipAlerts()).toBe(0)
  })

  it('reads the baseline once, on the first scan only (later ticks use the tracker state)', async () => {
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(65_000)
    clearInterval(stop)
    expect(mockListScheduledTasks.mock.calls.length).toBeGreaterThan(2)
    expect(mockListDbRunnable).toHaveBeenCalledTimes(1)
  })

  it('a failed baseline read is logged, the scan runs without a baseline and the loop carries on', async () => {
    mockListDbRunnable.mockRejectedValue(new Error('db locked'))
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'schedule-runner: skip ledger baseline read failed (no baseline)',
    )
    expect(massSkipAlerts()).toBe(0)
    const scans = mockListScheduledTasks.mock.calls.length
    await vi.advanceTimersByTimeAsync(15_000)
    clearInterval(stop)
    expect(mockListScheduledTasks.mock.calls.length).toBeGreaterThan(scans)
    expect(mockListDbRunnable).toHaveBeenCalledTimes(1)
  })
})
