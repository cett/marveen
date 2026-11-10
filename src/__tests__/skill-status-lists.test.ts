// Only a live skill reaches an agent, a tenant caller or an export. Real in-memory SQLite and the real route handler;
// the on-disk regeneration (covered in skill-status-regen.test.ts) is stubbed.
//
// Neutral fixtures only: tenant-a / tenant-b, agent-a / agent-b, user-a.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  initDatabase, db, createSkill, getSkill, grantSkillAccess, listAllSkills, listLiveSkills, listSkillsForTenant,
  listAgentOwnedSkills, listGlobalFleetSkills, type SkillActor,
} from '../db.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../web/skill-regen.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/skill-regen.js')>()),
  regenSingleSkillFile: vi.fn().mockResolvedValue({ reason: 'ok' }),
  removeGeneratedSkillFile: vi.fn().mockResolvedValue(undefined),
  removeGeneratedCompanionFile: vi.fn().mockResolvedValue(undefined),
}))

const ACTOR: SkillActor = { kind: 'system', id: null }
const BODY = '---\nname: x\ndescription: d\n---\nbody\n'

async function seed(id: string, tenant: string, status: 'live' | 'pending_review' | 'disabled' | 'expired' = 'live') {
  await createSkill({ id, name: id, content: BODY, tenant_id: tenant, is_global: tenant === 'fleet' && id.startsWith('global/') }, ACTOR)
  if (status !== 'live') db.prepare('UPDATE skills SET status = ? WHERE id = ?').run(status, id)
}
const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id).sort()

beforeEach(() => {
  initDatabase(':memory:')
})

describe('the DB lists', () => {
  beforeEach(async () => {
    await seed('global/live-g', 'fleet')
    await seed('global/off-g', 'fleet', 'disabled')
    await seed('agent/agent-a/live-a', 'fleet')
    await seed('agent/agent-a/off-a', 'fleet', 'disabled')
    await seed('agent/agent-a/pending-a', 'fleet', 'pending_review')
    await seed('tenant-a-live', 'tenant-a')
    await seed('tenant-a-off', 'tenant-a', 'disabled')
    await seed('tenant-b-live', 'tenant-b')
    await seed('tenant-b-expired', 'tenant-b', 'expired')
    await grantSkillAccess('tenant-b-live', 'tenant-a')
    await grantSkillAccess('tenant-b-expired', 'tenant-a')
  })

  it('a new skill is live without the writer naming a status', async () => {
    expect((await getSkill('global/live-g'))?.status).toBe('live')
    expect((await getSkill('global/off-g'))?.status).toBe('disabled')
  })

  it('listAllSkills (the admin list) shows every skill with its status, whatever the state', async () => {
    const all = await listAllSkills()
    expect(all).toHaveLength(9)
    expect(Object.fromEntries(all.map(r => [r.id, r.status]))).toMatchObject({
      'global/off-g': 'disabled', 'agent/agent-a/pending-a': 'pending_review', 'tenant-b-expired': 'expired', 'tenant-a-live': 'live',
    })
  })

  it('listLiveSkills returns the live ones only, from every tenant', async () => {
    expect(ids(await listLiveSkills())).toEqual(['agent/agent-a/live-a', 'global/live-g', 'tenant-a-live', 'tenant-b-live'])
  })

  it('listSkillsForTenant: own live skills plus live granted ones; a disabled own skill and an expired granted one are out', async () => {
    expect(ids(await listSkillsForTenant('tenant-a'))).toEqual(['tenant-a-live', 'tenant-b-live'])
    expect(ids(await listSkillsForTenant('tenant-b'))).toEqual(['tenant-b-live'])
  })

  it('listAgentOwnedSkills: the live skills of the agent only', async () => {
    expect(ids(await listAgentOwnedSkills('agent-a'))).toEqual(['agent/agent-a/live-a'])
  })

  it('listGlobalFleetSkills: the live global skills only', async () => {
    expect(ids(await listGlobalFleetSkills())).toEqual(['global/live-g'])
  })

  it('a skill that was revoked drops out of every agent-facing list at once and stays in the admin list', async () => {
    db.prepare("UPDATE skills SET status = 'disabled' WHERE id IN ('global/live-g', 'agent/agent-a/live-a', 'tenant-a-live')").run()
    expect(await listGlobalFleetSkills()).toEqual([])
    expect(await listAgentOwnedSkills('agent-a')).toEqual([])
    expect(ids(await listSkillsForTenant('tenant-a'))).toEqual(['tenant-b-live'])
    expect(ids(await listLiveSkills())).toEqual(['tenant-b-live'])
    expect(await listAllSkills()).toHaveLength(9)
  })
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

describe('GET /api/skills/sql', () => {
  beforeEach(async () => {
    await seed('global/live-g', 'fleet')
    await seed('global/off-g', 'fleet', 'disabled')
    await seed('agent/agent-a/live-a', 'fleet')
    await seed('agent/agent-a/off-a', 'fleet', 'disabled')
    await seed('tenant-a-live', 'tenant-a')
    await seed('tenant-a-off', 'tenant-a', 'disabled')
  })

  it('the admin sees the disabled skills, with their status', async () => {
    const r = await call('GET', '/api/skills/sql', ADMIN)
    expect(r.status).toBe(200)
    const byId = Object.fromEntries(r.body.skills.map((s: any) => [s.id, s.status]))
    expect(byId['global/off-g']).toBe('disabled')
    expect(byId['agent/agent-a/off-a']).toBe('disabled')
    expect(byId['tenant-a-off']).toBe('disabled')
    expect(byId['global/live-g']).toBe('live')
  })

  it('a tenant caller sees only the live skills of the tenant', async () => {
    const r = await call('GET', '/api/skills/sql', TENANT_A)
    expect(ids(r.body.skills)).toEqual(['tenant-a-live'])
  })

  it('an agent token sees the live global skills and never a disabled one', async () => {
    // (Its own agent skills only count when the agent has a skills directory on disk: not set up here.)
    const r = await call('GET', '/api/skills/sql', AGENT_A)
    expect(r.status).toBe(200)
    expect(ids(r.body.skills)).toEqual(['global/live-g'])
  })
})

describe('GET /api/skills/sql/:id and its files', () => {
  beforeEach(async () => {
    await seed('global/live-g', 'fleet')
    await seed('global/off-g', 'fleet', 'disabled')
    await seed('agent/agent-a/off-a', 'fleet', 'disabled')
    await seed('tenant-a-live', 'tenant-a')
    await seed('tenant-a-off', 'tenant-a', 'disabled')
    db.prepare("INSERT INTO skill_files (skill_id, rel_path, content, mode) VALUES ('tenant-a-off', 'ref/a.md', x'41', 420), ('tenant-a-live', 'ref/a.md', x'41', 420)").run()
  })

  it('the admin reads a disabled skill (status included): that is how a revoke is checked', async () => {
    const r = await call('GET', `/api/skills/sql/${enc('global/off-g')}`, ADMIN)
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: 'global/off-g', status: 'disabled' })
  })

  it('every other caller gets 404 for a disabled skill, the same answer as for one that does not exist', async () => {
    const missing = await call('GET', `/api/skills/sql/${enc('global/nope')}`, AGENT_A)
    for (const [extras, id] of [[AGENT_A, 'global/off-g'], [AGENT_A, 'agent/agent-a/off-a'], [TENANT_A, 'tenant-a-off']] as const) {
      const r = await call('GET', `/api/skills/sql/${enc(id)}`, extras)
      expect(r.status, id).toBe(404)
      expect(r.body, id).toEqual(missing.body)
    }
  })

  it('a live skill is served exactly as before', async () => {
    const g = await call('GET', `/api/skills/sql/${enc('global/live-g')}`, AGENT_A)
    expect(g.status).toBe(200)
    expect(g.body).toMatchObject({ id: 'global/live-g', status: 'live' })
    const t = await call('GET', `/api/skills/sql/${enc('tenant-a-live')}`, TENANT_A)
    expect(t.status).toBe(200)
  })

  it('the companion files of a disabled skill are for the admin only: list and bytes', async () => {
    expect((await call('GET', `/api/skills/sql/${enc('tenant-a-off')}/files`, ADMIN)).status).toBe(200)
    expect((await call('GET', `/api/skills/sql/${enc('tenant-a-off')}/files`, TENANT_A)).status).toBe(404)
    expect((await call('GET', `/api/skills/sql/${enc('tenant-a-off')}/files/${enc('ref/a.md')}`, TENANT_A)).status).toBe(404)
    expect((await call('GET', `/api/skills/sql/${enc('tenant-a-live')}/files`, TENANT_A)).status).toBe(200)
  })
})
