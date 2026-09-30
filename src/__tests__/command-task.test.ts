import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const {
  spawnMock, atomicWriteFileSyncMock, appendTaskRunMock, sendTelegramMessageMock, readFileSyncMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  atomicWriteFileSyncMock: vi.fn(),
  appendTaskRunMock: vi.fn(),
  sendTelegramMessageMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('node:fs', () => ({ readFileSync: readFileSyncMock }))
vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/command-task-test',
  TELEGRAM_BOT_TOKEN: 'bot-token',
  ALLOWED_CHAT_ID: 'chat-id',
}))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: atomicWriteFileSyncMock }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/telegram.js', () => ({ sendTelegramMessage: sendTelegramMessageMock }))
vi.mock('../db.js', () => ({ appendTaskRun: appendTaskRunMock }))

import { evaluateCommandResult, type CommandHealth } from '../web/command-task.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// runCommandTask caches its on-disk health map in a module-level variable
// after the first read, so a test that needs a specific pre-existing health
// state must start from a FRESH module instance (otherwise a later
// readFileSyncMock override is silently ignored -- the cache already won).
async function freshCommandTaskModule() {
  vi.resetModules()
  return import('../web/command-task.js')
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return { name: 'ping-check', command: 'true', ...overrides } as ScheduledTask
}



// A stand-in for the bash child: emits its outcome on the next tick, or never
// (hang) so the timeout path can be driven with fake timers.
interface FakeOutcome { code?: number | null; signal?: string | null; stderr?: string; error?: Error; hang?: boolean }
function fakeChild(o: FakeOutcome = {}) {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; pid?: number; kill: ReturnType<typeof vi.fn> }
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  if (!o.hang) {
    setImmediate(() => {
      if (o.error) { child.emit('error', o.error); return }
      if (o.stderr) child.stderr.emit('data', Buffer.from(o.stderr))
      child.emit('close', o.code ?? 0, o.signal ?? null)
    })
  }
  return child
}
function nextSpawn(o: FakeOutcome) { spawnMock.mockImplementationOnce(() => fakeChild(o)) }

beforeEach(() => {
  spawnMock.mockReset().mockImplementation(() => fakeChild())
  atomicWriteFileSyncMock.mockReset()
  appendTaskRunMock.mockReset()
  sendTelegramMessageMock.mockReset().mockResolvedValue(undefined)
  readFileSyncMock.mockReset().mockImplementation(() => { throw new Error('ENOENT') })
})
afterEach(() => { vi.useRealTimers() })

describe('evaluateCommandResult -- pure decision logic', () => {
  const NOW = 1000

  it('zeroes the streak on success with no prior state', () => {
    const { next, action } = evaluateCommandResult(undefined, true, 2, NOW)
    expect(next).toEqual({ fails: 0, alerted: false, lastStatus: 'ok', lastRun: NOW })
    expect(action).toBe('none')
  })

  it('increments the failure streak without alerting below threshold', () => {
    const prev: CommandHealth = { fails: 0, alerted: false, lastStatus: 'ok', lastRun: 0 }
    const { next, action } = evaluateCommandResult(prev, false, 3, NOW)
    expect(next.fails).toBe(1)
    expect(action).toBe('none')
  })

  it('fires an alert exactly when the streak first reaches failThreshold', () => {
    const prev: CommandHealth = { fails: 1, alerted: false, lastStatus: 'fail', lastRun: 0 }
    const { next, action } = evaluateCommandResult(prev, false, 2, NOW)
    expect(next.fails).toBe(2)
    expect(next.alerted).toBe(true)
    expect(action).toBe('alert')
  })

  it('does not re-alert on a further failure once already alerted', () => {
    const prev: CommandHealth = { fails: 2, alerted: true, lastStatus: 'fail', lastRun: 0 }
    const { next, action } = evaluateCommandResult(prev, false, 2, NOW)
    expect(next.fails).toBe(3)
    expect(action).toBe('none')
  })

  it('fires a recover action when a previously-alerted task succeeds', () => {
    const prev: CommandHealth = { fails: 5, alerted: true, lastStatus: 'fail', lastRun: 0 }
    const { next, action } = evaluateCommandResult(prev, true, 2, NOW)
    expect(next).toEqual({ fails: 0, alerted: false, lastStatus: 'ok', lastRun: NOW })
    expect(action).toBe('recover')
  })

  it('a success that was never alerted stays quiet (no recover spam)', () => {
    const prev: CommandHealth = { fails: 1, alerted: false, lastStatus: 'fail', lastRun: 0 }
    const { action } = evaluateCommandResult(prev, true, 2, NOW)
    expect(action).toBe('none')
  })
})

describe('runCommandTask', () => {
  it('skips (and does not run a command) when the task has no command', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    await runCommandTask(task({ command: undefined }), 1000)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('runs the command via bash -lc in its own process group, without blocking (async spawn)', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    await runCommandTask(task({ command: 'echo hi', timeoutMs: 5000 }), 1000)
    expect(spawnMock).toHaveBeenCalledWith('bash', ['-lc', 'echo hi'], expect.objectContaining({ detached: true }))
  })

  it('returns a promise that settles only after the command finished and the result is recorded', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    const p = runCommandTask(task(), 1000)
    expect(p).toBeInstanceOf(Promise)
    expect(appendTaskRunMock).not.toHaveBeenCalled()
    await p
    expect(appendTaskRunMock).toHaveBeenCalledTimes(1)
  })

  it('persists the health map and records a task run on every invocation', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    await runCommandTask(task(), 1000)
    expect(atomicWriteFileSyncMock).toHaveBeenCalled()
    expect(appendTaskRunMock).toHaveBeenCalledWith('ping-check', 'system')
  })

  it('uses the task-declared agent for the task-run record when present', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    await runCommandTask(task({ agent: 'agent-custom' }), 1000)
    expect(appendTaskRunMock).toHaveBeenCalledWith('ping-check', 'agent-custom')
  })

  it('does not send a Telegram alert on a lone failure below threshold', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    nextSpawn({ code: 1, stderr: 'boom' })
    await runCommandTask(task({ failThreshold: 2 }), 1000)
    expect(sendTelegramMessageMock).not.toHaveBeenCalled()
  })

  it('sends a Telegram alert once the failure streak crosses the threshold', async () => {
    nextSpawn({ code: 1, stderr: 'boom' })
    // Simulate one prior failure already on record.
    readFileSyncMock.mockReturnValue(JSON.stringify({ 'ping-check': { fails: 1, alerted: false, lastStatus: 'fail', lastRun: 0 } }))
    const { runCommandTask } = await freshCommandTaskModule()
    await runCommandTask(task({ failThreshold: 2 }), 1000)
    expect(sendTelegramMessageMock).toHaveBeenCalledWith('bot-token', 'chat-id', expect.stringContaining('Hiba'))
    expect(sendTelegramMessageMock).toHaveBeenCalledWith('bot-token', 'chat-id', expect.stringContaining('exit 1: boom'))
  })

  it('sends a recovery Telegram message once an alerted task succeeds again', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ 'ping-check': { fails: 3, alerted: true, lastStatus: 'fail', lastRun: 0 } }))
    const { runCommandTask } = await freshCommandTaskModule()
    await runCommandTask(task(), 1000)
    expect(sendTelegramMessageMock).toHaveBeenCalledWith('bot-token', 'chat-id', expect.stringContaining('Helyre'))
  })

  it('a spawn error is a failed run, not an exception', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    nextSpawn({ error: Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' }) })
    await expect(runCommandTask(task({ failThreshold: 1 }), 1000)).resolves.toBeUndefined()
    expect(sendTelegramMessageMock).toHaveBeenCalledWith('bot-token', 'chat-id', expect.stringContaining('ENOENT'))
  })

  it('a spawn that throws synchronously is a failed run, not an exception', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    spawnMock.mockImplementationOnce(() => { throw new Error('EAGAIN') })
    await expect(runCommandTask(task({ failThreshold: 1 }), 1000)).resolves.toBeUndefined()
    expect(atomicWriteFileSyncMock).toHaveBeenCalled()
  })

  it('a timeout kills the whole process group and is recorded as a failure (defaults to 10s)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = fakeChild({ hang: true })
    child.pid = 4242
    spawnMock.mockImplementationOnce(() => child)
    const { runCommandTask } = await freshCommandTaskModule()
    const p = runCommandTask(task({ timeoutMs: undefined, failThreshold: 1 }), 1000)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(killSpy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    await p
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(sendTelegramMessageMock).toHaveBeenCalledWith('bot-token', 'chat-id', expect.stringContaining('timeout 10000ms'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL')
    killSpy.mockRestore()
  })

  it('does not start the same task twice while it is still running (in-flight guard)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = fakeChild({ hang: true })
    spawnMock.mockImplementationOnce(() => first)
    const { runCommandTask } = await freshCommandTaskModule()
    const p1 = runCommandTask(task({ timeoutMs: 60_000 }), 1000)
    await runCommandTask(task({ timeoutMs: 60_000 }), 2000) // second occurrence: skipped at once
    expect(spawnMock).toHaveBeenCalledTimes(1)
    first.emit('close', 0, null)
    await p1
    // once finished, the next occurrence runs again
    await runCommandTask(task(), 3000)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('a different task is not blocked by one that is still running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hang = fakeChild({ hang: true })
    spawnMock.mockImplementationOnce(() => hang)
    const { runCommandTask } = await freshCommandTaskModule()
    const p1 = runCommandTask(task({ name: 'slow', timeoutMs: 60_000 }), 1000)
    const p2 = runCommandTask(task({ name: 'fast' }), 1000)
    await vi.advanceTimersByTimeAsync(10)
    await p2
    expect(spawnMock).toHaveBeenCalledTimes(2)
    hang.emit('close', 0, null)
    await p1
  })
})
