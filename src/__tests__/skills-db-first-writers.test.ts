import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

// Writers that used to write the SKILL.md file themselves (and mirror it into
// SQL) are DB-first now: the row is written, the file is generated from it.
// Real skill-regen + real filesystem under a temp home; only the DB is faked.

const { FAKE_HOME, FAKE_PROJECT, flag, store } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-db-first-'))
  return { FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project'), flag: { on: true }, store: new Map<string, any>() }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  const cfg = { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'marveen' }
  Object.defineProperty(cfg, 'SKILL_SQL_REGEN', { get: () => flag.on, enumerable: true })
  return cfg
})
vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'),
  listAgentNames: () => ['agent-b', 'agent-c'],
  agentDir: (n: string) => join(FAKE_PROJECT, 'agents', n),
  readFileOr: (p: string, d: string) => { try { return readFileSync(p, 'utf-8') } catch { return d } },
}))
vi.mock('../web/agent-scaffold.js', () => ({ generateSkillMd: vi.fn() }))
vi.mock('../web/multipart.js', () => ({ parseMultipart: vi.fn().mockReturnValue({ file: null }) }))
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('../db.js', () => ({
  getSkill: vi.fn((id: string) => store.get(id)),
  createSkill: vi.fn((o: any) => { const r = { created_by: null, created_at: 0, updated_at: 0, ...o, is_global: o.is_global ? 1 : 0 }; store.set(o.id, r); return r }),
  updateSkill: vi.fn((id: string, p: any) => { const r = { ...store.get(id), ...p }; store.set(id, r); return r }),
  deleteSkill: vi.fn((id: string) => store.delete(id)),
  seedSkillIfAbsent: vi.fn(),
  listSkillsForTenant: vi.fn().mockReturnValue([]),
  listAllSkills: vi.fn(() => [...store.values()]),
  grantSkillAccess: vi.fn(),
  revokeSkillAccess: vi.fn(),
  listSkillAccess: vi.fn().mockReturnValue([]),
}))

import { tryHandleSkills } from '../web/routes/skills.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

function call(method: string, path: string, body?: object, role = 'admin') {
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
  const ctx = { req, res, path: url.pathname, method, url, role, tenantId: undefined, auth: undefined } as unknown as RouteContext
  return tryHandleSkills(ctx).then(() => out)
}

const globalDir = (n: string) => join(FAKE_HOME, '.claude', 'skills', n)
const agentSkillDir = (a: string, n: string) => join(FAKE_PROJECT, 'agents', a, '.claude', 'skills', n)
const row = (id: string, content: string) => ({ id, name: id.split('/').pop(), description: '', content, tenant_id: 'fleet', is_global: 1, created_by: null, created_at: 0, updated_at: 0 })
function seedGlobal(n: string, content: string) {
  mkdirSync(globalDir(n), { recursive: true })
  writeFileSync(join(globalDir(n), 'SKILL.md'), content)
  store.set(`global/${n}`, row(`global/${n}`, content))
}

describe('PUT /api/skills/:name (dashboard edit) is DB-first', () => {
  beforeEach(() => { store.clear(); flag.on = true })

  it('writes the row and generates the file from it', async () => {
    seedGlobal('edit-me', '---\nname: edit-me\ndescription: old\n---\nold')
    const next = '---\nname: edit-me\ndescription: fresh\n---\nnew body'
    const out = await call('PUT', '/api/skills/edit-me', { content: next })
    expect(out.status).toBe(200)
    expect(store.get('global/edit-me').content).toBe(next)
    expect(store.get('global/edit-me').description).toBe('fresh')
    expect(readFileSync(join(globalDir('edit-me'), 'SKILL.md'), 'utf-8')).toBe(next)
  })

  it('still reaches disk with the automatic write-back switched off (an explicit user edit)', async () => {
    seedGlobal('edit-off', 'old')
    flag.on = false
    const out = await call('PUT', '/api/skills/edit-off', { content: 'edited while switch off' })
    expect(out.status).toBe(200)
    expect(readFileSync(join(globalDir('edit-off'), 'SKILL.md'), 'utf-8')).toBe('edited while switch off')
    expect(store.get('global/edit-off').content).toBe('edited while switch off')
  })

  it('creates the row for a file-only skill on first edit, then generates the file', async () => {
    mkdirSync(globalDir('file-only'), { recursive: true })
    writeFileSync(join(globalDir('file-only'), 'SKILL.md'), 'legacy')
    const out = await call('PUT', '/api/skills/file-only', { content: 'now in the db' })
    expect(out.status).toBe(200)
    expect(store.get('global/file-only').content).toBe('now in the db')
    expect(readFileSync(join(globalDir('file-only'), 'SKILL.md'), 'utf-8')).toBe('now in the db')
  })

  it('agent-local edit (?agent=) goes through the agent/<id>/<name> row', async () => {
    mkdirSync(agentSkillDir('agent-b', 'loc'), { recursive: true })
    writeFileSync(join(agentSkillDir('agent-b', 'loc'), 'SKILL.md'), 'old')
    const out = await call('PUT', '/api/skills/loc?agent=agent-b', { content: 'agent body' })
    expect(out.status).toBe(200)
    expect(store.get('agent/agent-b/loc').content).toBe('agent body')
    expect(readFileSync(join(agentSkillDir('agent-b', 'loc'), 'SKILL.md'), 'utf-8')).toBe('agent body')
  })
})

describe('DELETE /api/skills/sql/:id removes the generated file', () => {
  beforeEach(() => { store.clear(); flag.on = true })

  it('drops the row and the generated file', async () => {
    seedGlobal('del-me', 'body')
    const out = await call('DELETE', `/api/skills/sql/${encodeURIComponent('global/del-me')}`)
    expect(out.status).toBe(200)
    expect(store.has('global/del-me')).toBe(false)
    expect(existsSync(globalDir('del-me'))).toBe(false)
  })

  it('leaves a file that no longer matches the row (hand edit) in place', async () => {
    seedGlobal('del-edited', 'row body')
    writeFileSync(join(globalDir('del-edited'), 'SKILL.md'), 'someone edited the cache')
    const out = await call('DELETE', `/api/skills/sql/${encodeURIComponent('global/del-edited')}`)
    expect(out.status).toBe(200)
    expect(store.has('global/del-edited')).toBe(false)
    expect(readFileSync(join(globalDir('del-edited'), 'SKILL.md'), 'utf-8')).toBe('someone edited the cache')
  })
})

describe('POST /api/skills/:name/assign registers agent-local rows', () => {
  beforeEach(() => { store.clear(); flag.on = true })

  it('creates agent/<id>/<name> rows for the targets and removes them on unassign', async () => {
    seedGlobal('shared', 'shared body')
    let out = await call('POST', '/api/skills/shared/assign', { agents: ['agent-b', 'agent-c'] })
    expect(out.status).toBe(200)
    expect(store.get('agent/agent-b/shared').content).toBe('shared body')
    expect(store.get('agent/agent-c/shared').content).toBe('shared body')
    expect(store.get('agent/agent-b/shared').is_global).toBe(0)
    expect(readFileSync(join(agentSkillDir('agent-b', 'shared'), 'SKILL.md'), 'utf-8')).toBe('shared body')

    out = await call('POST', '/api/skills/shared/assign', { agents: ['agent-c'] })
    expect(out.status).toBe(200)
    expect(store.has('agent/agent-b/shared')).toBe(false)
    expect(existsSync(agentSkillDir('agent-b', 'shared'))).toBe(false)
    expect(store.has('agent/agent-c/shared')).toBe(true)
  })

  it('the agent file is generated from the DB row even when the copied global file was stale', async () => {
    seedGlobal('stale', 'stale file text')
    store.set('global/stale', row('global/stale', 'fresh row text'))
    await call('POST', '/api/skills/stale/assign', { agents: ['agent-b'] })
    expect(readFileSync(join(agentSkillDir('agent-b', 'stale'), 'SKILL.md'), 'utf-8')).toBe('fresh row text')
  })

  it('re-assigning refreshes an existing agent row from the global row', async () => {
    seedGlobal('shared2', 'v2')
    store.set('agent/agent-b/shared2', row('agent/agent-b/shared2', 'v1 stale'))
    await call('POST', '/api/skills/shared2/assign', { agents: ['agent-b'] })
    expect(store.get('agent/agent-b/shared2').content).toBe('v2')
  })
})
