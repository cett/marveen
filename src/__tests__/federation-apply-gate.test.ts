// POST /api/federation/apply restarts the main agent so it reloads CLAUDE.md. It is the third manual main-restart
// path and takes the same busy gate as POST /api/marveen/restart: a busy or unreadable pane answers 409 conflict, an
// explicit {"force": true} skips the gate and is logged, and the Federation page's plain '{}' body stays gated.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn().mockReturnValue({ ok: true }),
}))
vi.mock('../web/manual-restart-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/manual-restart-gate.js')>()),
  gateManualRestart: vi.fn().mockResolvedValue({ allow: true, reason: 'idle' }),
}))

import { tryHandleFederation } from '../web/routes/federation.js'
import { gateManualRestart } from '../web/manual-restart-gate.js'
import { hardRestartMarveenChannels } from '../web/channel-monitor.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'
import { logger } from '../logger.js'

async function apply(body?: string): Promise<{ status: number; json: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* noop */ }
  const out = { status: 0, body: '' }
  const res = {
    writeHead(code: number) { out.status = code; return res },
    end(data?: unknown) { out.body = String(data ?? '') },
    setHeader() { /* noop */ },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    if (body !== undefined) (req as unknown as EventEmitter).emit('data', Buffer.from(body))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/federation/apply'
  const ctx = { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null } as RouteContext
  expect(await tryHandleFederation(ctx)).toBe(true)
  let json: any = null
  try { json = JSON.parse(out.body) } catch { /* empty */ }
  return { status: out.status || 200, json }
}

describe('POST /api/federation/apply busy gate', () => {
  beforeEach(() => {
    vi.mocked(gateManualRestart).mockClear()
    vi.mocked(hardRestartMarveenChannels).mockClear()
  })

  it('an idle pane restarts the main session, gated on the main channels session', async () => {
    const r = await apply('{}')
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true })
    expect(gateManualRestart).toHaveBeenCalledWith(MAIN_CHANNELS_SESSION)
    expect(hardRestartMarveenChannels).toHaveBeenCalledTimes(1)
  })

  it('a busy pane answers 409 conflict/busy and restarts nothing', async () => {
    vi.mocked(gateManualRestart).mockResolvedValueOnce({ allow: false, reason: 'busy' })
    const r = await apply('{}')
    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ error: 'conflict', reason: 'busy' })
    expect(r.json.hint).toContain('POST /api/federation/apply')
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('an unreadable pane answers 409 conflict/no_pane and restarts nothing', async () => {
    vi.mocked(gateManualRestart).mockResolvedValueOnce({ allow: false, reason: 'no_pane' })
    const r = await apply()
    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ error: 'conflict', reason: 'no_pane' })
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('{"force": true} skips the gate, restarts, and is logged', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const r = await apply('{"force":true}')
    expect(r.status).toBe(200)
    expect(gateManualRestart).not.toHaveBeenCalled()
    expect(hardRestartMarveenChannels).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ route: '/api/federation/apply' }), expect.stringContaining('forced'))
    warn.mockRestore()
  })

  it('a failed restart after an allowed gate is still a 500', async () => {
    vi.mocked(hardRestartMarveenChannels).mockReturnValueOnce({ ok: false, error: 'tmux failed' })
    const r = await apply('{}')
    expect(r.status).toBe(500)
    expect(r.json.error).toBe('internal_error')
  })
})
