// POST /api/skills/sql/:id/revoke: live -> disabled in one step, with the trail row and the generated files taken away.
// Real in-memory SQLite, the real route handler and the real regen under a temp home (nothing outside it is touched).
//
// Neutral fixtures only: tenant-a, agent-a, user-a, token-a.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const regenSwitch = vi.hoisted(() => ({ on: true }))
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
  return { ...actual, PROJECT_ROOT: FAKE_PROJECT, MAIN_AGENT_ID: 'main-a', get SKILL_SQL_REGEN() { return regenSwitch.on }, TENANT_SKILL_FILES: 'single' }
})
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'),
  listAgentNames: () => ['agent-a'],
}))

import {
  initDatabase, db, createSkill, getSkill, putSkillFile, listSkillRevisions, listGlobalFleetSkills, listAllSkills,
  cascadeRevokeReason, MAX_REVOKE_REASON_CHARS,
  type SkillActor,
} from '../db.js'
import { tryHandleSkills, summarizeRevokeFiles } from '../web/routes/skills.js'
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
    expect(r.body).toEqual({ ok: true, id, status: 'disabled', cascaded: [], files: 'removed' })
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

  it('a file a person edited by hand is moved aside, and the answer names where', async () => {
    const id = await liveSkill()
    writeFileSync(globalMd('demo-a'), `${BODY}# my own change\n`)
    const r = await revoke(id, { reason: 'because' })
    expect(r.status).toBe(200)
    expect(r.body.files).toBe('quarantined')
    expect(r.body.quarantined).toHaveLength(1)
    expect(status(id)).toBe('disabled')
    expect(existsSync(globalMd('demo-a'))).toBe(false)
    expect(readFileSync(r.body.quarantined[0], 'utf-8')).toContain('my own change')
  })

  it('the generated file goes even when the file regeneration switch is off (the switch cannot keep a revoked skill loadable)', async () => {
    const id = await liveSkill()
    regenSwitch.on = false
    try {
      const r = await revoke(id, { reason: 'because' })
      expect(r.status).toBe(200)
      expect(r.body.files).toBe('removed')
      expect(existsSync(globalMd('demo-a'))).toBe(false)
    } finally {
      regenSwitch.on = true
    }
  })

  it('a second revoke on a skill that predates the trail answers 409 and the trail holds the baseline and one revoke only', async () => {
    db.prepare("INSERT INTO skills (id, name, description, content, tenant_id, is_global) VALUES ('global/old-b', 'old-b', '', ?, 'fleet', 1)").run(BODY)
    expect((await revoke('global/old-b', { reason: 'one' })).status).toBe(200)
    expect((await revoke('global/old-b', { reason: 'two' })).status).toBe(409)
    expect(trail('global/old-b').map(x => x.action)).toEqual(['baseline', 'revoke'])
  })

  it('a withdrawn global skill is not a source for the assign route: 404, and no agent gets a copy or a new live skill', async () => {
    const id = await liveSkill()
    await revoke(id, { reason: 'because' })
    // A leftover directory (a companion file) must not make it copyable either.
    mkdirSync(join(FAKE_HOME, '.claude', 'skills', 'demo-a', 'ref'), { recursive: true })
    writeFileSync(join(FAKE_HOME, '.claude', 'skills', 'demo-a', 'ref', 'a.md'), 'x')
    const r = await call('POST', '/api/skills/demo-a/assign', JSON.stringify({ agents: ['agent-a'] }), ADMIN)
    expect(r.status).toBe(404)
    expect(existsSync(join(FAKE_PROJECT, 'agents', 'agent-a', '.claude', 'skills', 'demo-a'))).toBe(false)
    expect(await getSkill('agent/agent-a/demo-a')).toBeUndefined()
  })

  it('a live global skill is still assignable (the positive control for the 404 above)', async () => {
    await liveSkill()
    const r = await call('POST', '/api/skills/demo-a/assign', JSON.stringify({ agents: ['agent-a'] }), ADMIN)
    expect(r.status).toBe(200)
    expect((await getSkill('agent/agent-a/demo-a'))?.status).toBe('live')
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

/** A live agent-local skill (the row the assign route makes, or one an agent wrote itself) with its generated file on disk. */
async function localCopy(agent: string, name: string, content = BODY) {
  const id = `agent/${agent}/${name}`
  await createSkill({ id, name, content, tenant_id: 'fleet', is_global: false }, SYSTEM)
  await regenSingleSkillFile(id, true)
  return id
}
const localMd = (agent: string, name: string) => join(FAKE_PROJECT, 'agents', agent, '.claude', 'skills', name, 'SKILL.md')
const trailLen = (id: string) => trail(id).length
const failRevisionOf = (skillId: string) =>
  db.exec(`CREATE TRIGGER break_rev BEFORE INSERT ON skill_revisions WHEN NEW.skill_id = '${skillId}' AND NEW.action = 'revoke' BEGIN SELECT RAISE(ABORT, 'simulated revision failure'); END`)

describe('a revoke of a global skill cascades to the agent-local skills of the same name', () => {
  it('disables every live copy with its own revoke row (same actor, cascade reason), and answers with their ids', async () => {
    const id = await liveSkill()
    const a = await localCopy('agent-a', 'demo-a')
    const b = await localCopy('agent-b', 'demo-a')
    const main = await localCopy('main-a', 'demo-a')

    const r = await revoke(id, { reason: 'found to run a downloaded script' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, id, status: 'disabled', cascaded: [a, b, main], files: 'removed' })
    for (const copy of [a, b, main]) {
      expect(status(copy)).toBe('disabled')
      expect(trail(copy).map(x => x.action)).toEqual(['create', 'revoke'])
      expect(revokeRows(copy)[0]).toMatchObject({ author_kind: 'human', author_id: 'user-a', reason: 'cascade from global/demo-a: found to run a downloaded script', content: null })
    }
    expect(revokeRows(id)[0]).toMatchObject({ author_kind: 'human', author_id: 'user-a', reason: 'found to run a downloaded script' })
    // The audit log names the admin for each copy, like for the global skill.
    for (const copy of [a, b, main]) {
      expect(db.prepare("SELECT agent_id, action FROM agent_audit_log WHERE entity = 'skill' AND entity_id = ? ORDER BY id").all(copy))
        .toEqual([{ agent_id: 'system', action: 'create' }, { agent_id: 'user-a', action: 'update' }])
    }
  })

  it('takes the generated file of every copy away (an agent, another agent, the main agent), and the global one', async () => {
    const id = await liveSkill()
    await localCopy('agent-a', 'demo-a')
    await localCopy('agent-b', 'demo-a')
    await localCopy('main-a', 'demo-a')
    expect([existsSync(globalMd('demo-a')), existsSync(localMd('agent-a', 'demo-a')), existsSync(localMd('agent-b', 'demo-a')),
      existsSync(join(FAKE_PROJECT, '.claude', 'skills', 'demo-a', 'SKILL.md'))]).toEqual([true, true, true, true])
    await revoke(id, { reason: 'because' })
    expect(existsSync(globalMd('demo-a'))).toBe(false)
    expect(existsSync(localMd('agent-a', 'demo-a'))).toBe(false)
    expect(existsSync(localMd('agent-b', 'demo-a'))).toBe(false)
    expect(existsSync(join(FAKE_PROJECT, '.claude', 'skills', 'demo-a', 'SKILL.md'))).toBe(false)
  })

  it('works on the copy the assign route makes', async () => {
    const id = await liveSkill()
    expect((await call('POST', '/api/skills/demo-a/assign', JSON.stringify({ agents: ['agent-a'] }), ADMIN)).status).toBe(200)
    expect(existsSync(localMd('agent-a', 'demo-a'))).toBe(true)
    const r = await revoke(id, { reason: 'because' })
    expect(r.body.cascaded).toEqual(['agent/agent-a/demo-a'])
    expect(status('agent/agent-a/demo-a')).toBe('disabled')
    expect(existsSync(localMd('agent-a', 'demo-a'))).toBe(false)
  })

  it('leaves everything that is not an exact copy alone: another name, a longer name, a deeper id, a tenant skill with the name, another global', async () => {
    const id = await liveSkill()
    await liveSkill('global/demo-b')
    const others = [
      await localCopy('agent-a', 'demo-b'),
      await localCopy('agent-a', 'demo-a-2'),
      await localCopy('agent-a', 'demo'),
      await localCopy('agent-a', 'xdemo-a'),
    ]
    await createSkill({ id: 'agent/agent-a/x/demo-a', name: 'demo-a', content: BODY, tenant_id: 'fleet', is_global: false }, SYSTEM)
    others.push('agent/agent-a/x/demo-a')
    await createSkill({ id: 'tenant-a-demo-a', name: 'demo-a', content: BODY, tenant_id: 'tenant-a' }, SYSTEM)
    others.push('tenant-a-demo-a', 'global/demo-b')
    const before = Object.fromEntries(others.map(o => [o, trailLen(o)]))

    const r = await revoke(id, { reason: 'because' })
    expect(r.body.cascaded).toEqual([])
    for (const o of others) {
      expect(status(o)).toBe('live')
      expect(trailLen(o)).toBe(before[o])
    }
    expect(existsSync(localMd('agent-a', 'demo-b'))).toBe(true)
  })

  it('an id with an empty agent segment is not a copy', async () => {
    const id = await liveSkill()
    await createSkill({ id: 'agent//demo-a', name: 'demo-a', content: BODY, tenant_id: 'fleet', is_global: false }, SYSTEM)
    expect((await revoke(id, { reason: 'because' })).body.cascaded).toEqual([])
    expect(status('agent//demo-a')).toBe('live')
  })

  it('a skill row of another tenant whose id looks like an agent copy is left alone (only the fleet rows are copies)', async () => {
    const id = await liveSkill()
    await createSkill({ id: 'agent/agent-a/demo-a', name: 'demo-a', content: BODY, tenant_id: 'tenant-a', is_global: false }, SYSTEM)
    expect((await revoke(id, { reason: 'because' })).body.cascaded).toEqual([])
    expect(status('agent/agent-a/demo-a')).toBe('live')
  })

  it('the name matches exactly, LIKE wildcards in it included: a_b does not reach aXb, a%b does not reach aZZb', async () => {
    for (const [name, lookalike] of [['a_b', 'aXb'], ['a%b', 'aZZb']] as const) {
      const id = await liveSkill(`global/${name}`)
      const exact = await localCopy('agent-a', name)
      const other = await localCopy('agent-a', lookalike)
      const r = await revoke(id, { reason: 'because' })
      expect(r.body.cascaded).toEqual([exact])
      expect(status(exact)).toBe('disabled')
      expect(status(other)).toBe('live')
      expect(revokeRows(other)).toHaveLength(0)
    }
  })

  it('a copy that is already disabled is left out: no new row, still disabled; the live one next to it goes', async () => {
    const id = await liveSkill()
    const done = await localCopy('agent-a', 'demo-a')
    const live = await localCopy('agent-b', 'demo-a')
    db.prepare("UPDATE skills SET status = 'disabled' WHERE id = ?").run(done)
    const before = trail(done)
    const r = await revoke(id, { reason: 'because' })
    expect(r.body.cascaded).toEqual([live])
    expect(trail(done)).toEqual(before)
    expect(status(done)).toBe('disabled')
  })

  it('a copy that is waiting for review or expired is not touched either', async () => {
    const id = await liveSkill()
    const a = await localCopy('agent-a', 'demo-a')
    const b = await localCopy('agent-b', 'demo-a')
    db.prepare("UPDATE skills SET status = 'pending_review' WHERE id = ?").run(a)
    db.prepare("UPDATE skills SET status = 'expired' WHERE id = ?").run(b)
    const r = await revoke(id, { reason: 'because' })
    expect(r.body.cascaded).toEqual([])
    expect([status(a), status(b)]).toEqual(['pending_review', 'expired'])
    expect(revokeRows(a)).toHaveLength(0)
    expect(revokeRows(b)).toHaveLength(0)
  })

  it('the status change of each copy is a compare-and-set: a copy that stopped being live between the two writes is skipped', async () => {
    const id = await liveSkill()
    const a = await localCopy('agent-a', 'demo-a')
    const b = await localCopy('agent-b', 'demo-a')
    // A concurrent writer, simulated: the moment the global skill is disabled, copy a leaves the live state some other way.
    db.exec(`CREATE TRIGGER race AFTER UPDATE OF status ON skills WHEN NEW.id = 'global/demo-a' AND NEW.status = 'disabled'
      BEGIN UPDATE skills SET status = 'pending_review' WHERE id = '${a}'; END`)
    const r = await revoke(id, { reason: 'because' })
    expect(r.status).toBe(200)
    expect(r.body.cascaded).toEqual([b])
    expect(status(a)).toBe('pending_review')
    expect(revokeRows(a)).toHaveLength(0)
    expect(revokeRows(b)).toHaveLength(1)
  })

  it('does not run upward: revoking an agent-local skill leaves the global skill and the other copies live', async () => {
    const id = await liveSkill()
    const a = await localCopy('agent-a', 'demo-a')
    const b = await localCopy('agent-b', 'demo-a')
    const r = await revoke(a, { reason: 'because' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ cascaded: [], files: 'removed' })
    expect(status(a)).toBe('disabled')
    expect([status(id), status(b)]).toEqual(['live', 'live'])
    expect(existsSync(globalMd('demo-a'))).toBe(true)
    expect(existsSync(localMd('agent-b', 'demo-a'))).toBe(true)
    expect(revokeRows(a)[0].reason).toBe('because') // no cascade prefix: this is the revoke itself
  })

  it('a tenant skill has no cascade: its same-named agent-local skills stay live', async () => {
    await createSkill({ id: 'tenant-a-demo-a', name: 'demo-a', content: BODY, tenant_id: 'tenant-a' }, SYSTEM)
    const copy = await localCopy('agent-a', 'demo-a')
    const r = await revoke('tenant-a-demo-a', { reason: 'because' })
    expect(r.status).toBe(200)
    expect(r.body.cascaded).toEqual([])
    expect(status(copy)).toBe('live')
  })

  it('a second revoke of the disabled global skill is a 409 and does not cascade again: a copy made since stays live', async () => {
    const id = await liveSkill()
    await localCopy('agent-a', 'demo-a')
    expect((await revoke(id, { reason: 'first' })).status).toBe(200)
    const late = await localCopy('agent-b', 'demo-a')
    const r = await revoke(id, { reason: 'second' })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: 'disabled' })
    expect(r.body.cascaded).toBeUndefined()
    expect(status(late)).toBe('live')
    expect(revokeRows(late)).toHaveLength(0)
    expect(existsSync(localMd('agent-b', 'demo-a'))).toBe(true)
  })

  it('a global skill that is not live (pending_review) does not cascade, and answers 409', async () => {
    const id = await liveSkill()
    const copy = await localCopy('agent-a', 'demo-a')
    db.prepare("UPDATE skills SET status = 'pending_review' WHERE id = ?").run(id)
    expect((await revoke(id, { reason: 'because' })).status).toBe(409)
    expect(status(copy)).toBe('live')
  })

  it('a copy that predates the trail gets its baseline, and before the global skill does', async () => {
    db.prepare("INSERT INTO skills (id, name, description, content, tenant_id, is_global) VALUES ('global/old-a', 'old-a', '', ?, 'fleet', 1)").run(BODY)
    db.prepare("INSERT INTO skills (id, name, description, content, tenant_id, is_global) VALUES ('agent/agent-a/old-a', 'old-a', '', ?, 'fleet', 0)").run(BODY)
    const r = await revoke('global/old-a', { reason: 'because' })
    expect(r.body.cascaded).toEqual(['agent/agent-a/old-a'])
    expect(trail('agent/agent-a/old-a').map(x => x.action)).toEqual(['baseline', 'revoke'])
    expect(trail('global/old-a').map(x => x.action)).toEqual(['baseline', 'revoke'])
    const baselineRowid = (sid: string) => (db.prepare("SELECT rowid AS n FROM skill_revisions WHERE skill_id = ? AND action = 'baseline'").get(sid) as { n: number }).n
    expect(baselineRowid('agent/agent-a/old-a')).toBeLessThan(baselineRowid('global/old-a'))
  })

  it('a copy that is not live and predates the trail is not even given a baseline', async () => {
    const id = await liveSkill()
    db.prepare("INSERT INTO skills (id, name, description, content, tenant_id, is_global, status) VALUES ('agent/agent-a/demo-a', 'demo-a', '', ?, 'fleet', 0, 'disabled')").run(BODY)
    expect((await revoke(id, { reason: 'because' })).body.cascaded).toEqual([])
    expect(trail('agent/agent-a/demo-a')).toEqual([])
  })

  it('a global skill that is not live gives its copies no baseline either (nothing is written for a 409)', async () => {
    const id = await liveSkill()
    db.prepare("INSERT INTO skills (id, name, description, content, tenant_id, is_global) VALUES ('agent/agent-a/demo-a', 'demo-a', '', ?, 'fleet', 0)").run(BODY)
    db.prepare("UPDATE skills SET status = 'disabled' WHERE id = ?").run(id)
    expect((await revoke(id, { reason: 'because' })).status).toBe(409)
    expect(trail('agent/agent-a/demo-a')).toEqual([])
    expect(status('agent/agent-a/demo-a')).toBe('live')
  })

  it('the reason of a copy fits the limit: a reason at the limit is cut, the global skill keeps it whole', async () => {
    const id = await liveSkill()
    const copy = await localCopy('agent-a', 'demo-a')
    const long = 'x'.repeat(MAX_REVOKE_REASON_CHARS)
    const r = await revoke(id, { reason: long })
    expect(r.status).toBe(200)
    expect(revokeRows(id)[0].reason).toBe(long)
    const cascadeReason = revokeRows(copy)[0].reason as string
    expect(cascadeReason).toHaveLength(MAX_REVOKE_REASON_CHARS)
    expect(cascadeReason.startsWith('cascade from global/demo-a: xxx')).toBe(true)
  })

  it('a short reason is not cut or padded', () => {
    expect(cascadeRevokeReason('global/demo-a', 'because')).toBe('cascade from global/demo-a: because')
    const prefixLen = 'cascade from global/demo-a: '.length
    const exact = 'y'.repeat(MAX_REVOKE_REASON_CHARS - prefixLen)
    expect(cascadeRevokeReason('global/demo-a', exact)).toBe(`cascade from global/demo-a: ${exact}`)
    expect(cascadeRevokeReason('global/demo-a', `${exact}z`)).toHaveLength(MAX_REVOKE_REASON_CHARS)
  })

  it('the cut never leaves half of a surrogate pair', () => {
    const prefixLen = 'cascade from global/demo-a: '.length
    // The emoji straddles the limit: its first half is the last unit that would fit.
    const reason = `${'x'.repeat(MAX_REVOKE_REASON_CHARS - prefixLen - 1)}\u{1F600}tail`
    const out = cascadeRevokeReason('global/demo-a', reason)
    expect(out).toHaveLength(MAX_REVOKE_REASON_CHARS - 1)
    const last = out.charCodeAt(out.length - 1)
    expect(last >= 0xD800 && last <= 0xDBFF).toBe(false)
  })

  it('the generated file of a copy goes even when the file regeneration switch is off', async () => {
    const id = await liveSkill()
    await localCopy('agent-a', 'demo-a')
    regenSwitch.on = false
    try {
      const r = await revoke(id, { reason: 'because' })
      expect(r.body).toMatchObject({ files: 'removed', cascaded: ['agent/agent-a/demo-a'] })
      expect(existsSync(localMd('agent-a', 'demo-a'))).toBe(false)
    } finally {
      regenSwitch.on = true
    }
  })

  it('a hand-edited file of a copy is moved aside like the global one: files quarantined, every path named', async () => {
    const id = await liveSkill()
    await localCopy('agent-a', 'demo-a')
    await localCopy('agent-b', 'demo-a')
    writeFileSync(localMd('agent-a', 'demo-a'), `${BODY}# my own change\n`)
    const r = await revoke(id, { reason: 'because' })
    expect(r.body.files).toBe('quarantined')
    expect(r.body.quarantined).toHaveLength(1)
    expect(readFileSync(r.body.quarantined[0], 'utf-8')).toContain('my own change')
    expect(existsSync(localMd('agent-a', 'demo-a'))).toBe(false)
    expect(existsSync(localMd('agent-b', 'demo-a'))).toBe(false)
  })

  it('a copy whose file cannot be removed makes `files` an error, and the moved-aside paths are still listed; the skills are disabled', async () => {
    const id = await liveSkill()
    const a = await localCopy('agent-a', 'demo-a')
    const b = await localCopy('agent-b', 'demo-a')
    writeFileSync(localMd('agent-a', 'demo-a'), `${BODY}# my own change\n`)
    // A directory where the file should be: it exists, it cannot be read as the generated text, it cannot be unlinked.
    rmSync(localMd('agent-b', 'demo-a'))
    mkdirSync(localMd('agent-b', 'demo-a'))
    const r = await revoke(id, { reason: 'because' })
    expect(r.status).toBe(200)
    expect(r.body.files).toBe('error')
    expect(r.body.quarantined).toHaveLength(1)
    expect([status(id), status(a), status(b)]).toEqual(['disabled', 'disabled', 'disabled'])
    expect(r.body.cascaded).toEqual([a, b])
  })

  it('a copy that has no generated file contributes nothing: `none` when nothing was there at all', async () => {
    const id = await liveSkill()
    await createSkill({ id: 'agent/agent-a/demo-a', name: 'demo-a', content: BODY, tenant_id: 'fleet', is_global: false }, SYSTEM)
    rmSync(globalMd('demo-a'))
    const r = await revoke(id, { reason: 'because' })
    expect(r.body).toEqual({ ok: true, id, status: 'disabled', cascaded: ['agent/agent-a/demo-a'], files: 'none' })
  })
})

describe('the files answer of a revoke that touched several skills', () => {
  it.each([
    [[], 'none'],
    [['none', 'none'], 'none'],
    [['none', 'removed'], 'removed'],
    [['removed', 'removed'], 'removed'],
    [['removed', 'quarantined', 'none'], 'quarantined'],
    [['quarantined', 'removed'], 'quarantined'],
    [['quarantined', 'error'], 'error'],
    [['removed', 'error', 'none'], 'error'],
    [['error'], 'error'],
  ] as const)('%j sums up to %s', (outcomes, expected) => {
    expect(summarizeRevokeFiles(outcomes)).toBe(expected)
  })
})

describe('the cascade is one transaction with the revoke', () => {
  it.each(['agent/agent-a/demo-a', 'agent/agent-b/demo-a'])('a failing trail write for %s rolls everything back: global and copies stay live, no revoke row, files stay', async (failing) => {
    const id = await liveSkill()
    const a = await localCopy('agent-a', 'demo-a')
    const b = await localCopy('agent-b', 'demo-a')
    failRevisionOf(failing)
    await expect(revoke(id, { reason: 'because' })).rejects.toThrow('simulated revision failure')
    for (const s of [id, a, b]) {
      expect(status(s)).toBe('live')
      expect(revokeRows(s)).toHaveLength(0)
    }
    expect([existsSync(globalMd('demo-a')), existsSync(localMd('agent-a', 'demo-a')), existsSync(localMd('agent-b', 'demo-a'))]).toEqual([true, true, true])
  })

  it('a failing audit-log insert for the second copy rolls the first copy and the global skill back too', async () => {
    const id = await liveSkill()
    const a = await localCopy('agent-a', 'demo-a')
    const b = await localCopy('agent-b', 'demo-a')
    db.exec("CREATE TRIGGER break_audit_copy BEFORE INSERT ON agent_audit_log WHEN NEW.entity_id = 'agent/agent-b/demo-a' AND NEW.action = 'update' BEGIN SELECT RAISE(ABORT, 'simulated audit failure'); END")
    await expect(revoke(id, { reason: 'because' })).rejects.toThrow('simulated audit failure')
    for (const s of [id, a, b]) {
      expect(status(s)).toBe('live')
      expect(revokeRows(s)).toHaveLength(0)
    }
  })

  it('a copy that fails after a baseline was written rolls the baseline back too (the skill that predates the trail stays without a trail)', async () => {
    db.prepare("INSERT INTO skills (id, name, description, content, tenant_id, is_global) VALUES ('global/old-a', 'old-a', '', ?, 'fleet', 1)").run(BODY)
    db.prepare("INSERT INTO skills (id, name, description, content, tenant_id, is_global) VALUES ('agent/agent-a/old-a', 'old-a', '', ?, 'fleet', 0)").run(BODY)
    failRevisionOf('agent/agent-a/old-a')
    await expect(revoke('global/old-a', { reason: 'because' })).rejects.toThrow('simulated revision failure')
    expect(status('global/old-a')).toBe('live')
    expect(trail('global/old-a')).toEqual([])
    expect(trail('agent/agent-a/old-a')).toEqual([])
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
