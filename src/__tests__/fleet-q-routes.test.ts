// #751: backend coverage -- src/web/routes/fleet-q.ts was at 0% (lowest
// statement count among sensibly-unit-testable route modules at the time).
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => ({
  listAgentNames: vi.fn(),
  readAgentCapabilities: vi.fn(),
  writeAgentCapabilities: vi.fn(),
  isKnownAgent: vi.fn(),
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: mocks.listAgentNames,
  readAgentCapabilities: mocks.readAgentCapabilities,
  writeAgentCapabilities: mocks.writeAgentCapabilities,
  isKnownAgent: mocks.isKnownAgent,
}))

import { tryHandleFleetQ } from '../web/routes/fleet-q.js'

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

describe('tryHandleFleetQ -- GET /.well-known/fleetq', () => {
  it('builds the manifest from listAgentNames + readAgentCapabilities per agent', async () => {
    mocks.listAgentNames.mockReturnValueOnce(['zack', 'boo'])
    mocks.readAgentCapabilities.mockImplementation((name: string) =>
      name === 'zack' ? ['backend', 'ci'] : ['qa']
    )
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/.well-known/fleetq' })
    const handled = await tryHandleFleetQ(ctx)
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(body()).toEqual({ zack: ['backend', 'ci'], boo: ['qa'] })
  })

  it('returns an empty manifest when there are no agents', async () => {
    mocks.listAgentNames.mockReturnValueOnce([])
    const { ctx, status, body } = makeCtx({ method: 'GET', path: '/.well-known/fleetq' })
    await tryHandleFleetQ(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({})
  })
})

describe('tryHandleFleetQ -- PUT /api/agents/:name/capabilities', () => {
  it('returns 404 for an unknown agent', async () => {
    mocks.isKnownAgent.mockReturnValueOnce(false)
    const { ctx, status, body } = makeCtx({
      method: 'PUT', path: '/api/agents/ghost/capabilities', body: { capabilities: ['x'] },
    })
    const handled = await tryHandleFleetQ(ctx)
    expect(handled).toBe(true)
    expect(status()).toBe(404)
    expect((body() as any).error).toBe('not_found')
    expect(mocks.writeAgentCapabilities).not.toHaveBeenCalled()
  })

  it('returns 400 when capabilities is missing', async () => {
    mocks.isKnownAgent.mockReturnValueOnce(true)
    const { ctx, status, body } = makeCtx({
      method: 'PUT', path: '/api/agents/zack/capabilities', body: {},
    })
    await tryHandleFleetQ(ctx)
    expect(status()).toBe(400)
    expect((body() as any).error).toBe('required')
    expect((body() as any).field).toBe('capabilities')
  })

  it('returns 400 when capabilities contains a non-string entry', async () => {
    mocks.isKnownAgent.mockReturnValueOnce(true)
    const { ctx, status } = makeCtx({
      method: 'PUT', path: '/api/agents/zack/capabilities', body: { capabilities: ['ok', 42] },
    })
    await tryHandleFleetQ(ctx)
    expect(status()).toBe(400)
    expect(mocks.writeAgentCapabilities).not.toHaveBeenCalled()
  })

  it('writes the new capabilities and echoes them back on success', async () => {
    mocks.isKnownAgent.mockReturnValueOnce(true)
    const { ctx, status, body } = makeCtx({
      method: 'PUT', path: '/api/agents/zack/capabilities', body: { capabilities: ['backend', 'ci'] },
    })
    await tryHandleFleetQ(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: true, capabilities: ['backend', 'ci'] })
    expect(mocks.writeAgentCapabilities).toHaveBeenCalledWith('zack', ['backend', 'ci'])
  })

  it('URL-decodes the agent name from the path', async () => {
    mocks.isKnownAgent.mockReturnValueOnce(true)
    const { ctx } = makeCtx({
      method: 'PUT', path: '/api/agents/agent%20name/capabilities', body: { capabilities: [] },
    })
    await tryHandleFleetQ(ctx)
    expect(mocks.isKnownAgent).toHaveBeenCalledWith('agent name')
    expect(mocks.writeAgentCapabilities).toHaveBeenCalledWith('agent name', [])
  })
})

describe('tryHandleFleetQ -- unmatched routes', () => {
  it('returns false for an unrelated path', async () => {
    const { ctx } = makeCtx({ method: 'GET', path: '/api/other' })
    expect(await tryHandleFleetQ(ctx)).toBe(false)
  })

  it('returns false for the fleetq path with the wrong method', async () => {
    const { ctx } = makeCtx({ method: 'POST', path: '/.well-known/fleetq' })
    expect(await tryHandleFleetQ(ctx)).toBe(false)
  })

  it('returns false for the capabilities path with the wrong method', async () => {
    const { ctx } = makeCtx({ method: 'GET', path: '/api/agents/zack/capabilities' })
    expect(await tryHandleFleetQ(ctx)).toBe(false)
  })
})
