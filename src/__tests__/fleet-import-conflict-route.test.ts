// The two refusals of a fleet import that cannot run now (an earlier import left a backup, another import is
// running) are conflicts: the route answers 409 for the common base class, not 500. The real error classes are used
// here (the route test beside it mocks the module), so a class that stopped extending the base would fail.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const mocks = vi.hoisted(() => ({
  importFleet: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../logger.js', () => ({ logger: mocks.logger }))
vi.mock('../web/fleet-transfer.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/fleet-transfer.js')>()),
  importFleet: mocks.importFleet,
}))

import { tryHandleFleet } from '../web/routes/fleet.js'
import { ImportConflictError, ImportInProgressError, StaleBackupError } from '../web/fleet-transfer.js'

function importCtx(): { ctx: RouteContext; status: () => number; body: () => unknown } {
  const em = new EventEmitter() as http.IncomingMessage & EventEmitter
  ;(em as unknown as { headers: Record<string, string> }).headers = {}
  setImmediate(() => { em.emit('data', Buffer.from('{}')); em.emit('end') })
  let code = 200
  let sent: string | Buffer | undefined
  const res = {
    writeHead: (c: number) => { code = c },
    setHeader: () => {},
    end: (d?: string | Buffer) => { sent = d },
  }
  const url = new URL('http://localhost/api/fleet/import?apply=true')
  return {
    ctx: { req: em, res: res as unknown as http.ServerResponse, path: url.pathname, method: 'POST', url, auth: { kind: 'token' } } as unknown as RouteContext,
    status: () => code,
    body: () => JSON.parse(String(sent)),
  }
}

describe('both refusals of a fleet import are conflicts', () => {
  it('StaleBackupError and ImportInProgressError extend ImportConflictError', () => {
    expect(new StaleBackupError('x')).toBeInstanceOf(ImportConflictError)
    expect(new ImportInProgressError('x')).toBeInstanceOf(ImportConflictError)
    expect(new StaleBackupError('x')).not.toBeInstanceOf(ImportInProgressError)
  })

  it.each([
    ['a stale backup', () => new StaleBackupError('backup /abs/path/CLAUDE.md.import-bak left by an earlier import')],
    ['an import in progress', () => new ImportInProgressError('A fleet import is already in progress')],
  ])('the route answers 409 conflict for %s, with the message as the hint, and logs no failure', async (_name, make) => {
    const error = make()
    mocks.importFleet.mockImplementationOnce(() => { throw error })
    mocks.logger.error.mockClear()
    const { ctx, status, body } = importCtx()

    await tryHandleFleet(ctx)

    expect(status()).toBe(409)
    expect(body()).toEqual({ error: 'conflict', hint: error.message })
    expect(mocks.logger.error).not.toHaveBeenCalled()
  })

  it('any other error is still a 500 internal_error', async () => {
    mocks.importFleet.mockImplementationOnce(() => { throw new Error('corrupt') })
    const { ctx, status, body } = importCtx()

    await tryHandleFleet(ctx)

    expect(status()).toBe(500)
    expect(body()).toEqual({ error: 'internal_error', hint: 'Fleet import failed' })
  })
})
