// The db context carrier (runAs / currentDbContext) and the counting of facade calls without a context.
// The first group pins the AsyncLocalStorage traps the Phase 1 waves rely on.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase, dbx, runAs, currentDbContext, getDbContextStats, resetDbContextStats } from '../db.js'
import { logger } from '../logger.js'
import { useTestDb } from './helpers/with-test-db.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

useTestDb()

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runAs', () => {
  it('sets the context for system, tenant and agent and returns what the function returns', () => {
    expect(runAs.system('heartbeat', () => currentDbContext())).toEqual({ role: 'system', name: 'heartbeat' })
    expect(runAs.tenant('acme', () => currentDbContext())).toEqual({ role: 'tenant', tenantId: 'acme' })
    expect(runAs.agent('zack', 'acme', () => currentDbContext())).toEqual({ role: 'agent', agentId: 'zack', tenantId: 'acme' })
    expect(runAs.system('x', () => 42)).toBe(42)
    expect(currentDbContext()).toBeUndefined()
  })

  it('works with an async function and returns its promise', async () => {
    const out = await runAs.tenant('acme', async () => {
      await sleep(1)
      return currentDbContext()?.tenantId
    })
    expect(out).toBe('acme')
  })

  it('refuses an empty id', () => {
    expect(() => runAs.system('', () => 1)).toThrow(TypeError)
    expect(() => runAs.tenant('', () => 1)).toThrow(TypeError)
    expect(() => runAs.agent('zack', '', () => 1)).toThrow(TypeError)
    expect(() => runAs.agent('', 'acme', () => 1)).toThrow(TypeError)
  })
})

describe('AsyncLocalStorage traps', () => {
  // (1) follows await and a setTimeout created inside
  it('follows await and a setTimeout created inside runAs', async () => {
    const seen = await runAs.tenant('acme', async () => {
      const afterAwait = (await Promise.resolve(currentDbContext()))?.tenantId
      await sleep(2)
      const afterSleep = currentDbContext()?.tenantId
      const inTimer = await new Promise<string | undefined>((resolve) => {
        setTimeout(() => resolve(currentDbContext()?.tenantId), 2)
      })
      return { afterAwait, afterSleep, inTimer }
    })
    expect(seen).toEqual({ afterAwait: 'acme', afterSleep: 'acme', inTimer: 'acme' })
  })

  // (2) does not reach an interval created before runAs
  it('does NOT reach a setInterval created before runAs: the tick must open its own runAs', async () => {
    const ticks: Array<string | undefined> = []
    const interval = setInterval(() => { ticks.push(currentDbContext()?.name) }, 5)
    try {
      await runAs.system('outer-job', async () => {
        expect(currentDbContext()?.name).toBe('outer-job')
        await sleep(30)
      })
    } finally {
      clearInterval(interval)
    }
    expect(ticks.length).toBeGreaterThan(0)
    // The tick ran while runAs was active elsewhere, and still saw no context.
    expect(ticks.every((t) => t === undefined)).toBe(true)
  })

  it('an interval created INSIDE runAs keeps that context, and a tick can open its own', async () => {
    const seen: Array<string | undefined> = []
    let interval!: NodeJS.Timeout
    runAs.system('creator', () => {
      interval = setInterval(() => {
        seen.push(currentDbContext()?.name)
        runAs.system('tick', () => { seen.push(currentDbContext()?.name) })
      }, 5)
    })
    await sleep(20)
    clearInterval(interval)
    expect(seen).toContain('creator')
    expect(seen).toContain('tick')
    expect(currentDbContext()).toBeUndefined()
  })

  // (3) nested runAs overrides and restores
  it('a nested runAs replaces the context and the outer one is back on exit', async () => {
    const trail: Array<string | undefined> = []
    await runAs.tenant('outer', async () => {
      trail.push(currentDbContext()?.tenantId)
      await runAs.tenant('inner', async () => {
        await sleep(1)
        trail.push(currentDbContext()?.tenantId)
      })
      trail.push(currentDbContext()?.tenantId)
    })
    trail.push(currentDbContext()?.tenantId)
    expect(trail).toEqual(['outer', 'inner', 'outer', undefined])
  })

  it('two concurrent runAs do not see each other', async () => {
    const [a, b] = await Promise.all([
      runAs.tenant('a', async () => { await sleep(5); return currentDbContext()?.tenantId }),
      runAs.tenant('b', async () => { await sleep(1); return currentDbContext()?.tenantId }),
    ])
    expect([a, b]).toEqual(['a', 'b'])
  })

  // (4) independent of the transaction scope
  it('the context and the transaction scope are independent of each other', async () => {
    await dbx.exec('CREATE TABLE ctx_t (name TEXT)')
    await runAs.tenant('acme', async () => {
      await dbx.tx(async (tx) => {
        expect(currentDbContext()?.tenantId).toBe('acme')
        await runAs.system('inside-tx', async () => {
          expect(currentDbContext()?.role).toBe('system')
          // still inside the transaction: this statement must not wait for the lock held by its own transaction
          await tx.run('INSERT INTO ctx_t (name) VALUES (?)', 'a')
          await dbx.run('INSERT INTO ctx_t (name) VALUES (?)', 'b')
        })
        expect(currentDbContext()?.tenantId).toBe('acme')
      })
      expect(currentDbContext()?.tenantId).toBe('acme')
    })
    expect((await dbx.all('SELECT name FROM ctx_t')).length).toBe(2)
  })
})

describe('calls without a context', () => {
  it('counts every facade call and the ones without a context', async () => {
    await dbx.exec('CREATE TABLE ctx_t (name TEXT)')
    await runAs.system('job', async () => {
      await dbx.run('INSERT INTO ctx_t (name) VALUES (?)', 'a')
      await dbx.get('SELECT * FROM ctx_t')
    })
    await dbx.all('SELECT * FROM ctx_t')
    await dbx.tx(async (tx) => { await tx.get('SELECT 1') })
    const stats = getDbContextStats()
    // exec, run, get, all, tx, tx.get
    expect(stats.total).toBe(6)
    // exec, all, tx, tx.get carry no context
    expect(stats.withoutContext).toBe(4)
  })

  it('warns with the call site, at most once per interval, and does not refuse the call', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const ctxWarnings = () => warn.mock.calls.filter((c) => String(c[1] ?? '').includes('without a db context'))

    expect(await dbx.get('SELECT 1 AS one')).toEqual({ one: 1 })
    await dbx.get('SELECT 2 AS two')
    await dbx.get('SELECT 3 AS three')
    expect(ctxWarnings().length).toBe(1)
    const meta = ctxWarnings()[0][0] as { callSite: string }
    expect(meta.callSite).toContain('db-context.test')
    expect(getDbContextStats().lastCallSite).toContain('db-context.test')

    vi.setSystemTime(new Date('2026-01-01T00:00:59Z'))
    await dbx.get('SELECT 4')
    expect(ctxWarnings().length).toBe(1)

    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
    await dbx.get('SELECT 5')
    expect(ctxWarnings().length).toBe(2)
  })

  it('stays quiet and counts nothing as missing when a context is set', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    await runAs.system('job', async () => { await dbx.get('SELECT 1') })
    expect(getDbContextStats()).toMatchObject({ total: 1, withoutContext: 0 })
    expect(warn.mock.calls.filter((c) => String(c[1] ?? '').includes('without a db context'))).toEqual([])
  })
})
