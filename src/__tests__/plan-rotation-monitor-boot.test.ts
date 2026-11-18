// The boot wiring of the plan-rotation monitor: when the dashboard starts it, when it must not, and that a
// second start or a stop leaves exactly one (or no) interval running. Neutral fixture names only.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'agent-a',
}))
vi.mock('../web/agent-process-session.js', () => ({ capturePane: () => null }))

import {
  bootPlanRotationMonitor,
  startPlanRotationMonitor,
  stopPlanRotationMonitor,
  MONITOR_TICK_MS,
  type MonitorDeps,
} from '../web/plan-rotation-monitor.js'
import { logger } from '../logger.js'

afterEach(() => {
  stopPlanRotationMonitor()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Deps whose only live call is readMode (mode off returns right after it): one readMode call is one tick. */
function countingDeps() {
  const readMode = vi.fn(() => Promise.resolve({ mode: 'off' as const, stored: 'off', reason: null }))
  const boom = () => { throw new Error('a tick in mode off must not get past readMode') }
  const deps: MonitorDeps = {
    now: () => Date.now(),
    mainAgentId: 'agent-a',
    readMode,
    isEnabled: boom,
    readPlans: boom,
    readSnapshot: boom,
    readState: boom,
    writeState: boom,
    apply: boom,
    notify: boom,
  }
  return { deps, readMode }
}

describe('bootPlanRotationMonitor', () => {
  it('a WEB_ONLY process (staging, every isolated instance) does not start it', () => {
    const start = vi.fn()
    expect(bootPlanRotationMonitor(true, start)).toBe(false)
    expect(start).not.toHaveBeenCalled()
  })

  it('a normal process starts it exactly once', () => {
    const start = vi.fn()
    expect(bootPlanRotationMonitor(false, start)).toBe(true)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('a start that throws is logged and never reaches the boot', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const start = vi.fn(() => { throw new Error('no deps today') })
    expect(() => bootPlanRotationMonitor(false, start)).not.toThrow()
    expect(bootPlanRotationMonitor(false, start)).toBe(false)
    expect(warn).toHaveBeenCalled()
  })
})

describe('start / stop', () => {
  it('ticks every 60 s, once per interval', async () => {
    vi.useFakeTimers()
    const { deps, readMode } = countingDeps()
    expect(MONITOR_TICK_MS).toBe(60_000)
    startPlanRotationMonitor(deps)
    expect(readMode).not.toHaveBeenCalled() // the first tick is after one interval, not at start
    await vi.advanceTimersByTimeAsync(59_999)
    expect(readMode).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(readMode).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(readMode).toHaveBeenCalledTimes(3)
  })

  it('a second start replaces the first: one interval, not two', async () => {
    vi.useFakeTimers()
    const first = countingDeps()
    const second = countingDeps()
    startPlanRotationMonitor(first.deps)
    startPlanRotationMonitor(second.deps)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(first.readMode).not.toHaveBeenCalled()
    expect(second.readMode).toHaveBeenCalledTimes(1)
  })

  it('stop ends the ticking, and a stop without a start is harmless', async () => {
    vi.useFakeTimers()
    expect(() => stopPlanRotationMonitor()).not.toThrow()
    const { deps, readMode } = countingDeps()
    startPlanRotationMonitor(deps)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readMode).toHaveBeenCalledTimes(1)
    stopPlanRotationMonitor()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(readMode).toHaveBeenCalledTimes(1)
  })

  it('a tick that throws is logged and the interval goes on', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const { deps } = countingDeps()
    let calls = 0
    deps.readMode = () => { calls++; return Promise.reject(new Error('db hiccup')) }
    startPlanRotationMonitor(deps)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(calls).toBe(3)
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('tick failed'))).toHaveLength(3)
  })
})

describe('the dashboard wiring (web.ts)', () => {
  const webTs = readFileSync(fileURLToPath(new URL('../web.ts', import.meta.url)), 'utf8')

  it('starts it through the WEB_ONLY-aware boot hook, with the same flag the other monitors use', () => {
    expect(webTs).toContain("const webOnly = process.env['WEB_ONLY'] === 'true'")
    expect(webTs).toMatch(/bootPlanRotationMonitor\(webOnly\)/)
  })

  it('stops it where the server closes, next to the other monitor intervals', () => {
    const close = webTs.slice(webTs.indexOf('server.close = (cb'))
    expect(close).toContain('stopPlanRotationMonitor()')
    // inside the close handler, before the original close is called
    expect(close.indexOf('stopPlanRotationMonitor()')).toBeLessThan(close.indexOf('origClose'))
  })
})
