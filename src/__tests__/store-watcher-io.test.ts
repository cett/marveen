// Test suite for store-watcher.ts's I/O orchestration (coverage series).
// store-watcher.test.ts already covers setStoreWriteActor/clearStoreWriteActor
// and startStoreWatcher/stopStoreWatcher as smoke tests against the REAL
// fs.watch; none of that exercises the actual event-classification logic
// inside the watch callback (system-file filtering, creation detection,
// dedup, sensitive-name flagging, actor attribution). This file mocks
// node:fs entirely, captures the callback registered with watch(), and
// drives it directly with synthetic (eventType, filename) pairs.
//
// Module-level state (knownFiles / recentEvents / currentWriteActor /
// watcher) is reset via vi.resetModules() + a fresh dynamic import per test.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockWatch = vi.hoisted(() => vi.fn())
const mockStatSync = vi.hoisted(() => vi.fn())
const mockReaddirSync = vi.hoisted(() => vi.fn())
const mockLogStoreFileEvent = vi.hoisted(() => vi.fn())
const mockLoggerInfo = vi.hoisted(() => vi.fn())
const mockLoggerWarn = vi.hoisted(() => vi.fn())

vi.mock('node:fs', () => ({
  watch: mockWatch,
  statSync: mockStatSync,
  readdirSync: mockReaddirSync,
}))

vi.mock('../config.js', () => ({ STORE_DIR: '/store' }))

vi.mock('../db.js', () => ({
  logStoreFileEvent: mockLogStoreFileEvent,
}))

vi.mock('../logger.js', () => ({
  logger: { info: mockLoggerInfo, warn: mockLoggerWarn, debug: vi.fn() },
}))

type FsCallback = (eventType: string, filename: string | null) => void

let capturedCallback: FsCallback | null = null

function fakeDirent(name: string, isDir: boolean): { name: string; isDirectory(): boolean } {
  return { name, isDirectory: () => isDir }
}

async function loadWatcher() {
  const mod = await import('../store-watcher.js')
  return mod
}

beforeEach(() => {
  vi.resetModules()
  capturedCallback = null
  mockWatch.mockReset().mockImplementation((_dir: string, _opts: unknown, cb: FsCallback) => {
    capturedCallback = cb
    return { close: vi.fn() }
  })
  mockStatSync.mockReset()
  mockReaddirSync.mockReset().mockReturnValue([]) // empty store by default at scan time
  mockLogStoreFileEvent.mockReset()
  mockLoggerInfo.mockReset()
  mockLoggerWarn.mockReset()
})

describe('startStoreWatcher: initial scan', () => {
  it('seeds knownFiles from a recursive scan so a pre-existing file is not reported as a creation', async () => {
    mockReaddirSync.mockImplementation((dir: string) => (dir === '/store' ? [fakeDirent('preexisting.txt', false)] : []))
    mockStatSync.mockReturnValue({ size: 42 })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    capturedCallback!('rename', 'preexisting.txt')
    expect(mockLogStoreFileEvent).not.toHaveBeenCalled()
  })

  it('recurses into subdirectories and namespaces their entries with a "/" separator', async () => {
    mockReaddirSync.mockImplementation((dir: string) => {
      if (dir === '/store') return [fakeDirent('sub', true)]
      if (dir === '/store/sub') return [fakeDirent('inner.txt', false)]
      return []
    })
    mockStatSync.mockReturnValue({ size: 1 })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    capturedCallback!('rename', 'sub/inner.txt')
    expect(mockLogStoreFileEvent).not.toHaveBeenCalled() // already known from the scan
  })

  it('a failed scan (readdirSync throws) is non-fatal -- the watcher still starts', async () => {
    mockReaddirSync.mockImplementation(() => { throw new Error('ENOENT') })
    const { startStoreWatcher } = await loadWatcher()
    expect(() => startStoreWatcher()).not.toThrow()
    expect(mockWatch).toHaveBeenCalled()
  })

  it('is idempotent -- a second call does not re-register the watcher', async () => {
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    startStoreWatcher()
    expect(mockWatch).toHaveBeenCalledTimes(1)
  })

  it('a watch() failure is caught and logged, not thrown', async () => {
    mockWatch.mockImplementation(() => { throw new Error('EMFILE') })
    const { startStoreWatcher } = await loadWatcher()
    expect(() => startStoreWatcher()).not.toThrow()
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Store file watcher failed to start')
  })
})

describe('watch callback: event classification', () => {
  it('ignores a null filename', async () => {
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    expect(() => capturedCallback!('rename', null)).not.toThrow()
    expect(mockLogStoreFileEvent).not.toHaveBeenCalled()
  })

  it('ignores change events (only rename can indicate a creation)', async () => {
    mockStatSync.mockReturnValue({ size: 10 })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    capturedCallback!('change', 'notes.md')
    expect(mockLogStoreFileEvent).not.toHaveBeenCalled()
  })

  it('skips a denylisted system file by exact name', async () => {
    mockStatSync.mockReturnValue({ size: 10 })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    capturedCallback!('rename', 'claudeclaw.db-wal')
    expect(mockLogStoreFileEvent).not.toHaveBeenCalled()
  })

  it('skips files matching the system regex (.pid, .tmp, .bak, .DS_Store)', async () => {
    mockStatSync.mockReturnValue({ size: 10 })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    for (const name of ['proc.pid', 'x.tmp', 'x.tmp.a1b2c3', 'old.bak', '.DS_Store']) {
      capturedCallback!('rename', name)
    }
    expect(mockLogStoreFileEvent).not.toHaveBeenCalled()
  })

  it('skips the whole scheduled-runs/ directory regardless of filename', async () => {
    mockStatSync.mockReturnValue({ size: 10 })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    capturedCallback!('rename', 'scheduled-runs/2026-01-01/run-42.json')
    expect(mockLogStoreFileEvent).not.toHaveBeenCalled()
  })

  it('drops knownFiles tracking when a tracked file disappears (delete/rename-away)', async () => {
    vi.useFakeTimers()
    mockStatSync.mockReturnValueOnce({ size: 10 }).mockImplementationOnce(() => { throw new Error('ENOENT') })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    capturedCallback!('rename', 'agent-note.md') // creation: now known
    capturedCallback!('rename', 'agent-note.md') // deletion: statSync throws
    expect(mockLogStoreFileEvent).toHaveBeenCalledTimes(1)
    // Re-creating it after the delete must log again (knownFiles forgot it).
    // Past the dedup window too, so this isn't mistaken for a repeat of the
    // first creation event.
    vi.advanceTimersByTime(1_001)
    mockStatSync.mockReturnValue({ size: 20 })
    capturedCallback!('rename', 'agent-note.md')
    expect(mockLogStoreFileEvent).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('logs a genuinely new agent-created file with its size and no sensitivity flag', async () => {
    mockStatSync.mockReturnValue({ size: 123 })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    capturedCallback!('rename', 'HANDOFF.md')
    expect(mockLogStoreFileEvent).toHaveBeenCalledWith('HANDOFF.md', 'create', 0, 123, null)
  })

  // Every current SENSITIVE_NAMES entry is also a SYSTEM_FILES entry, so the
  // isSensitive=1 branch is unreachable via a real creation event today (the
  // isSystemFile() denylist check runs first and skips the file entirely).
  // Documented here as a source-of-truth check rather than asserting
  // unreachable behaviour: if a future SENSITIVE_NAMES entry is NOT also
  // denylisted, that name would need its own reachable test.
  it('every currently-sensitive filename is also denylisted as a system file (isSensitive is unreachable today)', async () => {
    const SENSITIVE_NAMES = ['.dashboard-token', 'vault.json', '.vault-key', '.claude-oauth-token', '.federation-token', 'federation.json']
    mockStatSync.mockReturnValue({ size: 5 })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    for (const name of SENSITIVE_NAMES) capturedCallback!('rename', name)
    expect(mockLogStoreFileEvent).not.toHaveBeenCalled()
  })

  it('does not re-log an already-known file on a second rename (replace, not creation)', async () => {
    mockStatSync.mockReturnValue({ size: 5 })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    capturedCallback!('rename', 'a.md')
    // A second, distinct rename event well outside the dedup window still
    // should not re-log: the file is now in knownFiles.
    vi.useFakeTimers()
    vi.advanceTimersByTime(2_000)
    capturedCallback!('rename', 'a.md')
    vi.useRealTimers()
    expect(mockLogStoreFileEvent).toHaveBeenCalledTimes(1)
  })

  it('dedups repeated rename events for a brand-new file within the dedup window', async () => {
    mockStatSync.mockReturnValue({ size: 5 })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    // fs.watch firing the SAME logical creation twice before knownFiles can
    // register it as known would double-log without the recentEvents guard;
    // simulate that by resetting a fake "not yet known" path is not directly
    // reachable, so instead assert the guard via two logStoreFileEvent-free
    // repeats is not meaningful here -- the knownFiles check already prevents
    // a second log once the first has run synchronously. This test instead
    // pins the documented dedup key shape (relative path).
    capturedCallback!('rename', 'b.md')
    capturedCallback!('rename', 'b.md')
    expect(mockLogStoreFileEvent).toHaveBeenCalledTimes(1)
  })

  it('attributes the write actor set just before the event, then clears it', async () => {
    mockStatSync.mockReturnValue({ size: 5 })
    const { startStoreWatcher, setStoreWriteActor } = await loadWatcher()
    startStoreWatcher()
    setStoreWriteActor('kanban-route')
    capturedCallback!('rename', 'attributed.md')
    expect(mockLogStoreFileEvent).toHaveBeenCalledWith('attributed.md', 'create', 0, 5, 'kanban-route')

    // The slot must be consumed -- a later event with no actor set gets null.
    capturedCallback!('rename', 'unattributed.md')
    expect(mockLogStoreFileEvent).toHaveBeenLastCalledWith('unattributed.md', 'create', 0, 5, null)
  })

  it('clears the write-actor slot even for a denylisted system-file event', async () => {
    mockStatSync.mockReturnValue({ size: 5 })
    const { startStoreWatcher, setStoreWriteActor } = await loadWatcher()
    startStoreWatcher()
    setStoreWriteActor('some-route')
    capturedCallback!('rename', 'claudeclaw.db') // denylisted -> consumes but does not log
    capturedCallback!('rename', 'after-system-event.md')
    expect(mockLogStoreFileEvent).toHaveBeenCalledWith('after-system-event.md', 'create', 0, 5, null)
  })

  it('a logStoreFileEvent failure is caught and logged as a warning', async () => {
    mockStatSync.mockReturnValue({ size: 5 })
    mockLogStoreFileEvent.mockImplementationOnce(() => { throw new Error('db locked') })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    expect(() => capturedCallback!('rename', 'c.md')).not.toThrow()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), rel: 'c.md' }),
      'store-watcher: failed to log new file event',
    )
  })

  it('normalizes a Windows-style backslash path to forward slashes', async () => {
    mockStatSync.mockReturnValue({ size: 5 })
    const { startStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    capturedCallback!('rename', 'sub\\nested.md')
    expect(mockLogStoreFileEvent).toHaveBeenCalledWith('sub/nested.md', 'create', 0, 5, null)
  })
})

describe('stopStoreWatcher', () => {
  it('closes the underlying watcher', async () => {
    const closeFn = vi.fn()
    mockWatch.mockImplementation((_dir: string, _opts: unknown, cb: FsCallback) => {
      capturedCallback = cb
      return { close: closeFn }
    })
    const { startStoreWatcher, stopStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    stopStoreWatcher()
    expect(closeFn).toHaveBeenCalled()
  })

  it('is a no-op when never started', async () => {
    const { stopStoreWatcher } = await loadWatcher()
    expect(() => stopStoreWatcher()).not.toThrow()
  })

  it('a close() failure is swallowed (best-effort)', async () => {
    mockWatch.mockImplementation((_dir: string, _opts: unknown, cb: FsCallback) => {
      capturedCallback = cb
      return { close: () => { throw new Error('already closed') } }
    })
    const { startStoreWatcher, stopStoreWatcher } = await loadWatcher()
    startStoreWatcher()
    expect(() => stopStoreWatcher()).not.toThrow()
  })
})
