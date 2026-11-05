// The request/message trace carried in the db context (withTrace / currentTrace) and the ALS traps around it.
// The trace is what lets a writer deep in a call say which request it belongs to without a parameter.

import { describe, it, expect, afterEach } from 'vitest'
import { runAs, withTrace, currentTrace, currentDbContext, withDbContext } from '../db/context.js'
import { runAsRequest, systemJob, runAsAgentJob, setAgentTenantResolver, resetAgentTenantResolver } from '../db/background-jobs.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const T1 = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }
const T2 = { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) }

describe('withTrace', () => {
  it('adds the trace to the running context and keeps who is running', () => {
    const ctx = runAs.tenant('tenant-a', () => withTrace(T1, () => currentDbContext()))
    expect(ctx).toEqual({ role: 'tenant', tenantId: 'tenant-a', traceId: T1.traceId, spanId: T1.spanId })
    expect(runAs.system('job-a', () => withTrace(T1, () => currentTrace()))).toEqual(T1)
  })

  it('leaves the outer context without a trace when it returns', () => {
    runAs.system('job-a', () => {
      withTrace(T1, () => undefined)
      expect(currentTrace()).toBeUndefined()
      expect(currentDbContext()).toEqual({ role: 'system', name: 'job-a' })
    })
  })

  it('follows await and a timer created inside it', async () => {
    const seen = await runAs.system('job-a', () => withTrace(T1, async () => {
      await sleep(1)
      const viaTimer = await new Promise<unknown>((r) => setTimeout(() => r(currentTrace()), 1))
      return { afterAwait: currentTrace(), viaTimer }
    }))
    expect(seen).toEqual({ afterAwait: T1, viaTimer: T1 })
  })

  it('runs the function untouched when there is no context: a trace alone must not make a call look scoped', () => {
    expect(withTrace(T1, () => currentDbContext())).toBeUndefined()
    expect(withTrace(T1, () => currentTrace())).toBeUndefined()
    expect(withTrace(T1, () => 42)).toBe(42)
  })

  it('refuses an empty id', () => {
    runAs.system('job-a', () => {
      expect(() => withTrace({ traceId: '', spanId: 'x' }, () => 1)).toThrow(TypeError)
      expect(() => withTrace({ traceId: 'x', spanId: '' }, () => 1)).toThrow(TypeError)
    })
  })

  it('a nested trace replaces the outer one and the outer one is back after it', () => {
    runAs.system('job-a', () => withTrace(T1, () => {
      withTrace(T2, () => expect(currentTrace()).toEqual(T2))
      expect(currentTrace()).toEqual(T1)
    }))
  })

  it('a nested runAs replaces the identity and KEEPS the trace, for every runAs variant; the outer context is back after it', async () => {
    await runAs.system('job-a', () => withTrace(T1, async () => {
      expect(runAs.system('job-b', () => currentDbContext())).toEqual({ role: 'system', name: 'job-b', ...T1 })
      expect(runAs.tenant('tenant-a', () => currentDbContext())).toEqual({ role: 'tenant', tenantId: 'tenant-a', ...T1 })
      expect(runAs.agent('agent-a', 'tenant-a', () => currentDbContext())).toEqual({ role: 'agent', agentId: 'agent-a', tenantId: 'tenant-a', ...T1 })
      // also across an await inside the nested run
      expect(await runAs.system('job-b', async () => { await sleep(1); return currentTrace() })).toEqual(T1)
      expect(currentDbContext()).toEqual({ role: 'system', name: 'job-a', ...T1 })
    }))
  })

  it('a nested runAs inside a run WITHOUT a trace has none, and a nested withTrace still overrides the inherited one', () => {
    runAs.system('job-a', () => runAs.system('job-b', () => expect(currentTrace()).toBeUndefined()))
    runAs.system('job-a', () => withTrace(T1, () => runAs.system('job-b', () => withTrace(T2, () => expect(currentTrace()).toEqual(T2)))))
  })

  it('a runAs opened outside any context (a timer, a close handler) gets no trace from the request that created it', async () => {
    const seen: unknown[] = []
    const timer = setTimeout(() => runAs.system('job-b', () => seen.push(currentTrace())), 5)
    await runAs.system('job-a', () => withTrace(T1, () => sleep(1)))
    await sleep(15)
    clearTimeout(timer)
    expect(seen).toEqual([undefined])
  })
})

describe('ALS traps for the trace', () => {
  it('a timer created BEFORE the traced run does not get the trace (it keeps the context of where it was created)', async () => {
    let fired: unknown = 'not-fired'
    const timer = setTimeout(() => { fired = currentTrace() }, 5)
    await runAs.system('job-a', () => withTrace(T1, () => sleep(1)))
    await sleep(15)
    clearTimeout(timer)
    expect(fired).toBeUndefined()
  })

  it('a close-style callback registered inside the run does not carry the context; withDbContext restores it with the trace', async () => {
    const { EventEmitter } = await import('node:events')
    const emitter = new EventEmitter()
    const bare: unknown[] = []
    const restored: unknown[] = []
    runAs.system('job-a', () => withTrace(T1, () => {
      const captured = currentDbContext()
      emitter.once('close', () => bare.push(currentTrace()))
      emitter.once('end', () => withDbContext(captured, () => restored.push(currentTrace())))
    }))
    emitter.emit('close')
    emitter.emit('end')
    expect(bare).toEqual([undefined])
    expect(restored).toEqual([T1])
  })

  it('two overlapping traced runs keep their own trace across awaits', async () => {
    const run = (trace: typeof T1, ms: number) => runAs.system('job-a', () => withTrace(trace, async () => {
      await sleep(ms)
      return currentTrace()
    }))
    const [a, b] = await Promise.all([run(T1, 10), run(T2, 1)])
    expect(a).toEqual(T1)
    expect(b).toEqual(T2)
  })
})

describe('runAsRequest with a trace', () => {
  const who = [
    ['an anonymous caller', { authenticated: false, role: undefined, tenantId: 'tenant-a' }],
    ['an agent token', { authenticated: true, role: 'fleet_agent', agentId: 'agent-a', tenantId: 'tenant-a' }],
    ['a tenant caller', { authenticated: true, role: 'viewer', tenantId: 'tenant-a' }],
    ['a global admin', { authenticated: true, role: 'admin', tenantId: null }],
    ['a global viewer', { authenticated: true, role: 'viewer', tenantId: null }],
  ] as const

  it.each(who)('puts the trace in the context of %s without changing who it is', (_name, principal) => {
    const plain = runAsRequest({ ...principal }, () => currentDbContext())
    const traced = runAsRequest({ ...principal, trace: T1 }, () => currentDbContext())
    expect(traced).toEqual({ ...plain, traceId: T1.traceId, spanId: T1.spanId })
    expect(plain?.traceId).toBeUndefined()
  })

  it('carries the trace into the awaited work of the route', async () => {
    const seen = await runAsRequest({ authenticated: true, role: 'admin', tenantId: null, trace: T1 }, async () => {
      await sleep(1)
      return currentTrace()
    })
    expect(seen).toEqual(T1)
  })
})

// A timer created inside a request keeps that request's context, trace included. A background job that such a timer
// starts is not part of the request, so its openers (systemJob, runAsAgentJob and the tenant lookup it makes) open a
// context with no trace, while a runAs a route calls itself still keeps the request's trace.
describe('background-job openers do not inherit the trace of the request that created their timer', () => {
  const waitFor = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !cond(); i++) await sleep(5)
  }
  afterEach(() => { resetAgentTenantResolver() })

  it('setInterval and setTimeout created inside a request: the ticks of systemJob and runAsAgentJob carry no trace', async () => {
    const seen = { raw: [] as unknown[], system: [] as unknown[], agent: [] as unknown[], lookup: [] as unknown[], timeoutSystem: [] as unknown[], timeoutAgent: [] as unknown[] }
    const ctxs = { system: undefined as unknown, agent: undefined as unknown }
    setAgentTenantResolver(async () => { seen.lookup.push(currentTrace()); return 'default' })
    const timers: Array<ReturnType<typeof setInterval>> = []
    let direct: unknown
    await runAs.tenant('tenant-a', () => withTrace(T1, async () => {
      // the premise: a bare callback of a timer created here still sees the request's trace
      timers.push(setInterval(() => { seen.raw.push(currentTrace()) }, 3))
      timers.push(setInterval(systemJob('message-router', () => { seen.system.push(currentTrace()); ctxs.system = currentDbContext() }), 3))
      timers.push(setInterval(() => {
        void runAsAgentJob('auto-restart', 'agent-a', () => { seen.agent.push(currentTrace()); ctxs.agent = currentDbContext() })
      }, 3))
      timers.push(setTimeout(systemJob('message-router', () => { seen.timeoutSystem.push(currentTrace()) }), 3))
      timers.push(setTimeout(() => { void runAsAgentJob('background-task', 'agent-a', () => { seen.timeoutAgent.push(currentTrace()) }) }, 3))
      // a runAs the route code calls itself, in the same request, keeps the trace
      direct = runAs.tenant('tenant-b', () => currentTrace())
    }))
    await waitFor(() => seen.system.length >= 3 && seen.agent.length >= 3 && seen.timeoutSystem.length >= 1 && seen.timeoutAgent.length >= 1)
    timers.forEach((t) => { clearInterval(t); clearTimeout(t) })

    expect(seen.raw.length).toBeGreaterThanOrEqual(3)
    expect(seen.raw.every((t) => JSON.stringify(t) === JSON.stringify(T1))).toBe(true)
    expect(seen.system.length).toBeGreaterThanOrEqual(3)
    expect(seen.system.every((t) => t === undefined)).toBe(true)
    expect(seen.agent.length).toBeGreaterThanOrEqual(3)
    expect(seen.agent.every((t) => t === undefined)).toBe(true)
    expect(seen.timeoutSystem).toEqual([undefined])
    expect(seen.timeoutAgent).toEqual([undefined])
    // the tenant lookup of runAsAgentJob is part of the job too
    expect(seen.lookup.length).toBeGreaterThanOrEqual(1)
    expect(seen.lookup.every((t) => t === undefined)).toBe(true)
    // who runs is unchanged, only the trace is missing
    expect(ctxs.system).toEqual({ role: 'system', name: 'message-router' })
    expect(ctxs.agent).toEqual({ role: 'agent', agentId: 'agent-a', tenantId: 'default' })
    expect(direct).toEqual(T1)
  })

  it('the explicit option is the whole mechanism: runAs with inheritTrace false drops the trace, the default keeps it, for every variant', () => {
    runAs.system('job-a', () => withTrace(T1, () => {
      expect(runAs.system('job-b', () => currentTrace(), { inheritTrace: false })).toBeUndefined()
      expect(runAs.tenant('tenant-a', () => currentTrace(), { inheritTrace: false })).toBeUndefined()
      expect(runAs.agent('agent-a', 'tenant-a', () => currentTrace(), { inheritTrace: false })).toBeUndefined()
      expect(runAs.system('job-b', () => currentTrace(), {})).toEqual(T1)
      expect(runAs.system('job-b', () => currentTrace(), { inheritTrace: true })).toEqual(T1)
    }))
  })
})
