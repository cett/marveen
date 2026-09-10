// Route-level test for src/web/routes/profiles.ts: reads the real
// templates/profiles/*.json fixtures shipped in the repo and projects them
// down to the summary shape the dashboard uses (counts, not the raw
// filesystem allow/deny lists).
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'
import { tryHandleProfiles } from '../web/routes/profiles.js'

function makeCtx(method: string, path: string): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      if (!b) return
      const str = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(str) } catch { out.body = str }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as unknown as RouteContext, out }
}

describe('GET /api/profiles', () => {
  it('lists profile templates as allow/deny counts, not raw lists', async () => {
    const { ctx, out } = makeCtx('GET', '/api/profiles')
    const handled = await tryHandleProfiles(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    const rows = out.body as any[]
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row).toHaveProperty('id')
      expect(row).toHaveProperty('label')
      expect(row).toHaveProperty('description')
      expect(row).toHaveProperty('permissionMode')
      expect(typeof row.allowCount).toBe('number')
      expect(typeof row.denyCount).toBe('number')
      expect(row).not.toHaveProperty('filesystem')
    }
  })
})

describe('other paths/methods', () => {
  it('falls through (returns false) for an unrelated path', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleProfiles(ctx)).toBe(false)
  })

  it('falls through (returns false) for a non-GET method on /api/profiles', async () => {
    const { ctx } = makeCtx('POST', '/api/profiles')
    expect(await tryHandleProfiles(ctx)).toBe(false)
  })
})
