// autonomy_categories moved from store/autonomy-config.json into the
// autonomy_categories DB table (API-only reads, no file-cache). This test
// mocks '../../db.js' with an in-memory row map instead of writing a JSON
// side-car file, mirroring the route's actual read/write surface
// (listAutonomyCategories/getAutonomyCategory/setAutonomyCategoryLevel).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

interface Row {
  key: string
  label: string
  level: number
  locked: number
  max_level: number
  timeout_minutes: number | null
  updated_at: number
  updated_by: string
}

let rows: Map<string, Row>

function seedRows(entries: Array<Partial<Row> & { key: string }>) {
  rows = new Map(entries.map(e => [e.key, {
    label: e.label ?? e.key,
    level: e.level ?? 1,
    locked: e.locked ?? 0,
    max_level: e.max_level ?? 3,
    timeout_minutes: e.timeout_minutes ?? null,
    updated_at: e.updated_at ?? 0,
    updated_by: e.updated_by ?? 'system',
    ...e,
  } as Row]))
}

let dbUnavailable = false

vi.mock('../db.js', () => ({
  listAutonomyCategories: () => {
    if (dbUnavailable) throw new Error('database is not available')
    return Array.from(rows.values())
  },
  getAutonomyCategory: (key: string) => rows.get(key),
  setAutonomyCategoryLevel: (key: string, level: number, updatedBy: string) => {
    const row = rows.get(key)
    if (row) { row.level = level; row.updated_by = updatedBy; row.updated_at = 12345 }
  },
}))

import { tryHandleAutonomy } from '../web/routes/autonomy.js'

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
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
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('tryHandleAutonomy', () => {
  beforeEach(() => {
    dbUnavailable = false
    seedRows([
      { key: 'deploy', label: 'Deploy', level: 1, locked: 0, max_level: 3 },
      { key: 'safety', label: 'Safety', level: 1, locked: 1, max_level: 1 },
      { key: 'limited', label: 'Limited', level: 1, locked: 0, max_level: 2 },
    ])
  })

  it('GET returns 503 internal_error when the DB is unreachable (fail-safe: no file fallback)', async () => {
    dbUnavailable = true
    const { ctx, out } = makeCtx('GET', '/api/autonomy')
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(503)
    expect((out.body as { error: string }).error).toBe('internal_error')
  })

  it('GET returns categories in the pre-migration wire shape (camelCase maxLevel, boolean locked)', async () => {
    const { ctx, out } = makeCtx('GET', '/api/autonomy')
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(200)
    const deploy = out.body.categories.find((c: any) => c.key === 'deploy')
    expect(deploy).toEqual({ key: 'deploy', label: 'Deploy', level: 1, locked: false, maxLevel: 3 })
    const safety = out.body.categories.find((c: any) => c.key === 'safety')
    expect(safety.locked).toBe(true)
  })

  it('POST returns invalid_value when level out of range', async () => {
    const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'deploy', level: 5 })
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string }).error).toBe('invalid_value')
  })

  it('POST returns not_found when category key unknown', async () => {
    const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'nonexistent', level: 2 })
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(404)
    expect((out.body as { error: string }).error).toBe('not_found')
  })

  it('POST returns forbidden when category is locked and level > 1', async () => {
    const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'safety', level: 2 })
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(403)
    expect((out.body as { error: string }).error).toBe('forbidden')
  })

  it('POST returns invalid_value with field=level when level exceeds maxLevel', async () => {
    const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'limited', level: 3 })
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string; field: string }).error).toBe('invalid_value')
    expect((out.body as { error: string; field: string }).field).toBe('level')
  })

  it('POST returns ok for valid update', async () => {
    const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'deploy', level: 2 })
    await tryHandleAutonomy(ctx)
    expect(out.status).toBe(200)
    expect((out.body as { ok: boolean }).ok).toBe(true)
    expect(rows.get('deploy')?.level).toBe(2)
  })
})
