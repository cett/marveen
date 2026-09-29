import { describe, expect, it } from 'vitest'
import {
  SCHEDULE_TICK_STALE_THRESHOLD_MS,
  computeTickStatus,
} from '../web/schedule-runner.js'

// schedule-state-ui: the dashboard's scheduler-liveness indicator
// (/api/schedules/tick-status) needs to tell "healthy, ticking normally"
// apart from "dead / never started" apart from "ticking, but running late" --
// this is the pure decision behind that classification, unit-tested
// independently of the DB read (loadLastTickMs) and the route.

describe('computeTickStatus: scheduler liveness classification', () => {
  const now = 1_700_000_000_000

  it('no stamp at all (fresh install, or migration not yet run) is stale, not healthy', () => {
    const status = computeTickStatus(null, now)
    expect(status).toEqual({ lastTickMs: null, ageSeconds: null, stale: true })
  })

  it('a stamp from moments ago is healthy', () => {
    const status = computeTickStatus(now - 5_000, now)
    expect(status.stale).toBe(false)
    expect(status.ageSeconds).toBe(5)
    expect(status.lastTickMs).toBe(now - 5_000)
  })

  it('a stamp exactly at the threshold is still healthy (boundary is exclusive)', () => {
    const status = computeTickStatus(now - SCHEDULE_TICK_STALE_THRESHOLD_MS, now)
    expect(status.stale).toBe(false)
  })

  it('a stamp one second past the threshold is stale', () => {
    const status = computeTickStatus(now - SCHEDULE_TICK_STALE_THRESHOLD_MS - 1_000, now)
    expect(status.stale).toBe(true)
  })

  it('a stamp from the future (clock skew) never yields a negative age', () => {
    const status = computeTickStatus(now + 60_000, now)
    expect(status.ageSeconds).toBe(0)
    expect(status.stale).toBe(false)
  })

  it('a custom threshold is honored', () => {
    const status = computeTickStatus(now - 90_000, now, 60_000)
    expect(status.stale).toBe(true)
  })
})
