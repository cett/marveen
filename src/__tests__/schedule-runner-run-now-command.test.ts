// runScheduledTaskNow (POST /api/schedules/:name/run) for type='command' tasks.
// The cron loop runs a command task's shell command directly (runCommandTask);
// the manual run used to ignore the type and push the task through the agent
// session path instead -- "<agent>: busy" plus a pending retry that would later
// type the task's (stale) prompt into the agent's pane.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { runCommandTaskMock, listTasksMock, updateLastRunMock, insertRetryMock, isAgentRunningMock } = vi.hoisted(() => ({
  runCommandTaskMock: vi.fn(),
  listTasksMock: vi.fn(),
  updateLastRunMock: vi.fn(),
  insertRetryMock: vi.fn(),
  isAgentRunningMock: vi.fn(() => false),
}))

vi.mock('../web/command-task.js', () => ({ runCommandTask: runCommandTaskMock }))
vi.mock('../web/scheduled-tasks-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/scheduled-tasks-io.js')>()
  return { ...actual, listScheduledTasks: listTasksMock }
})
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, updateScheduleLastRun: updateLastRunMock, insertPendingTaskRetryIfNew: insertRetryMock }
})
vi.mock('../web/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process.js')>()
  return { ...actual, isAgentRunning: isAgentRunningMock }
})

import { runScheduledTaskNow } from '../web/schedule-runner.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    name: 'nightly-backup', description: 'backup', prompt: 'STALE PROMPT, must never reach a pane',
    schedule: '0 3 * * *', agent: 'agent-a', enabled: true, createdAt: 1, type: 'command',
    command: 'bash scripts/backup.sh', skipIfBusy: false, forceSend: false, status: 'live',
    ...overrides,
  } as ScheduledTask
}

beforeEach(() => {
  runCommandTaskMock.mockReset()
  listTasksMock.mockReset()
  updateLastRunMock.mockReset()
  insertRetryMock.mockReset()
  isAgentRunningMock.mockReset().mockReturnValue(false)
})

describe('runScheduledTaskNow: type=command', () => {
  it('runs the shell command directly and stamps the last run, without touching any agent session', async () => {
    listTasksMock.mockReturnValue([task()])
    const r = await runScheduledTaskNow('nightly-backup')
    expect(r.ok).toBe(true)
    expect(r.result).toMatch(/^command: executed/)
    expect(runCommandTaskMock).toHaveBeenCalledTimes(1)
    expect(runCommandTaskMock.mock.calls[0][0]).toMatchObject({ name: 'nightly-backup', command: 'bash scripts/backup.sh' })
    expect(updateLastRunMock).toHaveBeenCalledWith('nightly-backup', expect.any(Number), 'command')
    // the agent-session path was not entered: no session probe, no parked retry
    expect(isAgentRunningMock).not.toHaveBeenCalled()
    expect(insertRetryMock).not.toHaveBeenCalled()
  })

  it('still honours the disabled and not-live gates before running anything', async () => {
    listTasksMock.mockReturnValue([task({ enabled: false })])
    expect(await runScheduledTaskNow('nightly-backup')).toMatchObject({ ok: false, error: 'disabled' })
    listTasksMock.mockReturnValue([task({ status: 'draft' })])
    expect(await runScheduledTaskNow('nightly-backup')).toMatchObject({ ok: false, error: 'not_live' })
    expect(runCommandTaskMock).not.toHaveBeenCalled()
    expect(updateLastRunMock).not.toHaveBeenCalled()
  })

  it('a non-command task is never run as a shell command', async () => {
    listTasksMock.mockReturnValue([task({ type: 'task', command: undefined })])
    // the session path needs a real DB/tmux; only the routing decision matters here
    await runScheduledTaskNow('nightly-backup').catch(() => undefined)
    expect(runCommandTaskMock).not.toHaveBeenCalled()
    expect(updateLastRunMock).not.toHaveBeenCalledWith('nightly-backup', expect.any(Number), 'command')
  })
})
