// Route level: who the credential says is writing ends up in the skill trail. Real in-memory SQLite; only the
// on-disk regeneration (a different concern) is stubbed.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, db, createSkill, getSkill } from '../db.js'
import { skillActorFromRoute } from '../web/skill-actor.js'
import { tryHandleSkillSync } from '../web/routes/skill-sync.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import { resolveRequiredPermission } from '../web/rbac.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/skill-regen.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/skill-regen.js')>()),
  regenSingleSkillFile: vi.fn().mockResolvedValue({ reason: 'ok' }),
  removeGeneratedSkillFile: vi.fn().mockResolvedValue(undefined),
  removeGeneratedCompanionFile: vi.fn().mockResolvedValue(undefined),
}))

beforeEach(() => {
  initDatabase(':memory:')
})

type Extras = Partial<Pick<RouteContext, 'auth' | 'role' | 'tokenAgentId' | 'agentId' | 'tenantId'>>

async function call(handler: (c: RouteContext) => Promise<boolean>, method: string, path: string, body: unknown, extras: Extras) {
  const buf = Buffer.from(JSON.stringify(body ?? {}))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) { if (b) { const s = Buffer.isBuffer(b) ? b.toString('utf-8') : b; try { out.body = JSON.parse(s) } catch { out.body = s } } },
  }
  const url = new URL('http://localhost:3420' + path)
  const ctx = { req, res, path: url.pathname, method, url, tenantId: null, ...extras } as unknown as RouteContext
  expect(await handler(ctx)).toBe(true)
  return out
}

const revs = (id: string) => db.prepare('SELECT seq, action, author_kind, author_id, source_ref FROM skill_revisions WHERE skill_id = ? ORDER BY seq').all(id) as
  Array<{ seq: number; action: string; author_kind: string; author_id: string | null; source_ref: string | null }>

const SESSION: Extras = { auth: { kind: 'session', user: 'user-a' }, role: 'admin' }
const AGENT_TOKEN: Extras = { auth: { kind: 'token', tokenName: 'token-a' }, role: 'fleet_agent', tokenAgentId: 'agent-a', agentId: 'agent-a' }

describe('skillActorFromRoute', () => {
  it('a dashboard session is a person: the session user', () => {
    expect(skillActorFromRoute({ auth: { kind: 'session', user: 'user-a' } })).toEqual({ kind: 'human', id: 'user-a' })
  })

  it('a token that belongs to an agent is that agent (the identity comes from the credential)', () => {
    expect(skillActorFromRoute({ auth: { kind: 'token', tokenName: 'token-a' }, tokenAgentId: 'agent-a' })).toEqual({ kind: 'agent', id: 'agent-a' })
  })

  it('any other token is an agent caller named by its label; the legacy dashboard token has no label', () => {
    expect(skillActorFromRoute({ auth: { kind: 'token', tokenName: 'token-b' } })).toEqual({ kind: 'agent', id: 'token-b' })
    expect(skillActorFromRoute({ auth: { kind: 'token' } })).toEqual({ kind: 'agent', id: null })
  })

  it('a session wins over a stray agent id, and no principal at all is the system with no name', () => {
    expect(skillActorFromRoute({ auth: { kind: 'session', user: 'user-a' }, tokenAgentId: 'agent-a' })).toEqual({ kind: 'human', id: 'user-a' })
    expect(skillActorFromRoute({})).toEqual({ kind: 'system', id: null })
    expect(skillActorFromRoute({ auth: { kind: 'federation', peer: 'peer-a' } })).toEqual({ kind: 'system', id: null })
  })

  it('the X-Agent-Id claim is not used: it is the caller\'s own word', () => {
    const ctx = { auth: { kind: 'token' as const }, agentId: 'claimed-agent' } as Pick<RouteContext, 'auth' | 'tokenAgentId'>
    expect(skillActorFromRoute(ctx)).toEqual({ kind: 'agent', id: null })
  })

  it('the operator\'s own named admin token is the operator (the label is the reserved api_tokens row name)', () => {
    expect(skillActorFromRoute({ auth: { kind: 'token', tokenName: 'operator' } })).toEqual({ kind: 'operator', id: 'operator' })
  })

  it('only the exact reserved name is the operator: look-alike or other labels stay agent callers', () => {
    for (const name of ['Operator', 'operator ', ' operator', 'operator2', 'op', 'main-agent:operator', 'dashboard', '']) {
      expect(skillActorFromRoute({ auth: { kind: 'token', tokenName: name } }), JSON.stringify(name)).toEqual({ kind: 'agent', id: name })
    }
    expect(skillActorFromRoute({ auth: { kind: 'token' } })).toEqual({ kind: 'agent', id: null }) // the legacy file token: no label, unchanged
  })

  it('a token that names an agent is that agent first, even with the operator label; a session stays a person', () => {
    expect(skillActorFromRoute({ auth: { kind: 'token', tokenName: 'operator' }, tokenAgentId: 'agent-a' })).toEqual({ kind: 'agent', id: 'agent-a' })
    expect(skillActorFromRoute({ auth: { kind: 'session', user: 'operator' } })).toEqual({ kind: 'human', id: 'operator' })
  })

  it('a claimed agent id does not turn the operator into an agent, and the operator label in a body or header proves nothing', () => {
    const ctx = { auth: { kind: 'token' as const, tokenName: 'operator' }, agentId: 'claimed-agent' } as Pick<RouteContext, 'auth' | 'tokenAgentId'>
    expect(skillActorFromRoute(ctx)).toEqual({ kind: 'operator', id: 'operator' })
    const notOperator = { auth: { kind: 'token' as const, tokenName: 'token-b' }, agentId: 'operator' } as Pick<RouteContext, 'auth' | 'tokenAgentId'>
    expect(skillActorFromRoute(notOperator)).toEqual({ kind: 'agent', id: 'token-b' })
  })
})

describe('POST /api/skill-sync', () => {
  it('an agent token writes back its own skill: the trail names that agent and the hook as the source', async () => {
    const res = await call(tryHandleSkillSync, 'POST', '/api/skill-sync', { kind: 'skill', skill_id: 'agent/agent-a/s', content: 'one' }, AGENT_TOKEN)
    expect(res.body.ok).toBe(true)
    await call(tryHandleSkillSync, 'POST', '/api/skill-sync', { kind: 'skill', skill_id: 'agent/agent-a/s', content: 'two' }, AGENT_TOKEN)
    await call(tryHandleSkillSync, 'POST', '/api/skill-sync', { kind: 'companion', skill_id: 'agent/agent-a/s', rel_path: 'scripts/run.sh', content_base64: Buffer.from('echo').toString('base64'), mode: 0o755 }, AGENT_TOKEN)
    expect(revs('agent/agent-a/s')).toEqual([
      { seq: 1, action: 'create', author_kind: 'agent', author_id: 'agent-a', source_ref: 'skill-sync' },
      { seq: 2, action: 'modify', author_kind: 'agent', author_id: 'agent-a', source_ref: 'skill-sync' },
      { seq: 3, action: 'file_put', author_kind: 'agent', author_id: 'agent-a', source_ref: 'skill-sync' },
    ])
  })

  it('syncing the same text again leaves the trail alone', async () => {
    for (let i = 0; i < 3; i++) await call(tryHandleSkillSync, 'POST', '/api/skill-sync', { kind: 'skill', skill_id: 'agent/agent-a/s', content: 'same' }, AGENT_TOKEN)
    expect(revs('agent/agent-a/s').map((r) => r.action)).toEqual(['create'])
  })

  it('a refused write (another agent\'s skill) leaves no trail', async () => {
    const res = await call(tryHandleSkillSync, 'POST', '/api/skill-sync', { kind: 'skill', skill_id: 'agent/agent-b/s', content: 'x' }, AGENT_TOKEN)
    expect(res.status).toBe(403)
    expect(revs('agent/agent-b/s')).toEqual([])
    expect(await getSkill('agent/agent-b/s')).toBeUndefined()
  })
})

describe('GET /api/v1/skills/sql/:id/revisions', () => {
  const CANARY = 'canary-skill-text-that-must-not-be-returned'
  const get = (id: string, extras: Extras, prefix = '/api/v1') => call(tryHandleSkills, 'GET', `${prefix}/skills/sql/${encodeURIComponent(id)}/revisions`, undefined, extras)
  const USER: Extras = { auth: { kind: 'session', user: 'user-b' }, role: 'viewer', tenantId: 'tenant-x' }

  async function seedTrail() {
    const c = (method: string, path: string, body?: unknown) => call(tryHandleSkills, method, path, body, SESSION)
    await c('PUT', '/api/skills/sql/global%2Fdemo', { content: CANARY })
    await c('PUT', '/api/skills/sql/global%2Fdemo/files/scripts%2Frun.sh', { content: 'echo', mode: 0o755 })
    await c('PUT', '/api/skills/sql/global%2Fdemo', { content: CANARY + ' two', reason: 'ignored by the route' })
  }

  it('an admin gets the trail oldest first, metadata only, with the hashes and the scripts flag as a boolean', async () => {
    await seedTrail()
    const res = await get('global/demo', SESSION)
    expect(res.status).toBe(200)
    expect(res.body.skill_id).toBe('global/demo')
    expect(res.body.revisions.map((r: any) => [r.seq, r.action, r.has_scripts, r.author_kind, r.author_id])).toEqual([
      [1, 'create', false, 'human', 'user-a'], [2, 'file_put', true, 'human', 'user-a'], [3, 'modify', true, 'human', 'user-a'],
    ])
    const first = res.body.revisions[0]
    expect(first.content_sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(res.body.revisions[2].prev_sha256).toBe(res.body.revisions[1].content_sha256)
    expect(Object.keys(first).sort()).toEqual(['action', 'author_id', 'author_kind', 'content_sha256', 'created_at', 'files_sha256', 'has_scripts', 'prev_sha256', 'reason', 'seq', 'source_ref'])
  })

  it('never returns the text, in any field of the response', async () => {
    await seedTrail()
    const res = await get('global/demo', SESSION)
    expect(JSON.stringify(res.body)).not.toContain('canary')
    expect(JSON.stringify(res.body)).not.toContain('echo')
    for (const r of res.body.revisions) expect(r).not.toHaveProperty('content')
  })

  it('the trail of a deleted skill is still there by its id, and an unknown id is an empty list', async () => {
    await seedTrail()
    await call(tryHandleSkills, 'DELETE', '/api/skills/sql/global%2Fdemo', undefined, SESSION)
    expect(await getSkill('global/demo')).toBeUndefined()
    const res = await get('global/demo', SESSION)
    expect(res.body.revisions.map((r: any) => r.action)).toEqual(['create', 'file_put', 'modify', 'delete'])
    expect((await get('global/never-existed', SESSION)).body).toEqual({ skill_id: 'global/never-existed', revisions: [] })
  })

  it('a fleet agent token gets 403, for an existing skill, a deleted one and one that never existed, with the same answer', async () => {
    await seedTrail()
    await createSkill({ id: 'agent/agent-a/mine', name: 'mine', content: 'x', tenant_id: 'fleet' }, { kind: 'system', id: null })
    await call(tryHandleSkills, 'DELETE', '/api/skills/sql/global%2Fdemo', undefined, SESSION)
    const answers = []
    for (const id of ['agent/agent-a/mine', 'global/demo', 'global/never-existed']) answers.push(await get(id, AGENT_TOKEN))
    for (const a of answers) expect(a.status).toBe(403)
    expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1)
    expect(JSON.stringify(answers[0]!.body)).not.toContain('sha256')
  })

  it('a tenant user and an unauthenticated context get 403 too', async () => {
    await seedTrail()
    expect((await get('global/demo', USER)).status).toBe(403)
    expect((await get('global/demo', {})).status).toBe(403)
  })

  it('RBAC holds the route to admin:all (the skills prefix would let every skills:read role in), and the sibling routes keep theirs', () => {
    expect(resolveRequiredPermission('GET', '/api/skills/sql/global%2Fdemo/revisions')).toBe('admin:all')
    expect(resolveRequiredPermission('GET', '/api/skills/sql/global%2Fdemo/revisions/')).toBe('admin:all')
    expect(resolveRequiredPermission('GET', '/api/skills/sql/global%2Fdemo/access')).toBe('admin:all')
    expect(resolveRequiredPermission('GET', '/api/skills/sql/global%2Fdemo/files')).toBe('skills:read')
    expect(resolveRequiredPermission('GET', '/api/skills/sql/global%2Fdemo')).toBe('skills:read')
  })

  it('the legacy /api alias answers the same, and a malformed id is a 400 for an admin', async () => {
    await seedTrail()
    expect((await get('global/demo', SESSION, '/api')).body.revisions).toHaveLength(3)
    const res = await call(tryHandleSkills, 'GET', '/api/v1/skills/sql/%E0%A4%A/revisions', undefined, SESSION)
    expect(res.status).toBe(400)
  })
})

describe('/api/skills/sql', () => {
  it('create, update, a companion file and delete by a dashboard user are all traced to that user', async () => {
    const c = (method: string, path: string, body?: unknown) => call(tryHandleSkills, method, path, body, SESSION)
    expect((await c('PUT', '/api/skills/sql/global%2Fdemo', { content: '---\ndescription: demo\n---\nbody' })).status).toBe(201)
    expect((await c('PUT', '/api/skills/sql/global%2Fdemo', { content: 'body two' })).body.ok).toBe(true)
    expect((await c('PUT', '/api/skills/sql/global%2Fdemo/files/scripts%2Frun.sh', { content: 'echo' })).body.ok).toBe(true)
    expect((await c('DELETE', '/api/skills/sql/global%2Fdemo/files/scripts%2Frun.sh')).body.ok).toBe(true)
    expect((await c('DELETE', '/api/skills/sql/global%2Fdemo')).body.ok).toBe(true)
    expect(revs('global/demo')).toEqual([
      { seq: 1, action: 'create', author_kind: 'human', author_id: 'user-a', source_ref: null },
      { seq: 2, action: 'modify', author_kind: 'human', author_id: 'user-a', source_ref: null },
      { seq: 3, action: 'file_put', author_kind: 'human', author_id: 'user-a', source_ref: null },
      { seq: 4, action: 'file_delete', author_kind: 'human', author_id: 'user-a', source_ref: null },
      { seq: 5, action: 'delete', author_kind: 'human', author_id: 'user-a', source_ref: null },
    ])
    expect(await getSkill('global/demo')).toBeUndefined()
  })

  it('an admin API token is traced as an agent caller named by the token label', async () => {
    const token: Extras = { auth: { kind: 'token', tokenName: 'token-b' }, role: 'admin' }
    await call(tryHandleSkills, 'PUT', '/api/skills/sql/global%2Ftok', { content: 'one' }, token)
    await call(tryHandleSkills, 'PUT', '/api/skills/sql/global%2Ftok', { content: 'two' }, token)
    expect(revs('global/tok').map((r) => [r.action, r.author_kind, r.author_id])).toEqual([['create', 'agent', 'token-b'], ['modify', 'agent', 'token-b']])
  })

  it('the operator token writes a trail row of kind operator, a fake X-Agent-Id does not change it, an agent token stays an agent', async () => {
    const operator: Extras = { auth: { kind: 'token', tokenName: 'operator' }, role: 'admin', agentId: 'claimed-agent' }
    await call(tryHandleSkills, 'PUT', '/api/skills/sql/global%2Fop', { content: 'one' }, operator)
    await call(tryHandleSkills, 'PUT', '/api/skills/sql/global%2Fop', { content: 'two' }, operator)
    expect(revs('global/op').map((r) => [r.action, r.author_kind, r.author_id])).toEqual([['create', 'operator', 'operator'], ['modify', 'operator', 'operator']])
    // an agent token whose request CLAIMS to be the operator (the claimed id is the only thing the request controls)
    const agent: Extras = { auth: { kind: 'token', tokenName: 'token-a' }, role: 'admin', tokenAgentId: 'agent-a', agentId: 'operator' }
    await call(tryHandleSkills, 'PUT', '/api/skills/sql/global%2Fclaim', { content: 'x' }, agent)
    expect(revs('global/claim').map((r) => [r.author_kind, r.author_id])).toEqual([['agent', 'agent-a']])
    await call(tryHandleSkills, 'PUT', '/api/skills/sql/global%2Fsess', { content: 'x' }, SESSION)
    expect(revs('global/sess').map((r) => [r.author_kind, r.author_id])).toEqual([['human', 'user-a']])
  })

  it('a refused write (an agent token on a global skill) leaves skill and trail untouched', async () => {
    await createSkill({ id: 'global/shared', name: 'shared', content: 'original', tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
    const res = await call(tryHandleSkills, 'PUT', '/api/skills/sql/global%2Fshared', { content: 'hijack' }, AGENT_TOKEN)
    expect(res.status).toBe(403)
    expect((await getSkill('global/shared'))?.content).toBe('original')
    expect(revs('global/shared').map((r) => r.action)).toEqual(['create'])
  })

  it('a trail failure surfaces as an error and the skill is not changed', async () => {
    await createSkill({ id: 'global/shared', name: 'shared', content: 'original', tenant_id: 'fleet', is_global: true }, { kind: 'system', id: null })
    db.exec("CREATE TRIGGER break_trail BEFORE INSERT ON skill_revisions WHEN NEW.action = 'modify' BEGIN SELECT RAISE(ABORT, 'simulated trail failure'); END")
    const failing = call(tryHandleSkills, 'PUT', '/api/skills/sql/global%2Fshared', { content: 'changed' }, SESSION)
    await expect(failing).rejects.toThrow('simulated trail failure')
    expect((await getSkill('global/shared'))?.content).toBe('original')
  })
})
