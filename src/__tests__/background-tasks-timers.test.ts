// The timer callbacks of routes/background-tasks.ts (poll interval, 30-minute timeout) call async db functions.
// A timer cannot await, so each callback runs an async body with its own try/catch, and the poll skips a tick
// while the previous one is still running. The db layer is mocked: what is pinned here is the callback wiring and
// that only the writer that closed the task (finishBackgroundTask -> true) reports it and kills the tmux session.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  createBackgroundTaskAtomic: vi.fn(),
  getBackgroundTasks: vi.fn(),
  getBackgroundTask: vi.fn(),
  getRunningBackgroundTasks: vi.fn(),
  finishBackgroundTask: vi.fn(),
  markOrphanedTasksFailed: vi.fn(),
  execFileSync: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../platform.js', () => ({ resolveFromPath: () => '/usr/bin/tmux' }))
vi.mock('../logger.js', () => ({ logger: mocks.logger }))
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return { ...orig, execFileSync: mocks.execFileSync }
})
vi.mock('../db.js', () => ({
  createBackgroundTaskAtomic: mocks.createBackgroundTaskAtomic,
  getBackgroundTasks: mocks.getBackgroundTasks,
  getBackgroundTask: mocks.getBackgroundTask,
  getRunningBackgroundTasks: mocks.getRunningBackgroundTasks,
  finishBackgroundTask: mocks.finishBackgroundTask,
  markOrphanedTasksFailed: mocks.markOrphanedTasksFailed,
}))

import { sweepOrphanedBackgroundTasks } from '../web/routes/background-tasks.js'

const SESSION = 'bg-ABCD1234'
const TASK = {
  id: 'ABCD1234', agent_id: 'agent-a', prompt: 'p', status: 'running' as const, tmux_session: SESSION,
  started_at: 1_800_000_000, finished_at: null, output: null,
}
const POLL_MS = 10_000
const TIMEOUT_MS = 30 * 60 * 1000

let pane = 'still working'
let sessionAlive = true

function tmuxCalls(sub: string): unknown[][] {
  return mocks.execFileSync.mock.calls.filter((c) => (c[1] as string[])[0] === sub)
}

beforeEach(() => {
  vi.useFakeTimers()
  pane = 'still working'
  sessionAlive = true
  for (const m of [mocks.getBackgroundTask, mocks.getRunningBackgroundTasks, mocks.finishBackgroundTask, mocks.execFileSync,
    mocks.logger.info, mocks.logger.warn, mocks.logger.error]) m.mockReset()
  mocks.getRunningBackgroundTasks.mockResolvedValue([TASK])
  mocks.getBackgroundTask.mockResolvedValue(TASK)
  mocks.finishBackgroundTask.mockResolvedValue(true)
  mocks.execFileSync.mockImplementation((_bin: string, args: string[]) => {
    if (args[0] === 'list-sessions') return sessionAlive ? `${SESSION}\n` : ''
    if (args[0] === 'capture-pane') return pane
    return ''
  })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('poll interval tick', () => {
  it('finishes a task whose pane shows the done marker, kills the session and reports it', async () => {
    pane = 'result text\n___BG_DONE___\n'
    await sweepOrphanedBackgroundTasks()
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(mocks.finishBackgroundTask).toHaveBeenCalledWith(TASK.id, 'done', 'result text')
    expect(tmuxCalls('kill-session')).toHaveLength(1)
    expect(mocks.logger.info).toHaveBeenCalledWith({ id: TASK.id }, 'Background task completed')
  })

  it('a task the timeout sweep closed first (finishBackgroundTask -> false) is neither killed nor reported', async () => {
    pane = 'result text\n___BG_DONE___\n'
    mocks.finishBackgroundTask.mockResolvedValue(false)
    await sweepOrphanedBackgroundTasks()
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(mocks.finishBackgroundTask).toHaveBeenCalledTimes(1)
    expect(tmuxCalls('kill-session')).toHaveLength(0)
    expect(mocks.logger.info).not.toHaveBeenCalledWith({ id: TASK.id }, 'Background task completed')
  })

  it('a session that ended is closed as done only once, and the interval stops', async () => {
    // the sweep must see a live session to start the poll; the session dies afterwards
    await sweepOrphanedBackgroundTasks()
    sessionAlive = false
    await vi.advanceTimersByTimeAsync(POLL_MS)
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)

    expect(mocks.finishBackgroundTask).toHaveBeenCalledTimes(1)
    expect(mocks.finishBackgroundTask).toHaveBeenCalledWith(TASK.id, 'done', '(session ended)')
  })

  it('a db failure in the tick is logged, not left as an unhandled rejection, and the next tick runs', async () => {
    mocks.getBackgroundTask.mockRejectedValueOnce(new Error('db gone'))
    await sweepOrphanedBackgroundTasks()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.objectContaining({ id: TASK.id }), 'Background task poll tick failed')

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(mocks.getBackgroundTask).toHaveBeenCalledTimes(2)
  })

  it('does not start a second tick while the previous one is still waiting on the db', async () => {
    let release: (t: typeof TASK) => void = () => {}
    mocks.getBackgroundTask.mockImplementation(() => new Promise<typeof TASK>((r) => { release = r }))
    await sweepOrphanedBackgroundTasks()
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(mocks.getBackgroundTask).toHaveBeenCalledTimes(1)

    release(TASK)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(mocks.getBackgroundTask).toHaveBeenCalledTimes(2)
  })
})

describe('30-minute timeout timer', () => {
  it('closes a still-running task as timeout, kills the session and warns', async () => {
    await sweepOrphanedBackgroundTasks()
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)

    expect(mocks.finishBackgroundTask).toHaveBeenCalledWith(TASK.id, 'timeout', 'still working')
    expect(tmuxCalls('kill-session')).toHaveLength(1)
    expect(mocks.logger.warn).toHaveBeenCalledWith({ id: TASK.id }, 'Background task timed out after 30 minutes')
  })

  it('when the poll finished the task between the read and the write (finishBackgroundTask -> false) it does not kill or warn', async () => {
    mocks.finishBackgroundTask.mockResolvedValue(false)
    await sweepOrphanedBackgroundTasks()
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)

    expect(mocks.finishBackgroundTask).toHaveBeenCalledWith(TASK.id, 'timeout', 'still working')
    expect(tmuxCalls('kill-session')).toHaveLength(0)
    expect(mocks.logger.warn).not.toHaveBeenCalled()
  })

  it('a db failure in the timeout check is logged, not left as an unhandled rejection', async () => {
    await sweepOrphanedBackgroundTasks()
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - POLL_MS)
    mocks.getBackgroundTask.mockRejectedValue(new Error('db gone'))
    await vi.advanceTimersByTimeAsync(POLL_MS)

    expect(mocks.logger.error).toHaveBeenCalledWith(expect.objectContaining({ id: TASK.id }), 'Background task timeout check failed')
  })

  it('an already closed task is left alone', async () => {
    mocks.getBackgroundTask.mockResolvedValue({ ...TASK, status: 'done' as const })
    await sweepOrphanedBackgroundTasks()
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)

    expect(mocks.finishBackgroundTask).not.toHaveBeenCalled()
    expect(tmuxCalls('kill-session')).toHaveLength(0)
  })
})
