// /api/hooks/*: the facts and the one own-row write that the tenant gates of the hooks ask the dashboard in PG mode.
// Real in-memory SQLite (no mocks). Neutral fixtures only (agent-a, agent-b, tenant-x, tenant-y).
//
// What these cells pin (each has a red a removed guard would give):
//   - the caller is the agent the TOKEN names; an agent_id in the body is ignored, and no token agent is a 403
//   - a message counts only when it is addressed to the caller (another agent's msg_id reads as "not found")
//   - the skill answer carries only the named skills and never a skill's content
//   - the RBAC rows are explicit: removing one would drop the route to the admin:all fallback an agent token does not hold
import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { dbx } from '../db/facade.js'
import { useTestDb } from './helpers/with-test-db.js'
import { tryHandleHooksTenant } from '../web/routes/hooks-tenant.js'
import { ENDPOINT_PERMISSION_TABLE, hasPermission, resolveRequiredPermission, type Role } from '../web/rbac.js'
import type { RouteContext } from '../web/routes/types.js'

useTestDb()

function call(method: string, path: string, body: unknown, tokenAgentId: string | undefined, role: string = 'fleet_agent') {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => { (req as NodeJS.EventEmitter).emit('data', buf); (req as NodeJS.EventEmitter).emit('end') })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) { if (b) { const s = Buffer.isBuffer(b) ? b.toString('utf-8') : b; try { out.body = JSON.parse(s) } catch { out.body = s } } },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, role, tokenAgentId, tenantId: null } as unknown as RouteContext
  return { ctx, out }
}

async function run(method: string, path: string, body: unknown, tokenAgentId: string | undefined, role?: string) {
  const { ctx, out } = call(method, path, body, tokenAgentId, role)
  expect(await tryHandleHooksTenant(ctx)).toBe(true)
  return out
}

const facts = (sources: unknown[], agent: string | undefined = 'agent-a') => run('POST', '/api/hooks/tenant-facts', { sources }, agent)

async function seed(): Promise<void> {
  const now = 1700000000
  for (const t of [['tenant-x', 'main-x'], ['tenant-y', null]] as const) {
    await dbx.run('INSERT INTO tenants (id, display_name, created_at, main_agent_id) VALUES (?, ?, ?, ?)', t[0], t[0], now, t[1])
  }
  await dbx.run('INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES (?, ?, 1)', 'tenant-x', 'agent-a')
  await dbx.run('INSERT INTO tenant_channel_bindings (agent_id, channel, external_id, tenant_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'agent-a', 'telegram', '111', 'tenant-x', 'test', now, now)
  await dbx.run('INSERT INTO tenant_channel_bindings (agent_id, channel, external_id, tenant_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', 'agent-a', 'inter-agent', 'partner-bot', 'tenant-x', 'test', now, now)
  const msg = (id: number, from: string, to: string, tenant: string | null) =>
    dbx.run("INSERT INTO agent_messages (id, from_agent, to_agent, content, status, created_at, tenant_id) VALUES (?, ?, ?, 'x', 'done', ?, ?)", id, from, to, now, tenant)
  await msg(10, 'coord', 'agent-a', 'default')
  await msg(11, 'coord', 'agent-a', 'tenant-x')
  await msg(12, 'coord', 'agent-b', 'tenant-y')
  await msg(13, 'partner-bot', 'agent-a', 'default')
}

beforeEach(async () => { await seed() })

describe('who the caller is', () => {
  it('refuses a token that names no agent, on all three routes (403, nothing read or written)', async () => {
    for (const [m, p, b] of [['POST', '/api/hooks/tenant-facts', { sources: [] }], ['PUT', '/api/hooks/tenant-context', { status: 'default', tenant_id: 'default', source: 'local' }], ['POST', '/api/hooks/skill-gate', { targets: [] }]] as const) {
      const out = await run(m, p, b, undefined, 'admin')
      expect(out.status, p).toBe(403)
    }
    expect(await dbx.get('SELECT 1 FROM agent_tenant_context')).toBeUndefined()
  })

  it('ignores an agent_id in the body: the row is written for the token agent', async () => {
    const out = await run('PUT', '/api/hooks/tenant-context', { agent_id: 'agent-b', status: 'default', tenant_id: 'default', source: 'local' }, 'agent-a')
    expect(out.status).toBe(200)
    expect(await dbx.get('SELECT 1 FROM agent_tenant_context WHERE agent_id = ?', 'agent-b')).toBeUndefined()
    expect(await dbx.get('SELECT 1 FROM agent_tenant_context WHERE agent_id = ?', 'agent-a')).toBeDefined()
  })
})

describe('tenant-facts', () => {
  it('returns the message of the caller with its tenant and the serves fact', async () => {
    const out = await facts([{ kind: 'message', msg_id: 11 }])
    expect(out.status).toBe(200)
    const b = out.body as { sources: { message: { to_agent: string; tenant_id: string } | null; inter_agent_binding: string | null }[]; serves: Record<string, boolean> }
    expect(b.sources[0]!.message).toMatchObject({ to_agent: 'agent-a', tenant_id: 'tenant-x' })
    expect(b.serves['tenant-x']).toBe(true)
  })

  it('reads another agent\'s msg_id, and a missing one, as "not found" (the same unknown as today), and leaks no tenant', async () => {
    const out = await facts([{ kind: 'message', msg_id: 12 }, { kind: 'message', msg_id: 999 }])
    const b = out.body as { sources: { message: unknown }[]; serves: Record<string, boolean> }
    expect(b.sources.map((s) => s.message)).toEqual([null, null])
    expect(b.serves).toEqual({})
    expect(JSON.stringify(out.body)).not.toContain('tenant-y')
  })

  it('answers the same message for the agent it is addressed to only', async () => {
    const out = await facts([{ kind: 'message', msg_id: 12 }], 'agent-b')
    expect((out.body as { sources: { message: { tenant_id: string } }[] }).sources[0]!.message.tenant_id).toBe('tenant-y')
  })

  it('returns the binding of a channel, the inter-agent binding of a message sender, and a task of the caller only', async () => {
    await dbx.run("INSERT INTO schedules (id, agent, tenant_id, schedule) VALUES ('job-a', 'agent-a', 'tenant-x', '* * * * *')")
    const out = await facts([
      { kind: 'channel', channel: 'telegram', external_id: '111' },
      { kind: 'channel', channel: 'telegram', external_id: '404' },
      { kind: 'message', msg_id: 13 },
      { kind: 'scheduled', name: 'job-a' },
      { kind: 'scheduled', name: 'nope' },
    ])
    const s = (out.body as { sources: { binding?: string | null; message?: { tenant_id: string | null } | null; inter_agent_binding?: string | null; schedule?: { tenant_id: string | null } | null }[] }).sources
    expect(s[0]!.binding).toBe('tenant-x')
    expect(s[1]!.binding).toBeNull()
    expect(s[2]!.message).toMatchObject({ tenant_id: 'default' })
    expect(s[2]!.inter_agent_binding).toBe('tenant-x')
    expect(s[3]!.schedule).toEqual({ tenant_id: 'tenant-x' })
    expect(s[4]!.schedule).toBeNull()
    const other = await facts([{ kind: 'scheduled', name: 'job-a' }], 'agent-b')
    expect((other.body as { sources: { schedule: unknown }[] }).sources[0]!.schedule).toBeNull()
  })

  it('serves is false for a tenant the agent is not enabled for', async () => {
    await dbx.run("INSERT INTO agent_messages (id, from_agent, to_agent, content, status, created_at, tenant_id) VALUES (20, 'coord', 'agent-a', 'x', 'done', 1, 'tenant-y')")
    const out = await facts([{ kind: 'message', msg_id: 20 }])
    expect((out.body as { serves: Record<string, boolean> }).serves).toEqual({ 'tenant-y': false })
  })

  it('rejects a malformed source list with 400', async () => {
    for (const bad of [[{ kind: 'channel', channel: 'telegram' }], [{ kind: 'message', msg_id: 'x' }], [{ kind: 'other' }], 'nope']) {
      expect((await facts(bad as unknown[])).status).toBe(400)
    }
    expect((await facts(Array.from({ length: 21 }, () => ({ kind: 'message', msg_id: 1 })))).status).toBe(400)
  })
})

describe('tenant-context (the caller\'s own row)', () => {
  const put = (b: Record<string, unknown>, agent = 'agent-a') => run('PUT', '/api/hooks/tenant-context', b, agent)
  const row = (agent = 'agent-a') => dbx.get<{ status: string; tenant_id: string; source: string; session_id: string }>('SELECT status, tenant_id, source, session_id FROM agent_tenant_context WHERE agent_id = ?', agent)

  it('replaces the old row: a newer prompt never leaves the previous tenant behind', async () => {
    expect((await put({ status: 'bound', tenant_id: 'tenant-x', source: 's1', session_id: 'a' })).status).toBe(200)
    expect((await put({ status: 'unknown', tenant_id: '', source: 'hook-error', session_id: 'b' })).status).toBe(200)
    expect(await row()).toEqual({ status: 'unknown', tenant_id: '', source: 'hook-error', session_id: 'b' })
    expect((await dbx.all('SELECT 1 FROM agent_tenant_context')).length).toBe(1)
  })

  it('refuses to record a tenant the caller may not assert: default with another tenant, bound for a tenant it does not serve, bound with the default tenant', async () => {
    for (const b of [
      { status: 'default', tenant_id: 'tenant-x', source: 's' }, // would read as a served tenant without the serves check
      { status: 'bound', tenant_id: 'tenant-y', source: 's' }, // agent-a is not enabled for tenant-y
      { status: 'bound', tenant_id: 'default', source: 's' },
      { status: 'bound', tenant_id: 'no-such-tenant', source: 's' },
    ]) expect((await put(b)).status, JSON.stringify(b)).toBe(403)
    expect(await row()).toBeUndefined()
    expect((await put({ status: 'default', tenant_id: 'default', source: 's' })).status).toBe(200)
    expect((await put({ status: 'bound', tenant_id: 'tenant-x', source: 's' })).status).toBe(200)
  })

  it('refuses bound/default without a tenant and unknown/conflict with one, and an unknown status', async () => {
    for (const b of [
      { status: 'bound', tenant_id: '', source: 's' }, { status: 'default', tenant_id: '', source: 's' },
      { status: 'unknown', tenant_id: 'tenant-x', source: 's' }, { status: 'conflict', tenant_id: 'tenant-x', source: 's' },
      { status: 'weird', tenant_id: '', source: 's' }, { status: 'default', tenant_id: 'default' },
    ]) expect((await put(b)).status, JSON.stringify(b)).toBe(400)
    expect(await row()).toBeUndefined()
  })
})

describe('skill-gate', () => {
  beforeEach(async () => {
    const ins = (id: string, name: string, content: string, tenant: string) =>
      dbx.run('INSERT INTO skills (id, name, content, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)', id, name, content, tenant)
    await ins('skill-one', 'Skill One', '---\nname: front-one\n---\nSECRET-BODY-1', 'tenant-x')
    await ins('Skill-Two', 'Two', 'SECRET-BODY-2', 'tenant-y')
    await ins('skill-fleet', 'Fleet', 'x', 'fleet')
    await dbx.run('INSERT INTO skill_tenant_access (skill_id, tenant_id) VALUES (?, ?)', 'Skill-Two', 'tenant-x')
  })
  const gate = (targets: unknown[], agent = 'agent-a') => run('POST', '/api/hooks/skill-gate', { targets }, agent)
  const target = (kind: string, value: string) => ({ kind, value, folded: value.toLowerCase() })

  it('returns only the skills a target names, with the grant of the caller\'s tenant, and never a skill\'s content', async () => {
    await run('PUT', '/api/hooks/tenant-context', { status: 'bound', tenant_id: 'tenant-x', source: 's', session_id: 'q' }, 'agent-a')
    const out = await gate([target('skill', 'front-one'), target('dir', 'skill-two')])
    const b = out.body as { skills: { id: string; tenant_id: string; granted: string[]; names: string[] }[] }
    expect(b.skills.map((s) => s.id).sort()).toEqual(['Skill-Two', 'skill-one'])
    expect(b.skills.find((s) => s.id === 'Skill-Two')!.granted).toEqual(['tenant-x'])
    expect(b.skills.find((s) => s.id === 'Skill-Two')!.tenant_id).toBe('*')
    expect(b.skills.find((s) => s.id === 'skill-one')!.tenant_id).toBe('tenant-x')
    // another tenant's id never leaves the server: neither as the owner of Skill-Two nor as a grantee
    expect(JSON.stringify(out.body)).not.toContain('tenant-y')
    expect(b.skills.find((s) => s.id === 'skill-one')!.names).toContain('front-one')
    const text = JSON.stringify(out.body)
    expect(text).not.toContain('SECRET-BODY')
    expect(text).not.toContain('"content"')
  })

  it('a name that matches nothing returns no skill (no catalog), and a fleet skill is never listed', async () => {
    const out = await gate([target('skill', 'nothing-here'), target('skill', 'skill-fleet')])
    expect((out.body as { skills: unknown[] }).skills).toEqual([])
  })

  it('the directory match is case-insensitive through the casefolded value the hook sends', async () => {
    const out = await gate([{ kind: 'dir', value: 'SKILL-TWO', folded: 'skill-two' }])
    expect((out.body as { skills: { id: string }[] }).skills.map((s) => s.id)).toEqual(['Skill-Two'])
  })

  it('carries the context row and the serves fact of the caller, and nobody else\'s', async () => {
    await run('PUT', '/api/hooks/tenant-context', { status: 'bound', tenant_id: 'tenant-x', source: 's', session_id: 'q' }, 'agent-a')
    await dbx.run("INSERT INTO agent_tenant_context (agent_id, tenant_id, status, source, session_id, updated_at) VALUES ('agent-b', 'tenant-y', 'bound', 's', 'q', 1)")
    const out = await gate([target('skill', 'x')])
    const b = out.body as { context: { status: string; tenant_id: string }; serves: boolean }
    expect(b.context).toMatchObject({ status: 'bound', tenant_id: 'tenant-x' })
    expect(b.serves).toBe(true)
    const other = await gate([target('skill', 'x')], 'agent-b')
    expect((other.body as { serves: boolean }).serves).toBe(false) // agent-b is not enabled for tenant-y
  })

  it('without a context the answer names no tenant at all (owner masked, grants empty)', async () => {
    const out = await gate([target('skill', 'front-one'), target('dir', 'skill-two')])
    const b = out.body as { skills: { tenant_id: string; granted: string[] }[] }
    expect(b.skills.map((s) => s.tenant_id)).toEqual(['*', '*'])
    expect(b.skills.map((s) => s.granted)).toEqual([[], []])
    expect(JSON.stringify(out.body)).not.toMatch(/tenant-[xy]/)
  })

  it('no context row: context null (the hook then has no tenant)', async () => {
    const out = await gate([target('skill', 'x')])
    expect(out.body).toMatchObject({ context: null, serves: true })
  })
})

describe('the RBAC rows of /api/hooks/*', () => {
  const rows: [string, string, string][] = [
    ['POST', '/api/hooks/tenant-facts', 'hook-gate:read'], ['POST', '/api/hooks/skill-gate', 'hook-gate:read'], ['PUT', '/api/hooks/tenant-context', 'hook-gate:write'],
    ['POST', '/api/hooks/watchdog-facts', 'hook-gate:read'],
    ['POST', '/api/hooks/watchdog-record', 'hook-gate:write'],
  ]
  it('are explicit table rows (not the admin:all fallback an agent token does not hold)', () => {
    for (const [m, p, perm] of rows) {
      expect(ENDPOINT_PERMISSION_TABLE.some((e) => e.method === m && e.pathPattern === p && e.permission === perm), `${m} ${p}`).toBe(true)
      expect(resolveRequiredPermission(m, p), `${m} ${p}`).toBe(perm)
    }
  })
  it('are held by fleet_agent and admin and by no tenant-user role', () => {
    for (const [, , perm] of rows) {
      for (const r of ['fleet_agent', 'admin'] as Role[]) expect(hasPermission(r, perm as never), `${r} ${perm}`).toBe(true)
      for (const r of ['agent', 'read_only', 'viewer'] as Role[]) expect(hasPermission(r, perm as never), `${r} ${perm}`).toBe(false)
    }
  })
  it('an unlisted sibling path has no row (null = the gate treats it as admin:all, which an agent token does not hold)', () => {
    expect(resolveRequiredPermission('POST', '/api/hooks/other')).toBeNull()
    expect(resolveRequiredPermission('POST', '/api/hooks/tenant-facts/extra')).toBeNull()
  })
})
