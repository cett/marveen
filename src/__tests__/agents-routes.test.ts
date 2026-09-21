// Route-level tests for agents.ts dispatcher (#751 step 22).
// Before this file, the tryHandleAgents dispatcher had zero route-level tests.
// This file covers the dispatcher logic and re-exports.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// Mock the handler modules
const tryHandleAgentsModels = vi.fn()
const tryHandleAgentsChannels = vi.fn()
const tryHandleAgentsProcess = vi.fn()
const tryHandleAgentsCrud = vi.fn()

vi.mock('../web/routes/agents-models.js', () => ({
  tryHandleAgentsModels: (...args: unknown[]) => tryHandleAgentsModels(...(args as [])),
}))

vi.mock('../web/routes/agents-channels.js', () => ({
  tryHandleAgentsChannels: (...args: unknown[]) => tryHandleAgentsChannels(...(args as [])),
  validateDiscordChannelId: vi.fn().mockReturnValue(true),
  isManagedSettingsReady: vi.fn().mockReturnValue(true),
  getManagedSettingsSudoCommand: vi.fn().mockReturnValue('sudo command'),
  setAgentEnabledPlugins: vi.fn().mockResolvedValue(undefined),
  resetAgentEnabledPlugins: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../web/routes/agents-process.js', () => ({
  tryHandleAgentsProcess: (...args: unknown[]) => tryHandleAgentsProcess(...(args as [])),
}))

vi.mock('../web/routes/agents-crud.js', () => ({
  tryHandleAgentsCrud: (...args: unknown[]) => tryHandleAgentsCrud(...(args as [])),
}))

import { tryHandleAgents, validateDiscordChannelId, isManagedSettingsReady, getManagedSettingsSudoCommand, setAgentEnabledPlugins, resetAgentEnabledPlugins } from '../web/routes/agents.js'

function makeCtx(method: string = 'GET', path: string = '/api/agents'): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: {
      req, res, path: url.pathname, method, url,
      role: 'user' as any,
      tenantId: 'default',
    } as RouteContext,
    out,
  }
}

describe('agents.ts dispatcher', () => {
  beforeEach(() => {
    tryHandleAgentsModels.mockClear()
    tryHandleAgentsChannels.mockClear()
    tryHandleAgentsProcess.mockClear()
    tryHandleAgentsCrud.mockClear()
  })

  it('returns true when first handler handles the request', async () => {
    tryHandleAgentsModels.mockResolvedValue(true)
    tryHandleAgentsChannels.mockResolvedValue(false)
    tryHandleAgentsProcess.mockResolvedValue(false)
    tryHandleAgentsCrud.mockResolvedValue(false)

    const { ctx } = makeCtx()
    const result = await tryHandleAgents(ctx, '/web')

    expect(result).toBe(true)
    expect(tryHandleAgentsModels).toHaveBeenCalledWith(ctx)
    // Later handlers should not be called once first one returns true
    expect(tryHandleAgentsChannels).not.toHaveBeenCalled()
    expect(tryHandleAgentsProcess).not.toHaveBeenCalled()
    expect(tryHandleAgentsCrud).not.toHaveBeenCalled()
  })

  it('tries second handler when first returns false', async () => {
    tryHandleAgentsModels.mockResolvedValue(false)
    tryHandleAgentsChannels.mockResolvedValue(true)
    tryHandleAgentsProcess.mockResolvedValue(false)
    tryHandleAgentsCrud.mockResolvedValue(false)

    const { ctx } = makeCtx()
    const result = await tryHandleAgents(ctx, '/web')

    expect(result).toBe(true)
    expect(tryHandleAgentsModels).toHaveBeenCalledWith(ctx)
    expect(tryHandleAgentsChannels).toHaveBeenCalledWith(ctx)
    expect(tryHandleAgentsProcess).not.toHaveBeenCalled()
    expect(tryHandleAgentsCrud).not.toHaveBeenCalled()
  })

  it('tries third handler when first two return false', async () => {
    tryHandleAgentsModels.mockResolvedValue(false)
    tryHandleAgentsChannels.mockResolvedValue(false)
    tryHandleAgentsProcess.mockResolvedValue(true)
    tryHandleAgentsCrud.mockResolvedValue(false)

    const { ctx } = makeCtx()
    const result = await tryHandleAgents(ctx, '/web')

    expect(result).toBe(true)
    expect(tryHandleAgentsModels).toHaveBeenCalledWith(ctx)
    expect(tryHandleAgentsChannels).toHaveBeenCalledWith(ctx)
    expect(tryHandleAgentsProcess).toHaveBeenCalledWith(ctx)
    expect(tryHandleAgentsCrud).not.toHaveBeenCalled()
  })

  it('tries all handlers and returns false when none handle the request', async () => {
    tryHandleAgentsModels.mockResolvedValue(false)
    tryHandleAgentsChannels.mockResolvedValue(false)
    tryHandleAgentsProcess.mockResolvedValue(false)
    tryHandleAgentsCrud.mockResolvedValue(false)

    const { ctx } = makeCtx()
    const result = await tryHandleAgents(ctx, '/web')

    expect(result).toBe(false)
    expect(tryHandleAgentsModels).toHaveBeenCalledWith(ctx)
    expect(tryHandleAgentsChannels).toHaveBeenCalledWith(ctx)
    expect(tryHandleAgentsProcess).toHaveBeenCalledWith(ctx)
    expect(tryHandleAgentsCrud).toHaveBeenCalledWith(ctx, '/web')
  })

  it('passes webDir to the last handler', async () => {
    tryHandleAgentsModels.mockResolvedValue(false)
    tryHandleAgentsChannels.mockResolvedValue(false)
    tryHandleAgentsProcess.mockResolvedValue(false)
    tryHandleAgentsCrud.mockResolvedValue(true)

    const { ctx } = makeCtx()
    const webDir = '/some/web/dir'
    const result = await tryHandleAgents(ctx, webDir)

    expect(result).toBe(true)
    expect(tryHandleAgentsCrud).toHaveBeenCalledWith(ctx, webDir)
  })
})

describe('agents.ts re-exports', () => {
  it('exports validateDiscordChannelId', () => {
    expect(typeof validateDiscordChannelId).toBe('function')
  })

  it('exports isManagedSettingsReady', () => {
    expect(typeof isManagedSettingsReady).toBe('function')
  })

  it('exports getManagedSettingsSudoCommand', () => {
    expect(typeof getManagedSettingsSudoCommand).toBe('function')
  })

  it('exports setAgentEnabledPlugins', () => {
    expect(typeof setAgentEnabledPlugins).toBe('function')
  })

  it('exports resetAgentEnabledPlugins', () => {
    expect(typeof resetAgentEnabledPlugins).toBe('function')
  })
})
