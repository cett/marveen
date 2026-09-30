import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// Skill ids carry '/' ("global/<dir>", "agent/<id>/<dir>"). The SQL skill
// routes take the id as ONE percent-encoded path segment; these tests pin that
// every method works with both id shapes and that the id reaches the DB layer
// decoded. The path is built exactly like src/web.ts does (URL.pathname), so a
// regression in how %2F survives URL parsing is caught here too.

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen' }
})
vi.mock('../web/agent-scaffold.js', () => ({ generateSkillMd: vi.fn() }))
vi.mock('../web/multipart.js', () => ({ parseMultipart: vi.fn().mockReturnValue({ file: null }) }))
vi.mock('../web/skill-regen.js', () => ({ regenSingleSkillFile: vi.fn(), removeGeneratedSkillFile: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('../db.js', () => ({
  getSkill: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  deleteSkill: vi.fn().mockReturnValue(true),
  seedSkillIfAbsent: vi.fn(),
  listSkillsForTenant: vi.fn().mockReturnValue([]),
  listAllSkills: vi.fn().mockReturnValue([]),
  grantSkillAccess: vi.fn(),
  revokeSkillAccess: vi.fn().mockReturnValue(true),
  listSkillAccess: vi.fn().mockReturnValue([]),
  listSkillFiles: vi.fn().mockReturnValue([]),
}))

import { tryHandleSkills } from '../web/routes/skills.js'
import { normalizePath } from '../web/routes/versioning.js'
import { getSkill, updateSkill, deleteSkill, listSkillAccess, grantSkillAccess, revokeSkillAccess } from '../db.js'
import { regenSingleSkillFile } from '../web/skill-regen.js'

const mockGetSkill = vi.mocked(getSkill)
const mockUpdateSkill = vi.mocked(updateSkill)
const mockDeleteSkill = vi.mocked(deleteSkill)
const mockListAccess = vi.mocked(listSkillAccess)
const mockGrant = vi.mocked(grantSkillAccess)
const mockRevoke = vi.mocked(revokeSkillAccess)
const mockRegen = vi.mocked(regenSingleSkillFile)

function makeCtx(method: string, rawPath: string, body?: object) {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${rawPath}`)
  const { path } = normalizePath(url.pathname)
  const ctx = { req, res, path, method, url, role: 'admin', tenantId: undefined, auth: undefined } as unknown as RouteContext
  return { ctx, out }
}

// [label, id as stored in the DB]
const IDS: Array<[string, string]> = [
  ['plain id', 'fleet-my-skill'],
  ['global/<dir> id', 'global/my-skill'],
  ['agent/<id>/<dir> id', 'agent/zed/my-skill'],
]

const row = (id: string) => ({ id, name: 'n', description: '', content: 'c', tenant_id: 'fleet', is_global: 0, created_by: null, created_at: 0, updated_at: 0 })

describe('/api/skills/sql/:id with percent-encoded ids', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSkill.mockImplementation(((id: string) => row(id)) as any)
    mockUpdateSkill.mockImplementation(((id: string, patch: any) => ({ ...row(id), ...patch })) as any)
    mockDeleteSkill.mockReturnValue(true)
    mockListAccess.mockReturnValue([])
    mockRevoke.mockReturnValue(true)
  })

  it('URL.pathname keeps %2F intact (the property the route relies on)', () => {
    const url = new URL('http://localhost:3420/api/skills/sql/global%2Fmy-skill')
    expect(url.pathname).toBe('/api/skills/sql/global%2Fmy-skill')
    expect(normalizePath(url.pathname).path).toBe('/api/skills/sql/global%2Fmy-skill')
    expect(normalizePath('/api/v1/skills/sql/global%2Fmy-skill').path).toBe('/api/skills/sql/global%2Fmy-skill')
  })

  for (const [label, id] of IDS) {
    const enc = encodeURIComponent(id)

    it(`GET ${label}`, async () => {
      const { ctx, out } = makeCtx('GET', `/api/skills/sql/${enc}`)
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.id).toBe(id)
      expect(mockGetSkill).toHaveBeenCalledWith(id)
    })

    it(`PUT ${label}`, async () => {
      const { ctx, out } = makeCtx('PUT', `/api/skills/sql/${enc}`, { content: 'new body' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(mockUpdateSkill).toHaveBeenCalledWith(id, { content: 'new body' })
      expect(mockRegen).toHaveBeenCalledWith(id)
    })

    it(`DELETE ${label}`, async () => {
      const { ctx, out } = makeCtx('DELETE', `/api/skills/sql/${enc}`)
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(mockDeleteSkill).toHaveBeenCalledWith(id)
    })

    it(`GET/POST access + DELETE access item, ${label}`, async () => {
      let r = makeCtx('GET', `/api/skills/sql/${enc}/access`)
      await tryHandleSkills(r.ctx)
      expect(r.out.status).toBe(200)
      expect(mockListAccess).toHaveBeenCalledWith(id)

      r = makeCtx('POST', `/api/skills/sql/${enc}/access`, { tenant_id: 't1' })
      await tryHandleSkills(r.ctx)
      expect(r.out.status).toBe(200)
      expect(mockGrant).toHaveBeenCalledWith(id, 't1', undefined)

      r = makeCtx('DELETE', `/api/skills/sql/${enc}/access/${encodeURIComponent('t/1')}`)
      await tryHandleSkills(r.ctx)
      expect(r.out.status).toBe(200)
      expect(mockRevoke).toHaveBeenCalledWith(id, 't/1')
    })

    it(`v1 alias serves ${label}`, async () => {
      const { ctx, out } = makeCtx('GET', `/api/v1/skills/sql/${enc}`)
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(mockGetSkill).toHaveBeenCalledWith(id)
    })
  }

  it('an unknown encoded id is a clean 404, not a fall-through', async () => {
    mockGetSkill.mockReturnValue(undefined as any)
    const { ctx, out } = makeCtx('GET', `/api/skills/sql/${encodeURIComponent('global/nope')}`)
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('a double-encoded id is decoded exactly once (no second decode)', async () => {
    const { ctx } = makeCtx('GET', `/api/skills/sql/${encodeURIComponent(encodeURIComponent('global/x'))}`)
    await tryHandleSkills(ctx)
    expect(mockGetSkill).toHaveBeenCalledWith('global%2Fx')
  })

  it('a raw (unencoded) slash id is not matched by the id routes', async () => {
    const { ctx } = makeCtx('GET', '/api/skills/sql/global/my-skill')
    await tryHandleSkills(ctx)
    expect(mockGetSkill).not.toHaveBeenCalled()
  })

  for (const method of ['GET', 'PUT', 'DELETE']) {
    it(`${method} with a malformed percent-escape is a 400, not a crash`, async () => {
      const { ctx, out } = makeCtx(method, '/api/skills/sql/bad%zzid', method === 'PUT' ? { content: 'x' } : undefined)
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('invalid_value')
      expect(mockGetSkill).not.toHaveBeenCalled()
      expect(mockUpdateSkill).not.toHaveBeenCalled()
      expect(mockDeleteSkill).not.toHaveBeenCalled()
    })
  }

  it('a malformed escape in an access sub-route is a 400 too', async () => {
    let r = makeCtx('GET', '/api/skills/sql/%/access')
    expect(await tryHandleSkills(r.ctx)).toBe(true)
    expect(r.out.status).toBe(400)
    r = makeCtx('DELETE', '/api/skills/sql/ok/access/%E0%A4%A')
    expect(await tryHandleSkills(r.ctx)).toBe(true)
    expect(r.out.status).toBe(400)
    expect(mockRevoke).not.toHaveBeenCalled()
  })

  it('POST access with a malformed escape in the skill id is a 400 and grants nothing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/skills/sql/bad%zzid/access', { tenant_id: 't1' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(mockGetSkill).not.toHaveBeenCalled()
    expect(mockGrant).not.toHaveBeenCalled()
  })

  it('DELETE access item with a malformed escape in the skill id (valid tenant) is a 400 and revokes nothing', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/skills/sql/bad%zzid/access/t1')
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(mockRevoke).not.toHaveBeenCalled()
  })
})
