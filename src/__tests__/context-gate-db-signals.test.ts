// The two db signals of a context-restart gate check: both lookups are awaited, a failed stats lookup is null (the
// gate then counts a pending outbound message: fail-closed) and a failed open-question lookup is false.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ stats: vi.fn(), question: vi.fn() }))

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, getDispatchedPendingStats: mocks.stats, hasOpenInboundQuestion: mocks.question }
})

import { readGateDbSignals } from '../web/context-restart-gate-runner.js'
import { MAIN_AGENT_ID } from '../config.js'

beforeEach(() => { mocks.stats.mockReset(); mocks.question.mockReset() })

describe('readGateDbSignals', () => {
  it('passes the settled values through, not the Promises', async () => {
    mocks.stats.mockResolvedValue({ count: 3, hasStale: true })
    mocks.question.mockResolvedValue(true)
    expect(await readGateDbSignals('agent-a', 1_000, 60_000)).toEqual({ dispatchedStats: { count: 3, hasStale: true }, openQuestion: true })
  })

  it('asks for the stats of the agent with the coordinator id and the stale cutoff', async () => {
    mocks.stats.mockResolvedValue({ count: 0, hasStale: false })
    mocks.question.mockResolvedValue(false)
    await readGateDbSignals('agent-a', 1_000, 60_000)
    expect(mocks.stats).toHaveBeenCalledWith('agent-a', 1_000, 60_000, { coordinatorAgentId: MAIN_AGENT_ID })
    expect(mocks.question).toHaveBeenCalledWith(expect.any(String), { nowMs: 1_000, staleCutoffMs: 60_000 })
  })

  it('a rejected stats lookup is null and does not hide the open question', async () => {
    mocks.stats.mockRejectedValue(new Error('db busy'))
    mocks.question.mockResolvedValue(true)
    expect(await readGateDbSignals('agent-a', 1_000, 60_000)).toEqual({ dispatchedStats: null, openQuestion: true })
  })

  it('a synchronous throw of the stats lookup is null too', async () => {
    mocks.stats.mockImplementation(() => { throw new Error('closed handle') })
    mocks.question.mockResolvedValue(false)
    expect((await readGateDbSignals('agent-a', 1_000, 60_000)).dispatchedStats).toBeNull()
  })

  it('a rejected open-question lookup is false and keeps the stats', async () => {
    mocks.stats.mockResolvedValue({ count: 1, hasStale: false })
    mocks.question.mockRejectedValue(new Error('db busy'))
    expect(await readGateDbSignals('agent-a', 1_000, 60_000)).toEqual({ dispatchedStats: { count: 1, hasStale: false }, openQuestion: false })
  })
})
