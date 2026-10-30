// #751 step 3: src/web/routes/agent-taskstate.ts (the HTTP wiring around the
// already-tested pure functions in agent-taskstate.ts, see agent-taskstate.test.ts)
// was at 0%.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => ({
  readTaskState: vi.fn(),
  writeTaskState: vi.fn(),
  markConsumed: vi.fn(),
  clearTaskState: vi.fn(),
  shouldReplayTaskState: vi.fn(),
  buildTaskStateInjection: vi.fn(),
  isTrustedTaskStateWriter: vi.fn(() => true),
  buildNoTaskStateNote: vi.fn((_source: string): string | null => null),
}))

vi.mock('../web/agent-taskstate.js', () => ({
  readTaskState: mocks.readTaskState,
  writeTaskState: mocks.writeTaskState,
  markConsumed: mocks.markConsumed,
  clearTaskState: mocks.clearTaskState,
  shouldReplayTaskState: mocks.shouldReplayTaskState,
  buildTaskStateInjection: mocks.buildTaskStateInjection,
  isTrustedTaskStateWriter: mocks.isTrustedTaskStateWriter,
  buildNoTaskStateNote: mocks.buildNoTaskStateNote,
}))

import { tryHandleAgentTaskState } from '../web/routes/agent-taskstate.js'

function makeCtx(opts: { method: string; path: string; body?: object | string; ctx?: Partial<RouteContext> }): {
  ctx: RouteContext; status: () => number; body: () => unknown
} {
  const raw = opts.body == null ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
  const em = new EventEmitter() as any
  em.headers = {}
  setImmediate(() => { if (raw) em.emit('data', Buffer.from(raw)); em.emit('end') })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const url = new URL(`http://localhost${opts.path}`)
  return {
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' }, ...opts.ctx } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

describe('tryHandleAgentTaskState -- GET .../replay', () => {
  it('returns the built injection text when shouldReplayTaskState says yes', () => {
    mocks.readTaskState.mockReturnValueOnce({ agent: 'zack', consumed: false })
    mocks.shouldReplayTaskState.mockReturnValueOnce(true)
    mocks.buildTaskStateInjection.mockReturnValueOnce('resume where you left off')
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/agent-taskstate/zack/replay?source=compact' })
    return tryHandleAgentTaskState(ctx).then(handled => {
      expect(handled).toBe(true)
      expect(status()).toBe(200)
      expect(body()).toEqual({ additionalContext: 'resume where you left off' })
      expect(mocks.shouldReplayTaskState).toHaveBeenCalledWith({ agent: 'zack', consumed: false }, 'compact', expect.any(Number))
    })
  })

  it('returns null when shouldReplayTaskState says no', async () => {
    mocks.readTaskState.mockReturnValueOnce(null)
    mocks.shouldReplayTaskState.mockReturnValueOnce(false)
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agent-taskstate/zack/replay' })
    await tryHandleAgentTaskState(ctx)
    expect(body()).toEqual({ additionalContext: null })
    expect(mocks.buildTaskStateInjection).not.toHaveBeenCalled()
  })

  it('defaults source to an empty string when the query param is absent', async () => {
    mocks.readTaskState.mockReturnValueOnce(null)
    mocks.shouldReplayTaskState.mockReturnValueOnce(false)
    const { ctx } = makeCtx({ method: 'GET', path: '/api/agent-taskstate/zack/replay' })
    await tryHandleAgentTaskState(ctx)
    expect(mocks.shouldReplayTaskState).toHaveBeenCalledWith(null, '', expect.any(Number))
  })
})

describe('tryHandleAgentTaskState -- replay of a record from an untrusted writer', () => {
  it('refuses it, marks it consumed, injects nothing and still hands the source to the no-state note', async () => {
    mocks.markConsumed.mockClear()
    mocks.readTaskState.mockReturnValueOnce({ agent: 'zack', consumed: false, writer: 'shared' })
    mocks.isTrustedTaskStateWriter.mockReturnValueOnce(false)
    mocks.shouldReplayTaskState.mockReturnValueOnce(false)
    mocks.buildTaskStateInjection.mockClear()
    mocks.buildNoTaskStateNote.mockClear()
    mocks.buildNoTaskStateNote.mockReturnValueOnce('note')
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agent-taskstate/zack/replay?source=compact' })
    await tryHandleAgentTaskState(ctx)
    expect(mocks.markConsumed).toHaveBeenCalledWith('zack')
    expect(mocks.buildTaskStateInjection).not.toHaveBeenCalled()
    expect(mocks.buildNoTaskStateNote).toHaveBeenCalledWith('compact')
    expect(body()).toEqual({ additionalContext: 'note' })
  })

  it('an already consumed record from an untrusted writer is not written again', async () => {
    mocks.markConsumed.mockClear()
    mocks.readTaskState.mockReturnValueOnce({ agent: 'zack', consumed: true, writer: 'shared' })
    mocks.isTrustedTaskStateWriter.mockReturnValue(false)
    mocks.shouldReplayTaskState.mockReturnValueOnce(false)
    const { ctx } = makeCtx({ method: 'GET', path: '/api/agent-taskstate/zack/replay?source=compact' })
    try {
      await tryHandleAgentTaskState(ctx)
    } finally {
      mocks.isTrustedTaskStateWriter.mockReturnValue(true)
    }
    expect(mocks.markConsumed).not.toHaveBeenCalled()
  })

  it('a trusted record is never consumed by the replay read itself', async () => {
    mocks.markConsumed.mockClear()
    mocks.readTaskState.mockReturnValueOnce({ agent: 'zack', consumed: false, writer: 'zack' })
    mocks.shouldReplayTaskState.mockReturnValueOnce(true)
    mocks.buildTaskStateInjection.mockReturnValueOnce('block')
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agent-taskstate/zack/replay?source=resume' })
    await tryHandleAgentTaskState(ctx)
    expect(mocks.markConsumed).not.toHaveBeenCalled()
    expect(body()).toEqual({ additionalContext: 'block' })
  })
})

describe('tryHandleAgentTaskState -- POST .../consume', () => {
  it('marks the record consumed and returns ok', async () => {
    const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agent-taskstate/zack/consume' })
    await tryHandleAgentTaskState(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: true })
    expect(mocks.markConsumed).toHaveBeenCalledWith('zack')
  })
})

describe('tryHandleAgentTaskState -- POST /api/agent-taskstate/:agent (write)', () => {
  it('writes the task state and echoes the record back', async () => {
    mocks.writeTaskState.mockReturnValueOnce({ agent: 'zack', nextAction: 'ship it' })
    const { ctx, status, body } = makeCtx({
      method: 'POST', path: '/api/agent-taskstate/zack',
      body: { doneSteps: ['a'], nextAction: 'ship it', summary: 'building' },
    })
    await tryHandleAgentTaskState(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: true, record: { agent: 'zack', nextAction: 'ship it' } })
    expect(mocks.writeTaskState).toHaveBeenCalledWith(
      'zack',
      expect.objectContaining({ doneSteps: ['a'], nextAction: 'ship it', summary: 'building' }),
      expect.any(Number),
      'shared', // the plain dashboard token names no agent
    )
  })

  it('the writer comes from the authenticated context, never from the body or X-Agent-Id', async () => {
    const cases: Array<[Partial<RouteContext>, string]> = [
      [{ tokenAgentId: 'zack', role: 'fleet_agent', agentId: 'zack' }, 'zack'],
      [{ tokenAgentId: 'jarvis', role: 'admin', agentId: 'jarvis' }, 'jarvis'],
      [{ auth: { kind: 'session', user: 'owner' } }, 'session:owner'],
      // the shared token with a self-declared X-Agent-Id (ctx.agentId) stays shared
      [{ agentId: 'zack' }, 'shared'],
    ]
    for (const [override, expected] of cases) {
      mocks.writeTaskState.mockClear()
      mocks.writeTaskState.mockReturnValueOnce({ agent: 'zack' })
      const { ctx } = makeCtx({
        method: 'POST', path: '/api/agent-taskstate/zack',
        body: { nextAction: 'x', writer: 'zack' },
        ctx: override,
      })
      await tryHandleAgentTaskState(ctx)
      expect(mocks.writeTaskState.mock.calls[0]?.[3], JSON.stringify(override)).toBe(expected)
    }
  })

  it('does not pass a writer key from the body through to the record fields', async () => {
    mocks.writeTaskState.mockClear()
    mocks.writeTaskState.mockReturnValueOnce({ agent: 'zack' })
    const { ctx } = makeCtx({ method: 'POST', path: '/api/agent-taskstate/zack', body: { nextAction: 'x', writer: 'jarvis' } })
    await tryHandleAgentTaskState(ctx)
    expect(mocks.writeTaskState.mock.calls[0]?.[1]).not.toHaveProperty('writer')
  })

  it('returns 400 parse_error for malformed JSON', async () => {
    const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agent-taskstate/zack', body: '{not json' })
    await tryHandleAgentTaskState(ctx)
    expect(status()).toBe(400)
    expect((body() as any).error).toBe('parse_error')
    expect(mocks.writeTaskState).not.toHaveBeenCalled()
  })
})

describe('tryHandleAgentTaskState -- GET /api/agent-taskstate/:agent (read)', () => {
  it('returns the raw stored record', async () => {
    mocks.readTaskState.mockReturnValueOnce({ agent: 'zack', summary: 'idle' })
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/agent-taskstate/zack' })
    await tryHandleAgentTaskState(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ agent: 'zack', summary: 'idle' })
  })
})

describe('tryHandleAgentTaskState -- DELETE /api/agent-taskstate/:agent (clear)', () => {
  it('clears the record and returns ok', async () => {
    const { ctx, status, body } = makeCtx({ method: 'DELETE', path: '/api/agent-taskstate/zack' })
    await tryHandleAgentTaskState(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: true })
    expect(mocks.clearTaskState).toHaveBeenCalledWith('zack')
  })
})

describe('tryHandleAgentTaskState -- unmatched routes', () => {
  it('returns false for an unrelated path', async () => {
    const { ctx } = makeCtx({ method: 'GET', path: '/api/other' })
    expect(await tryHandleAgentTaskState(ctx)).toBe(false)
  })

  it('returns false for the base path with an unsupported method', async () => {
    const { ctx } = makeCtx({ method: 'PUT', path: '/api/agent-taskstate/zack' })
    expect(await tryHandleAgentTaskState(ctx)).toBe(false)
  })
})
