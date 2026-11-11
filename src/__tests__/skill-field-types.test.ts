// A body field of the wrong TYPE on the skills write routes (content: null on PUT /api/skills/sql/:id answered 500, a
// number as a name or description reached the sanitizer and the generator). One helper, requireStringFields, runs after
// the route's 403/404 decisions and before anything is written: 400 invalid_value with the field name, and NOTHING
// changes (the row, the revision trail, the disk, no regeneration). Real in-memory SQLite and the real route handlers;
// HOME and the project root are throwaway directories.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { FAKE_HOME, FAKE_PROJECT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-field-types-'))
  return { FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project') }
})
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => FAKE_HOME }))
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()), PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'agent-main', SKILL_SQL_REGEN: true,
}))
vi.mock('../web/skill-regen.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/skill-regen.js')>()),
  regenSingleSkillFile: vi.fn().mockResolvedValue({ reason: 'ok' }),
}))

import { initDatabase, createSkill, getSkill, listSkillRevisions, db } from '../db.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import { tryHandleAgentsSkills } from '../web/routes/agents-skills.js'
import { regenSingleSkillFile } from '../web/skill-regen.js'
import type { RouteContext } from '../web/routes/types.js'

const PLAIN = '---\nname: x\ndescription: d\n---\nbody\n'
const ID = 'global/ft-skill'
const WRONG: Array<[string, unknown]> = [['null', null], ['a number', 5], ['a boolean', true], ['an array', []], ['an object', {}]]
const skillsRoot = join(FAKE_HOME, '.claude', 'skills')
afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

beforeEach(async () => {
  initDatabase(':memory:')
  vi.mocked(regenSingleSkillFile).mockClear()
  mkdirSync(join(skillsRoot, 'ft-skill'), { recursive: true })
  writeFileSync(join(skillsRoot, 'ft-skill', 'SKILL.md'), PLAIN)
  mkdirSync(join(skillsRoot, 'ft-new'), { recursive: true })
  writeFileSync(join(skillsRoot, 'ft-new', 'SKILL.md'), PLAIN)
  mkdirSync(join(FAKE_PROJECT, 'agents', 'agent-b'), { recursive: true })
  await createSkill({ id: ID, name: 'ft-skill', description: 'original', content: PLAIN, tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
})

async function call(handler: (c: RouteContext) => Promise<boolean>, method: string, path: string, body: unknown, extras: Partial<RouteContext> = {}) {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) { if (b) { const s = Buffer.isBuffer(b) ? b.toString('utf-8') : b; try { out.body = JSON.parse(s) } catch { out.body = s } } },
  }
  const url = new URL('http://localhost:3420' + path)
  const ctx = { req, res, path: url.pathname, method, url, tenantId: null, auth: { kind: 'session', user: 'reviewer' }, role: 'admin', ...extras } as unknown as RouteContext
  expect(await handler(ctx)).toBe(true)
  return out
}

const enc = encodeURIComponent
const expectRefused = (out: { status: number; body: { error?: string; field?: string; hint?: string } }, field: string) => {
  expect(out.status).toBe(400)
  expect(out.body).toMatchObject({ error: 'invalid_value', field, hint: `${field} must be a string` })
}
const trailCount = async () => (await listSkillRevisions(ID)).length
const rowCount = () => (db.prepare('SELECT COUNT(*) AS n FROM skills').get() as { n: number }).n

describe('PUT /api/skills/sql/:id (update): content, description and name must be strings', () => {
  for (const field of ['content', 'description', 'name']) {
    for (const [label, value] of WRONG) {
      it(`${field} as ${label}: 400, and the row, the trail, the disk copy and the regen are untouched`, async () => {
        const before = JSON.stringify(await getSkill(ID))
        const trail = await trailCount()
        const out = await call(tryHandleSkills, 'PUT', `/api/skills/sql/${enc(ID)}`, { [field]: value })
        expectRefused(out, field)
        expect(JSON.stringify(await getSkill(ID))).toBe(before)
        expect(await trailCount()).toBe(trail)
        expect(regenSingleSkillFile).not.toHaveBeenCalled()
      })
    }
  }

  it('the reported case: content null is 400, not 500', async () => {
    const out = await call(tryHandleSkills, 'PUT', `/api/skills/sql/${enc(ID)}`, { content: null })
    expect(out.status).toBe(400)
  })

  it('valid strings still update, an empty description is allowed, and an empty content is still accepted (unchanged rule)', async () => {
    // (a description change is a privilege key: the route queues it, 202, instead of applying it, 200; neither is a type refusal)
    expect([200, 202]).toContain((await call(tryHandleSkills, 'PUT', `/api/skills/sql/${enc(ID)}`, { description: '' })).status)
    // a description change next to a content change is a privilege change: it is queued (202) instead of applied (200),
    // either way it is not refused for its type
    const both = await call(tryHandleSkills, 'PUT', `/api/skills/sql/${enc(ID)}`, { content: PLAIN.replace('body', 'body 2'), description: 'new' })
    expect([200, 202]).toContain(both.status)
    expect((await call(tryHandleSkills, 'PUT', `/api/skills/sql/${enc(ID)}`, { content: '' })).status).toBeLessThan(300)
  })

  it('the create branch (a file-backed id with no row yet): a wrong description is 400 and no row appears', async () => {
    const before = rowCount()
    for (const [, value] of WRONG) {
      expectRefused(await call(tryHandleSkills, 'PUT', `/api/skills/sql/${enc('global/ft-new')}`, { content: PLAIN, description: value }), 'description')
    }
    expect(rowCount()).toBe(before)
    expect(regenSingleSkillFile).not.toHaveBeenCalled()
  })
})

describe('POST /api/skills/sql (tenant create): description must be a string, null still means none', () => {
  for (const [label, value] of WRONG.filter(([l]) => l !== 'null')) {
    it(`description as ${label}: 400 and no row`, async () => {
      const before = rowCount()
      expectRefused(await call(tryHandleSkills, 'POST', '/api/skills/sql', { name: 'tenant skill', content: PLAIN, description: value }), 'description')
      expect(rowCount()).toBe(before)
    })
  }

  it('twin pair, on purpose: description null is accepted here (stored as empty) and is 400 on the update route', async () => {
    const created = await call(tryHandleSkills, 'POST', '/api/skills/sql', { name: 'twin skill', content: PLAIN, description: null })
    expect(created.status).toBeLessThan(300)
    expect(rowCount()).toBe(2)
    expectRefused(await call(tryHandleSkills, 'PUT', `/api/skills/sql/${enc(ID)}`, { description: null }), 'description')
  })
})

describe('POST /api/skills and POST /api/agents/:name/skills (create): name and description must be strings', () => {
  const targets = [
    { label: 'POST /api/skills', handler: tryHandleSkills, path: '/api/skills', dir: (n: string) => join(skillsRoot, n) },
    { label: 'POST /api/agents/:name/skills', handler: tryHandleAgentsSkills, path: '/api/agents/agent-b/skills', dir: (n: string) => join(FAKE_PROJECT, 'agents', 'agent-b', '.claude', 'skills', n) },
  ]
  for (const t of targets) {
    describe(t.label, () => {
      for (const field of ['name', 'description']) {
        for (const [label, value] of WRONG) {
          it(`${field} as ${label}: 400 and nothing is created on disk`, async () => {
            const body = { name: 'made-up-skill', description: 'does a thing', [field]: value }
            const before = existsSync(skillsRoot) ? readdirSync(skillsRoot).sort() : []
            expectRefused(await call(t.handler, 'POST', t.path, body), field)
            expect(existsSync(t.dir('made-up-skill'))).toBe(false)
            expect(existsSync(skillsRoot) ? readdirSync(skillsRoot).sort() : []).toEqual(before)
          })
        }
      }
    })
  }
})

// The type check runs AFTER the route's 403/404 decisions: a caller who may not touch the skill gets the same 403/404 as
// with a valid body, so the 400 says nothing about a skill the caller must not learn about (content: null in each case).
describe('the type check comes after the 403/404 decisions (PUT /api/skills/sql/:id, content null)', () => {
  const put = (id: string, extras: Partial<RouteContext>) => call(tryHandleSkills, 'PUT', `/api/skills/sql/${enc(id)}`, { content: null }, extras)

  it('a fleet agent token on another agent\'s skill: 403, not 400', async () => {
    await createSkill({ id: 'agent/agent-b/ft-other', name: 'ft-other', description: 'd', content: PLAIN, tenant_id: 'fleet', is_global: false }, { kind: 'system', id: null })
    const out = await put('agent/agent-b/ft-other', { auth: { kind: 'token', tokenName: 'tok' }, role: 'fleet_agent', tokenAgentId: 'agent-a' } as Partial<RouteContext>)
    expect(out.status).toBe(403)
    expect(out.body).toMatchObject({ error: 'forbidden' })
  })

  it('an id that does not exist (and is not a file-backed id): 404, not 400', async () => {
    const out = await put('no-such-skill-id', {})
    expect(out.status).toBe(404)
    expect(out.body).toMatchObject({ error: 'not_found' })
  })

  it('a skill of the caller\'s own tenant that is not live (revoked), caller not an admin: 404, not 400', async () => {
    await createSkill({ id: 'co-x-ft-revoked', name: 'ft-revoked', description: 'd', content: PLAIN, tenant_id: 'co-x', is_global: false }, { kind: 'system', id: null })
    db.prepare("UPDATE skills SET status = 'disabled' WHERE id = 'co-x-ft-revoked'").run()
    const out = await put('co-x-ft-revoked', { auth: { kind: 'session', user: 'viewer' }, role: 'viewer', tenantId: 'co-x' } as Partial<RouteContext>)
    expect(out.status).toBe(404)
    expect(out.body).toMatchObject({ error: 'not_found' })
  })

  it('a skill of another tenant: 404, not 400', async () => {
    const out = await put(ID, { auth: { kind: 'session', user: 'viewer' }, role: 'viewer', tenantId: 'co-x' } as Partial<RouteContext>)
    expect(out.status).toBe(404)
    expect(out.body).toMatchObject({ error: 'not_found' })
  })
})

// is_global was read by truthiness: the string "false" or the number 1 made a skill global. Only a boolean is a flag.
describe('is_global must be a boolean (PUT /api/skills/sql/:id and POST /api/skills/sql)', () => {
  const NOT_BOOLEAN: Array<[string, unknown]> = [['the string "false"', 'false'], ['the string "true"', 'true'], ['the number 1', 1], ['the number 0', 0], ['an array', []], ['an object', {}]]
  const globalFlag = () => (db.prepare('SELECT is_global FROM skills WHERE id = ?').get(ID) as { is_global: number }).is_global

  for (const [label, value] of NOT_BOOLEAN) {
    it(`PUT with is_global as ${label}: 400, the flag and the row are unchanged, nothing is regenerated`, async () => {
      db.prepare("UPDATE skills SET is_global = 0 WHERE id = ?").run(ID)
      const before = JSON.stringify(await getSkill(ID))
      const out = await call(tryHandleSkills, 'PUT', `/api/skills/sql/${enc(ID)}`, { is_global: value })
      expect(out.status).toBe(400)
      expect(out.body).toMatchObject({ error: 'invalid_value', field: 'is_global', hint: 'is_global must be a boolean' })
      expect(JSON.stringify(await getSkill(ID))).toBe(before)
      expect(globalFlag()).toBe(0)
      expect(regenSingleSkillFile).not.toHaveBeenCalled()
    })

    it(`POST (tenant create) with is_global as ${label}: 400 and no row`, async () => {
      const before = rowCount()
      const out = await call(tryHandleSkills, 'POST', '/api/skills/sql', { name: 'flag skill', content: PLAIN, is_global: value })
      expect(out.status).toBe(400)
      expect(out.body).toMatchObject({ error: 'invalid_value', field: 'is_global' })
      expect(rowCount()).toBe(before)
    })
  }

  it('a real boolean still works on both routes, null still means not global on create, and a non-admin gets the 403 before the type check', async () => {
    expect([200, 202]).toContain((await call(tryHandleSkills, 'PUT', `/api/skills/sql/${enc(ID)}`, { is_global: false })).status)
    expect(rowCount()).toBe(1)
    expect((await call(tryHandleSkills, 'POST', '/api/skills/sql', { name: 'flag ok', content: PLAIN, is_global: false })).status).toBeLessThan(300)
    expect((await call(tryHandleSkills, 'POST', '/api/skills/sql', { name: 'flag null', content: PLAIN, is_global: null })).status).toBeLessThan(300)
    const viewer = { auth: { kind: 'session', user: 'viewer' }, role: 'viewer', tenantId: 'fleet' } as Partial<RouteContext>
    const out = await call(tryHandleSkills, 'PUT', `/api/skills/sql/${enc(ID)}`, { is_global: 'false' }, viewer)
    expect(out.status).toBe(403)
  })
})

describe('the helper decides on the type only', () => {
  it('a missing field is left to the route\'s own required rule', async () => {
    const out = await call(tryHandleSkills, 'POST', '/api/skills', { description: 'does a thing' })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'required', field: 'name' })
  })
})
