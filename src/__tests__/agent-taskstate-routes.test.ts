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
}))

vi.mock('../web/agent-taskstate.js', () => ({
  readTaskState: mocks.readTaskState,
  writeTaskState: mocks.writeTaskState,
  markConsumed: mocks.markConsumed,
  clearTaskState: mocks.clearTaskState,
  shouldReplayTaskState: mocks.shouldReplayTaskState,
  buildTaskStateInjection: mocks.buildTaskStateInjection,
}))

import { tryHandleAgentTaskState } from '../web/routes/agent-taskstate.js'

function makeCtx(opts: { method: string; path: string; body?: object | string }): {
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
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' } } as RouteContext,
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
      expect.any(Number)
    )
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
