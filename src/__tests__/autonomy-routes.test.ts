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
const auditWrites: Array<Record<string, any>> = []

vi.mock('../db.js', () => ({
  listAutonomyCategories: () => {
    if (dbUnavailable) throw new Error('database is not available')
    return Array.from(rows.values())
  },
  // A copy, like the real SELECT: the route reads the old value after the write for its audit entry.
  getAutonomyCategory: (key: string) => { const r = rows.get(key); return r ? { ...r } : undefined },
  setAutonomyCategoryLevel: (key: string, level: number, updatedBy: string) => {
    const row = rows.get(key)
    if (row) { row.level = level; row.updated_by = updatedBy; row.updated_at = 12345 }
  },
  setAutonomyCategoryTimeout: (key: string, minutes: number | null, updatedBy: string) => {
    const row = rows.get(key)
    if (row) { row.timeout_minutes = minutes; row.updated_by = updatedBy; row.updated_at = 12346 }
  },
  writeAgentAuditLog: (entry: Record<string, any>) => { auditWrites.push(entry) },
}))

import { tryHandleAutonomy } from '../web/routes/autonomy.js'

function makeCtx(method: string, path: string, body?: object, role?: RouteContext['role']): { ctx: RouteContext; out: { status: number; body: any } } {
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
  return { ctx: { req, res, path: url.pathname, method, url, role, auth: role ? { kind: 'token' } : undefined } as RouteContext, out }
}

describe('tryHandleAutonomy', () => {
  beforeEach(() => {
    dbUnavailable = false
    auditWrites.length = 0
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
    expect(deploy).toEqual({ key: 'deploy', label: 'Deploy', level: 1, locked: false, maxLevel: 3, timeoutMinutes: null })
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

  it('GET reports timeoutMinutes per category', async () => {
    rows.get('limited')!.timeout_minutes = 90
    const { ctx, out } = makeCtx('GET', '/api/autonomy')
    await tryHandleAutonomy(ctx)
    expect(out.body.categories.find((c: any) => c.key === 'limited').timeoutMinutes).toBe(90)
    expect(out.body.categories.find((c: any) => c.key === 'deploy').timeoutMinutes).toBeNull()
  })

  describe('POST timeout_minutes', () => {
    it('an admin sets it without touching the level, and the change is audited with the old and new value', async () => {
      rows.get('deploy')!.timeout_minutes = 60
      const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'deploy', timeout_minutes: 240 }, 'admin')
      await tryHandleAutonomy(ctx)
      expect(out.status).toBe(200)
      expect(out.body).toMatchObject({ ok: true, key: 'deploy', level: 1, timeoutMinutes: 240 })
      expect(rows.get('deploy')).toMatchObject({ timeout_minutes: 240, level: 1 })
      expect(auditWrites).toHaveLength(1)
      expect(auditWrites[0]).toMatchObject({ entity: 'approval', entity_id: 'deploy', detail: { timeout_minutes_from: 60, timeout_minutes_to: 240 } })
    })

    it('level and timeout_minutes can be changed in one call', async () => {
      const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'deploy', level: 2, timeout_minutes: 30 }, 'admin')
      await tryHandleAutonomy(ctx)
      expect(out.status).toBe(200)
      expect(rows.get('deploy')).toMatchObject({ level: 2, timeout_minutes: 30 })
    })

    it('null clears it back to the server ceiling', async () => {
      rows.get('deploy')!.timeout_minutes = 60
      const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'deploy', timeout_minutes: null }, 'admin')
      await tryHandleAutonomy(ctx)
      expect(out.status).toBe(200)
      expect(rows.get('deploy')!.timeout_minutes).toBeNull()
    })

    it('accepts the one-week upper bound and the one-minute lower bound', async () => {
      for (const minutes of [1, 10080]) {
        const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'deploy', timeout_minutes: minutes }, 'admin')
        await tryHandleAutonomy(ctx)
        expect(out.status).toBe(200)
        expect(rows.get('deploy')!.timeout_minutes).toBe(minutes)
      }
    })

    it('rejects 0, negatives, above a week, fractions and non-numbers, and writes nothing', async () => {
      for (const bad of [0, -1, 10081, 1.5, '60', true, {}]) {
        const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'deploy', timeout_minutes: bad }, 'admin')
        await tryHandleAutonomy(ctx)
        expect(out.status, JSON.stringify(bad)).toBe(400)
        expect(out.body.field).toBe('timeout_minutes')
      }
      expect(rows.get('deploy')!.timeout_minutes).toBeNull()
      expect(auditWrites).toHaveLength(0)
    })

    it('a non-admin, and a caller with no resolved role, gets 403 and nothing is written', async () => {
      for (const role of ['agent', 'read_only', undefined] as const) {
        const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'deploy', timeout_minutes: 5 }, role)
        await tryHandleAutonomy(ctx)
        expect(out.status, String(role)).toBe(403)
      }
      expect(rows.get('deploy')!.timeout_minutes).toBeNull()
    })

    it('an invalid level in the same call blocks the timeout change too (no partial write)', async () => {
      const { ctx, out } = makeCtx('POST', '/api/autonomy', { key: 'limited', level: 3, timeout_minutes: 30 }, 'admin')
      await tryHandleAutonomy(ctx)
      expect(out.status).toBe(400)
      expect(rows.get('limited')!.timeout_minutes).toBeNull()
    })

    it('an unknown category is 404, and a call with neither level nor timeout_minutes is 400', async () => {
      const a = makeCtx('POST', '/api/autonomy', { key: 'nope', timeout_minutes: 30 }, 'admin')
      await tryHandleAutonomy(a.ctx)
      expect(a.out.status).toBe(404)
      const b = makeCtx('POST', '/api/autonomy', { key: 'deploy' }, 'admin')
      await tryHandleAutonomy(b.ctx)
      expect(b.out.status).toBe(400)
    })
  })
})
