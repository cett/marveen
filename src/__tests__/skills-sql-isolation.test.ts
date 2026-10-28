import { describe, it, expect, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  initDatabase,
  createSkill, getSkill, updateSkill, deleteSkill,
  listSkillsForTenant, listAllSkills,
  grantSkillAccess, revokeSkillAccess, listSkillAccess,
} from '../db.js'
import { tryHandleSkills } from '../web/routes/skills.js'
import type { RouteContext } from '../web/routes/types.js'

function makeSkillCtx(
  method: string, path: string,
  opts: { role?: string; tenantId?: string | null; body?: object } = {},
): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = opts.body ? Buffer.from(JSON.stringify(opts.body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b ?? '{}') } catch { out.body = b } },
    setHeader: () => {},
    pipe: () => {},
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = {
    req, res, path: url.pathname, method, url,
    role: opts.role ?? 'viewer',
    tenantId: opts.tenantId !== undefined ? opts.tenantId : 'default-tenant',
  } as RouteContext
  return { ctx, out }
}

// Integration tests: real SQLite in-memory, all migrations applied.
// Verifies tenant isolation for SQL-backed skills (716).

beforeAll(() => {
  initDatabase(':memory:')
})

describe('SQL skills tenant isolation (716)', () => {
  it('tenant A cannot see tenant B skills via listSkillsForTenant', async () => {
    await createSkill({ id: 'iso-acme-skill', name: 'Acme Skill', content: 'content A', tenant_id: 'iso-acme' })
    await createSkill({ id: 'iso-corp-skill', name: 'Corp Skill', content: 'content B', tenant_id: 'iso-corp' })

    const acmeSkills = await listSkillsForTenant('iso-acme')
    expect(acmeSkills.some(s => s.id === 'iso-acme-skill')).toBe(true)
    expect(acmeSkills.some(s => s.id === 'iso-corp-skill')).toBe(false)

    const corpSkills = await listSkillsForTenant('iso-corp')
    expect(corpSkills.some(s => s.id === 'iso-corp-skill')).toBe(true)
    expect(corpSkills.some(s => s.id === 'iso-acme-skill')).toBe(false)
  })

  it('fleet skills (tenant_id=fleet, is_global=1) are NOT visible to B2B tenants by default', async () => {
    await createSkill({ id: 'fleet-priv-skill', name: 'Fleet Private', content: 'fleet content', tenant_id: 'fleet', is_global: true })

    const visibleToTenant = await listSkillsForTenant('iso-acme')
    expect(visibleToTenant.some(s => s.id === 'fleet-priv-skill')).toBe(false)
  })

  it('fleet skill becomes visible after explicit grantSkillAccess', async () => {
    await createSkill({ id: 'fleet-granted-skill', name: 'Fleet Granted', content: 'fleet content', tenant_id: 'fleet', is_global: true })
    await grantSkillAccess('fleet-granted-skill', 'iso-acme', 'admin')

    const skills = await listSkillsForTenant('iso-acme')
    expect(skills.some(s => s.id === 'fleet-granted-skill')).toBe(true)
  })

  it('revokeSkillAccess removes the visibility for the granted tenant', async () => {
    await createSkill({ id: 'fleet-revoke-skill', name: 'Fleet Revoke', content: 'content', tenant_id: 'fleet', is_global: true })
    await grantSkillAccess('fleet-revoke-skill', 'iso-acme', 'admin')
    await revokeSkillAccess('fleet-revoke-skill', 'iso-acme')

    const skills = await listSkillsForTenant('iso-acme')
    expect(skills.some(s => s.id === 'fleet-revoke-skill')).toBe(false)
  })

  it('deleteSkill cascades skill_tenant_access rows', async () => {
    await createSkill({ id: 'cascade-skill', name: 'Cascade', content: 'content', tenant_id: 'iso-acme' })
    await grantSkillAccess('cascade-skill', 'iso-corp', 'admin')

    await deleteSkill('cascade-skill')

    const corpSkills = await listSkillsForTenant('iso-corp')
    expect(corpSkills.some(s => s.id === 'cascade-skill')).toBe(false)
    const access = await listSkillAccess('cascade-skill')
    expect(access).toHaveLength(0)
  })

  it('updateSkill updates content and description', async () => {
    await createSkill({ id: 'update-skill', name: 'Update Me', content: 'v1', tenant_id: 'iso-acme' })
    const updated = await updateSkill('update-skill', { content: 'v2', description: 'updated desc' })
    expect(updated?.content).toBe('v2')
    expect(updated?.description).toBe('updated desc')
  })

  it('updateSkill on non-existent id returns undefined', async () => {
    const result = await updateSkill('does-not-exist-xyz', { content: 'x' })
    expect(result).toBeUndefined()
  })

  it('getSkill returns undefined for unknown id', async () => {
    expect(await getSkill('no-such-skill-xyz')).toBeUndefined()
  })

  it('listAllSkills returns skills from all tenants', async () => {
    await createSkill({ id: 'all-acme', name: 'All Acme', content: 'ca', tenant_id: 'iso-acme-all' })
    await createSkill({ id: 'all-corp', name: 'All Corp', content: 'cb', tenant_id: 'iso-corp-all' })
    await createSkill({ id: 'all-fleet', name: 'All Fleet', content: 'cc', tenant_id: 'fleet', is_global: true })

    const all = await listAllSkills()
    expect(all.some(s => s.id === 'all-acme')).toBe(true)
    expect(all.some(s => s.id === 'all-corp')).toBe(true)
    expect(all.some(s => s.id === 'all-fleet')).toBe(true)
  })

  it('grantSkillAccess is idempotent (double-grant does not throw)', async () => {
    await createSkill({ id: 'idempotent-skill', name: 'Idempotent', content: 'c', tenant_id: 'iso-acme' })
    await grantSkillAccess('idempotent-skill', 'iso-corp', 'admin')
    expect(() => grantSkillAccess('idempotent-skill', 'iso-corp', 'admin')).not.toThrow()
  })
})

describe('SQL skills route: IDOR null-tenant guard (716 security)', () => {
  it('GET /api/skills/sql/:id returns 404 when caller has no tenant scope (fail-closed)', async () => {
    await createSkill({ id: 'idor-test-skill', name: 'IDOR Test', content: 'secret', tenant_id: 'victim-tenant' })
    const { ctx, out } = makeSkillCtx('GET', '/api/skills/sql/idor-test-skill', { role: 'viewer', tenantId: null })
    await tryHandleSkills(ctx)
    expect(out.status).toBe(404)
  })

  it('GET /api/skills/sql/:id returns skill when caller has matching tenant', async () => {
    await createSkill({ id: 'idor-own-skill', name: 'Own Skill', content: 'mine', tenant_id: 'my-tenant' })
    const { ctx, out } = makeSkillCtx('GET', '/api/skills/sql/idor-own-skill', { role: 'viewer', tenantId: 'my-tenant' })
    await tryHandleSkills(ctx)
    expect(out.status).toBe(200)
    expect((out.body as { id: string }).id).toBe('idor-own-skill')
  })

  it('GET /api/skills/sql/:id returns 404 for cross-tenant without grant (mutation-proof)', async () => {
    await createSkill({ id: 'idor-other-skill', name: 'Other Skill', content: 'theirs', tenant_id: 'other-tenant' })
    const { ctx, out } = makeSkillCtx('GET', '/api/skills/sql/idor-other-skill', { role: 'viewer', tenantId: 'attacker-tenant' })
    await tryHandleSkills(ctx)
    expect(out.status).toBe(404)
  })
})

describe('SQL skills route: slash-containing skill IDs decode correctly', () => {
  it('GET /api/skills/sql/:id finds the skill when the id contains an encoded slash', async () => {
    await createSkill({ id: 'agent/boo/foo', name: 'Slashed Skill', content: 'x', tenant_id: 'my-tenant' })
    const { ctx, out } = makeSkillCtx('GET', '/api/skills/sql/agent%2Fboo%2Ffoo', { role: 'viewer', tenantId: 'my-tenant' })
    await tryHandleSkills(ctx)
    expect(out.status).toBe(200)
    expect((out.body as { id: string }).id).toBe('agent/boo/foo')
  })

  it('grant and revoke access work for a slash-containing skill id', async () => {
    await createSkill({ id: 'agent/boo/access', name: 'Slashed Access', content: 'x', tenant_id: 'fleet', is_global: true })

    const grant = makeSkillCtx('POST', '/api/skills/sql/agent%2Fboo%2Faccess/access', { role: 'admin', body: { tenant_id: 'granted-tenant' } })
    await tryHandleSkills(grant.ctx)
    expect(grant.out.status).toBe(200)
    expect((await listSkillAccess('agent/boo/access')).some(g => g.tenant_id === 'granted-tenant')).toBe(true)

    const revoke = makeSkillCtx('DELETE', '/api/skills/sql/agent%2Fboo%2Faccess/access/granted-tenant', { role: 'admin' })
    await tryHandleSkills(revoke.ctx)
    expect(revoke.out.status).toBe(200)
    expect((await listSkillAccess('agent/boo/access')).some(g => g.tenant_id === 'granted-tenant')).toBe(false)
  })
})
