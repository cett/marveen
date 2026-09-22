import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const {
  getActiveBlackboardAgentIdsMock, getAgentTierMock, markBlackboardStaleMock, sweepStaleActivePlansMock,
  getEffectiveSettingValueMock,
} = vi.hoisted(() => ({
  getActiveBlackboardAgentIdsMock: vi.fn(),
  getAgentTierMock: vi.fn(),
  markBlackboardStaleMock: vi.fn(),
  sweepStaleActivePlansMock: vi.fn(),
  getEffectiveSettingValueMock: vi.fn(),
}))

vi.mock('../db.js', () => ({
  getActiveBlackboardAgentIds: getActiveBlackboardAgentIdsMock,
  getAgentTier: getAgentTierMock,
  markBlackboardStale: markBlackboardStaleMock,
  sweepStaleActivePlans: sweepStaleActivePlansMock,
}))
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: getEffectiveSettingValueMock }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

import { startBlackboardStaleSweeper, TIER_CONFIG_KEY } from '../web/blackboard-stale-sweeper.js'

const SETTINGS: Record<string, number> = {
  BB_STALE_ORCHESTRATOR_MIN: 120,
  BB_STALE_INTERACTIVE_MIN: 60,
  'BB_STALE_SHORT_RUNNING_MIN': 15,
  BB_STALE_DEFAULT_MIN: 30,
  BB_STALE_ASSIGNED_MIN: 45,
  PLAN_STALE_MIN: 90,
}

beforeEach(() => {
  vi.useFakeTimers()
  getActiveBlackboardAgentIdsMock.mockReset().mockReturnValue([])
  getAgentTierMock.mockReset().mockReturnValue('default')
  markBlackboardStaleMock.mockReset().mockReturnValue(0)
  sweepStaleActivePlansMock.mockReset().mockReturnValue(0)
  getEffectiveSettingValueMock.mockReset().mockImplementation((key: string) => SETTINGS[key] ?? 0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TIER_CONFIG_KEY', () => {
  it('maps every known tier to its own settings key', () => {
    expect(TIER_CONFIG_KEY['orchestrator']).toBe('BB_STALE_ORCHESTRATOR_MIN')
    expect(TIER_CONFIG_KEY['interactive']).toBe('BB_STALE_INTERACTIVE_MIN')
    expect(TIER_CONFIG_KEY['short-running']).toBe('BB_STALE_SHORT_RUNNING_MIN')
    expect(TIER_CONFIG_KEY['default']).toBe('BB_STALE_DEFAULT_MIN')
  })
})

describe('startBlackboardStaleSweeper', () => {
  it('does nothing until the first interval tick', () => {
    startBlackboardStaleSweeper()
    expect(getActiveBlackboardAgentIdsMock).not.toHaveBeenCalled()
  })

  it('resolves a per-tier threshold (in seconds) for every active agent and calls markBlackboardStale', async () => {
    getActiveBlackboardAgentIdsMock.mockReturnValue(['agent-a', 'agent-b'])
    getAgentTierMock.mockImplementation((id: string) => (id === 'agent-a' ? 'orchestrator' : 'default'))
    const handle = startBlackboardStaleSweeper()
    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(markBlackboardStaleMock).toHaveBeenCalledWith(
      { 'agent-a': 120 * 60, 'agent-b': 30 * 60 },
      30 * 60,
      45 * 60,
    )
    clearInterval(handle)
  })

  it('falls back to the default threshold key for an unknown tier', async () => {
    getActiveBlackboardAgentIdsMock.mockReturnValue(['agent-x'])
    getAgentTierMock.mockReturnValue('some-unmapped-tier')
    const handle = startBlackboardStaleSweeper()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(markBlackboardStaleMock).toHaveBeenCalledWith({ 'agent-x': 30 * 60 }, 30 * 60, 45 * 60)
    clearInterval(handle)
  })

  it('sweeps stale active-plan bindings on every tick using PLAN_STALE_MIN', async () => {
    const handle = startBlackboardStaleSweeper()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(sweepStaleActivePlansMock).toHaveBeenCalledWith(90)
    clearInterval(handle)
  })

  it('runs again on the next interval tick', async () => {
    const handle = startBlackboardStaleSweeper()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(sweepStaleActivePlansMock).toHaveBeenCalledTimes(2)
    clearInterval(handle)
  })

  it('does not let a thrown error from the DB layer kill the interval', async () => {
    getActiveBlackboardAgentIdsMock.mockImplementationOnce(() => { throw new Error('db down') })
    const handle = startBlackboardStaleSweeper()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    // Second tick recovers and runs normally.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(sweepStaleActivePlansMock).toHaveBeenCalledTimes(1)
    clearInterval(handle)
  })
})
