// The Skills screen lists from the database: GET /api/skills/sql is the list of record, and for the ADMIN each row says whether
// its canonical SKILL.md is on disk (file_present), so a skill whose file is gone is badged instead of vanishing, and can still be
// deleted. Real in-memory SQLite and the real route handler, HOME pointed at a temporary directory; the regeneration is stubbed.
//
// Neutral fixtures only: tenant-a, agent-a, user-a.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createSkill, getSkill, db, type SkillActor } from '../db.js'
import { tryHandleSkills, skillFilePresent } from '../web/routes/skills.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/skill-regen.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/skill-regen.js')>()),
  regenSingleSkillFile: vi.fn().mockResolvedValue({ reason: 'ok' }),
  removeGeneratedSkillFile: vi.fn().mockResolvedValue(undefined),
  removeGeneratedCompanionFile: vi.fn().mockResolvedValue(undefined),
}))

const ACTOR: SkillActor = { kind: 'system', id: null }
const BODY = '---\nname: x\ndescription: d\n---\nbody\n'

let home: string
let savedHome: string | undefined

async function seed(id: string, tenant: string, status: 'live' | 'disabled' = 'live') {
  await createSkill({ id, name: id, content: BODY, tenant_id: tenant, is_global: tenant === 'fleet' && id.startsWith('global/') }, ACTOR)
  if (status !== 'live') db.prepare('UPDATE skills SET status = ? WHERE id = ?').run(status, id)
}

/** The generated cache of a global skill: ~/.claude/skills/<name>/SKILL.md. */
function writeGlobalFile(name: string): void {
  const dir = join(home, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), BODY)
}

beforeEach(() => {
  savedHome = process.env.HOME
  home = mkdtempSync(join(tmpdir(), 'skills-ui-'))
  process.env.HOME = home // os.homedir() reads it at call time
  initDatabase(':memory:')
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

type Extras = Partial<Pick<RouteContext, 'auth' | 'role' | 'tokenAgentId' | 'agentId' | 'tenantId'>>

async function call(method: string, path: string, extras: Extras) {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', Buffer.from('{}')); (req as NodeJS.EventEmitter).emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) { if (b) { const s = Buffer.isBuffer(b) ? b.toString('utf-8') : b; try { out.body = JSON.parse(s) } catch { out.body = s } } },
  }
  const url = new URL('http://localhost:3420' + path)
  const ctx = { req, res, path: url.pathname, method, url, tenantId: null, ...extras } as unknown as RouteContext
  expect(await tryHandleSkills(ctx)).toBe(true)
  return out
}

const ADMIN: Extras = { auth: { kind: 'session', user: 'user-a' }, role: 'admin' }
const TENANT_A: Extras = { auth: { kind: 'session', user: 'user-b' }, role: 'viewer', tenantId: 'tenant-a' }
const AGENT_A: Extras = { auth: { kind: 'token', tokenName: 'token-a' }, role: 'fleet_agent', tokenAgentId: 'agent-a', agentId: 'agent-a' }
const enc = (id: string) => encodeURIComponent(id)
const byId = (rows: Array<{ id: string }>) => Object.fromEntries(rows.map((r) => [r.id, r])) as Record<string, any>

describe('GET /api/skills/sql: file_present for the admin', () => {
  beforeEach(async () => {
    await seed('global/has-file', 'fleet')
    await seed('global/no-file', 'fleet')
    await seed('global/revoked-no-file', 'fleet', 'disabled')
    await seed('tenant-a-skill', 'tenant-a')
    writeGlobalFile('has-file')
  })

  it('says true where the canonical SKILL.md is on disk, false where it is gone, null where the id has no single canonical file', async () => {
    const r = await call('GET', '/api/skills/sql', ADMIN)
    expect(r.status).toBe(200)
    const rows = byId(r.body.skills)
    expect(rows['global/has-file'].file_present).toBe(true)
    expect(rows['global/no-file'].file_present).toBe(false)
    expect(rows['global/revoked-no-file'].file_present).toBe(false)
    expect(rows['tenant-a-skill'].file_present).toBeNull()
  })

  it('a skill with no file is still in the list (the row is the list of record), with its content and status', async () => {
    const rows = byId((await call('GET', '/api/skills/sql', ADMIN)).body.skills)
    expect(rows['global/no-file']).toMatchObject({ id: 'global/no-file', status: 'live', content: BODY })
  })

  it('a directory named SKILL.md is not a file', async () => {
    mkdirSync(join(home, '.claude', 'skills', 'odd', 'SKILL.md'), { recursive: true })
    expect(skillFilePresent('global/odd')).toBe(false)
  })

  it('a path-unsafe or unknown id has no canonical file: null, and no probe of the disk', () => {
    expect(skillFilePresent('global/..')).toBeNull()
    expect(skillFilePresent('global/a/../b')).toBeNull()
    expect(skillFilePresent('/etc/passwd')).toBeNull()
    expect(skillFilePresent('tenant-a-skill')).toBeNull()
  })

  it('nobody but the admin is told about the machine: no file_present for a tenant caller or an agent token', async () => {
    const t = await call('GET', '/api/skills/sql', TENANT_A)
    expect(t.status).toBe(200)
    for (const row of t.body.skills) expect('file_present' in row, row.id).toBe(false)
    const a = await call('GET', '/api/skills/sql', AGENT_A)
    expect(a.status).toBe(200)
    expect(a.body.skills.length).toBeGreaterThan(0)
    for (const row of a.body.skills) expect('file_present' in row, row.id).toBe(false)
  })

  it('a tenant caller lists its own live skills and not another tenant\'s', async () => {
    await seed('tenant-b-skill', 'tenant-b')
    const t = await call('GET', '/api/skills/sql', TENANT_A)
    expect(t.body.skills.map((s: any) => s.id)).toEqual(['tenant-a-skill'])
  })
})

describe('a skill whose file is gone can be deleted from the list', () => {
  it('DELETE /api/skills/sql/:id removes the row of a skill that has no file', async () => {
    await seed('global/no-file', 'fleet')
    expect((await call('GET', '/api/skills/sql', ADMIN)).body.skills.map((s: any) => s.id)).toEqual(['global/no-file'])
    const del = await call('DELETE', `/api/skills/sql/${enc('global/no-file')}`, ADMIN)
    expect(del.status).toBe(200)
    expect(del.body).toEqual({ ok: true })
    expect(await getSkill('global/no-file')).toBeUndefined()
    expect((await call('GET', '/api/skills/sql', ADMIN)).body.skills).toEqual([])
  })
})
