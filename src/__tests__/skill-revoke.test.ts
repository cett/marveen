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
// A pass-through view of the db module (a Proxy, so the live `db` binding stays live) whose only difference is a hook
// that runs just before listSkillFiles: the DELETE route awaits it between its status read and its write, which is the
// place the interleave tests below commit a revoke at, deterministically.
const raceHook = vi.hoisted(() => ({ beforeListSkillFiles: null as null | (() => Promise<void>) }))
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return new Proxy(actual, {
    get(target, key, receiver) {
      if (key === 'listSkillFiles') {
        return async (...args: Parameters<typeof actual.listSkillFiles>) => {
          const hook = raceHook.beforeListSkillFiles
          if (hook) await hook()
          return actual.listSkillFiles(...args)
        }
      }
      return Reflect.get(target, key, receiver)
    },
  })
})
vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  AGENTS_BASE_DIR: join(FAKE_PROJECT, 'agents'),
  listAgentNames: () => ['agent-a'],
}))

import {
  initDatabase, db, createSkill, getSkill, putSkillFile, updateSkill, deleteSkill, listSkillRevisions, listGlobalFleetSkills, listAllSkills,
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

// `bodyGate`: the request body arrives only when this promise resolves (a client that sends its body late), so a test can
// commit a revoke while the handler is parked in readBody, after its status read and before its write.
async function call(method: string, path: string, rawBody: string | undefined, extras: Extras, bodyGate?: Promise<void>) {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  const sendBody = () => { if (rawBody !== undefined) (req as NodeJS.EventEmitter).emit('data', Buffer.from(rawBody)); (req as NodeJS.EventEmitter).emit('end') }
  if (bodyGate) void bodyGate.then(sendBody)
  else setImmediate(sendBody)
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
async function liveSkill(id = 'global/demo-a', description = '') {
  await createSkill({ id, name: id, description, content: BODY, tenant_id: 'fleet', is_global: true }, SYSTEM)
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
async function localCopy(agent: string, name: string, content = BODY, description = '') {
  const id = `agent/${agent}/${name}`
  await createSkill({ id, name, description, content, tenant_id: 'fleet', is_global: false }, SYSTEM)
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

// A revoke has to freeze the text: a caller who is not an admin gets the answer for a skill that is not there on PUT and
// DELETE of a skill that is not live, the same as GET and the companion-file routes already gave.
describe('a caller who is not an admin cannot edit or delete a skill that is not live', () => {
  const NOT_LIVE = ['disabled', 'pending_review', 'expired'] as const
  const AGENT_SKILL = 'agent/agent-a/demo-a'
  const TENANT_SKILL = 'tenant-a-demo'
  // description unchanged from BODY's: a body-text-only edit, so the privilege gate (a changed description is a
  // privilege key, see skill-privilege.ts) never fires here -- this describe block is about the requireLive CAS, not the gate.
  const NEW_BODY = '---\nname: demo\ndescription: d\n---\n# changed body\n'
  const put = (id: string, content: string, extras: Extras, prefix = '/api') =>
    call('PUT', `${prefix}/skills/sql/${encodeURIComponent(id)}`, JSON.stringify({ content }), extras)
  const del = (id: string, extras: Extras, prefix = '/api') =>
    call('DELETE', `${prefix}/skills/sql/${encodeURIComponent(id)}`, undefined, extras)
  const setStatus = (id: string, s: string) => { db.prepare('UPDATE skills SET status = ? WHERE id = ?').run(s, id) }
  const contentOf = (id: string) => (db.prepare('SELECT content FROM skills WHERE id = ?').get(id) as { content: string } | undefined)?.content
  // description 'd' matches BODY's own frontmatter: a same-description edit never touches the privilege gate (a changed
  // description is a privilege key, see skill-privilege.ts), so these fixtures stay about the requireLive CAS only.
  const tenantSkill = async (): Promise<string> => { await createSkill({ id: TENANT_SKILL, name: 'demo', description: 'd', content: BODY, tenant_id: 'tenant-a' }, SYSTEM); return TENANT_SKILL }

  describe.each([
    ['a fleet agent token on its own agent skill', AGENT_TOKEN, async (): Promise<string> => { await localCopy('agent-a', 'demo-a', BODY, 'd'); return AGENT_SKILL }, 'agent/agent-a/never-existed-a'],
    ['a tenant user on the skill of its own tenant', TENANT_VIEWER, tenantSkill, 'tenant-a-never-existed-a'],
  ] as const)('%s', (_label, extras, make, missingId) => {
    it.each(NOT_LIVE)('PUT on a %s skill: 404, the text, the status and the trail stay', async (st) => {
      const id = await make()
      setStatus(id, st)
      const before = { content: contentOf(id), status: status(id), trail: trail(id), audits: db.prepare("SELECT COUNT(*) AS n FROM agent_audit_log WHERE entity = 'skill' AND entity_id = ?").get(id) }
      const r = await put(id, NEW_BODY, extras)
      expect(r.status).toBe(404)
      expect(r.body).toEqual({ error: 'not_found' })
      expect(contentOf(id)).toBe(before.content)
      expect(status(id)).toBe(st)
      expect(trail(id)).toEqual(before.trail)
      expect(db.prepare("SELECT COUNT(*) AS n FROM agent_audit_log WHERE entity = 'skill' AND entity_id = ?").get(id)).toEqual(before.audits)
    })

    it.each(NOT_LIVE)('DELETE of a %s skill: 404, the row, its companion files and the trail stay', async (st) => {
      const id = await make()
      await putSkillFile(id, 'ref/a.md', Buffer.from('notes'), 0o644, SYSTEM)
      setStatus(id, st)
      const trailBefore = trail(id)
      const r = await del(id, extras)
      expect(r.status).toBe(404)
      expect(r.body).toEqual({ error: 'not_found' })
      expect(status(id)).toBe(st)
      expect(db.prepare('SELECT rel_path FROM skill_files WHERE skill_id = ?').all(id)).toEqual([{ rel_path: 'ref/a.md' }])
      expect(trail(id)).toEqual(trailBefore)
    })

    it('the 404 is byte for byte the answer for an id that does not exist (the write is not an oracle), on /api and /api/v1', async () => {
      const id = await make()
      setStatus(id, 'disabled')
      for (const prefix of ['/api', '/api/v1']) {
        const goneDel = await del(missingId, extras, prefix)
        expect(goneDel.status).toBe(404)
        expect(await del(id, extras, prefix)).toEqual(goneDel)
        if (extras === TENANT_VIEWER) {
          // A fleet agent PUT to a missing file-backed id of its own is the create branch (201, by design), so only the
          // tenant caller has a missing-id PUT to compare with.
          const gonePut = await put(missingId, NEW_BODY, extras, prefix)
          expect(gonePut.status).toBe(404)
          expect(await put(id, NEW_BODY, extras, prefix)).toEqual(gonePut)
        } else {
          expect(await put(id, NEW_BODY, extras, prefix)).toEqual(goneDel)
        }
      }
    })

    it('a revoked skill (the real route) is frozen as well: PUT and DELETE both 404, the text is the one at the revoke', async () => {
      const id = await make()
      // Only the admin can revoke: the caller under test then tries to write.
      expect((await revoke(id, { reason: 'because' }, ADMIN)).status).toBe(200)
      expect((await put(id, NEW_BODY, extras)).status).toBe(404)
      expect((await del(id, extras)).status).toBe(404)
      expect(contentOf(id)).toBe(BODY)
      expect(status(id)).toBe('disabled')
      expect(revokeRows(id)).toHaveLength(1)
    })

    it('positive control: the same caller still edits and deletes its own LIVE skill', async () => {
      const id = await make()
      const r = await put(id, NEW_BODY, extras)
      expect(r.status).toBe(200)
      expect(contentOf(id)).toBe(NEW_BODY)
      expect(status(id)).toBe('live')
      expect((await del(id, extras)).status).toBe(200)
      expect(status(id)).toBeUndefined()
    })
  })

  it('the order of refusals holds: a fleet agent gets 403 for a skill that is not its own, live or not, before any 404 for status', async () => {
    await localCopy('agent-b', 'demo-a')
    setStatus('agent/agent-b/demo-a', 'disabled')
    expect((await put('agent/agent-b/demo-a', NEW_BODY, AGENT_TOKEN)).status).toBe(403)
    expect((await del('agent/agent-b/demo-a', AGENT_TOKEN)).status).toBe(403)
    expect(status('agent/agent-b/demo-a')).toBe('disabled')
  })

  it('a fleet agent PUT to a file-backed id that has no row is still a create (201): the create branch is untouched', async () => {
    const r = await put('agent/agent-a/fresh-a', BODY, AGENT_TOKEN)
    expect(r.status).toBe(201)
    expect(status('agent/agent-a/fresh-a')).toBe('live')
  })

  it('the delete-then-create chain stops at the first step: a copy the cascade disabled cannot be deleted and re-created live by its agent', async () => {
    const global = await liveSkill()
    const copy = await localCopy('agent-a', 'demo-a')
    expect((await revoke(global, { reason: 'because' }, ADMIN)).status).toBe(200)
    expect(status(copy)).toBe('disabled')
    expect(existsSync(localMd('agent-a', 'demo-a'))).toBe(false)
    const trailBefore = trail(copy)

    // Step 1: the delete is refused, the disabled row stays.
    const d = await del(copy, AGENT_TOKEN)
    expect(d.status).toBe(404)
    expect(status(copy)).toBe('disabled')
    // Step 2 cannot start from a deleted row either: the PUT on the still existing disabled row is refused too, so no
    // new live row and no generated file appear.
    const p = await put(copy, NEW_BODY, AGENT_TOKEN)
    expect(p.status).toBe(404)
    expect(status(copy)).toBe('disabled')
    expect(contentOf(copy)).toBe(BODY)
    expect(db.prepare('SELECT COUNT(*) AS n FROM skills WHERE id = ?').get(copy)).toEqual({ n: 1 })
    expect(trail(copy)).toEqual(trailBefore)
    expect(existsSync(localMd('agent-a', 'demo-a'))).toBe(false)
  })

  it.each([
    ['a global skill', 'global/demo-a', 'fleet', AGENT_TOKEN, 403],
    ['a tenant skill', TENANT_SKILL, 'tenant-a', TENANT_VIEWER, 404],
    ['an agent-local skill', AGENT_SKILL, 'fleet', AGENT_TOKEN, 404],
  ] as const)('%s: the not-live guard is not limited to one skill type (non-admin PUT and DELETE of the disabled row are refused, the row stays)', async (_label, id, tenant, extras, expected) => {
    await createSkill({ id, name: 'demo', content: BODY, tenant_id: tenant, is_global: id.startsWith('global/') }, SYSTEM)
    setStatus(id, 'disabled')
    // A global skill is not writable for these callers at all (403 comes first); the two others reach the status check.
    expect((await put(id, NEW_BODY, extras)).status).toBe(expected)
    expect((await del(id, extras)).status).toBe(expected)
    expect(status(id)).toBe('disabled')
    expect(contentOf(id)).toBe(BODY)
  })

  it('a tenant user cannot reach a not-live skill of another tenant either (404 as before)', async () => {
    await createSkill({ id: 'tenant-b-demo', name: 'demo', content: BODY, tenant_id: 'tenant-b' }, SYSTEM)
    expect((await put('tenant-b-demo', NEW_BODY, TENANT_VIEWER)).status).toBe(404)
    expect((await del('tenant-b-demo', TENANT_VIEWER)).status).toBe(404)
    expect(status('tenant-b-demo')).toBe('live')
  })

  describe('the admin is not affected', () => {
    it.each(NOT_LIVE)('PUT on a %s skill still works: the text changes and the status is not changed by it', async (st) => {
      const id = await liveSkill('global/demo-a', 'd')
      setStatus(id, st)
      const r = await put(id, NEW_BODY, ADMIN)
      expect(r.status).toBe(200)
      expect(contentOf(id)).toBe(NEW_BODY)
      expect(status(id)).toBe(st)
    })

    it.each(NOT_LIVE)('DELETE of a %s skill still works', async (st) => {
      const id = await liveSkill()
      setStatus(id, st)
      expect((await del(id, ADMIN)).status).toBe(200)
      expect(status(id)).toBeUndefined()
    })

    it('an admin edit of a tenant skill that is disabled works too', async () => {
      const id = await tenantSkill()
      setStatus(id, 'disabled')
      expect((await put(id, NEW_BODY, ADMIN)).status).toBe(200)
      expect(contentOf(id)).toBe(NEW_BODY)
    })
  })
})

// The status is not only read at the top of the route: a revoke that commits between that read and the write (the body of a
// PUT can arrive late, a DELETE awaits its companion-file read) must be honoured by the write itself.
describe('a revoke that commits between the route read and the write is not written over', () => {
  const AGENT_SKILL = 'agent/agent-a/demo-a'
  const TENANT_SKILL = 'tenant-a-demo'
  // description unchanged from BODY's, same reason as the sibling describe block above.
  const NEW_BODY = '---\nname: demo\ndescription: d\n---\n# changed body\n'
  const contentOf = (id: string) => (db.prepare('SELECT content FROM skills WHERE id = ?').get(id) as { content: string } | undefined)?.content
  const trailActions = (id: string) => trail(id).map(r => r.action)
  const tick = () => new Promise<void>(r => setTimeout(r, 25))
  const urlOf = (id: string, prefix = '/api') => `${prefix}/skills/sql/${encodeURIComponent(id)}`
  const makeAgentSkill = async () => { await localCopy('agent-a', 'demo-a', BODY, 'd'); return AGENT_SKILL }
  const makeTenantSkill = async () => { await createSkill({ id: TENANT_SKILL, name: 'demo', description: 'd', content: BODY, tenant_id: 'tenant-a' }, SYSTEM); return TENANT_SKILL }

  /** A non-admin PUT whose body is still on the wire: it has passed the status read and waits in readBody. */
  async function slowPut(id: string, extras: Extras, prefix = '/api') {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const pending = call('PUT', urlOf(id, prefix), JSON.stringify({ content: NEW_BODY }), extras, gate)
    await tick()
    return { release, pending }
  }

  beforeEach(() => { raceHook.beforeListSkillFiles = null })
  afterAll(() => { raceHook.beforeListSkillFiles = null })

  describe.each([
    ['a fleet agent token on its own agent skill', AGENT_TOKEN, makeAgentSkill],
    ['a tenant user on the skill of its own tenant', TENANT_VIEWER, makeTenantSkill],
  ] as const)('%s', (_label, extras, make) => {
    it('PUT: the revoke commits while the body is on the wire: 404, the text, the status and the trail stay as the revoke left them', async () => {
      const id = await make()
      const { release, pending } = await slowPut(id, extras)
      expect((await revoke(id, { reason: 'because' }, ADMIN)).status).toBe(200)
      expect(status(id)).toBe('disabled')
      release()
      const r = await pending
      expect(r.status).toBe(404)
      expect(r.body).toEqual({ error: 'not_found' })
      expect(contentOf(id)).toBe(BODY)
      expect(status(id)).toBe('disabled')
      expect(trailActions(id)).toEqual(['create', 'revoke'])
      expect(existsSync(localMd('agent-a', 'demo-a'))).toBe(false)
    })

    it('PUT: the same on /api/v1', async () => {
      const id = await make()
      const { release, pending } = await slowPut(id, extras, '/api/v1')
      expect((await revoke(id, { reason: 'because' }, ADMIN, '/api/v1')).status).toBe(200)
      release()
      expect((await pending).status).toBe(404)
      expect(contentOf(id)).toBe(BODY)
    })

    it('DELETE: the revoke commits between the status read and the write: 404, the row, its companion files and the trail stay', async () => {
      const id = await make()
      await putSkillFile(id, 'ref/a.md', Buffer.from('notes'), 0o644, SYSTEM)
      raceHook.beforeListSkillFiles = async () => {
        raceHook.beforeListSkillFiles = null
        expect((await revoke(id, { reason: 'because' }, ADMIN)).status).toBe(200)
      }
      const r = await call('DELETE', urlOf(id), undefined, extras)
      expect(r.status).toBe(404)
      expect(r.body).toEqual({ error: 'not_found' })
      expect(status(id)).toBe('disabled')
      expect(db.prepare('SELECT rel_path FROM skill_files WHERE skill_id = ?').all(id)).toEqual([{ rel_path: 'ref/a.md' }])
      // No delete row: the trail is what the setup and the revoke wrote.
      expect(trailActions(id)).toEqual(['create', 'file_put', 'revoke'])
    })

    it('positive control: the same interleave without a revoke still lets the caller edit and delete its own live skill', async () => {
      const id = await make()
      const { release, pending } = await slowPut(id, extras)
      release()
      expect((await pending).status).toBe(200)
      expect(contentOf(id)).toBe(NEW_BODY)
      let hookRan = false
      raceHook.beforeListSkillFiles = () => { hookRan = true; return Promise.resolve() }
      expect((await call('DELETE', urlOf(id), undefined, extras)).status).toBe(200)
      expect(hookRan).toBe(true)
      expect(status(id)).toBeUndefined()
    })
  })

  it('the delete-then-create chain does not come alive through the race: a cascaded copy cannot be deleted in flight and re-created live', async () => {
    const global = await liveSkill()
    const copy = await localCopy('agent-a', 'demo-a')
    raceHook.beforeListSkillFiles = async () => {
      raceHook.beforeListSkillFiles = null
      expect((await revoke(global, { reason: 'because' }, ADMIN)).status).toBe(200)
    }
    // The agent's DELETE passed the status read while its copy was live; the cascade commits before the write.
    const d = await call('DELETE', urlOf(copy), undefined, AGENT_TOKEN)
    expect(d.status).toBe(404)
    expect(status(copy)).toBe('disabled')
    // The second step of the chain: with the row still there and disabled, the PUT is refused as well.
    const p = await call('PUT', urlOf(copy), JSON.stringify({ content: NEW_BODY }), AGENT_TOKEN)
    expect(p.status).toBe(404)
    expect(status(copy)).toBe('disabled')
    expect(contentOf(copy)).toBe(BODY)
    expect(existsSync(localMd('agent-a', 'demo-a'))).toBe(false)
  })

  describe('the admin is not affected by the race guard', () => {
    it('an admin PUT that is in flight when the revoke commits still writes (the admin edits a disabled skill), the status stays disabled', async () => {
      const id = await liveSkill('global/demo-a', 'd')
      let release!: () => void
      const gate = new Promise<void>(r => { release = r })
      const pending = call('PUT', urlOf(id), JSON.stringify({ content: NEW_BODY }), ADMIN, gate)
      await tick()
      expect((await revoke(id, { reason: 'because' }, ADMIN)).status).toBe(200)
      release()
      expect((await pending).status).toBe(200)
      expect(contentOf(id)).toBe(NEW_BODY)
      expect(status(id)).toBe('disabled')
    })

    it('an admin DELETE in flight when the revoke commits still deletes', async () => {
      const id = await liveSkill()
      raceHook.beforeListSkillFiles = async () => {
        raceHook.beforeListSkillFiles = null
        expect((await revoke(id, { reason: 'because' }, ADMIN)).status).toBe(200)
      }
      expect((await call('DELETE', urlOf(id), undefined, ADMIN)).status).toBe(200)
      expect(status(id)).toBeUndefined()
    })
  })

  describe('the db layer: requireLive is decided inside the write', () => {
    const baselineCount = (id: string) => (db.prepare('SELECT COUNT(*) AS n FROM skill_revisions WHERE skill_id = ?').get(id) as { n: number }).n

    it('updateSkill with requireLive on a not-live row: not_found, nothing changes (text, status, trail)', async () => {
      for (const st of ['disabled', 'pending_review', 'expired'] as const) {
        const id = `demo-${st}`
        await createSkill({ id, name: 'demo', content: BODY, tenant_id: 'tenant-a' }, SYSTEM)
        db.prepare('UPDATE skills SET status = ? WHERE id = ?').run(st, id)
        const before = { n: baselineCount(id), updated: (db.prepare('SELECT updated_at FROM skills WHERE id = ?').get(id) as { updated_at: number }).updated_at }
        expect((await updateSkill(id, { content: NEW_BODY }, SYSTEM, {}, { requireLive: true })).outcome).toBe('not_found')
        expect(contentOf(id)).toBe(BODY)
        expect(status(id)).toBe(st)
        expect(baselineCount(id)).toBe(before.n)
        expect((db.prepare('SELECT updated_at FROM skills WHERE id = ?').get(id) as { updated_at: number }).updated_at).toBe(before.updated)
      }
    })

    it('updateSkill: a missing row with requireLive is not_found; without it a not-live row is written (the admin path)', async () => {
      expect((await updateSkill('never-existed', { content: NEW_BODY }, SYSTEM, {}, { requireLive: true })).outcome).toBe('not_found')
      await createSkill({ id: 'demo-x', name: 'demo', content: BODY, tenant_id: 'tenant-a' }, SYSTEM)
      db.prepare("UPDATE skills SET status = 'disabled' WHERE id = 'demo-x'").run()
      const result = await updateSkill('demo-x', { content: NEW_BODY }, SYSTEM)
      expect(result.outcome === 'updated' && result.skill.status).toBe('disabled')
      expect(contentOf('demo-x')).toBe(NEW_BODY)
    })

    it('updateSkill with requireLive on a live row writes as before', async () => {
      await createSkill({ id: 'demo-y', name: 'demo', content: BODY, tenant_id: 'tenant-a' }, SYSTEM)
      const result = await updateSkill('demo-y', { content: NEW_BODY }, SYSTEM, {}, { requireLive: true })
      expect(result.outcome === 'updated' && result.skill.status).toBe('live')
      expect(contentOf('demo-y')).toBe(NEW_BODY)
    })

    it('deleteSkill with requireLive on a not-live row: false, the row, its files and the trail stay', async () => {
      for (const st of ['disabled', 'pending_review', 'expired'] as const) {
        const id = `demo-${st}`
        await createSkill({ id, name: 'demo', content: BODY, tenant_id: 'tenant-a' }, SYSTEM)
        await putSkillFile(id, 'ref/a.md', Buffer.from('notes'), 0o644, SYSTEM)
        db.prepare('UPDATE skills SET status = ? WHERE id = ?').run(st, id)
        const before = baselineCount(id)
        expect(await deleteSkill(id, SYSTEM, {}, { requireLive: true })).toBe(false)
        expect(status(id)).toBe(st)
        expect(db.prepare('SELECT rel_path FROM skill_files WHERE skill_id = ?').all(id)).toEqual([{ rel_path: 'ref/a.md' }])
        expect(baselineCount(id)).toBe(before)
      }
    })

    it('deleteSkill: requireLive on a live row deletes it; without it a not-live row is deleted (the admin path)', async () => {
      await createSkill({ id: 'demo-live', name: 'demo', content: BODY, tenant_id: 'tenant-a' }, SYSTEM)
      expect(await deleteSkill('demo-live', SYSTEM, {}, { requireLive: true })).toBe(true)
      expect(status('demo-live')).toBeUndefined()
      await createSkill({ id: 'demo-off', name: 'demo', content: BODY, tenant_id: 'tenant-a' }, SYSTEM)
      db.prepare("UPDATE skills SET status = 'disabled' WHERE id = 'demo-off'").run()
      expect(await deleteSkill('demo-off', SYSTEM)).toBe(true)
      expect(status('demo-off')).toBeUndefined()
    })
  })
})
