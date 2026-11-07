import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// sendPromptToSession reports 'sent' | 'aborted-busy' | 'skipped-locked'. The scheduler used to ignore it: a prompt
// the pane refused (it sits on the external CLAUDE.md imports dialog, which swallows the text) was recorded
// 'fired', last_run_at was stamped, and the retry queue never saw the task. A refused send is now 'refused': nothing
// of the delivery is recorded, the retry row stays, and the runner's own blackboard row is handed back.

const here = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(here, '..', 'web', 'schedule-runner.ts'), 'utf-8')

const mockAppendTaskRun = vi.fn()
const mockDeletePendingRetry = vi.fn()
const mockUpdatePendingRetry = vi.fn(() => true)
const mockListPendingRetries = vi.fn(() => [] as unknown[])
const mockSessionReady = vi.fn(() => Promise.resolve(true))
const mockSendPrompt = vi.fn((..._a: unknown[]): unknown => 'sent')
const mockUpsertBlackboard = vi.fn((_agent: unknown, _row: unknown) =>
  Promise.resolve({ id: 'bb000001', agent_id: 'agent-a', task_ref: null, status: 'active', summary: 'send-result-fixture', updated_at: 0 }))
const mockFindBlackboardRow = vi.fn((_agent?: unknown): Promise<unknown> =>
  Promise.resolve({ id: 'bb000001', agent_id: 'agent-a', task_ref: null, status: 'active', summary: 'send-result-fixture', updated_at: 0, tenant_id: 'default' }))
const mockUpdateScheduleLastRun = vi.fn()
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => mockListPendingRetries(),
  deletePendingTaskRetry: (...a: unknown[]) => mockDeletePendingRetry(...a),
  updatePendingTaskRetry: (...a: unknown[]) => (mockUpdatePendingRetry as (...x: unknown[]) => boolean)(...a),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => Promise.resolve(false)),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
  upsertBlackboard: (agent: unknown, row: unknown) => mockUpsertBlackboard(agent, row),
  findActiveKanbanCardByTitle: vi.fn(() => undefined),
  findBlackboardRowByAgent: (agent?: unknown) => mockFindBlackboardRow(agent),
  updateScheduleLastRun: (...a: unknown[]) => mockUpdateScheduleLastRun(...a),
  clearScheduleLastRunIfMatches: vi.fn(),
  getSystemConfig: vi.fn(() => undefined),
  setSystemConfig: vi.fn(),
}))
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: vi.fn(() => Promise.resolve()),
  sendTelegramPhoto: vi.fn(() => Promise.resolve()),
}))
vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  SCHEDULED_TASKS_DIR: '/tmp/marveen-send-result-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
  isTaskLive: (task: { status?: string }) => task.status === undefined || task.status === 'live',
}))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => mockSessionReady(),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  startAgentProcess: vi.fn(() => ({ ok: false, error: 'tmux unavailable' })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => Promise.resolve(false)),
}))

const TASK: ScheduledTask = {
  name: 'send-result-fixture',
  description: 'send result fixture',
  prompt: 'Do the thing.',
  schedule: '0 8 * * *',
  agent: 'agent-a',
  enabled: true,
  createdAt: 0,
  type: 'heartbeat',
  targetSession: 'send-result-test-session',
}

function retryRow() {
  return {
    task_name: TASK.name,
    agent_name: 'agent-a',
    first_attempt: Date.now() - 60_000,
    last_attempt: Date.now() - 15_000,
    attempt_count: 4,
    last_reason: 'busy',
    alerted_at: null,
  }
}

async function runTick() {
  vi.resetModules()
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  // The first tick runs 5 s after start, the second 15 s after: stop between them, so one tick is observed.
  await vi.advanceTimersByTimeAsync(6_000)
  clearInterval(stop)
}

const runLogStatuses = () => mockAppendTaskRun.mock.calls.map((c) => c[2])
const bbWrites = () => mockUpsertBlackboard.mock.calls.map((c) => c[1] as { status: string; summary: string })

beforeEach(() => {
  vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
  vi.clearAllMocks()
  vi.useFakeTimers()
  // A quiet moment: no cron occurrence for the fixture, so only the pending-retry loop acts.
  vi.setSystemTime(new Date('2026-08-14T10:30:00.000Z'))
  mockListScheduledTasks.mockReturnValue([TASK])
  mockListPendingRetries.mockReturnValue([retryRow()])
  mockSessionReady.mockResolvedValue(true)
  mockSendPrompt.mockReturnValue('sent')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('schedule runner: a refused send is not a fired task', () => {
  it.each(['aborted-busy', 'skipped-locked'])('%s: no fired row, no last_run stamp, the retry row stays and is refreshed as "refused"', async (result) => {
    mockSendPrompt.mockReturnValue(result)
    await runTick()

    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
    expect(runLogStatuses()).not.toContain('fired')
    expect(runLogStatuses()).not.toContain('fired_late')
    expect(mockUpdateScheduleLastRun).not.toHaveBeenCalled()
    expect(mockDeletePendingRetry).not.toHaveBeenCalled()
    expect(mockUpdatePendingRetry).toHaveBeenCalledWith(TASK.name, 'agent-a', expect.anything(), 'refused')
  })

  it('the runner blackboard row is handed back as blocked (no phantom active task)', async () => {
    mockSendPrompt.mockReturnValue('aborted-busy')
    await runTick()

    const writes = bbWrites()
    expect(writes.map((w) => w.status)).toEqual(['active', 'blocked'])
    expect(writes[1].summary).toContain(TASK.name)
    expect(writes[1].summary).toMatch(/not delivered/)
  })

  it('a row the agent changed in the meantime is NOT overwritten (compare-and-write)', async () => {
    mockSendPrompt.mockReturnValue('aborted-busy')
    mockFindBlackboardRow.mockResolvedValue({ id: 'bb000001', agent_id: 'agent-a', task_ref: null, status: 'active', summary: 'the agent posted this itself', updated_at: 1, tenant_id: 'default' })
    await runTick()

    expect(bbWrites().map((w) => w.status)).toEqual(['active'])
  })

  it('control: a sent prompt is fired, the retry row is deleted, no blocked write', async () => {
    await runTick()

    expect(runLogStatuses()).toContain('fired')
    expect(mockDeletePendingRetry).toHaveBeenCalledWith(TASK.name, 'agent-a')
    expect(bbWrites().map((w) => w.status)).toEqual(['active'])
  })

  it('a sender that returns nothing (older or mocked) stays on the fired path, exactly as before', async () => {
    mockSendPrompt.mockReturnValue(undefined)
    await runTick()

    expect(runLogStatuses()).toContain('fired')
    expect(mockDeletePendingRetry).toHaveBeenCalledWith(TASK.name, 'agent-a')
  })
})

describe('schedule runner: the cron and run-now paths queue a refused task', () => {
  it('the cron loop enqueues "refused" and is NOT gated by skipIfBusy', () => {
    const branch = SRC.slice(SRC.indexOf("} else if (result === 'refused') {"))
    const body = branch.slice(0, branch.indexOf("} else if (result === 'first-run')"))
    expect(body).toMatch(/insertPendingTaskRetryIfNew\(task\.name, agentName, now, 'refused'\)/)
    expect(body).not.toMatch(/task\.skipIfBusy/)
    expect(body).not.toMatch(/appendTaskRun/)
  })

  it('a manual run queues a refused task like a busy one', () => {
    expect(SRC).toMatch(/result === 'first-run' \|\| result === 'refused'\) \{\s*\n\s*const reason/)
  })

  it('the send result is classified by the shared helper, not compared ad hoc', () => {
    expect(SRC).toMatch(/import \{ wasPromptRefused \} from '\.\/send-result\.js'/)
    expect(SRC).toMatch(/const sendResult = await sendPromptToSession\(session, fullPrompt, host, \{ waitForIdle: !task\.forceSend \}\)/)
    // The refusal check sits BEFORE the delivery is recorded.
    expect(SRC.indexOf('if (wasPromptRefused(sendResult))')).toBeLessThan(SRC.indexOf("recordDelivery(session, fullPrompt, 'scheduled-task')"))
  })
})
