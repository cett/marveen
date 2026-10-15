import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'
import { FLEET_AGENT_ROLE, hasPermission, resolveRequiredPermission } from '../web/rbac.js'

let tmp: string

function makeCtx(method: string, path: string): { ctx: RouteContext; out: { status: number; body: Record<string, unknown> } } {
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string) { if (b) out.body = JSON.parse(b) as Record<string, unknown> },
  }
  return { ctx: { req: { method, headers: {} }, res, path, method } as unknown as RouteContext, out }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'claude-update-route-'))
  process.env['MARVEEN_STORE_DIR'] = tmp
  vi.resetModules()
})

afterEach(() => {
  delete process.env['MARVEEN_STORE_DIR']
  rmSync(tmp, { recursive: true, force: true })
})

describe('GET /api/claude-update/status', () => {
  it('serves the recorded state from the store', async () => {
    writeFileSync(join(tmp, 'claude-update.json'), JSON.stringify({
      installed: '2.1.300', latest: '2.1.310', status: 'up-to-date', checkedAt: Math.floor(Date.now() / 1000), updatedAt: 1000,
    }))
    const { tryHandleClaudeUpdate } = await import('../web/routes/claude-update.js')
    const { ctx, out } = makeCtx('GET', '/api/claude-update/status')
    expect(await tryHandleClaudeUpdate(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ installed: '2.1.300', latest: '2.1.310', behind: true, stale: false, rolloutPending: true })
  })

  it('answers an install that never ran the task with an empty, not-yet-stale state', async () => {
    const { tryHandleClaudeUpdate } = await import('../web/routes/claude-update.js')
    const { ctx, out } = makeCtx('GET', '/api/claude-update/status')
    expect(await tryHandleClaudeUpdate(ctx)).toBe(true)
    expect(out.body).toMatchObject({ installed: null, neverChecked: true, stale: false, rolloutPending: false })
  })

  it('leaves other paths and methods alone', async () => {
    const { tryHandleClaudeUpdate } = await import('../web/routes/claude-update.js')
    expect(await tryHandleClaudeUpdate(makeCtx('POST', '/api/claude-update/status').ctx)).toBe(false)
    expect(await tryHandleClaudeUpdate(makeCtx('GET', '/api/claude-update').ctx)).toBe(false)
  })
})

describe('RBAC for the status endpoint', () => {
  it('stays admin-only: no table row, so it needs admin:all, which a fleet agent token does not hold', () => {
    expect(resolveRequiredPermission('GET', '/api/claude-update/status')).toBeNull()
    expect(hasPermission(FLEET_AGENT_ROLE, 'admin:all')).toBe(false)
    expect(hasPermission('viewer', 'admin:all')).toBe(false)
    expect(hasPermission('admin', 'admin:all')).toBe(true)
  })
})
