import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const execFileMock = vi.fn()

vi.mock('node:child_process', () => ({ execFile: execFileMock }))
vi.mock('../platform.js', () => ({ resolveFromPath: () => '/usr/local/bin/claude' }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

const CONNECTED_LINE = 'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - Connected'

function mockExecFileOnce(err: (Error & { code?: number }) | null, stdout: string, stderr = ''): void {
  execFileMock.mockImplementationOnce(
    (_bin: string, _args: string[], _opts: unknown, cb: (err: unknown, out: string, errOut: string) => void) => {
      cb(err, stdout, stderr)
    },
  )
}

async function freshModule() {
  vi.resetModules()
  return import('../web/mcp-list.js')
}

describe('getMcpListCache / purgeFromMcpListCache', () => {
  it('starts empty', async () => {
    const mod = await freshModule()
    expect(mod.getMcpListCache()).toEqual({ entries: [], lastRefreshed: 0, refreshing: false })
  })

  it('purge is a no-op and returns false when the entry is absent', async () => {
    const mod = await freshModule()
    expect(mod.purgeFromMcpListCache('nope')).toBe(false)
  })

  it('purge removes a matching entry from the cache by name', async () => {
    mockExecFileOnce(null, CONNECTED_LINE)
    const mod = await freshModule()
    const cache = await mod.refreshMcpListCache()
    expect(cache.entries.length).toBe(1)
    const name = cache.entries[0]!.name
    expect(mod.purgeFromMcpListCache(name)).toBe(true)
    expect(mod.getMcpListCache().entries).toHaveLength(0)
  })
})

describe('refreshMcpListCache', () => {
  it('parses a successful `claude mcp list` run into cache entries', async () => {
    mockExecFileOnce(null, CONNECTED_LINE)
    const mod = await freshModule()
    const cache = await mod.refreshMcpListCache()
    expect(cache.refreshing).toBe(false)
    expect(cache.entries.length).toBe(1)
    expect(cache.error).toBeUndefined()
    expect(cache.lastRefreshed).toBeGreaterThan(0)
  })

  it('collapses concurrent calls into a single in-flight refresh', async () => {
    mockExecFileOnce(null, CONNECTED_LINE)
    const mod = await freshModule()
    const [a, b] = await Promise.all([mod.refreshMcpListCache(), mod.refreshMcpListCache()])
    expect(a).toBe(b)
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('retains stale entries and surfaces the error on a hard failure with no stdout', async () => {
    mockExecFileOnce(null, CONNECTED_LINE)
    const mod = await freshModule()
    await mod.refreshMcpListCache()

    const err = new Error('spawn ENOENT') as Error & { code?: number }
    mockExecFileOnce(err, '')
    const cache = await mod.refreshMcpListCache()
    expect(cache.entries.length).toBe(1) // stale entries kept
    expect(cache.error).toContain('ENOENT')
  })

  it('still parses stdout when the CLI exits non-zero but prints usable output', async () => {
    const err = new Error('exit 1') as Error & { code?: number }
    mockExecFileOnce(err, CONNECTED_LINE)
    const mod = await freshModule()
    const cache = await mod.refreshMcpListCache()
    expect(cache.entries.length).toBe(1)
  })

  it('handles a clean exit with an empty list as genuinely empty', async () => {
    mockExecFileOnce(null, '')
    const mod = await freshModule()
    const cache = await mod.refreshMcpListCache()
    expect(cache.entries).toEqual([])
    expect(cache.error).toBeUndefined()
  })

  it('recovers from execFile throwing synchronously without crashing', async () => {
    execFileMock.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const mod = await freshModule()
    const cache = await mod.refreshMcpListCache()
    expect(cache.refreshing).toBe(false)
    expect(cache.error).toContain('boom')
  })
})

describe('startMcpListChecker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('schedules a delayed refresh without throwing', async () => {
    mockExecFileOnce(null, CONNECTED_LINE)
    const mod = await freshModule()
    mod.startMcpListChecker()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(execFileMock).toHaveBeenCalled()
  })
})
