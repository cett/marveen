// #751 step 7: src/web/routes/agents-skills.ts was at 0%. Real filesystem
// (mkdtempSync-based fake project/home, mirroring the skill-regen.test.ts
// pattern) and a real in-memory DB for the skills table, since the route's
// whole job is filesystem/DB bookkeeping around skill dirs. The archive import
// (real zips, the quarantine) is covered in skill-import-quarantine.test.ts.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  existsSync, mkdirSync, writeFileSync, rmSync, readFileSync,
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
  // SKILL_SQL_REGEN: true matches the live server (Phase 1-3 of the
  // file->SQL-only migration shipped) -- regenSingleSkillFile() actually writes in these tests.
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen', SKILL_SQL_REGEN: true, STORE_DIR: join(FAKE_HOME, 'store') }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../web/agent-scaffold.js', () => ({ generateSkillMd: vi.fn() }))
vi.mock('../web/multipart.js', () => ({ parseMultipart: vi.fn() }))

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
import { addGeneratedHeader } from '../skill-header.js'

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

  it('lists the main agent\'s skills from SQL as source=global, deletable=true', async () => {
    const { createSkill } = await import('../db.js')
    await createSkill({ id: 'global/skill-a', name: 'skill-a', description: 'does A', content: '---\nname: skill-a\ndescription: "does A"\n---\nbody', tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agents/marveen/skills' })
    await tryHandleAgentsSkills(ctx)
    const skills = body() as any[]
    expect(skills).toHaveLength(1)
    const a = skills.find((s) => s.name === 'skill-a')
    expect(a).toMatchObject({ hasSkillMd: true, description: 'does A', source: 'global', deletable: true })
  })

  it('a directory with no matching SQL row does not surface (SQL is now the source of truth, not the directory scan)', async () => {
    writeSkillDir(GLOBAL_SKILLS_DIR, 'skill-no-row') // on disk, but never materialized into SQL
    const { ctx, body } = makeCtx({ method: 'GET', path: '/api/agents/marveen/skills' })
    await tryHandleAgentsSkills(ctx)
    expect(body()).toEqual([])
  })

  it('lists a sub-agent\'s local skills plus non-shadowed inherited global skills', async () => {
    const { createSkill } = await import('../db.js')
    await createSkill({ id: 'agent/agent-b/local-only', name: 'local-only', description: 'local', content: 'x', tenant_id: 'fleet', is_global: false }, { kind: 'system', id: null })
    await createSkill({ id: 'agent/agent-b/shared-name', name: 'shared-name', description: 'local version', content: 'x', tenant_id: 'fleet', is_global: false }, { kind: 'system', id: null })
    await createSkill({ id: 'global/shared-name', name: 'shared-name', description: 'global version', content: 'x', tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
    await createSkill({ id: 'global/inherited-only', name: 'inherited-only', description: 'from global', content: 'x', tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
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
    await createSkill({ id: 'global/doomed', name: 'doomed', content: 'x', tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
    const { ctx, status } = makeCtx({ method: 'DELETE', path: '/api/agents/marveen/skills/doomed' })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(200)
    expect(existsSync(join(GLOBAL_SKILLS_DIR, 'doomed'))).toBe(false)
    expect(await getSkill('global/doomed')).toBeUndefined()
  })

  it('deletes a sub-agent skill dir using the agent/<name>/<skill> DB id', async () => {
    writeSkillDir(agentSkillsDir('agent-b'), 'doomed', { skillMd: '---\ndescription: x\n---\n' })
    const { createSkill } = await import('../db.js')
    await createSkill({ id: 'agent/agent-b/doomed', name: 'doomed', content: 'x', tenant_id: 'fleet', is_global: false }, { kind: 'system', id: null })
    const { ctx, status } = makeCtx({ method: 'DELETE', path: '/api/agents/agent-b/skills/doomed' })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(200)
    expect(existsSync(join(agentSkillsDir('agent-b'), 'doomed'))).toBe(false)
    expect(await getSkill('agent/agent-b/doomed')).toBeUndefined()
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
    await createSkill({ id: 'global/dup', name: 'dup', content: 'x', tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
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
    expect(readFileSync(join(GLOBAL_SKILLS_DIR, 'new-skill', 'SKILL.md'), 'utf-8')).toBe(addGeneratedHeader('# generated content', 'global/new-skill'))
    expect(await getSkill('global/new-skill')).toMatchObject({ name: 'new-skill', is_global: 1 })
  })

  it('creates an agent-local skill for a sub-agent', async () => {
    vi.mocked(generateSkillMd).mockResolvedValueOnce('# sub-agent skill')
    const { ctx, status } = makeCtx({ method: 'POST', path: '/api/agents/agent-b/skills', body: jsonBody({ name: 'sub-skill', description: 'y' }) })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(200)
    expect(readFileSync(join(agentSkillsDir('agent-b'), 'sub-skill', 'SKILL.md'), 'utf-8')).toBe(addGeneratedHeader('# sub-agent skill', 'agent/agent-b/sub-skill'))
    expect(await getSkill('agent/agent-b/sub-skill')).toMatchObject({ is_global: 0 })
  })

  it('does not roll back the DB row when the post-create file regen fails (Phase 4 of the file->SQL-only migration: SQL is the source of truth, file regen is best-effort)', async () => {
    vi.mocked(generateSkillMd).mockResolvedValueOnce('# will fail to write')
    atomicWriteMock.mockImplementationOnce(() => { throw new Error('disk full') })
    const { ctx, status, body } = makeCtx({ method: 'POST', path: '/api/agents/marveen/skills', body: jsonBody({ name: 'regen-fail', description: 'y' }) })
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(200)
    expect(body()).toEqual({ ok: true, name: 'regen-fail' })
    expect(await getSkill('global/regen-fail')).toMatchObject({ name: 'regen-fail' })
    // writeSkillFileToDisk mkdir's the dir before the write attempt, so the
    // dir can exist even though the write itself failed -- assert on the file.
    expect(existsSync(join(GLOBAL_SKILLS_DIR, 'regen-fail', 'SKILL.md'))).toBe(false)
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

  // The import itself (staging, quarantine, 202, 409, the refused entries) is covered end to end with real archives in
  // skill-import-quarantine.test.ts; here only the route's own failure path is pinned.
  it('returns 500 when the archive cannot be read at all, and leaves no staging directory behind', async () => {
    const { parseMultipart } = await import('../web/multipart.js')
    vi.mocked(parseMultipart).mockReturnValue({ file: { data: Buffer.from('corrupt'), filename: 'corrupt.zip' } } as any)
    const { ctx, status, body } = multipartCtx('marveen')
    await tryHandleAgentsSkills(ctx)
    expect(status()).toBe(500)
    expect((body() as any).error).toBe('internal_error')
  })
})
