import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { FAKE_HOME } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sql-test-'))
  // Minimal setup
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true })
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true })
  return { FAKE_HOME: home }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn().mockReturnValue(FAKE_HOME) }
})

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: FAKE_HOME }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path')
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    AGENTS_BASE_DIR: path.join(FAKE_HOME, 'agents'),
    listAgentNames: vi.fn().mockReturnValue(['agent-1', 'agent-2']),
    agentDir: vi.fn().mockImplementation((name: string) => path.join(FAKE_HOME, 'agents', name)),
    readFileOr: vi.fn().mockImplementation((filePath: string, def: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      try { return require('node:fs').readFileSync(filePath, 'utf-8') } catch { return def }
    }),
  }
})

vi.mock('../web/agent-scaffold.js', () => ({
  generateSkillMd: vi.fn().mockResolvedValue('---\nname: new\n---\nContent'),
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn().mockImplementation((path: string, content: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').writeFileSync(path, content)
  }),
}))

vi.mock('../web/multipart.js', () => ({
  parseMultipart: vi.fn().mockReturnValue({ file: null }),
}))

vi.mock('../web/skill-regen.js', () => ({
  regenSingleSkillFile: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

vi.mock('../db.js', () => ({
  getSkill: vi.fn().mockReturnValue(undefined),
  createSkill: vi.fn().mockImplementation((opts: any) => ({ ...opts, is_global: opts.is_global ? 1 : 0, created_by: null, created_at: 0, updated_at: 0 })),
  updateSkill: vi.fn().mockReturnValue(undefined),
  deleteSkill: vi.fn().mockReturnValue(true),
  seedSkillIfAbsent: vi.fn().mockReturnValue(true),
  listSkillsForTenant: vi.fn().mockReturnValue([]),
  listAllSkills: vi.fn().mockReturnValue([]),
  grantSkillAccess: vi.fn(),
  revokeSkillAccess: vi.fn().mockReturnValue(true),
  listSkillAccess: vi.fn().mockReturnValue([]),
}))

import { tryHandleSkills } from '../web/routes/skills.js'

function makeCtx(
  method: string,
  path: string,
  body?: object,
  opts?: { role?: string; tenantId?: string; auth?: any }
): {
  ctx: RouteContext; out: { status: number; body: any }
} {
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
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: {
      req,
      res,
      path: url.pathname,
      method,
      url,
      role: opts?.role ?? 'user',
      tenantId: opts?.tenantId,
      auth: opts?.auth,
    } as RouteContext,
    out,
  }
}

describe('tryHandleSkills SQL endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // --- GET /api/skills/sql ---
  describe('GET /api/skills/sql', () => {
    it('admin sees all skills', async () => {
      const { getSkill, listAllSkills } = await import('../db.js')
      ;(listAllSkills as any).mockReturnValueOnce([
        { id: 'fleet-test', name: 'Test', description: '', content: '', tenant_id: 'fleet', is_global: 0 },
      ])
      const { ctx, out } = makeCtx('GET', '/api/skills/sql', undefined, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.skills).toBeDefined()
      expect(listAllSkills).toHaveBeenCalled()
    })

    it('non-admin without tenant returns empty list', async () => {
      const { ctx, out } = makeCtx('GET', '/api/skills/sql', undefined, { role: 'user' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.skills).toEqual([])
    })

    it('tenant user sees tenant-scoped skills', async () => {
      const { listSkillsForTenant } = await import('../db.js')
      ;(listSkillsForTenant as any).mockReturnValueOnce([
        { id: 'tenant-skill', name: 'Tenant', description: '', content: '', tenant_id: 'acme', is_global: 0 },
      ])
      const { ctx, out } = makeCtx('GET', '/api/skills/sql', undefined, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.skills[0].id).toBe('tenant-skill')
      expect(listSkillsForTenant).toHaveBeenCalledWith('acme')
    })
  })

  // --- POST /api/skills/sql ---
  describe('POST /api/skills/sql', () => {
    it('non-admin without tenant returns 403', async () => {
      const { ctx, out } = makeCtx('POST', '/api/skills/sql', { name: 'test', content: '# Test' }, { role: 'user' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(403)
    })

    it('admin creates skill', async () => {
      const { createSkill } = await import('../db.js')
      ;(createSkill as any).mockReturnValueOnce({ id: 'fleet-new', name: 'New', description: '', content: '', tenant_id: 'fleet', is_global: 0 })
      const { ctx, out } = makeCtx('POST', '/api/skills/sql', { name: 'New', content: '# New Skill', description: 'A skill' }, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(201)
      expect(out.body.ok).toBe(true)
      expect(createSkill).toHaveBeenCalled()
    })

    it('tenant user creates tenant-scoped skill', async () => {
      const { createSkill } = await import('../db.js')
      ;(createSkill as any).mockReturnValueOnce({ id: 'acme-skill', name: 'TenantSkill', description: '', content: '', tenant_id: 'acme', is_global: 0 })
      const { ctx, out } = makeCtx('POST', '/api/skills/sql', { name: 'TenantSkill', content: '# X', description: 'Desc' }, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(201)
      expect(createSkill).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 'acme' }))
    })

    it('POST /api/skills/sql rejects missing name', async () => {
      const { ctx, out } = makeCtx('POST', '/api/skills/sql', { content: '# Test' }, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('required')
      expect(out.body.field).toBe('name')
    })

    it('POST /api/skills/sql rejects missing content', async () => {
      const { ctx, out } = makeCtx('POST', '/api/skills/sql', { name: 'Test' }, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('required')
      expect(out.body.field).toBe('content')
    })

    it('non-admin cannot set is_global', async () => {
      const { ctx, out } = makeCtx('POST', '/api/skills/sql', { name: 'Test', content: '# Test', is_global: true }, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(403)
      expect(out.body.error).toBe('forbidden')
    })

    it('POST /api/skills/sql rejects conflict on duplicate', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'fleet-dup', name: 'Dup' })
      const { ctx, out } = makeCtx('POST', '/api/skills/sql', { name: 'Dup', content: '# Dup' }, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(409)
    })
  })

  // --- GET /api/skills/sql/:id ---
  describe('GET /api/skills/sql/:id', () => {
    it('admin gets any skill', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'fleet-skill', name: 'Skill', tenant_id: 'fleet' })
      const { ctx, out } = makeCtx('GET', '/api/skills/sql/fleet-skill', undefined, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.id).toBe('fleet-skill')
    })

    it('non-admin gets only tenant-scoped skill', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'acme-skill', name: 'Skill', tenant_id: 'acme' })
      const { ctx, out } = makeCtx('GET', '/api/skills/sql/acme-skill', undefined, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
    })

    it('non-admin cannot access other tenant skill', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'other-skill', name: 'Skill', tenant_id: 'other' })
      const { ctx, out } = makeCtx('GET', '/api/skills/sql/other-skill', undefined, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('returns 404 for non-existent skill', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce(null)
      const { ctx, out } = makeCtx('GET', '/api/skills/sql/ghost', undefined, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('non-admin without tenant returns 404', async () => {
      const { ctx, out } = makeCtx('GET', '/api/skills/sql/some-skill', undefined, { role: 'user' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })
  })

  // --- PUT /api/skills/sql/:id ---
  describe('PUT /api/skills/sql/:id', () => {
    it('admin updates skill', async () => {
      const { getSkill, updateSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'fleet-skill', tenant_id: 'fleet' })
      ;(updateSkill as any).mockReturnValueOnce({ id: 'fleet-skill', name: 'Updated' })
      const { ctx, out } = makeCtx('PUT', '/api/skills/sql/fleet-skill', { name: 'Updated', content: '# Updated' }, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })

    it('tenant user updates own skill', async () => {
      const { getSkill, updateSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'acme-skill', tenant_id: 'acme' })
      ;(updateSkill as any).mockReturnValueOnce({ id: 'acme-skill' })
      const { ctx, out } = makeCtx('PUT', '/api/skills/sql/acme-skill', { content: '# Updated' }, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
    })

    it('tenant user cannot update other tenant skill', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'other-skill', tenant_id: 'other' })
      const { ctx, out } = makeCtx('PUT', '/api/skills/sql/other-skill', { content: '# Try' }, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('non-admin cannot set is_global', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'acme-skill', tenant_id: 'acme' })
      const { ctx, out } = makeCtx('PUT', '/api/skills/sql/acme-skill', { is_global: true }, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(403)
    })

    it('PUT returns 404 for non-existent skill', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce(null)
      const { ctx, out } = makeCtx('PUT', '/api/skills/sql/ghost', { content: '# X' }, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })
  })

  // --- DELETE /api/skills/sql/:id ---
  describe('DELETE /api/skills/sql/:id', () => {
    it('admin deletes skill', async () => {
      const { getSkill, deleteSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'fleet-skill', tenant_id: 'fleet' })
      ;(deleteSkill as any).mockReturnValueOnce(true)
      const { ctx, out } = makeCtx('DELETE', '/api/skills/sql/fleet-skill', undefined, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })

    it('tenant user deletes own skill', async () => {
      const { getSkill, deleteSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'acme-skill', tenant_id: 'acme' })
      ;(deleteSkill as any).mockReturnValueOnce(true)
      const { ctx, out } = makeCtx('DELETE', '/api/skills/sql/acme-skill', undefined, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
    })

    it('tenant user cannot delete other tenant skill', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'other-skill', tenant_id: 'other' })
      const { ctx, out } = makeCtx('DELETE', '/api/skills/sql/other-skill', undefined, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('DELETE returns 404 for non-existent skill', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce(null)
      const { ctx, out } = makeCtx('DELETE', '/api/skills/sql/ghost', undefined, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })
  })

  // --- GET/POST/DELETE /api/skills/sql/:id/access ---
  describe('GET /api/skills/sql/:id/access', () => {
    it('admin only can list access', async () => {
      const { getSkill, listSkillAccess } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'fleet-skill' })
      ;(listSkillAccess as any).mockReturnValueOnce([{ tenant_id: 'acme' }])
      const { ctx, out } = makeCtx('GET', '/api/skills/sql/fleet-skill/access', undefined, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.access[0].tenant_id).toBe('acme')
    })

    it('non-admin cannot list access', async () => {
      const { ctx, out } = makeCtx('GET', '/api/skills/sql/fleet-skill/access', undefined, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(403)
    })

    it('GET /access returns 404 for missing skill', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce(null)
      const { ctx, out } = makeCtx('GET', '/api/skills/sql/ghost/access', undefined, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })
  })

  describe('POST /api/skills/sql/:id/access', () => {
    it('admin grants access', async () => {
      const { getSkill, grantSkillAccess } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'fleet-skill' })
      ;(grantSkillAccess as any).mockReturnValueOnce(true)
      const { ctx, out } = makeCtx('POST', '/api/skills/sql/fleet-skill/access', { tenant_id: 'new-tenant' }, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })

    it('non-admin cannot grant access', async () => {
      const { ctx, out } = makeCtx('POST', '/api/skills/sql/fleet-skill/access', { tenant_id: 'acme' }, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(403)
    })

    it('POST /access rejects missing tenant_id', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'fleet-skill' })
      const { ctx, out } = makeCtx('POST', '/api/skills/sql/fleet-skill/access', { }, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(400)
    })

    it('POST /access returns 404 for missing skill', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce(null)
      const { ctx, out } = makeCtx('POST', '/api/skills/sql/ghost/access', { tenant_id: 'acme' }, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })
  })

  describe('DELETE /api/skills/sql/:id/access/:tenantId', () => {
    it('admin revokes access', async () => {
      const { revokeSkillAccess } = await import('../db.js')
      ;(revokeSkillAccess as any).mockReturnValueOnce(true)
      const { ctx, out } = makeCtx('DELETE', '/api/skills/sql/fleet-skill/access/acme', undefined, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })

    it('non-admin cannot revoke access', async () => {
      const { ctx, out } = makeCtx('DELETE', '/api/skills/sql/fleet-skill/access/acme', undefined, { role: 'user', tenantId: 'acme' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(403)
    })

    it('DELETE /access returns 404 when revoke fails', async () => {
      const { revokeSkillAccess } = await import('../db.js')
      ;(revokeSkillAccess as any).mockReturnValueOnce(false)
      const { ctx, out } = makeCtx('DELETE', '/api/skills/sql/fleet-skill/access/ghost', undefined, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })
  })

  // --- /api/v1 aliases ---
  describe('/api/v1 endpoint aliases', () => {
    it('GET /api/v1/skills/sql works (legacy alias)', async () => {
      const { listAllSkills } = await import('../db.js')
      ;(listAllSkills as any).mockReturnValueOnce([])
      const { ctx, out } = makeCtx('GET', '/api/v1/skills/sql', undefined, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
    })

    it('POST /api/v1/skills/sql works (legacy alias)', async () => {
      const { createSkill } = await import('../db.js')
      ;(createSkill as any).mockReturnValueOnce({ id: 'test', name: 'Test', description: '', content: '', tenant_id: 'fleet', is_global: 0 })
      const { ctx, out } = makeCtx('POST', '/api/v1/skills/sql', { name: 'Test', content: '# Test' }, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(201)
    })

    it('GET /api/v1/skills/sql/:id works (legacy alias)', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'test-skill', tenant_id: 'fleet' })
      const { ctx, out } = makeCtx('GET', '/api/v1/skills/sql/test-skill', undefined, { role: 'admin' })
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(200)
    })
  })

  // --- Error handling ---
  describe('Error handling', () => {
    it('POST /api/skills/sql handles invalid JSON', async () => {
      const buf = Buffer.from('not json')
      const req = new EventEmitter() as any
      req.method = 'POST'
      req.headers = {}
      setImmediate(() => { req.emit('data', buf); req.emit('end') })
      const out = { status: 200, body: null as any }
      const res = {
        writeHead(s: number) { out.status = s },
        end(b?: string) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
      } as any
      const url = new URL('http://localhost:3420/api/skills/sql')
      const ctx = { req, res, path: url.pathname, method: 'POST', url, role: 'admin', tenantId: null } as RouteContext
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('parse_error')
    })

    it('PUT /api/skills/sql/:id handles invalid JSON', async () => {
      const { getSkill } = await import('../db.js')
      ;(getSkill as any).mockReturnValueOnce({ id: 'test', tenant_id: 'fleet' })

      const buf = Buffer.from('bad json')
      const req = new EventEmitter() as any
      req.method = 'PUT'
      req.headers = {}
      setImmediate(() => { req.emit('data', buf); req.emit('end') })
      const out = { status: 200, body: null as any }
      const res = {
        writeHead(s: number) { out.status = s },
        end(b?: string) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
      } as any
      const url = new URL('http://localhost:3420/api/skills/sql/test')
      const ctx = { req, res, path: url.pathname, method: 'PUT', url, role: 'admin', tenantId: null } as RouteContext
      expect(await tryHandleSkills(ctx)).toBe(true)
      expect(out.status).toBe(400)
    })
  })
})
