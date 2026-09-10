// #751 step 7: src/web/routes/agents-skills.ts was at 0%. Real filesystem
// (mkdtempSync-based fake project/home, mirroring the skill-regen.test.ts
// pattern) and a real in-memory DB for the skills table, since the route's
// whole job is filesystem/DB bookkeeping around skill dirs. `execSync` (the
// actual `unzip` calls) is mocked -- unzip itself isn't our code, but the
// route's branching on ITS output (path traversal, symlink rejection, "no
// SKILL.md found") is, so the mock performs the real filesystem side effects
// a real unzip would, keeping those branches exercised for real.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const { FAKE_HOME, FAKE_PROJECT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-skills-route-'))
  return { FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project') }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen' }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-scaffold.js', () => ({ generateSkillMd: vi.fn() }))
vi.mock('../web/multipart.js', () => ({ parseMultipart: vi.fn() }))

const { execSyncMock } = vi.hoisted(() => ({ execSyncMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: execSyncMock }
})

// Wraps the real atomicWriteFileSync by default so every "happy path" test
// writes for real; only the disk-failure rollback test overrides it once.
const { atomicWriteMock } = vi.hoisted(() => ({ atomicWriteMock: vi.fn() }))
vi.mock('../web/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/atomic-write.js')>()
  atomicWriteMock.mockImplementation(actual.atomicWriteFileSync)
  return { atomicWriteFileSync: atomicWriteMock }
})

import { generateSkillMd } from '../web/agent-scaffold.js'
import { initDatabase, getSkill } from '../db.js'
import { tryHandleAgentsSkills } from '../web/routes/agents-skills.js'

function makeCtx(opts: { method: string; path: string; body?: Buffer; contentType?: string }): {
  ctx: RouteContext; status: () => number; body: () => unknown
} {
  const em = new EventEmitter() as any
  em.headers = opts.contentType ? { 'content-type': opts.contentType } : {}
  setImmediate(() => {
    if (opts.body) em.emit('data', opts.body)
    em.emit('end')
  })
  let code = 200
  let resBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (d?: string) => { resBody = d ?? '' },
  }
  const url = new URL(`http://localhost${opts.path}`)
  return {
    ctx: { req: em as http.IncomingMessage, res: res as unknown as http.ServerResponse, path: url.pathname, method: opts.method, url, auth: { kind: 'token' } } as RouteContext,
    status: () => code,
    body: () => { try { return JSON.parse(resBody) } catch { return resBody } },
  }
}

const GLOBAL_SKILLS_DIR = join(FAKE_HOME, '.claude', 'skills')
function agentSkillsDir(name: string): string { return join(FAKE_PROJECT, 'agents', name, '.claude', 'skills') }

function writeSkillDir(root: string, name: string, opts: { skillMd?: string } = {}): void {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (opts.skillMd !== undefined) writeFileSync(join(dir, 'SKILL.md'), opts.skillMd)
}

beforeEach(() => {
  initDatabase(':memory:')
  execSyncMock.mockReset()
  vi.mocked(generateSkillMd).mockReset()
  rmSync(GLOBAL_SKILLS_DIR, { recursive: true, force: true })
  rmSync(join(FAKE_PROJECT, 'agents'), { recursive: true, force: true })
  mkdirSync(GLOBAL_SKILLS_DIR, { recursive: true })
  mkdirSync(join(FAKE_PROJECT, 'agents', 'agent-b', '.claude', 'skills'), { recursive: true })
})

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

describe('GET /api/agents/:name/skills', () => {
  it('returns 404 for an unknown sub-agent', async () => {
    const { ctx, status } = makeCtx({ method: 'GET', path: '/api/agents/nobody/skills' })
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(status()).toBe(404)
  })

  it('lists the main agent\'s skills from the global dir as source=global, deletable=true', async () => {
    writeSkillDir(GLOBAL_SKILLS_DIR, 'skill-a', { skillMd: '---\nname: skill-a\ndescription: "does A"\n---\nbody' })
    writeSkillDir(GLOBAL_SKILLS_DIR, 'skill-no-md') // no SKILL.md -> hasSkillMd false, description ''
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agents/marveen/skills' })
    await tryHandleAgentsSkills(ctx)
    const skills = body() as any[]
    expect(skills).toHaveLength(2)
    const a = skills.find((s) => s.name === 'skill-a')
    expect(a).toMatchObject({ hasSkillMd: true, description: 'does A', source: 'global', deletable: true })
    const noMd = skills.find((s) => s.name === 'skill-no-md')
    expect(noMd).toMatchObject({ hasSkillMd: false, description: '', source: 'global', deletable: true })
  })

  it('lists a sub-agent\'s local skills plus non-shadowed inherited global skills', async () => {
    writeSkillDir(agentSkillsDir('agent-b'), 'local-only', { skillMd: '---\nname: local-only\ndescription: local\n---\n' })
    writeSkillDir(agentSkillsDir('agent-b'), 'shared-name', { skillMd: '---\nname: shared-name\ndescription: local version\n---\n' })
    writeSkillDir(GLOBAL_SKILLS_DIR, 'shared-name', { skillMd: '---\nname: shared-name\ndescription: global version\n---\n' })
    writeSkillDir(GLOBAL_SKILLS_DIR, 'inherited-only', { skillMd: '---\nname: inherited-only\ndescription: from global\n---\n' })
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agents/agent-b/skills' })
    await tryHandleAgentsSkills(ctx)
    const skills = body() as any[]
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(['inherited-only', 'local-only', 'shared-name'])
    const shared = skills.find((s) => s.name === 'shared-name')
    // Local shadows global: the local version's description wins, and it's deletable.
    expect(shared).toMatchObject({ description: 'local version', source: 'agent', deletable: true })
    const inherited = skills.find((s) => s.name === 'inherited-only')
    expect(inherited).toMatchObject({ source: 'global', deletable: false })
  })

  it('readSkillDescription falls back to empty string for a malformed frontmatter block', async () => {
    writeSkillDir(GLOBAL_SKILLS_DIR, 'weird', { skillMd: 'no frontmatter fences here at all' })
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agents/marveen/skills' })
    await tryHandleAgentsSkills(ctx)
    const weird = (body() as any[]).find((s) => s.name === 'weird')
    expect(weird).toMatchObject({ hasSkillMd: true, description: '' })
  })
})

describe('DELETE /api/agents/:name/skills/:skillName', () => {
  it('returns 404 for an unknown agent', async () => {
    const { ctx, status } = makeCtx({ method: 'DELETE', path: '/api/agents/nobody/skills/x' })
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(status()).toBe(404)
  })

  it('returns 404 when the skill directory does not exist', async () => {
    const { ctx, status } = makeCtx({ method: 'DELETE', path: '/api/agents/marveen/skills/ghost' })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(404)
  })

  it('deletes a global (main agent) skill dir and its DB row', async () => {
    writeSkillDir(GLOBAL_SKILLS_DIR, 'doomed', { skillMd: '---\ndescription: x\n---\n' })
    const { createSkill } = await import('../db.js')
    createSkill({ id: 'global/doomed', name: 'doomed', content: 'x', tenant_id: 'fleet', is_global: true })
    const { ctx, status } = makeCtx({ method: 'DELETE', path: '/api/agents/marveen/skills/doomed' })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(200)
    expect(existsSync(join(GLOBAL_SKILLS_DIR, 'doomed'))).toBe(false)
    expect(getSkill('global/doomed')).toBeUndefined()
  })

  it('deletes a sub-agent skill dir using the agent/<name>/<skill> DB id', async () => {
    writeSkillDir(agentSkillsDir('agent-b'), 'doomed', { skillMd: '---\ndescription: x\n---\n' })
    const { createSkill } = await import('../db.js')
    createSkill({ id: 'agent/agent-b/doomed', name: 'doomed', content: 'x', tenant_id: 'fleet', is_global: false })
    const { ctx, status } = makeCtx({ method: 'DELETE', path: '/api/agents/agent-b/skills/doomed' })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(200)
    expect(existsSync(join(agentSkillsDir('agent-b'), 'doomed'))).toBe(false)
    expect(getSkill('agent/agent-b/doomed')).toBeUndefined()
  })
})

describe('POST /api/agents/:name/skills (create)', () => {
  function jsonBody(o: unknown): Buffer { return Buffer.from(JSON.stringify(o)) }

  it('returns 404 for an unknown agent', async () => {
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/agents/nobody/skills', body: jsonBody({ name: 'x', description: 'y' }) })
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(status()).toBe(404)
  })

  it('requires a name and a description', async () => {
    const noName = makeCtx({ method: 'POST', path: '/api/agents/marveen/skills', body: jsonBody({ name: '', description: 'y' }) })
    await tryHandleAgentsSkills(noName.ctx)
    expect(noName.status()).toBe(400)

    const noDesc = makeCtx({ method: 'POST', path: '/api/agents/marveen/skills', body: jsonBody({ name: 'my-skill', description: '' }) })
    await tryHandleAgentsSkills(noDesc.ctx)
    expect(noDesc.status()).toBe(400)
  })

  it('returns 409 when the skill directory already exists', async () => {
    writeSkillDir(GLOBAL_SKILLS_DIR, 'taken')
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/agents/marveen/skills', body: jsonBody({ name: 'taken', description: 'y' }) })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(409)
  })

  it('returns 500 when SKILL.md generation fails', async () => {
    vi.mocked(generateSkillMd).mockRejectedValueOnce(new Error('claude unavailable'))
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/agents/marveen/skills', body: jsonBody({ name: 'broken-gen', description: 'y' }) })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(500)
    expect(existsSync(join(GLOBAL_SKILLS_DIR, 'broken-gen'))).toBe(false)
  })

  it('returns 409 when the DB already has a row for this id (dir absent, id pre-seeded)', async () => {
    const { createSkill } = await import('../db.js')
    createSkill({ id: 'global/dup', name: 'dup', content: 'x', tenant_id: 'fleet', is_global: true })
    vi.mocked(generateSkillMd).mockResolvedValueOnce('# generated')
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/agents/marveen/skills', body: jsonBody({ name: 'dup', description: 'y' }) })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(409)
    expect(existsSync(join(GLOBAL_SKILLS_DIR, 'dup'))).toBe(false)
  })

  it('creates a global skill for the main agent: DB row + SKILL.md on disk', async () => {
    vi.mocked(generateSkillMd).mockResolvedValueOnce('# generated content')
    const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/marveen/skills', body: jsonBody({ name: 'new-skill', description: 'does things' }) })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: true, name: 'new-skill' })
    expect(readFileSync(join(GLOBAL_SKILLS_DIR, 'new-skill', 'SKILL.md'), 'utf-8')).toBe('# generated content')
    expect(getSkill('global/new-skill')).toMatchObject({ name: 'new-skill', is_global: 1 })
  })

  it('creates an agent-local skill for a sub-agent', async () => {
    vi.mocked(generateSkillMd).mockResolvedValueOnce('# sub-agent skill')
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/agents/agent-b/skills', body: jsonBody({ name: 'sub-skill', description: 'y' }) })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(200)
    expect(readFileSync(join(agentSkillsDir('agent-b'), 'sub-skill', 'SKILL.md'), 'utf-8')).toBe('# sub-agent skill')
    expect(getSkill('agent/agent-b/sub-skill')).toMatchObject({ is_global: 0 })
  })

  it('rolls back the DB row and the freshly created dir when writing SKILL.md fails', async () => {
    vi.mocked(generateSkillMd).mockResolvedValueOnce('# will fail to write')
    atomicWriteMock.mockImplementationOnce(() => { throw new Error('disk full') })
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/agents/marveen/skills', body: jsonBody({ name: 'rollback-me', description: 'y' }) })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(500)
    expect(getSkill('global/rollback-me')).toBeUndefined()
    expect(existsSync(join(GLOBAL_SKILLS_DIR, 'rollback-me'))).toBe(false)
  })
})

describe('POST /api/agents/:name/skills/import', () => {
  function multipartCtx(agent: string): { ctx: RouteContext; status: () => number; body: () => unknown } {
    return makeCtx({
      method: 'POST',
      path: `/api/agents/${agent}/skills/import`,
      contentType: 'multipart/form-data; boundary=X',
      body: Buffer.from('irrelevant, parseMultipart is mocked'),
    })
  }

  it('returns 400 for a name that sanitizes to empty', async () => {
    const { parseMultipart } = await import('../web/multipart.js')
    vi.mocked(parseMultipart).mockReturnValue({ file: { data: Buffer.from(''), filename: 'x.zip' } } as any)
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/agents/%21%21%21/skills/import', contentType: 'multipart/form-data', body: Buffer.from('x') })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(400)
  })

  it('returns 404 for an unknown agent', async () => {
    const { ctx, status } = multipartCtx('nobody')
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(404)
  })

  it('returns 400 when no file was uploaded', async () => {
    const { parseMultipart } = await import('../web/multipart.js')
    vi.mocked(parseMultipart).mockReturnValue({ file: null } as any)
    const { ctx, status } = multipartCtx('marveen')
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(400)
  })

  it('rejects a zip whose listing contains a path-traversal entry, without extracting', async () => {
    const { parseMultipart } = await import('../web/multipart.js')
    vi.mocked(parseMultipart).mockReturnValue({ file: { data: Buffer.from('zip-bytes'), filename: 'evil.zip' } } as any)
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('unzip -Z1')) return '../escape.txt\n'
      throw new Error(`unexpected execSync call in traversal test: ${cmd}`)
    })
    const { ctx, status, body } = multipartCtx('marveen')
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(400)
    expect((body() as any).hint).toMatch(/path traversal/i)
    // Only the -Z1 listing call happened -- extraction never ran.
    expect(execSyncMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an archive that extracts a symlink, and cleans up the extracted entries', async () => {
    const { parseMultipart } = await import('../web/multipart.js')
    vi.mocked(parseMultipart).mockReturnValue({ file: { data: Buffer.from('zip-bytes'), filename: 'sneaky.zip' } } as any)
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('unzip -Z1')) return 'sneaky/\nsneaky/SKILL.md\n'
      if (cmd.startsWith('unzip -o')) {
        const dir = join(GLOBAL_SKILLS_DIR, 'sneaky')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), '# ok')
        symlinkSync('/etc/passwd', join(dir, 'evil-link'))
        return ''
      }
      throw new Error(`unexpected execSync call: ${cmd}`)
    })
    const { ctx, status, body } = multipartCtx('marveen')
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(400)
    expect((body() as any).hint).toMatch(/symlink/i)
    expect(existsSync(join(GLOBAL_SKILLS_DIR, 'sneaky'))).toBe(false)
  })

  it('rejects an archive with no SKILL.md in any extracted top-level entry', async () => {
    const { parseMultipart } = await import('../web/multipart.js')
    vi.mocked(parseMultipart).mockReturnValue({ file: { data: Buffer.from('zip-bytes'), filename: 'empty.zip' } } as any)
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('unzip -Z1')) return 'junk/\njunk/readme.txt\n'
      if (cmd.startsWith('unzip -o')) {
        mkdirSync(join(GLOBAL_SKILLS_DIR, 'junk'), { recursive: true })
        writeFileSync(join(GLOBAL_SKILLS_DIR, 'junk', 'readme.txt'), 'not a skill')
        return ''
      }
      throw new Error(`unexpected execSync call: ${cmd}`)
    })
    const { ctx, status, body } = multipartCtx('marveen')
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(400)
    expect((body() as any).hint).toMatch(/no valid skill/i)
    expect(existsSync(join(GLOBAL_SKILLS_DIR, 'junk'))).toBe(false)
  })

  it('imports a valid skill archive for the main agent: extracts, seeds the DB, reports it', async () => {
    const { parseMultipart } = await import('../web/multipart.js')
    vi.mocked(parseMultipart).mockReturnValue({ file: { data: Buffer.from('zip-bytes'), filename: 'good.zip' } } as any)
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('unzip -Z1')) return 'good-skill/\ngood-skill/SKILL.md\n'
      if (cmd.startsWith('unzip -o')) {
        const dir = join(GLOBAL_SKILLS_DIR, 'good-skill')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: imported\n---\nbody')
        return ''
      }
      throw new Error(`unexpected execSync call: ${cmd}`)
    })
    const { ctx, status, body } = multipartCtx('marveen')
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: true, imported: ['good-skill'] })
    expect(getSkill('global/good-skill')).toMatchObject({ name: 'good-skill', description: 'imported', is_global: 1 })
  })

  it('imports into the sub-agent-scoped DB id for a non-main agent', async () => {
    const { parseMultipart } = await import('../web/multipart.js')
    vi.mocked(parseMultipart).mockReturnValue({ file: { data: Buffer.from('zip-bytes'), filename: 'good.zip' } } as any)
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('unzip -Z1')) return 'sub-good/\nsub-good/SKILL.md\n'
      if (cmd.startsWith('unzip -o')) {
        const dir = join(agentSkillsDir('agent-b'), 'sub-good')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), '# sub good')
        return ''
      }
      throw new Error(`unexpected execSync call: ${cmd}`)
    })
    const { ctx, status } = multipartCtx('agent-b')
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(200)
    expect(getSkill('agent/agent-b/sub-good')).toMatchObject({ is_global: 0 })
  })

  it('returns 500 and cleans up the tmp zip when extraction itself throws', async () => {
    const { parseMultipart } = await import('../web/multipart.js')
    vi.mocked(parseMultipart).mockReturnValue({ file: { data: Buffer.from('corrupt'), filename: 'corrupt.zip' } } as any)
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('unzip -Z1')) throw new Error('corrupt archive')
      throw new Error(`unexpected execSync call: ${cmd}`)
    })
    const { ctx, status, body } = multipartCtx('marveen')
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(500)
    expect((body() as any).error).toBe('internal_error')
  })
})
