import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

import { logger } from '../logger.js'
import { registerSigtermFlush, runSigtermFlushes } from '../web/sigterm-flush.js'
import { DEFAULT_GRACE_MS } from '../process-lock.js'

describe('sigterm-flush registry', () => {
  const unregister: Array<() => void> = []
  const reg = (name: string, run: () => Promise<void>): void => { unregister.push(registerSigtermFlush(name, run)) }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const off of unregister.splice(0)) off()
  })

  it('resolves at once with nothing registered', async () => {
    await expect(runSigtermFlushes(50)).resolves.toBeUndefined()
  })

  it('runs the flushes one after the other, in registration order, and waits for each', async () => {
    const log: string[] = []
    reg('first', async () => { log.push('first:start'); await new Promise((r) => setTimeout(r, 15)); log.push('first:end') })
    reg('second', () => { log.push('second:start'); log.push('second:end'); return Promise.resolve() })
    await runSigtermFlushes(1000)
    expect(log).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('a flush that throws is logged and the next one still runs; the run never rejects', async () => {
    const ran: string[] = []
    reg('bad', () => Promise.reject(new Error('flush failed')))
    reg('good', () => { ran.push('good'); return Promise.resolve() })
    await expect(runSigtermFlushes(1000)).resolves.toBeUndefined()
    expect(ran).toEqual(['good'])
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ hook: 'bad' }), 'SIGTERM flush failed')
  })

  it('a synchronous throw from a flush is handled like a rejection', async () => {
    const ran: string[] = []
    reg('sync-bad', () => { throw new Error('sync boom') })
    reg('good', () => { ran.push('good'); return Promise.resolve() })
    await expect(runSigtermFlushes(1000)).resolves.toBeUndefined()
    expect(ran).toEqual(['good'])
  })

  it('a flush that never finishes does not hold the shutdown: the run resolves at the budget and says so', async () => {
    vi.useFakeTimers()
    reg('hangs', () => new Promise<void>(() => {}))
    let done = false
    const run = runSigtermFlushes(3000).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(2999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await run
    expect(done).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith({ budgetMs: 3000 }, expect.stringContaining('did not finish within its budget'))
  })

  it('the budget is for all flushes together, not per flush', async () => {
    vi.useFakeTimers()
    const reached: string[] = []
    reg('slow-1', async () => { await new Promise((r) => setTimeout(r, 400)); reached.push('slow-1') })
    reg('slow-2', async () => { await new Promise((r) => setTimeout(r, 400)); reached.push('slow-2') })
    const run = runSigtermFlushes(500)
    await vi.advanceTimersByTimeAsync(600)
    await run
    expect(reached).toEqual(['slow-1']) // slow-2 was still running at the deadline
  })

  it('leaves no timer behind when the flushes finish in time', async () => {
    vi.useFakeTimers()
    reg('quick', async () => {})
    await runSigtermFlushes(3000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the function register returns removes the flush', async () => {
    const ran: string[] = []
    const off = registerSigtermFlush('temp', () => { ran.push('temp'); return Promise.resolve() })
    off()
    off() // a second call is harmless
    await runSigtermFlushes(100)
    expect(ran).toEqual([])
  })
})

// The reason the registry exists: with the database closed first, the desired run-state flush wrote into a closed
// handle (the old web.ts listener ran AFTER index.ts's shutdown() had closed the database), and the next start
// found the agents missing from the desired set. Both orders below run against a real database file.
describe('the flush against a database that is, or is not, closed yet', () => {
  let storeDir: string
  let dbMod: typeof import('../db.js')
  let desired: typeof import('../web/agent-desired-state.js')
  let dbFile: string

  beforeEach(async () => {
    storeDir = mkdtempSync(join(tmpdir(), 'sigterm-flush-test-'))
    process.env['MARVEEN_STORE_DIR'] = storeDir
    dbFile = join(storeDir, 'flush.db')
    vi.resetModules()
    dbMod = await import('../db.js')
    desired = await import('../web/agent-desired-state.js')
    dbMod.initDatabase(dbFile)
  })

  afterEach(() => {
    try { dbMod.closeDatabase() } catch { /* already closed */ }
    delete process.env['MARVEEN_STORE_DIR']
    rmSync(storeDir, { recursive: true, force: true })
  })

  function persistedDesired(): string[] {
    dbMod.initDatabase(dbFile) // a fresh handle on the file: what the next start would read
    return [...desired.getDesiredAgents()].sort()
  }

  it('BEFORE (the old order): the database is closed, then the flush runs -> the agent is lost', async () => {
    dbMod.closeDatabase()
    await desired.addDesiredAgent('agent-running') // what the old SIGTERM listener did after shutdown() had closed it
    expect(persistedDesired()).toEqual([])
  })

  it('AFTER (the shutdown order): the registered flush is awaited, then the database is closed -> the agent is kept', async () => {
    const sig = await import('../web/sigterm-flush.js')
    const off = sig.registerSigtermFlush('desired-run-state', () => desired.addDesiredAgent('agent-running'))
    try {
      await sig.runSigtermFlushes(3000)
      dbMod.closeDatabase()
    } finally {
      off()
    }
    expect(persistedDesired()).toEqual(['agent-running'])
  })
})

// index.ts is the process entry point (importing it boots the service), so its shutdown order is pinned in the
// source: the database closes only inside `finish`, `finish` runs only after the flushes (SIGTERM) or at once
// (anything else), and web.ts registers the flush instead of keeping a second SIGTERM listener.
describe('shutdown wiring (source pin)', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')
  const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('index.ts closes the database only inside finish(), after the awaited SIGTERM flushes', () => {
    const src = stripComments(read('../index.ts'))
    expect(src.match(/closeDatabase\(\)/g)).toHaveLength(1)
    const finishStart = src.indexOf('const finish = (): void => {')
    const closeAt = src.indexOf('closeDatabase()')
    const flushAt = src.indexOf('runSigtermFlushes(SIGTERM_FLUSH_BUDGET_MS).then(finish, finish)')
    expect(finishStart).toBeGreaterThan(-1)
    expect(closeAt).toBeGreaterThan(finishStart) // inside finish
    expect(flushAt).toBeGreaterThan(closeAt) // finish is only invoked from the flush continuation (or the else branch)
    expect(src).toMatch(/if \(signal === 'SIGTERM'\) \{[\s\S]*?runSigtermFlushes[\s\S]*?\} else \{\s*finish\(\)\s*\}/)
  })

  it('index.ts hands the signal name to shutdown(): the listener is the function itself, not a wrapper', () => {
    const src = stripComments(read('../index.ts'))
    expect(src).toContain("process.on('SIGTERM', shutdown)")
    expect(src).toMatch(/const shutdown = \(signal\?: string\): void =>/)
  })

  it('the flush budget fits inside the process-lock takeover grace and the hard-kill timer', () => {
    const src = stripComments(read('../index.ts'))
    const budget = Number(/const SIGTERM_FLUSH_BUDGET_MS = (\d+)/.exec(src)?.[1])
    const hardKill = Number(/const SHUTDOWN_HARD_KILL_MS = (\d+)/.exec(src)?.[1])
    expect(budget).toBeGreaterThan(0)
    // A replacing start SIGKILLs this process once the takeover grace has passed: the flush (then closeDatabase)
    // must be done before that, with room left for the close itself. The hard-kill timer is the outer bound.
    expect(budget).toBeLessThan(DEFAULT_GRACE_MS)
    expect(hardKill).toBeGreaterThan(budget)
  })

  it('web.ts registers the desired-state flush and keeps no SIGTERM listener of its own', () => {
    const src = stripComments(read('../web.ts'))
    expect(src).toContain("registerSigtermFlush('desired-run-state', () => runAs.system('shutdown-flush', () => flushRunningStateToDesired()))")
    expect(src).not.toMatch(/process\.(once|on)\('SIGTERM'/)
  })
})
