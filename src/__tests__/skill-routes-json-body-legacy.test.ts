// Same class as skill-routes-json-body.test.ts, on the five remaining skills routes that parsed the body with a bare
// JSON.parse and no catch: create (POST /api/skills), assign, the agent-local PUT, the global PUT and the agent skill
// create (POST /api/agents/:name/skills). A body that is not JSON threw (500), and so did null on the first field read.
// They parse through the shared parseObjectBody now. Real route handlers; HOME and the project root are throwaway.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { FAKE_HOME, FAKE_PROJECT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-json-legacy-'))
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

import { initDatabase, createSkill } from '../db.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import { tryHandleAgentsSkills } from '../web/routes/agents-skills.js'
import type { RouteContext } from '../web/routes/types.js'

const PLAIN = '---\nname: x\ndescription: d\n---\nbody\n'
afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

beforeEach(async () => {
  initDatabase(':memory:')
  for (const root of [join(FAKE_HOME, '.claude', 'skills'), join(FAKE_PROJECT, '.claude', 'skills')]) {
    mkdirSync(join(root, 'jb-skill'), { recursive: true })
    writeFileSync(join(root, 'jb-skill', 'SKILL.md'), PLAIN)
  }
  mkdirSync(join(FAKE_PROJECT, 'agents', 'agent-b'), { recursive: true })
  await createSkill({ id: 'global/jb-skill', name: 'jb-skill', description: 'd', content: PLAIN, tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
})

async function call(handler: (c: RouteContext) => Promise<boolean>, method: string, path: string, rawBody: string) {
  const buf = Buffer.from(rawBody)
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
  const ctx = { req, res, path: url.pathname, method, url, tenantId: null, auth: { kind: 'session', user: 'reviewer' }, role: 'admin' } as unknown as RouteContext
  expect(await handler(ctx)).toBe(true)
  return out
}

const ROUTES: Array<{ label: string; handler: (c: RouteContext) => Promise<boolean>; method: string; path: string }> = [
  { label: 'POST /api/skills (create)', handler: tryHandleSkills, method: 'POST', path: '/api/skills' },
  { label: 'POST /api/skills/:name/assign', handler: tryHandleSkills, method: 'POST', path: '/api/skills/jb-skill/assign' },
  { label: 'PUT /api/skills/:name?agent= (agent-local)', handler: tryHandleSkills, method: 'PUT', path: '/api/skills/jb-skill?agent=agent-main' },
  { label: 'PUT /api/skills/:name (global)', handler: tryHandleSkills, method: 'PUT', path: '/api/skills/jb-skill' },
  { label: 'POST /api/agents/:name/skills (create)', handler: tryHandleAgentsSkills, method: 'POST', path: '/api/agents/agent-b/skills' },
]

describe('the remaining bare JSON.parse routes answer 400, not 500', () => {
  for (const route of ROUTES) {
    describe(route.label, () => {
      for (const body of ['null', '[]', '"x"', '42', 'true']) {
        it(`${body} answers 400 invalid_value`, async () => {
          const out = await call(route.handler, route.method, route.path, body)
          expect(out.status).toBe(400)
          expect(out.body).toMatchObject({ error: 'invalid_value', hint: 'Body must be a JSON object' })
        })
      }
      it('text that is not JSON answers parse_error', async () => {
        const out = await call(route.handler, route.method, route.path, '{not json')
        expect(out.status).toBe(400)
        expect(out.body).toMatchObject({ error: 'parse_error', hint: 'Invalid JSON' })
      })
      it('an object reaches the route\'s own validation (no 500, not the guard)', async () => {
        const out = await call(route.handler, route.method, route.path, '{}')
        expect(out.status).not.toBe(500)
        expect(out.body?.hint).not.toBe('Body must be a JSON object')
        expect(out.body?.error).not.toBe('parse_error')
      })
    })
  }
})
