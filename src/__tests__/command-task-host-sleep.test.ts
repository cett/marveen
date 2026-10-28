// A command task's time limit counts the time the host was awake. The process clock and the timers keep
// counting while the machine sleeps, so a command that straddled a sleep used to fail with "timeout" on
// wake-up (a false failure and a false alert, although the command had run for seconds). The watchdog in
// runCommand sees the sleep as a tick that arrives far too late and takes that gap off the clock.
//
// Both clocks are injected: a manual monotonic clock for the watchdog and fake setTimeout for the
// deadline, so a sleep is a jump of the clock and not a wait. The commands are real processes.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { atomicWriteFileSyncMock } = vi.hoisted(() => ({ atomicWriteFileSyncMock: vi.fn() }))

vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/command-task-host-sleep-test', TELEGRAM_BOT_TOKEN: '', ALLOWED_CHAT_ID: '',
}))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: atomicWriteFileSyncMock }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/telegram.js', () => ({ sendTelegramMessage: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../db.js', () => ({ appendTaskRun: vi.fn() }))

import { runCommand, runCommandTask, evaluateCommandResult, type RunClock } from '../web/command-task.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

const TIMEOUT_MS = 5000 // the watchdog ticks every 1000 ms at this limit

function manualClock() {
  let t = 0
  let onTick: (() => void) | null = null
  const clock: RunClock = { now: () => t, every: (_ms, fn) => { onTick = fn; return () => { onTick = null } } }
  return {
    clock,
    elapse: (ms: number) => { t += ms },
    tick: () => { onTick?.() },
    get watching() { return onTick !== null },
  }
}
type Manual = ReturnType<typeof manualClock>

/** The host is awake for ms: both clocks move together, one watchdog tick per second. */
function awake(c: Manual, ms: number): void {
  for (let left = ms; left > 0; left -= 1000) {
    const step = Math.min(1000, left)
    c.elapse(step)
    vi.advanceTimersByTime(step)
    c.tick()
  }
}

/** The host sleeps for ms; the deadline timer and the watchdog both wake up late, in either order. */
function sleepFor(c: Manual, ms: number, order: 'timer-first' | 'tick-first'): void {
  c.elapse(ms)
  if (order === 'timer-first') {
    vi.advanceTimersToNextTimer()
    c.tick()
  } else {
    c.tick()
    vi.advanceTimersToNextTimer()
  }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Result = Awaited<ReturnType<typeof runCommand>>
function start(cmd: string, c: Manual, limitMs = TIMEOUT_MS): { settled: () => Result | null; done: Promise<Result> } {
  let result: Result | null = null
  const done = runCommand(cmd, limitMs, c.clock).then((r) => (result = r))
  return { settled: () => result, done }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) })
afterEach(() => { vi.useRealTimers() })

describe.each(['timer-first', 'tick-first'] as const)('a command that straddles a host sleep (%s)', (order) => {
  it('is not failed for the time the host slept, and is failed once its awake time is used up', async () => {
    const c = manualClock()
    const run = start('sleep 30', c)
    awake(c, 2000)
    sleepFor(c, 900_000, order)
    await Promise.resolve()
    expect(run.settled()).toBeNull() // 2 s awake of 5 s, 15 minutes asleep: still running
    awake(c, 2000)
    expect(run.settled()).toBeNull() // 4 s awake
    awake(c, 1000)
    const r = await run.done // 5 s awake: a real timeout
    expect(r).toMatchObject({ outcome: 'fail', detail: 'timeout 5000ms', suspendedMs: 900_000 })
  })

  it('lets a command that finishes after the sleep finish as ok (it is not killed at wake-up)', async () => {
    const c = manualClock()
    const run = start('sleep 0.6', c)
    awake(c, 1000)
    sleepFor(c, 900_000, order)
    const r = await run.done
    expect(r).toMatchObject({ outcome: 'ok', detail: 'exit 0', suspendedMs: 900_000 })
  })

  it('takes every sleep off the clock, not only the first one', async () => {
    const c = manualClock()
    const run = start('sleep 30', c)
    awake(c, 1000)
    sleepFor(c, 900_000, order)
    awake(c, 1000)
    sleepFor(c, 600_000, order)
    awake(c, 2000)
    expect(run.settled()).toBeNull() // 4 s awake in total
    awake(c, 1000)
    expect(await run.done).toMatchObject({ outcome: 'fail', detail: 'timeout 5000ms', suspendedMs: 1_500_000 })
  })
})

describe('a command that does not straddle a sleep', () => {
  it('is failed when its time is up, and its whole process tree is killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmd-sleep-'))
    const pidFile = join(dir, 'child.pid')
    const c = manualClock()
    const run = start(`sleep 30 & echo $! > ${pidFile}; wait`, c)
    // the clocks are fake, the shell is not: let it start its grandchild before the time runs out
    for (const t0 = Date.now(); !existsSync(pidFile) && Date.now() - t0 < 5000;) await new Promise((r) => setImmediate(r))
    expect(existsSync(pidFile)).toBe(true)
    awake(c, 4000)
    expect(run.settled()).toBeNull()
    awake(c, 1000)
    expect(await run.done).toMatchObject({ outcome: 'fail', detail: 'timeout 5000ms', suspendedMs: 0 })
    vi.useRealTimers()
    const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
    await realSleep(500)
    expect(alive(pid)).toBe(false)
  }, 15000)

  it('is failed after its full limit when the host never slept, however long the limit is', async () => {
    const c = manualClock()
    const run = start('sleep 30', c, 30_000)
    awake(c, 29_000)
    expect(run.settled()).toBeNull()
    awake(c, 1000)
    expect(await run.done).toMatchObject({ outcome: 'fail', detail: 'timeout 30000ms', suspendedMs: 0 })
  })

  it('is failed on time when the host was only slow: a gap of exactly one tick plus 5 s is not a sleep', async () => {
    const c = manualClock()
    const run = start('sleep 30', c)
    awake(c, 1000)
    sleepFor(c, 6000, 'timer-first') // the late tick came 6000 ms after the previous one (1000 + 5000)
    expect(await run.done).toMatchObject({ outcome: 'fail', detail: 'timeout 5000ms', suspendedMs: 0 })
  })

  it('is treated as a sleep one millisecond past that', async () => {
    const c = manualClock()
    const run = start('sleep 0.6', c)
    awake(c, 1000)
    sleepFor(c, 6001, 'timer-first')
    expect(await run.done).toMatchObject({ outcome: 'ok', suspendedMs: 6001 })
  })

  it('stops the watchdog when the command ends', async () => {
    const c = manualClock()
    const run = start('exit 0', c)
    await run.done
    expect(c.watching).toBe(false)
  })
})

describe('the health map carries why the last run ended', () => {
  const task = (o: Partial<ScheduledTask>) => ({ name: 'detail-task', ...o }) as ScheduledTask
  const lastHealth = (name: string) => {
    const calls = atomicWriteFileSyncMock.mock.calls
    return JSON.parse(calls[calls.length - 1][1] as string)[name]
  }
  beforeEach(() => { vi.useRealTimers(); atomicWriteFileSyncMock.mockClear() })

  it('stores the exit code and the stderr head of a failure, and exit 0 for a clean run', async () => {
    await runCommandTask(task({ name: 'detail-fail', command: 'echo nope >&2; exit 3', failThreshold: 1 }), 1000)
    expect(lastHealth('detail-fail')).toMatchObject({ lastStatus: 'fail', fails: 1, alerted: true, lastDetail: 'exit 3: nope' })
    await runCommandTask(task({ name: 'detail-ok', command: 'true' }), 1000)
    expect(lastHealth('detail-ok')).toMatchObject({ lastStatus: 'ok', fails: 0, alerted: false, lastDetail: 'exit 0' })
  }, 15000)

  it('stores the timeout of a real timeout', async () => {
    await runCommandTask(task({ name: 'detail-timeout', command: 'sleep 30', timeoutMs: 300, failThreshold: 1 }), 1000)
    expect(lastHealth('detail-timeout')).toMatchObject({ lastStatus: 'fail', lastDetail: 'timeout 300ms' })
  }, 15000)

  it('leaves the streak and the alert state to the outcome, with or without a detail', () => {
    const prev = { fails: 1, alerted: false, lastStatus: 'fail' as const, lastRun: 1 }
    const withDetail = evaluateCommandResult(prev, 'fail', 2, 9, 'exit 1')
    const without = evaluateCommandResult(prev, 'fail', 2, 9)
    expect(withDetail.action).toBe('alert')
    expect(withDetail.next).toEqual({ fails: 2, alerted: true, lastStatus: 'fail', lastRun: 9, lastDetail: 'exit 1' })
    expect(without.next).toEqual({ fails: 2, alerted: true, lastStatus: 'fail', lastRun: 9 })
  })

  it('cuts a long detail', () => {
    const r = evaluateCommandResult(undefined, 'fail', 2, 9, 'x'.repeat(1000))
    expect(r.next.lastDetail).toHaveLength(240)
  })
})
