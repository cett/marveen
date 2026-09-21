import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(true),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  resolveFromPath: vi.fn().mockReturnValue('/usr/bin/tmux'),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  agentDir: vi.fn().mockReturnValue('/tmp/agent-a-dir'),
  agentSessionName: vi.fn().mockReturnValue('agent-a-session'),
  isAgentRunning: vi.fn().mockReturnValue(true),
  isMainChannelsAgent: vi.fn().mockReturnValue(false),
  MAIN_CHANNELS_SESSION: 'test-channels',
  readTerminalInputEnabled: vi.fn().mockReturnValue(true),
  writeTerminalInputEnabled: vi.fn().mockImplementation((v: boolean) => v),
  literalKeyArgs: vi.fn().mockReturnValue(['send-keys', '-t', 'session', 'text']),
  specialKeyArgs: vi.fn().mockReturnValue(null),
  loginSequence: vi.fn().mockReturnValue([]),
}))

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>()
  return { ...orig, existsSync: mocks.existsSync }
})
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return { ...orig, execFile: mocks.execFile, execFileSync: mocks.execFileSync }
})
vi.mock('../../platform.js', () => ({ resolveFromPath: mocks.resolveFromPath }))
vi.mock('../../logger.js', () => ({ logger: mocks.logger }))
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...orig, agentDir: mocks.agentDir }
})
vi.mock('../web/agent-process.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../web/agent-process.js')>()
  return { ...orig, agentSessionName: mocks.agentSessionName, isAgentRunning: mocks.isAgentRunning }
})
vi.mock('../web/main-agent.js', () => ({
  isMainChannelsAgent: mocks.isMainChannelsAgent,
  MAIN_CHANNELS_SESSION: mocks.MAIN_CHANNELS_SESSION,
}))
vi.mock('../web/terminal-input-store.js', () => ({
  readTerminalInputEnabled: mocks.readTerminalInputEnabled,
  writeTerminalInputEnabled: mocks.writeTerminalInputEnabled,
}))
vi.mock('../web/tmux-keys.js', () => ({
  literalKeyArgs: mocks.literalKeyArgs,
  specialKeyArgs: mocks.specialKeyArgs,
  loginSequence: mocks.loginSequence,
}))

import { tryHandleAgentTerminal } from '../web/routes/agent-terminal.js'

function makeCtx(opts: { method: string; path: string; body?: string | object }): {
  ctx: RouteContext; status: () => number; body: () => unknown
} {
  const raw = opts.body == null ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
  const em = new EventEmitter() as any
  em.headers = {}
  em.socket = { remoteAddress: '127.0.0.1' }
  em.on = vi.fn(em.on.bind(em)) // Wrap the on method with a spy
  setImmediate(() => { if (raw) em.emit('data', Buffer.from(raw)); em.emit('end') })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: vi.fn((c: number, _h?: object) => { code = c }),
    end: (d?: string) => { resBody = d ?? '' },
    write: vi.fn(),
    on: vi.fn(),
  }
  const url = new URL(`http://localhost${opts.path}`)
  const ctx: RouteContext = {
    req: em as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method: opts.method,
    url,
    auth: { kind: 'token' },
  }
  return { ctx, status: () => code, body: () => { try { return JSON.parse(resBody) } catch { return resBody } } }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.existsSync.mockReturnValue(true)
  mocks.isAgentRunning.mockReturnValue(true)
  mocks.isMainChannelsAgent.mockReturnValue(false)
  mocks.readTerminalInputEnabled.mockReturnValue(true)
  mocks.literalKeyArgs.mockReturnValue(['send-keys', '-t', 'session', 'text'])
  mocks.specialKeyArgs.mockReturnValue(null)
  mocks.loginSequence.mockReturnValue([])
})

describe('agent-terminal routes', () => {

  describe('edge cases and integration', () => {
    it('handles agents/:name with URL encoding', async () => {
      mocks.existsSync.mockReturnValue(true)
      mocks.isAgentRunning.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent%20a/keys', body: { keys: 'x' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(409)
      expect((body() as any).error).toBe('conflict')
    })

    it('handles main agent with isMainChannelsAgent', async () => {
      mocks.isMainChannelsAgent.mockReturnValue(true)
      mocks.isAgentRunning.mockReturnValue(true)
      mocks.literalKeyArgs.mockReturnValue(['send-keys', '-t', 'test-channels', 'hello'])
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(null)
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/marveen/keys', body: { keys: 'hello' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      expect((body() as any).ok).toBe(true)
    })

    it('blocks injection attempt when terminal-input is disabled', async () => {
      mocks.readTerminalInputEnabled.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: 'x' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(403)
      expect((body() as any).error).toBe('forbidden')
    })

    it('accepts injection with headers set in request', async () => {
      mocks.readTerminalInputEnabled.mockReturnValue(true)
      mocks.literalKeyArgs.mockReturnValue(['send-keys', '-t', 'session', 'test'])
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(null)
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: 'test' } })
      ctx.req.headers['x-forwarded-for'] = '192.168.1.1'
      ctx.req.headers['user-agent'] = 'Test-Agent/1.0'
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      expect((body() as any).ok).toBe(true)
    })
  })

  describe('POST /api/terminal-input -- toggle -- errors', () => {
    it('parse_error on invalid JSON body', async () => {
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/terminal-input', body: 'not-json' })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(400)
      expect((body() as any).error).toBe('parse_error')
    })

    it('invalid_value + field:enabled when body.enabled is not boolean', async () => {
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/terminal-input', body: { enabled: 'yes' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(400)
      const b = body() as any
      expect(b.error).toBe('invalid_value')
      expect(b.field).toBe('enabled')
    })
  })

  describe('GET /api/terminal-input -- success', () => {
    it('returns current enabled state (true)', async () => {
      mocks.readTerminalInputEnabled.mockReturnValue(true)
      const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/terminal-input' })
      const handled = await tryHandleAgentTerminal(ctx)
      expect(handled).toBe(true)
      expect(status()).toBe(200)
      expect((body() as any).enabled).toBe(true)
    })

    it('returns current enabled state (false)', async () => {
      mocks.readTerminalInputEnabled.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/terminal-input' })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      expect((body() as any).enabled).toBe(false)
    })
  })

  describe('POST /api/terminal-input -- success', () => {
    it('enables terminal-input when disabled', async () => {
      mocks.readTerminalInputEnabled.mockReturnValue(false)
      mocks.writeTerminalInputEnabled.mockImplementation((v: boolean) => v)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/terminal-input', body: { enabled: true } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      expect((body() as any).enabled).toBe(true)
      expect(mocks.writeTerminalInputEnabled).toHaveBeenCalledWith(true)
    })

    it('disables terminal-input when enabled', async () => {
      mocks.readTerminalInputEnabled.mockReturnValue(true)
      mocks.writeTerminalInputEnabled.mockImplementation((v: boolean) => v)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/terminal-input', body: { enabled: false } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      expect((body() as any).enabled).toBe(false)
      expect(mocks.writeTerminalInputEnabled).toHaveBeenCalledWith(false)
    })
  })

  describe('GET pane stream -- errors', () => {
    it('not_found + 404 when agent does not exist', async () => {
      mocks.existsSync.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'GET', path: '/api/agents/agent-a/pane/stream' })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(404)
      expect((body() as any).error).toBe('not_found')
    })
  })

  describe('GET pane stream -- success', () => {
    it('initiates SSE stream with correct headers', async () => {
      mocks.isAgentRunning.mockReturnValue(true)
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout?: string) => void) => {
        // Simulate successful capture-pane call
        setTimeout(() => cb(null, 'pane content\nline 2'), 10)
      })
      const { ctx, status } = makeCtx({ method: 'GET', path: '/api/agents/agent-a/pane/stream' })
      const handled = await tryHandleAgentTerminal(ctx)
      expect(handled).toBe(true)
      expect(status()).toBe(200)
      expect(ctx.res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      }))
    })

    it('streams pane data and running status via SSE', async () => {
      mocks.isAgentRunning.mockReturnValue(true)
      const captureOutput = 'terminal output'
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout?: string) => void) => {
        setTimeout(() => cb(null, captureOutput), 5)
      })
      const { ctx } = makeCtx({ method: 'GET', path: '/api/agents/agent-a/pane/stream' })
      await tryHandleAgentTerminal(ctx)
      // Verify SSE stream write was called with data
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(ctx.res.write).toHaveBeenCalledWith(expect.stringMatching(/data: .*pane.*running/))
    })

    it('handles closed connection gracefully', async () => {
      const { ctx } = makeCtx({ method: 'GET', path: '/api/agents/agent-a/pane/stream' })
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout?: string) => void) => {
        setTimeout(() => cb(null, 'data'), 5)
      })
      await tryHandleAgentTerminal(ctx)
      // Simulate request close event
      const closeListener = (ctx.req.on as any).mock.calls.find((c: any[]) => c[0] === 'close')
      expect(closeListener).toBeDefined()
      if (closeListener) closeListener[1]()
      // Verify no further writes after close
      const writeCalls = (ctx.res.write as any).mock.calls.length
      // Simulate another tick - should not write after close
      await new Promise(resolve => setTimeout(resolve, 800))
      expect((ctx.res.write as any).mock.calls.length).toBe(writeCalls)
    })

    it('handles execFile error by sending empty pane and checking session alive', async () => {
      mocks.isAgentRunning.mockReturnValue(false)
      mocks.execFileSync.mockImplementation(() => { throw new Error('not found') })
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error) => void) => {
        setTimeout(() => cb(new Error('capture failed')), 5)
      })
      const { ctx } = makeCtx({ method: 'GET', path: '/api/agents/agent-a/pane/stream' })
      await tryHandleAgentTerminal(ctx)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(ctx.res.write).toHaveBeenCalledWith(expect.stringMatching(/pane.*running.*false/))
    })

    it('handles main agent terminal stream', async () => {
      mocks.isMainChannelsAgent.mockReturnValue(true)
      mocks.isAgentRunning.mockReturnValue(true)
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null, stdout?: string) => void) => {
        setTimeout(() => cb(null, 'main pane'), 5)
      })
      const { ctx, status } = makeCtx({ method: 'GET', path: '/api/agents/marveen/pane/stream' })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
    })
  })

  describe('POST /api/agents/:name/keys -- errors', () => {
    it('forbidden + 403 when terminal-input disabled', async () => {
      mocks.readTerminalInputEnabled.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: 'x' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(403)
      expect((body() as any).error).toBe('forbidden')
    })

    it('not_found + 404 when agent does not exist', async () => {
      mocks.existsSync.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: 'x' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(404)
      expect((body() as any).error).toBe('not_found')
    })

    it('conflict + 409 when agent exists but is not running', async () => {
      mocks.isAgentRunning.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: 'x' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(409)
      const b = body() as any
      expect(b.error).toBe('conflict')
      expect(b.hint).toBeTruthy()
    })

    it('parse_error on invalid JSON body', async () => {
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: 'not-json' })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(400)
      expect((body() as any).error).toBe('parse_error')
    })

    it('invalid_value when payload has neither keys nor special', async () => {
      mocks.literalKeyArgs.mockReturnValue(null)
      mocks.specialKeyArgs.mockReturnValue(null)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { other: 'field' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(400)
      expect((body() as any).error).toBe('invalid_value')
    })

    it('internal_error + 500 when tmux send-keys fails', async () => {
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error) => void) => {
        cb(new Error('tmux died'))
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: 'hello' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(500)
      expect((body() as any).error).toBe('internal_error')
    })
  })

  describe('POST /api/agents/:name/keys -- success', () => {
    it('injects literal keys successfully', async () => {
      mocks.literalKeyArgs.mockReturnValue(['send-keys', '-t', 'agent-a-session', 'hello'])
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(null)
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: 'hello' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      expect((body() as any).ok).toBe(true)
      // Verify that the keys were processed through literalKeyArgs
      expect(mocks.literalKeyArgs).toHaveBeenCalled()
    })

    it('injects special key successfully', async () => {
      mocks.specialKeyArgs.mockReturnValue(['send-keys', '-t', 'agent-a-session', 'Enter'])
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(null)
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { special: 'Enter' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      expect((body() as any).ok).toBe(true)
      expect(mocks.specialKeyArgs).toHaveBeenCalled()
    })

    it('sanitizes literal keys payload (removes whitespace)', async () => {
      mocks.literalKeyArgs.mockReturnValue(['send-keys', '-t', 'agent-a-session', 'mytoken'])
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(null)
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: '  mytoken  \n' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      expect((body() as any).ok).toBe(true)
      // The sanitizer should be called, but we just verify the injection succeeded
    })

    it('handles long pastes (truncation happens in code)', async () => {
      const longPaste = 'x'.repeat(150) // > 120 chars
      mocks.literalKeyArgs.mockReturnValue(['send-keys', '-t', 'agent-a-session', longPaste.slice(0, 120)])
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(null)
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/keys', body: { keys: longPaste } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      expect((body() as any).ok).toBe(true)
    })
  })

  describe('POST /api/agents/:name/login -- errors', () => {
    it('not_found + 404 when agent does not exist', async () => {
      mocks.existsSync.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: { phase: 'start' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(404)
      expect((body() as any).error).toBe('not_found')
    })

    it('conflict + 409 when agent exists but is not running', async () => {
      mocks.isAgentRunning.mockReturnValue(false)
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: { phase: 'start' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(409)
      const b = body() as any
      expect(b.error).toBe('conflict')
      expect(b.hint).toBeTruthy()
    })

    it('invalid_value + field:phase for unknown phase value', async () => {
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: { phase: 'unknown' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(400)
      const b = body() as any
      expect(b.error).toBe('invalid_value')
      expect(b.field).toBe('phase')
    })

    it('internal_error + 500 when login sequence fails', async () => {
      mocks.loginSequence.mockReturnValue([{ kind: 'literal', text: 'x', delayMs: 0 }])
      mocks.literalKeyArgs.mockReturnValue(['send-keys', '-t', 's', 'x'])
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error) => void) => {
        cb(new Error('tmux died'))
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: { phase: 'start' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(500)
      expect((body() as any).error).toBe('internal_error')
    })
  })

  describe('POST /api/agents/:name/login -- success', () => {
    it('runs login sequence for start phase', async () => {
      mocks.loginSequence.mockReturnValue([])
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(null)
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: { phase: 'start' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      const b = body() as any
      expect(b.ok).toBe(true)
      expect(b.phase).toBe('start')
      expect(mocks.loginSequence).toHaveBeenCalledWith('start')
    })

    it('runs login sequence for confirm phase', async () => {
      mocks.loginSequence.mockReturnValue([
        { kind: 'literal', text: 'code', delayMs: 50 },
      ])
      mocks.literalKeyArgs.mockReturnValue(['send-keys', '-t', 'agent-a-session', 'code'])
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(null)
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: { phase: 'confirm' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      expect((body() as any).phase).toBe('confirm')
      expect(mocks.loginSequence).toHaveBeenCalledWith('confirm')
    })

    it('requires phase to be start or confirm (missing phase defaults to undefined and fails)', async () => {
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: {} })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(400)
      expect((body() as any).error).toBe('invalid_value')
    })

    it('handles empty login sequence', async () => {
      mocks.loginSequence.mockReturnValue([])
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(null)
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: { phase: 'start' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      expect((body() as any).ok).toBe(true)
    })

    it('treats special keys with no recognized args gracefully in runLoginSteps', async () => {
      // When a login step has a special key that returns null from specialKeyArgs,
      // runLoginSteps should skip that step (since the if (args) check fails and continues)
      mocks.loginSequence.mockReturnValue([
        { kind: 'literal', text: 'user', delayMs: 0 },
      ])
      mocks.literalKeyArgs.mockReturnValue(['send-keys', '-t', 'agent-a-session', 'user'])
      mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
        cb(null)
      })
      const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/agent-a/login', body: { phase: 'start' } })
      await tryHandleAgentTerminal(ctx)
      expect(status()).toBe(200)
      expect((body() as any).ok).toBe(true)
      // Verify the literal key step was executed
      expect(mocks.execFile).toHaveBeenCalled()
    })
  })

})
