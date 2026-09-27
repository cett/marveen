// model_profile_map moved from an optional store/model-profile-map.json
// side-car into the model_profile_map DB table, mirroring the
// autonomy_categories route test. This test mocks '../../db.js' with an
// in-memory row map instead of writing a JSON side-car file, mirroring the
// route's actual read/write surface (listModelProfileMap/
// getModelProfileMapEntry/setModelProfileMapEntry).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

interface Row {
  profile_id: string
  model_id: string
  updated_at: number
  updated_by: string
}

let rows: Map<string, Row>

function seedRows(entries: Array<Partial<Row> & { profile_id: string }>) {
  rows = new Map(entries.map(e => [e.profile_id, {
    model_id: e.model_id ?? 'claude-sonnet-5',
    updated_at: e.updated_at ?? 0,
    updated_by: e.updated_by ?? 'seed_migration',
    ...e,
  } as Row]))
}

let dbUnavailable = false

vi.mock('../db.js', () => ({
  listModelProfileMap: () => {
    if (dbUnavailable) throw new Error('database is not available')
    return Array.from(rows.values())
  },
  getModelProfileMapEntry: (profileId: string) => rows.get(profileId),
  setModelProfileMapEntry: (profileId: string, modelId: string, updatedBy: string) => {
    const row = rows.get(profileId)
    if (row) { row.model_id = modelId; row.updated_by = updatedBy; row.updated_at = 12345 }
  },
}))

import { tryHandleModelProfiles } from '../web/routes/model-profiles.js'

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

describe('tryHandleModelProfiles', () => {
  beforeEach(() => {
    dbUnavailable = false
    seedRows([
      { profile_id: 'premium_reasoning', model_id: 'claude-opus-5' },
      { profile_id: 'build_strong', model_id: 'claude-sonnet-5' },
      { profile_id: 'analysis_efficient', model_id: 'deepseek-v4-pro' },
      { profile_id: 'routine_lowcost', model_id: 'deepseek-v4-pro' },
    ])
  })

  it('GET returns 503 internal_error when the DB is unreachable (fail-safe: no file fallback)', async () => {
    dbUnavailable = true
    const { ctx, out } = makeCtx('GET', '/api/model-profiles')
    await tryHandleModelProfiles(ctx)
    expect(out.status).toBe(503)
    expect((out.body as { error: string }).error).toBe('internal_error')
  })

  it('GET returns the profile map in the wire shape (camelCase profileId/modelId)', async () => {
    const { ctx, out } = makeCtx('GET', '/api/model-profiles')
    await tryHandleModelProfiles(ctx)
    expect(out.status).toBe(200)
    const buildStrong = out.body.profiles.find((p: any) => p.profileId === 'build_strong')
    expect(buildStrong).toEqual({ profileId: 'build_strong', modelId: 'claude-sonnet-5', updatedAt: 0, updatedBy: 'seed_migration' })
    expect(out.body.profiles).toHaveLength(4)
  })

  it('PATCH returns invalid_value when profileId is not one of the 4 known ids', async () => {
    const { ctx, out } = makeCtx('PATCH', '/api/model-profiles', { profileId: 'turbo', modelId: 'x' })
    await tryHandleModelProfiles(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string; field: string }).field).toBe('profileId')
  })

  it('PATCH returns invalid_value when modelId is empty', async () => {
    const { ctx, out } = makeCtx('PATCH', '/api/model-profiles', { profileId: 'build_strong', modelId: '  ' })
    await tryHandleModelProfiles(ctx)
    expect(out.status).toBe(400)
    expect((out.body as { error: string; field: string }).field).toBe('modelId')
  })

  it('PATCH returns not_found when profileId is well-formed but missing from the DB', async () => {
    rows.delete('build_strong')
    const { ctx, out } = makeCtx('PATCH', '/api/model-profiles', { profileId: 'build_strong', modelId: 'claude-sonnet-5' })
    await tryHandleModelProfiles(ctx)
    expect(out.status).toBe(404)
    expect((out.body as { error: string }).error).toBe('not_found')
  })

  it('PATCH returns ok for a valid update and persists it', async () => {
    const { ctx, out } = makeCtx('PATCH', '/api/model-profiles', { profileId: 'analysis_efficient', modelId: 'claude-opus-5' })
    await tryHandleModelProfiles(ctx)
    expect(out.status).toBe(200)
    expect((out.body as { ok: boolean }).ok).toBe(true)
    expect(rows.get('analysis_efficient')?.model_id).toBe('claude-opus-5')
  })
})
