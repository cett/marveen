// Telemetry of a command-type scheduled task (src/web/command-task.ts): the schedule.run span and the
// run-duration metric. The shell child is a stand-in (spawn is mocked); the clock is faked so the measured
// duration is exact.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const {
  spawnMock, atomicWriteFileSyncMock, appendTaskRunMock, sendTelegramMessageMock, readFileSyncMock,
  upsertOtelSpanMock, recordDurationMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  atomicWriteFileSyncMock: vi.fn(),
  appendTaskRunMock: vi.fn(),
  sendTelegramMessageMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  upsertOtelSpanMock: vi.fn(),
  recordDurationMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('node:fs', () => ({ readFileSync: readFileSyncMock }))
vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/command-task-otel-test',
  TELEGRAM_BOT_TOKEN: 'bot-token',
  ALLOWED_CHAT_ID: 'chat-id',
}))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: atomicWriteFileSyncMock }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/telegram.js', () => ({ sendTelegramMessage: sendTelegramMessageMock }))
vi.mock('../db.js', () => ({ appendTaskRun: appendTaskRunMock, upsertOtelSpan: upsertOtelSpanMock }))
vi.mock('../otel-signals.js', () => ({ recordScheduleRunDuration: recordDurationMock }))

import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

const START_MS = 1_800_000_000_000

// command-task keeps its health map and its in-flight set at module level: a fresh instance per test.
async function freshModule() {
  vi.resetModules()
  return import('../web/command-task.js')
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return { name: 'nightly-check', command: 'echo SECRET-COMMAND-TEXT', agent: 'agent-a', ...overrides } as ScheduledTask
}

// A bash child that "runs" for `runMs` of the faked clock, then exits (or fails to start, or never exits).
interface Outcome { code?: number; runMs?: number; error?: Error; hang?: boolean }
function child(o: Outcome = {}) {
  const c = new EventEmitter() as EventEmitter & { stderr: EventEmitter; pid?: number; kill: ReturnType<typeof vi.fn> }
  c.stderr = new EventEmitter()
  c.kill = vi.fn()
  if (!o.hang) {
    setImmediate(() => {
      vi.setSystemTime(START_MS + (o.runMs ?? 0))
      if (o.error) { c.emit('error', o.error); return }
      c.emit('close', o.code ?? 0, null)
    })
  }
  return c
}
const nextSpawn = (o: Outcome) => spawnMock.mockImplementationOnce(() => child(o))

beforeEach(() => {
  // Date only: setImmediate stays real, so the stand-in child still fires on its own.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START_MS)
  spawnMock.mockReset().mockImplementation(() => child())
  atomicWriteFileSyncMock.mockReset()
  appendTaskRunMock.mockReset()
  sendTelegramMessageMock.mockReset().mockResolvedValue(undefined)
  readFileSyncMock.mockReset().mockImplementation(() => { throw new Error('ENOENT') })
  upsertOtelSpanMock.mockReset()
  recordDurationMock.mockReset()
})
afterEach(() => { vi.useRealTimers() })

describe('runCommandTask: schedule.run span and duration metric', () => {
  it('records one closed schedule.run span with the real start and end of a successful run', async () => {
    const { runCommandTask } = await freshModule()
    nextSpawn({ code: 0, runMs: 2500 })
    await runCommandTask(task(), START_MS)

    expect(upsertOtelSpanMock).toHaveBeenCalledTimes(1)
    expect(upsertOtelSpanMock.mock.calls[0][0]).toEqual({
      trace_id: `schedule-nightly-check-${START_MS}`,
      span_id: 'run',
      parent_span_id: null,
      agent_id: 'agent-a',
      operation: 'schedule.run',
      start_ms: START_MS,
      end_ms: START_MS + 2500,
      status: 'ok',
      attributes: JSON.stringify({ schedule: 'nightly-check', schedule_type: 'command' }),
    })
  })

  it('records the duration in seconds with status ok', async () => {
    const { runCommandTask } = await freshModule()
    nextSpawn({ code: 0, runMs: 2500 })
    await runCommandTask(task(), START_MS)
    expect(recordDurationMock).toHaveBeenCalledTimes(1)
    expect(recordDurationMock).toHaveBeenCalledWith('nightly-check', 2.5, true)
  })

  it('marks a failing command (non-zero exit) as an error span and an error duration', async () => {
    const { runCommandTask } = await freshModule()
    nextSpawn({ code: 3, runMs: 1000 })
    await runCommandTask(task(), START_MS)
    expect(upsertOtelSpanMock.mock.calls[0][0]).toMatchObject({ status: 'error', start_ms: START_MS, end_ms: START_MS + 1000 })
    expect(recordDurationMock).toHaveBeenCalledWith('nightly-check', 1, false)
  })

  it('records the findings exit code as an ok span, an ok duration and one "finding" alert (not an error)', async () => {
    const { runCommandTask, COMMAND_EXIT_FINDINGS } = await freshModule()
    nextSpawn({ code: COMMAND_EXIT_FINDINGS, runMs: 1000 })
    await runCommandTask(task(), START_MS)
    expect(upsertOtelSpanMock.mock.calls[0][0]).toMatchObject({ status: 'ok', start_ms: START_MS, end_ms: START_MS + 1000 })
    expect(JSON.parse(upsertOtelSpanMock.mock.calls[0][0].attributes)).toEqual({ schedule: 'nightly-check', schedule_type: 'command', outcome: 'findings' })
    expect(recordDurationMock).toHaveBeenCalledWith('nightly-check', 1, true)
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1)
    expect(sendTelegramMessageMock.mock.calls[0][2]).toContain('Lelet')
    const persisted = JSON.parse(atomicWriteFileSyncMock.mock.calls[0][1] as string)
    expect(persisted['nightly-check']).toMatchObject({ fails: 0, alerted: true, lastStatus: 'findings' })
  })

  it('keeps any other non-zero exit code a failure', async () => {
    const { runCommandTask, COMMAND_EXIT_FINDINGS } = await freshModule()
    nextSpawn({ code: COMMAND_EXIT_FINDINGS + 1, runMs: 1000 })
    await runCommandTask(task(), START_MS)
    expect(upsertOtelSpanMock.mock.calls[0][0]).toMatchObject({ status: 'error' })
  })

  it('marks a command that cannot be started (child error event) as an error', async () => {
    const { runCommandTask } = await freshModule()
    nextSpawn({ error: new Error('spawn bash ENOENT'), runMs: 0 })
    await runCommandTask(task(), START_MS)
    expect(upsertOtelSpanMock.mock.calls[0][0]).toMatchObject({ status: 'error' })
    expect(recordDurationMock).toHaveBeenCalledWith('nightly-check', 0, false)
  })

  it('marks a command whose spawn throws as an error', async () => {
    const { runCommandTask } = await freshModule()
    spawnMock.mockImplementationOnce(() => { throw new Error('EAGAIN') })
    await runCommandTask(task(), START_MS)
    expect(upsertOtelSpanMock.mock.calls[0][0]).toMatchObject({ status: 'error' })
    expect(recordDurationMock).toHaveBeenCalledWith('nightly-check', 0, false)
  })

  it('records the span and the duration of a command that runs into its timeout', async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(START_MS)
    const { runCommandTask } = await freshModule()
    nextSpawn({ hang: true })
    const run = runCommandTask(task({ timeoutMs: 5000 } as Partial<ScheduledTask>), START_MS)
    await vi.advanceTimersByTimeAsync(5000)
    await run
    expect(upsertOtelSpanMock.mock.calls[0][0]).toMatchObject({ status: 'error', start_ms: START_MS, end_ms: START_MS + 5000 })
    expect(recordDurationMock).toHaveBeenCalledWith('nightly-check', 5, false)
  })

  it('files a task without an agent under "system"', async () => {
    const { runCommandTask } = await freshModule()
    await runCommandTask(task({ agent: undefined } as Partial<ScheduledTask>), START_MS)
    expect(upsertOtelSpanMock.mock.calls[0][0].agent_id).toBe('system')
  })

  it('exports the schedule name and type only, never the command text', async () => {
    const { runCommandTask } = await freshModule()
    await runCommandTask(task(), START_MS)
    const span = upsertOtelSpanMock.mock.calls[0][0]
    expect(JSON.stringify(span)).not.toContain('SECRET-COMMAND-TEXT')
    expect(JSON.parse(span.attributes)).toEqual({ schedule: 'nightly-check', schedule_type: 'command' })
  })

  it('gives two runs of the same task two different traces', async () => {
    const { runCommandTask } = await freshModule()
    await runCommandTask(task(), START_MS)
    vi.setSystemTime(START_MS + 60_000)
    await runCommandTask(task(), START_MS + 60_000)
    const ids = upsertOtelSpanMock.mock.calls.map((c) => c[0].trace_id)
    expect(new Set(ids).size).toBe(2)
  })

  it('does not record anything for a task with no command, or one that is still running', async () => {
    const { runCommandTask } = await freshModule()
    await runCommandTask(task({ command: '' } as Partial<ScheduledTask>), START_MS)
    expect(upsertOtelSpanMock).not.toHaveBeenCalled()

    nextSpawn({ hang: true })
    const first = runCommandTask(task({ timeoutMs: 5000 } as Partial<ScheduledTask>), START_MS)
    await runCommandTask(task(), START_MS) // skipped: the first one is in flight
    expect(upsertOtelSpanMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledTimes(1)
    // let the first one finish so no timer outlives the test
    const c = spawnMock.mock.results[0].value as EventEmitter
    c.emit('close', 0, null)
    await first
    expect(upsertOtelSpanMock).toHaveBeenCalledTimes(1)
  })
})

describe('runCommandTask: telemetry is never fatal to the task', () => {
  it('still records the run and persists the health when the span write throws', async () => {
    const { runCommandTask } = await freshModule()
    upsertOtelSpanMock.mockImplementation(() => { throw new Error('db locked') })
    await expect(runCommandTask(task(), START_MS)).resolves.toBeUndefined()
    expect(appendTaskRunMock).toHaveBeenCalledWith('nightly-check', 'agent-a')
    expect(atomicWriteFileSyncMock).toHaveBeenCalled()
  })

  it('still writes the span when the duration metric throws', async () => {
    const { runCommandTask } = await freshModule()
    recordDurationMock.mockImplementation(() => { throw new Error('registry broken') })
    await runCommandTask(task(), START_MS)
    expect(upsertOtelSpanMock).toHaveBeenCalledTimes(1)
    expect(appendTaskRunMock).toHaveBeenCalled()
  })

  it('still records the duration when the span write throws', async () => {
    const { runCommandTask } = await freshModule()
    upsertOtelSpanMock.mockImplementation(() => { throw new Error('db locked') })
    await runCommandTask(task(), START_MS)
    expect(recordDurationMock).toHaveBeenCalledTimes(1)
  })
})
