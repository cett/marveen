// POST /api/skills/sql/:id/revoke: live -> disabled in one step, with the trail row and the generated files taken away.
// Real in-memory SQLite, the real route handler and the real regen under a temp home (nothing outside it is touched).
//
// Neutral fixtures only: tenant-a, agent-a, user-a, token-a.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { FAKE_HOME, FAKE_PROJECT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-revoke-'))
  return { FAKE_HOME: fakeHome, FAKE_PROJECT: path.join(fakeHome, 'project') }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => FAKE_HOME }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'main-a', SKILL_SQL_REGEN: true, TENANT_SKILL_FILES: 'single' }
})
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'),
  listAgentNames: () => ['agent-a'],
}))

import {
  initDatabase, db, createSkill, getSkill, putSkillFile, listSkillRevisions, listGlobalFleetSkills, listAllSkills,
  type SkillActor,
} from '../db.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import { regenSingleSkillFile, regenSkillFilesFromSQL } from '../web/skill-regen.js'
import { resolveRequiredPermission } from '../web/rbac.js'
import type { RouteContext } from '../web/routes/types.js'

afterAll(() => { rmSync(FAKE_HOME, { recursive: true, force: true }) })

const SYSTEM: SkillActor = { kind: 'system', id: null }
const BODY = '---\nname: demo\ndescription: d\n---\n# demo body\n'
const globalMd = (dir: string) => join(FAKE_HOME, '.claude', 'skills', dir, 'SKILL.md')

type Extras = Partial<Pick<RouteContext, 'auth' | 'role' | 'tokenAgentId' | 'agentId' | 'tenantId'>>
const ADMIN: Extras = { auth: { kind: 'session', user: 'user-a' }, role: 'admin' }
const AGENT_TOKEN: Extras = { auth: { kind: 'token', tokenName: 'token-a' }, role: 'fleet_agent', tokenAgentId: 'agent-a', agentId: 'agent-a' }
const TENANT_VIEWER: Extras = { auth: { kind: 'session', user: 'user-b' }, role: 'viewer', tenantId: 'tenant-a' }

async function call(method: string, path: string, rawBody: string | undefined, extras: Extras) {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { if (rawBody !== undefined) (req as NodeJS.EventEmitter).emit('data', Buffer.from(rawBody)); (req as NodeJS.EventEmitter).emit('end') })
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
const revoke = (id: string, body: unknown, extras: Extras = ADMIN, prefix = '/api') =>
  call('POST', `${prefix}/skills/sql/${encodeURIComponent(id)}/revoke`, typeof body === 'string' ? body : JSON.stringify(body), extras)

const status = (id: string) => (db.prepare('SELECT status FROM skills WHERE id = ?').get(id) as { status: string } | undefined)?.status
const trail = (id: string) => db.prepare('SELECT seq, action, author_kind, author_id, reason, content, content_sha256 FROM skill_revisions WHERE skill_id = ? ORDER BY seq').all(id) as
  Array<{ seq: number; action: string; author_kind: string; author_id: string | null; reason: string | null; content: string | null; content_sha256: string | null }>
const revokeRows = (id: string) => trail(id).filter(r => r.action === 'revoke')

/** A live fleet skill with its generated file on disk, the way the running system has it. */
async function liveSkill(id = 'global/demo-a') {
  await createSkill({ id, name: id, content: BODY, tenant_id: 'fleet', is_global: true }, SYSTEM)
  await regenSingleSkillFile(id)
  return id
}

beforeEach(() => {
  initDatabase(':memory:')
  rmSync(FAKE_PROJECT, { recursive: true, force: true })
  rmSync(join(FAKE_HOME, '.claude'), { recursive: true, force: true })
  mkdirSync(join(FAKE_PROJECT, 'agents', 'agent-a'), { recursive: true })
})

describe('a revoke by the admin', () => {
  it('turns a live skill into a disabled one, writes the revoke row with the actor and the reason, and removes the generated file', async () => {
    const id = await liveSkill()
    expect(existsSync(globalMd('demo-a'))).toBe(true)

    const r = await revoke(id, { reason: 'found to run a downloaded script' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, id, status: 'disabled', files: 'removed' })
    expect(status(id)).toBe('disabled')
    expect(existsSync(globalMd('demo-a'))).toBe(false)

    const rows = trail(id)
    expect(rows.map(x => [x.seq, x.action])).toEqual([[1, 'create'], [2, 'revoke']])
    expect(rows[1]).toMatchObject({ author_kind: 'human', author_id: 'user-a', reason: 'found to run a downloaded script', content: null })
    expect(rows[1].content_sha256).toBe(rows[0].content_sha256) // the text did not change: a revoke is a status change only
  })

  it('trims the reason, and takes the /api/v1 path as well', async () => {
    const id = await liveSkill()
    expect((await revoke(id, { reason: '  withdrawn  ' }, ADMIN, '/api/v1')).status).toBe(200)
    expect(revokeRows(id)[0].reason).toBe('withdrawn')
  })

  it('changes the status and nothing else: text, companion files and the earlier trail stay', async () => {
    const id = await liveSkill()
    await putSkillFile(id, 'ref/a.md', Buffer.from('notes'), 0o644, SYSTEM)
    const before = await getSkill(id)
    const trailBefore = trail(id)
    await revoke(id, { reason: 'because' })
    const after = await getSkill(id)
    expect({ ...after, status: 'x', updated_at: 0 }).toEqual({ ...before, status: 'x', updated_at: 0 })
    expect(db.prepare('SELECT rel_path FROM skill_files WHERE skill_id = ?').all(id)).toEqual([{ rel_path: 'ref/a.md' }])
    expect(trail(id).slice(0, trailBefore.length)).toEqual(trailBefore)
  })

  it('shows in the audit log as an update of the skill, and in the trail an admin reads', async () => {
    const id = await liveSkill()
    await revoke(id, { reason: 'because' })
    const audits = db.prepare("SELECT agent_id, action, entity_id FROM agent_audit_log WHERE entity = 'skill' AND entity_id = ? ORDER BY id").all(id)
    // The create was made by the system actor in the fixture; the revoke is the admin's, named by the session.
    expect(audits).toEqual([{ agent_id: 'system', action: 'create', entity_id: id }, { agent_id: 'user-a', action: 'update', entity_id: id }])
    expect((await listSkillRevisions(id)).map(x => x.action)).toEqual(['create', 'revoke'])
  })

  it('a skill that predates the trail gets its baseline first, so the state at the revoke is on record', async () => {
    db.prepare("INSERT INTO skills (id, name, description, content, tenant_id, is_global) VALUES ('global/old-a', 'old-a', '', ?, 'fleet', 1)").run(BODY)
    expect(trail('global/old-a')).toEqual([])
    expect((await revoke('global/old-a', { reason: 'because' })).status).toBe(200)
    expect(trail('global/old-a').map(x => x.action)).toEqual(['baseline', 'revoke'])
  })

  it('the revoked skill is gone from the agent-facing list and from the regen, and still in the admin list with its status', async () => {
    const id = await liveSkill()
    await liveSkill('global/demo-b')
    await revoke(id, { reason: 'because' })
    expect((await listGlobalFleetSkills()).map(s => s.id)).toEqual(['global/demo-b'])
    expect((await listAllSkills()).find(s => s.id === id)?.status).toBe('disabled')
    await regenSkillFilesFromSQL()
    expect(existsSync(globalMd('demo-a'))).toBe(false)
    expect(existsSync(globalMd('demo-b'))).toBe(true)
  })

  it('a file a person edited by hand stays on disk and the answer says so', async () => {
    const id = await liveSkill()
    writeFileSync(globalMd('demo-a'), `${BODY}# my own change\n`)
    const r = await revoke(id, { reason: 'because' })
    expect(r.status).toBe(200)
    expect(r.body.files).toBe('kept_modified_on_disk')
    expect(status(id)).toBe('disabled')
    expect(readFileSync(globalMd('demo-a'), 'utf-8')).toContain('my own change')
  })

  it('a tenant skill: the generated copy goes from the agent that held it', async () => {
    await createSkill({ id: 'tenant-a-demo', name: 'demo', content: BODY, tenant_id: 'tenant-a' }, SYSTEM)
    db.prepare("INSERT OR IGNORE INTO skill_tenant_access (skill_id, tenant_id) VALUES ('tenant-a-demo', 'tenant-a')").run()
    const copy = join(FAKE_PROJECT, 'agents', 'agent-a', '.claude', 'skills', 'tenant-a-demo', 'SKILL.md')
    mkdirSync(join(FAKE_PROJECT, 'agents', 'agent-a', '.claude', 'skills', 'tenant-a-demo'), { recursive: true })
    // The copy is written by the regen when an agent of the tenant qualifies; here it is put in place the way the regen would.
    const { addGeneratedHeader } = await import('../skill-header.js')
    writeFileSync(copy, addGeneratedHeader(BODY, 'tenant-a-demo', { tenant: true }))
    const r = await revoke('tenant-a-demo', { reason: 'because' })
    expect(r.status).toBe(200)
    expect(status('tenant-a-demo')).toBe('disabled')
    expect(existsSync(copy)).toBe(false)
  })
})

describe('a revoke that has nothing to revoke', () => {
  it('a second revoke is a 409 "disabled" and changes and records nothing', async () => {
    const id = await liveSkill()
    expect((await revoke(id, { reason: 'first' })).status).toBe(200)
    const r = await revoke(id, { reason: 'second' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: 'disabled', current_status: 'disabled' })
    expect(revokeRows(id)).toHaveLength(1)
    expect(revokeRows(id)[0].reason).toBe('first')
  })

  it('two revokes at the same moment: exactly one wins, one trail row', async () => {
    const id = await liveSkill()
    const [a, b] = await Promise.all([revoke(id, { reason: 'one' }), revoke(id, { reason: 'two' })])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    expect(revokeRows(id)).toHaveLength(1)
    expect(status(id)).toBe('disabled')
  })

  it.each(['pending_review', 'expired'] as const)('a %s skill is a 409 "not_live" and stays as it is', async (st) => {
    const id = await liveSkill()
    db.prepare('UPDATE skills SET status = ? WHERE id = ?').run(st, id)
    const r = await revoke(id, { reason: 'because' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: 'not_live', current_status: st })
    expect(status(id)).toBe(st)
    expect(revokeRows(id)).toHaveLength(0)
  })

  it('an id that does not exist is a 404', async () => {
    const r = await revoke('global/never-existed', { reason: 'because' })
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'not_found' })
  })
})

describe('a bad request changes nothing', () => {
  it.each([
    ['no body at all', undefined],
    ['an empty object', '{}'],
    ['an empty reason', '{"reason":""}'],
    ['a blank reason', '{"reason":"   \\n\\t "}'],
    ['a reason that is not a string', '{"reason":42}'],
    ['a reason that is null', '{"reason":null}'],
    ['a reason that is an object', '{"reason":{"text":"x"}}'],
  ])('%s: 400 required', async (_name, raw) => {
    const id = await liveSkill()
    const r = await call('POST', `/api/skills/sql/${encodeURIComponent(id)}/revoke`, raw as string | undefined, ADMIN)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: raw === undefined ? 'parse_error' : 'required' })
    expect(status(id)).toBe('live')
    expect(revokeRows(id)).toHaveLength(0)
    expect(existsSync(globalMd('demo-a'))).toBe(true)
  })

  it('a body that is not JSON: 400 parse_error', async () => {
    const id = await liveSkill()
    const r = await revoke(id, '{reason: nope')
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: 'parse_error' })
    expect(status(id)).toBe('live')
  })

  it('a reason over the limit: 400 invalid_value; one at the limit is taken', async () => {
    const id = await liveSkill()
    const tooLong = await revoke(id, { reason: 'x'.repeat(1001) })
    expect(tooLong.status).toBe(400)
    expect(tooLong.body).toMatchObject({ error: 'invalid_value', field: 'reason' })
    expect(status(id)).toBe('live')
    expect((await revoke(id, { reason: 'x'.repeat(1000) })).status).toBe(200)
  })

  it('a malformed percent-encoding in the id: 400, not a crash', async () => {
    const r = await call('POST', '/api/skills/sql/%zz/revoke', '{"reason":"because"}', ADMIN)
    expect(r.status).toBe(400)
  })
})

describe('who may revoke', () => {
  it('a fleet agent token gets 403, for its own skill and for any other, and the skill stays live', async () => {
    const own = await liveSkill('global/demo-a')
    const r = await revoke(own, { reason: 'because' }, AGENT_TOKEN)
    expect(r.status).toBe(403)
    expect(status(own)).toBe('live')
    expect(revokeRows(own)).toHaveLength(0)
    expect(existsSync(globalMd('demo-a'))).toBe(true)
  })

  it('a refusal is the same for a skill that exists and one that does not (the id is not probed)', async () => {
    const id = await liveSkill()
    for (const extras of [AGENT_TOKEN, TENANT_VIEWER]) {
      const existing = await revoke(id, { reason: 'because' }, extras)
      const missing = await revoke('global/never-existed', { reason: 'because' }, extras)
      expect(existing.status).toBe(403)
      expect(missing).toEqual(existing)
    }
  })

  it('a tenant role gets 403 for its own tenant skill too', async () => {
    await createSkill({ id: 'tenant-a-demo', name: 'demo', content: BODY, tenant_id: 'tenant-a' }, SYSTEM)
    expect((await revoke('tenant-a-demo', { reason: 'because' }, TENANT_VIEWER)).status).toBe(403)
    expect(status('tenant-a-demo')).toBe('live')
  })

  it('RBAC maps the route to admin:all on its own row, for both path shapes and any method (it does not fall under skills:write)', () => {
    expect(resolveRequiredPermission('POST', '/api/skills/sql/global%2Fdemo-a/revoke')).toBe('admin:all')
    expect(resolveRequiredPermission('POST', '/api/skills/sql/global%2Fdemo-a/revoke/')).toBe('admin:all')
    expect(resolveRequiredPermission('GET', '/api/skills/sql/global%2Fdemo-a/revoke')).toBe('admin:all')
    // The skill itself stays where it was.
    expect(resolveRequiredPermission('PUT', '/api/skills/sql/global%2Fdemo-a')).not.toBe('admin:all')
  })
})

describe('the revoke is one transaction', () => {
  it('a failing audit-log insert rolls the status change back too: the skill stays live', async () => {
    const id = await liveSkill()
    db.exec("CREATE TRIGGER break_audit BEFORE INSERT ON agent_audit_log WHEN NEW.entity = 'skill' AND NEW.action = 'update' BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END")
    await expect(revoke(id, { reason: 'because' })).rejects.toThrow('simulated audit failure')
    expect(status(id)).toBe('live')
    expect(revokeRows(id)).toHaveLength(0)
    expect(existsSync(globalMd('demo-a'))).toBe(true)
  })
})
