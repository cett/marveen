import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// The tick liveness stamp (schedule_last_tick_ms) is written with an awaited async db write. The tick must wait
// for it (a still-running tick makes the next interval fire skip, so ticks never overlap), a failed write must be
// logged without wedging the loop, and the stamp stays throttled to one write per TICK_STATE_PERSIST_INTERVAL_MS.

const mockSetSystemConfig = vi.fn<(key: string, value: string) => Promise<void>>()
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../db.js', () => ({
  appendTaskRun: vi.fn(),
  listPendingTaskRetries: () => Promise.resolve([]),
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => Promise.resolve(true)),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => Promise.resolve(false)),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
  upsertBlackboard: vi.fn(() => ({ id: 'bb000001', agent_id: '', task_ref: null, status: 'active', summary: '', updated_at: 0 })),
  findActiveKanbanCardByTitle: vi.fn(() => undefined),
  findBlackboardRowByAgent: vi.fn(() => undefined),
  updateScheduleLastRun: vi.fn(),
  clearScheduleLastRunIfMatches: vi.fn(),
  getSystemConfig: vi.fn(() => undefined),
  setSystemConfig: (key: string, value: string) => mockSetSystemConfig(key, value),
}))

vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(async () => {}),
  sendTelegramPhoto: vi.fn(async () => {}),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-tick-persist-no-tasks-dir',
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

async function startRunner(): Promise<NodeJS.Timeout> {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  return startScheduleRunner()
}

describe('schedule runner: awaited tick liveness stamp', () => {
  beforeEach(() => {
    vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(START)
    mockSetSystemConfig.mockResolvedValue(undefined)
    mockListScheduledTasks.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('writes the stamp after the first tick scanned (key and value: the tick time)', async () => {
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000) // the immediate first tick
    clearInterval(stop)
    expect(mockSetSystemConfig).toHaveBeenCalledTimes(1)
    expect(mockSetSystemConfig).toHaveBeenCalledWith('schedule_last_tick_ms', String(START.getTime() + 5_000))
  })

  it('the tick waits for the write: while it is pending the next interval fires skip (ticks never overlap)', async () => {
    let release: () => void = () => {}
    mockSetSystemConfig.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000) // first tick starts, scans, then waits on the stamp write
    expect(mockListScheduledTasks).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(45_000) // three more interval fires land while the write is pending
    expect(mockListScheduledTasks).toHaveBeenCalledTimes(1) // all skipped: the tick is still in flight
    expect(mockSetSystemConfig).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(15_000) // the next fire after the write resolved runs a full tick again
    clearInterval(stop)
    expect(mockListScheduledTasks.mock.calls.length).toBeGreaterThan(1)
  })

  it('a failed write is logged and the loop carries on with the next tick', async () => {
    mockSetSystemConfig.mockRejectedValueOnce(new Error('disk full'))
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'schedule-runner: failed to persist tick liveness stamp',
    )
    const scansAfterFailure = mockListScheduledTasks.mock.calls.length
    await vi.advanceTimersByTimeAsync(15_000)
    clearInterval(stop)
    expect(mockListScheduledTasks.mock.calls.length).toBeGreaterThan(scansAfterFailure) // the guard was released
  })

  it('is throttled: one write per 60 s of ticks, not one per 15 s tick', async () => {
    const stop = await startRunner()
    await vi.advanceTimersByTimeAsync(100_000)
    clearInterval(stop)
    // ticks at 5 s, 15 s, 30 s ... 90 s: stamped at 5 s and again once 60 s have passed (75 s)
    expect(mockSetSystemConfig).toHaveBeenCalledTimes(2)
  })
})
