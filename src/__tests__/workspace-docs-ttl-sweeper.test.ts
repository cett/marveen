// Test suite for workspace-docs-ttl-sweeper (#751 step 24).
// The sweeper initializes a recurring interval to delete expired workspace docs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mockSweepExpiredWorkspaceDocs = vi.hoisted(() => vi.fn(() => 3))
const mockGetEffectiveSettingValue = vi.hoisted(() => vi.fn(() => 7))
const mockLoggerInfo = vi.hoisted(() => vi.fn())
const mockLoggerError = vi.hoisted(() => vi.fn())

vi.mock('../workspace-store.js', () => ({
  sweepExpiredWorkspaceDocs: mockSweepExpiredWorkspaceDocs,
}))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: mockGetEffectiveSettingValue,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: mockLoggerInfo,
    error: mockLoggerError,
  },
}))

import { startWorkspaceDocsTtlSweeper } from '../web/workspace-docs-ttl-sweeper.js'

describe('workspace-docs-ttl-sweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSweepExpiredWorkspaceDocs.mockClear()
    mockGetEffectiveSettingValue.mockClear()
    mockLoggerInfo.mockClear()
    mockLoggerError.mockClear()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  it('starts interval with 5-minute granularity', () => {
    const handle = startWorkspaceDocsTtlSweeper()
    expect(handle).toBeDefined()
  })

  it('sweeps expired docs on interval tick', () => {
    startWorkspaceDocsTtlSweeper()

    vi.advanceTimersByTime(5 * 60_000)

    expect(mockGetEffectiveSettingValue).toHaveBeenCalledWith('WORKSPACE_DOCS_TTL_DAYS')
    expect(mockSweepExpiredWorkspaceDocs).toHaveBeenCalledWith(7)
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { deleted: 3, ttlDays: 7 },
      'workspace-docs-ttl-sweeper: deleted expired docs'
    )
  })

  it('does not log info when no documents were deleted', () => {
    mockSweepExpiredWorkspaceDocs.mockReturnValueOnce(0)

    startWorkspaceDocsTtlSweeper()
    vi.advanceTimersByTime(5 * 60_000)

    expect(mockLoggerInfo).not.toHaveBeenCalled()
  })

  it('logs error when sweep fails', () => {
    const sweepError = new Error('sweep failed')
    mockSweepExpiredWorkspaceDocs.mockImplementationOnce(() => {
      throw sweepError
    })

    startWorkspaceDocsTtlSweeper()
    vi.advanceTimersByTime(5 * 60_000)

    expect(mockLoggerError).toHaveBeenCalledWith(
      { err: sweepError },
      'workspace-docs-ttl-sweeper: sweep failed'
    )
  })

  it('continues sweeping on repeated interval ticks', () => {
    mockSweepExpiredWorkspaceDocs
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(0)

    startWorkspaceDocsTtlSweeper()

    // First tick
    vi.advanceTimersByTime(5 * 60_000)
    expect(mockSweepExpiredWorkspaceDocs).toHaveBeenCalledTimes(1)
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      { deleted: 1, ttlDays: 7 },
      'workspace-docs-ttl-sweeper: deleted expired docs'
    )

    // Second tick
    vi.advanceTimersByTime(5 * 60_000)
    expect(mockSweepExpiredWorkspaceDocs).toHaveBeenCalledTimes(2)
    expect(mockLoggerInfo).toHaveBeenLastCalledWith(
      { deleted: 2, ttlDays: 7 },
      'workspace-docs-ttl-sweeper: deleted expired docs'
    )

    // Third tick (no docs deleted)
    vi.advanceTimersByTime(5 * 60_000)
    expect(mockSweepExpiredWorkspaceDocs).toHaveBeenCalledTimes(3)
    // Info should still be called exactly 2 times (the 0-doc tick doesn't log)
    expect(mockLoggerInfo).toHaveBeenCalledTimes(2)
  })

  it('uses WORKSPACE_DOCS_TTL_DAYS setting value', () => {
    mockGetEffectiveSettingValue.mockReturnValueOnce(30)

    startWorkspaceDocsTtlSweeper()
    vi.advanceTimersByTime(5 * 60_000)

    expect(mockSweepExpiredWorkspaceDocs).toHaveBeenCalledWith(30)
  })
})
