import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// PUT /api/skills/sql/:id creates a file-backed skill (global/<dir>, agent/<agent>/<dir>)
// that has no row yet: skill writers are DB-first, so the agent that holds the
// content must be able to create the row. Anything that is not such an id, or a
// non-admin caller, still gets the old 404.

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen' }
})
vi.mock('../web/agent-scaffold.js', () => ({ generateSkillMd: vi.fn() }))
vi.mock('../web/multipart.js', () => ({ parseMultipart: vi.fn().mockReturnValue({ file: null }) }))
vi.mock('../web/skill-regen.js', () => ({ regenSingleSkillFile: vi.fn(), removeGeneratedSkillFile: vi.fn() }))
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: '/nonexistent-agents', listAgentNames: () => ['zed'], readFileOr: vi.fn(), agentDir: vi.fn(),
}))
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
import { getSkill, createSkill, updateSkill } from '../db.js'
import { regenSingleSkillFile } from '../web/skill-regen.js'

const mockGetSkill = vi.mocked(getSkill)
const mockCreateSkill = vi.mocked(createSkill)
const mockUpdateSkill = vi.mocked(updateSkill)
const mockRegen = vi.mocked(regenSingleSkillFile)

function makeCtx(method: string, rawPath: string, body?: object, role = 'admin') {
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
  const ctx = { req, res, path, method, url, role, tenantId: undefined, auth: undefined } as unknown as RouteContext
  return { ctx, out }
}

const BODY = { content: '---\nname: x\ndescription: "does x"\n---\n\nbody\n' }
const enc = (id: string) => encodeURIComponent(id)

describe('PUT /api/skills/sql/:id creates a missing file-backed skill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSkill.mockReturnValue(undefined)
    mockCreateSkill.mockImplementation(((o: any) => ({ ...o, is_global: o.is_global ? 1 : 0 })) as any)
  })

  it('global/<dir>: creates a fleet global row, description from the frontmatter, then generates the file', async () => {
    const { ctx, out } = makeCtx('PUT', `/api/skills/sql/${enc('global/new-skill')}`, BODY)
    await tryHandleSkills(ctx)
    expect(out.status).toBe(201)
    expect(mockCreateSkill).toHaveBeenCalledWith(expect.objectContaining({
      id: 'global/new-skill', name: 'new-skill', description: 'does x', content: BODY.content, tenant_id: 'fleet', is_global: true,
    }))
    expect(mockRegen).toHaveBeenCalledWith('global/new-skill')
    expect(mockUpdateSkill).not.toHaveBeenCalled()
  })

  it('agent/<agent>/<dir>: creates a non-global row for an existing agent; an explicit description wins', async () => {
    const { ctx, out } = makeCtx('PUT', `/api/skills/sql/${enc('agent/zed/mine')}`, { ...BODY, description: 'explicit' })
    await tryHandleSkills(ctx)
    expect(out.status).toBe(201)
    expect(mockCreateSkill).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent/zed/mine', description: 'explicit', is_global: false }))
  })

  it('agent/<MAIN_AGENT_ID>/<dir> is accepted too', async () => {
    const { ctx, out } = makeCtx('PUT', `/api/skills/sql/${enc('agent/marveen/local')}`, BODY)
    await tryHandleSkills(ctx)
    expect(out.status).toBe(201)
  })

  it('requires content', async () => {
    const { ctx, out } = makeCtx('PUT', `/api/skills/sql/${enc('global/new-skill')}`, { description: 'x' })
    await tryHandleSkills(ctx)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'required', field: 'content' })
    expect(mockCreateSkill).not.toHaveBeenCalled()
  })

  const NOT_CREATABLE: Array<[string, string, string?]> = [
    ['an unknown agent', 'agent/ghost/x'],
    ['a plain tenant id', 'fleet-my-skill'],
    ['an unsanitized directory name', 'global/Bad Name'],
    ['a dot-dot directory', 'global/..'],
    ['an empty directory name', 'global/'],
    ['too many segments', 'agent/zed/a/b'],
    ['a non-admin caller', 'global/new-skill', 'user'],
  ]
  for (const [label, id, role] of NOT_CREATABLE) {
    it(`keeps the 404 for ${label}`, async () => {
      const { ctx, out } = makeCtx('PUT', `/api/skills/sql/${enc(id)}`, BODY, role)
      await tryHandleSkills(ctx)
      expect(out.status).toBe(404)
      expect(mockCreateSkill).not.toHaveBeenCalled()
      expect(mockRegen).not.toHaveBeenCalled()
    })
  }

  describe('the description of an existing skill follows the frontmatter', () => {
    beforeEach(() => {
      mockGetSkill.mockReturnValue({ id: 'global/new-skill', tenant_id: 'fleet' } as any)
      mockUpdateSkill.mockReturnValue({ id: 'global/new-skill' } as any)
    })
    const put = async (body: object) => {
      const { ctx, out } = makeCtx('PUT', `/api/skills/sql/${enc('global/new-skill')}`, body)
      await tryHandleSkills(ctx)
      expect(out.status).toBe(200)
      return mockUpdateSkill.mock.calls[0][1] as any
    }

    it('new content without a description carries its frontmatter description', async () => {
      expect((await put(BODY)).description).toBe('does x')
    })

    it('an explicit description wins over the frontmatter', async () => {
      expect((await put({ ...BODY, description: 'explicit' })).description).toBe('explicit')
    })

    it('content without a frontmatter description leaves the stored description alone', async () => {
      const patch = await put({ content: 'just text' })
      expect(patch).not.toHaveProperty('description')
    })

    it('a patch without content does not touch the description', async () => {
      const patch = await put({ name: 'renamed' })
      expect(patch).not.toHaveProperty('description')
    })
  })

  it('an existing row is still updated, not re-created', async () => {
    mockGetSkill.mockReturnValue({ id: 'global/new-skill', tenant_id: 'fleet' } as any)
    mockUpdateSkill.mockReturnValue({ id: 'global/new-skill' } as any)
    const { ctx, out } = makeCtx('PUT', `/api/skills/sql/${enc('global/new-skill')}`, BODY)
    await tryHandleSkills(ctx)
    expect(out.status).toBe(200)
    expect(mockCreateSkill).not.toHaveBeenCalled()
    expect(mockUpdateSkill).toHaveBeenCalled()
  })
})
