// PUT /api/memories/:id when the DB layer refuses the text although the route's own check let it through (the two
// share isBlankContent today, so this is the case of a future divergence): BlankContentError must come back as the
// same 400 the route check answers, not as an unhandled error. updateMemory is replaced here to force that case.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { BlankContentError } from '../blank-content.js'

const { failWith } = vi.hoisted(() => ({ failWith: { error: null as Error | null } }))
vi.mock('../db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db.js')>()
  return {
    ...real,
    updateMemory: vi.fn(async () => { throw failWith.error }),
  }
})

import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

function put(id: number, body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as any
  req.method = 'PUT'
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420/api/memories/${id}`)
  return { ctx: { req, res, path: url.pathname, method: 'PUT', url, role: 'admin', tenantId: null } as unknown as RouteContext, out }
}

describe('PUT /api/memories/:id with a DB-layer refusal', () => {
  it('answers a BlankContentError from updateMemory with the 400 required, not an error', async () => {
    failWith.error = new BlankContentError('updateMemory')
    const { ctx, out } = put(1, { content: 'text the route check accepts' })
    await expect(tryHandleMemories(ctx)).resolves.toBe(true)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'required', field: 'content' })
  })

  it('control: any other error from updateMemory is not swallowed', async () => {
    failWith.error = new Error('disk gone')
    const { ctx } = put(1, { content: 'text the route check accepts' })
    await expect(tryHandleMemories(ctx)).rejects.toThrow('disk gone')
  })
})
