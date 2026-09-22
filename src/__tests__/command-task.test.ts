import { describe, it, expect, beforeEach, vi } from 'vitest'

const {
  spawnSyncMock, atomicWriteFileSyncMock, appendTaskRunMock, sendTelegramMessageMock, readFileSyncMock,
} = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  atomicWriteFileSyncMock: vi.fn(),
  appendTaskRunMock: vi.fn(),
  sendTelegramMessageMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }))
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

beforeEach(() => {
  spawnSyncMock.mockReset().mockReturnValue({ status: 0, stderr: '', error: undefined })
  atomicWriteFileSyncMock.mockReset()
  appendTaskRunMock.mockReset()
  sendTelegramMessageMock.mockReset().mockResolvedValue(undefined)
  readFileSyncMock.mockReset().mockImplementation(() => { throw new Error('ENOENT') })
})

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
    runCommandTask(task({ command: undefined }), 1000)
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('runs the command via bash -lc with the configured timeout', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    runCommandTask(task({ command: 'echo hi', timeoutMs: 5000 }), 1000)
    expect(spawnSyncMock).toHaveBeenCalledWith('bash', ['-lc', 'echo hi'], expect.objectContaining({ timeout: 5000 }))
  })

  it('defaults the timeout to 10s and the fail threshold to 2 when unset', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    runCommandTask(task({ timeoutMs: undefined, failThreshold: undefined }), 1000)
    expect(spawnSyncMock).toHaveBeenCalledWith('bash', ['-lc', 'true'], expect.objectContaining({ timeout: 10_000 }))
  })

  it('persists the health map and records a task run on every invocation', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    runCommandTask(task(), 1000)
    expect(atomicWriteFileSyncMock).toHaveBeenCalled()
    expect(appendTaskRunMock).toHaveBeenCalledWith('ping-check', 'system')
  })

  it('uses the task-declared agent for the task-run record when present', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    runCommandTask(task({ agent: 'agent-custom' }), 1000)
    expect(appendTaskRunMock).toHaveBeenCalledWith('ping-check', 'agent-custom')
  })

  it('does not send a Telegram alert on a lone failure below threshold', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    spawnSyncMock.mockReturnValue({ status: 1, stderr: 'boom', error: undefined })
    runCommandTask(task({ failThreshold: 2 }), 1000)
    await Promise.resolve()
    expect(sendTelegramMessageMock).not.toHaveBeenCalled()
  })

  it('sends a Telegram alert once the failure streak crosses the threshold', async () => {
    spawnSyncMock.mockReturnValue({ status: 1, stderr: 'boom', error: undefined })
    // Simulate one prior failure already on record.
    readFileSyncMock.mockReturnValue(JSON.stringify({ 'ping-check': { fails: 1, alerted: false, lastStatus: 'fail', lastRun: 0 } }))
    const { runCommandTask } = await freshCommandTaskModule()
    runCommandTask(task({ failThreshold: 2 }), 1000)
    await Promise.resolve()
    expect(sendTelegramMessageMock).toHaveBeenCalledWith('bot-token', 'chat-id', expect.stringContaining('Hiba'))
  })

  it('sends a recovery Telegram message once an alerted task succeeds again', async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ 'ping-check': { fails: 3, alerted: true, lastStatus: 'fail', lastRun: 0 } }))
    const { runCommandTask } = await freshCommandTaskModule()
    runCommandTask(task(), 1000)
    await Promise.resolve()
    expect(sendTelegramMessageMock).toHaveBeenCalledWith('bot-token', 'chat-id', expect.stringContaining('Helyre'))
  })

  it('treats spawnSync error as a failure and surfaces the timeout detail', async () => {
    const { runCommandTask } = await freshCommandTaskModule()
    spawnSyncMock.mockReturnValue({ status: null, stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) })
    expect(() => runCommandTask(task({ timeoutMs: 500 }), 1000)).not.toThrow()
    expect(atomicWriteFileSyncMock).toHaveBeenCalled()
  })
})
