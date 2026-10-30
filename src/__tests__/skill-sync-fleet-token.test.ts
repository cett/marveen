// POST /api/skill-sync is the write-back half of the skill-sql-sync hook, which runs in an agent's session
// and sends that agent's OWN fleet_agent token. The endpoint had no row in the endpoint table, so it resolved
// to admin:all and every write-back of an agent's own SKILL.md was a 403. It is reachable with skills:write
// now, and a fleet token is held to the skills of its own agent, as on PUT /api/skills/sql/:id. This is the gate
// chain of web.ts in miniature over a real in-memory database.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type http from 'node:http'
import { initDatabase, getDb, createTenant, createSkill, getSkill, getSkillFile, insertApiToken, setTenantAgentAvailability } from '../db.js'
import { resolveAuth, type AuthResult } from '../web/auth-gate.js'
import { checkPermission, resolveRole, resolveTenantId } from '../web/authz.js'
import { resolveRequiredPermission } from '../web/rbac.js'
import { tryHandleSkillSync } from '../web/routes/skill-sync.js'
import { resetTokenShadowForTests } from '../web/token-shadow.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-agent' }))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const NOW = () => Math.floor(Date.now() / 1000)
const b64 = (s: string) => Buffer.from(s).toString('base64')

async function callAs(auth: AuthResult, body: unknown) {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as http.IncomingMessage
  req.method = 'POST'
  req.headers = {}
  ;(req as unknown as { destroy: () => void }).destroy = () => {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) {
      if (!b) return
      try { out.body = JSON.parse(Buffer.isBuffer(b) ? b.toString('utf-8') : b) } catch { /* not JSON */ }
    },
  } as unknown as http.ServerResponse
  const url = new URL('http://localhost:3420/api/skill-sync')
  const decision = checkPermission(auth, 'POST', url.pathname)
  if (!decision.allowed) { out.status = decision.status; out.body = { error: 'denied', reason: decision.reason }; return out }
  const role = resolveRole(auth)
  const tokenAgentId = auth.kind === 'token' ? auth.agentId : undefined
  const ctx = {
    req, res, path: '/api/skill-sync', method: 'POST', url, role, tenantId: resolveTenantId(auth), tokenAgentId,
    auth: auth.kind === 'token' ? { kind: 'token', tokenName: auth.tokenName } : undefined,
  } as unknown as RouteContext
  expect(await tryHandleSkillSync(ctx)).toBe(true)
  return out
}

async function tokenAuth(raw: string): Promise<AuthResult> {
  const req = { headers: { authorization: `Bearer ${raw}` } } as unknown as http.IncomingMessage
  return resolveAuth(req, new URL('http://x/api/me'), '/api/me', 'GET', 'the-file-token', true)
}
const session = (role: 'admin' | 'agent' | 'read_only' | 'viewer', tenantId: string | null): AuthResult => ({ kind: 'session', user: `u-${role}`, role, tenantId })

const shadowRows = (): Array<{ category: string; caller: string; target: string }> =>
  getDb().prepare("SELECT category, caller, target FROM token_usage_shadow WHERE category = 'fleet_skill_write_denied'").all() as Array<{ category: string; caller: string; target: string }>

beforeEach(async () => {
  initDatabase(':memory:')
  resetTokenShadowForTests()
  for (const agent of ['alpha', 'beta']) {
    await insertApiToken({ tokenHash: sha(`tok-${agent}`), name: `fleet:${agent}`, role: 'fleet_agent', tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId: agent })
  }
  await insertApiToken({ tokenHash: sha('tok-admin'), name: 'operator', role: 'admin', tenantId: 'default', createdAt: NOW() - 10, expiresAt: null, agentId: null })
  await createSkill({ id: 'agent/alpha/mine', name: 'mine', content: 'old', tenant_id: 'fleet' })
  await createSkill({ id: 'agent/beta/theirs', name: 'theirs', content: 'old', tenant_id: 'fleet' })
  await createSkill({ id: 'global/shared', name: 'shared', content: 'old', tenant_id: 'fleet', is_global: true })
})

describe('the endpoint table', () => {
  // Paths reach the table already normalised (/api/v1 -> /api, versioning.ts), so one row covers both spellings.
  it('POST /api/skill-sync needs skills:write, no other method is mapped', () => {
    expect(resolveRequiredPermission('POST', '/api/skill-sync')).toBe('skills:write')
    expect(resolveRequiredPermission('GET', '/api/skill-sync')).toBeNull()
  })
  it('stays closed to the tenant roles, which hold no skills:write', async () => {
    for (const role of ['agent', 'read_only', 'viewer'] as const) {
      const r = await callAs(session(role, 'default'), { kind: 'skill', skill_id: 'agent/alpha/mine', content: 'x' })
      expect([role, r.status]).toEqual([role, 403])
    }
    expect((await getSkill('agent/alpha/mine'))!.content).toBe('old')
  })
})

describe('a fleet_agent token writes back the skills of its own agent', () => {
  it('SKILL.md of its own skill: stored (the case that was a 403)', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), { kind: 'skill', skill_id: 'agent/alpha/mine', content: 'edited' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, message: 'upserted agent/alpha/mine' })
    expect((await getSkill('agent/alpha/mine'))!.content).toBe('edited')
    expect(shadowRows()).toEqual([])
  })

  it('a new skill of its own agent is created as a fleet row', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), { kind: 'skill', skill_id: 'agent/alpha/fresh', content: 'new' })
    expect(r.status).toBe(200)
    expect(await getSkill('agent/alpha/fresh')).toMatchObject({ tenant_id: 'fleet', is_global: 0, content: 'new' })
  })

  it('a companion file of its own skill: stored', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), { kind: 'companion', skill_id: 'agent/alpha/mine', rel_path: 'scripts/run.sh', content_base64: b64('#!/bin/sh\n'), mode: 0o755 })
    expect(r.status).toBe(200)
    expect(await getSkillFile('agent/alpha/mine', 'scripts/run.sh')).toMatchObject({ mode: 0o755 })
  })
})

describe('and nothing else: another agent\'s skill, a global one, a tenant one stay 403', () => {
  it('SKILL.md of another agent', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), { kind: 'skill', skill_id: 'agent/beta/theirs', content: 'evil' })
    expect(r.status).toBe(403)
    expect((await getSkill('agent/beta/theirs'))!.content).toBe('old')
    expect(shadowRows()).toEqual([{ category: 'fleet_skill_write_denied', caller: 'alpha', target: 'beta' }])
  })

  it('a new skill under another agent\'s name is not created either', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), { kind: 'skill', skill_id: 'agent/beta/planted', content: 'evil' })
    expect(r.status).toBe(403)
    expect(await getSkill('agent/beta/planted')).toBeUndefined()
  })

  it('a global skill', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), { kind: 'skill', skill_id: 'global/shared', content: 'evil' })
    expect(r.status).toBe(403)
    expect((await getSkill('global/shared'))!.content).toBe('old')
    expect(shadowRows()).toEqual([{ category: 'fleet_skill_write_denied', caller: 'alpha', target: 'global' }])
  })

  it('an id that only starts like its own agent\'s', async () => {
    for (const skill_id of ['agent/alpha', 'agent/alpha/', 'agent/alpha/a/b', 'agent/alphabet/x', 'agent/alpha/../beta/theirs']) {
      const r = await callAs(await tokenAuth('tok-alpha'), { kind: 'skill', skill_id, content: 'evil' })
      expect([skill_id, r.status]).toEqual([skill_id, 403])
    }
    expect((await getSkill('agent/beta/theirs'))!.content).toBe('old')
  })

  it('a companion file of another agent\'s or a global skill', async () => {
    for (const skill_id of ['agent/beta/theirs', 'global/shared']) {
      const r = await callAs(await tokenAuth('tok-alpha'), { kind: 'companion', skill_id, rel_path: 'scripts/x.sh', content_base64: b64('evil') })
      expect([skill_id, r.status]).toEqual([skill_id, 403])
      expect(await getSkillFile(skill_id, 'scripts/x.sh')).toBeUndefined()
    }
  })

  it('a generated tenant copy: the tenant row stays as it was, even for an agent that qualifies for the tenant', async () => {
    await createTenant('co-x', 'Co X')
    await createSkill({ id: 'co-x-helper', name: 'helper', content: 'old', tenant_id: 'co-x' })
    await setTenantAgentAvailability('co-x', 'alpha', true)
    const r = await callAs(await tokenAuth('tok-alpha'), { kind: 'tenant', header_id: 'co-x-helper', agent_id: 'alpha', dir_name: 'co-x-helper', content: 'evil' })
    expect(r.status).toBe(403)
    expect((await getSkill('co-x-helper'))!.content).toBe('old')
  })

  it('a tenant companion of its own skill id (tenant_agent set) is refused as a tenant-level write', async () => {
    const r = await callAs(await tokenAuth('tok-alpha'), { kind: 'companion', skill_id: 'agent/alpha/mine', rel_path: 'a.txt', content_base64: b64('x'), tenant_agent: 'alpha' })
    expect(r.status).toBe(403)
    expect(await getSkillFile('agent/alpha/mine', 'a.txt')).toBeUndefined()
  })
})

describe('the admin keeps the whole endpoint', () => {
  it('the operator token writes any skill and a tenant copy as before', async () => {
    expect((await callAs(await tokenAuth('tok-admin'), { kind: 'skill', skill_id: 'agent/beta/theirs', content: 'by admin' })).status).toBe(200)
    expect((await callAs(await tokenAuth('tok-admin'), { kind: 'skill', skill_id: 'global/shared', content: 'by admin' })).status).toBe(200)
    expect((await getSkill('agent/beta/theirs'))!.content).toBe('by admin')
    expect((await getSkill('global/shared'))!.content).toBe('by admin')
    expect(shadowRows()).toEqual([])
  })
  it('an admin session too', async () => {
    expect((await callAs(session('admin', null), { kind: 'skill', skill_id: 'agent/beta/theirs', content: 'by session' })).status).toBe(200)
  })
})
