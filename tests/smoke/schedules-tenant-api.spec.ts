/**
 * Schedules API over real HTTP: tenant ownership, the PUT allowlist and the tenant-move rule,
 * with the shared bearer token, a human admin session and a tenant-bound user.
 *
 * Needs an isolated instance (this test creates and deletes schedules) with a second enabled
 * tenant, an agent enabled for that tenant ONLY, and a viewer bound to it:
 *   DASHBOARD_URL=http://localhost:3421 SMOKE_TOKEN=<shared bearer token> \
 *   SMOKE_USER=<global admin> SMOKE_PASSWORD=<pass> SMOKE_TENANT=<second tenant id> \
 *   SMOKE_TENANT_AGENT=<agent enabled only for it> SMOKE_MAIN_AGENT=<fleet main agent> \
 *   SMOKE_TENANT_USER=<viewer bound to SMOKE_TENANT> SMOKE_TENANT_PASSWORD=<pass> \
 *   npm run smoke -- schedules-tenant-api
 * Skipped when any of them is missing.
 */
import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test'

const BASE = process.env.DASHBOARD_URL || 'http://localhost:3420'
const TOKEN = process.env.SMOKE_TOKEN || ''
const USER = process.env.SMOKE_USER || ''
const PASSWORD = process.env.SMOKE_PASSWORD || ''
const TENANT = process.env.SMOKE_TENANT || ''
const TENANT_AGENT = process.env.SMOKE_TENANT_AGENT || ''
const MAIN_AGENT = process.env.SMOKE_MAIN_AGENT || ''
const TENANT_USER = process.env.SMOKE_TENANT_USER || ''
const TENANT_PASSWORD = process.env.SMOKE_TENANT_PASSWORD || ''

const ready = [TOKEN, USER, PASSWORD, TENANT, TENANT_AGENT, MAIN_AGENT, TENANT_USER, TENANT_PASSWORD].every(Boolean)

test.describe('Schedules API: tenant rules over HTTP', () => {
  test.skip(!ready, 'SMOKE_TOKEN / SMOKE_USER / SMOKE_PASSWORD / SMOKE_TENANT / SMOKE_TENANT_AGENT / SMOKE_MAIN_AGENT / SMOKE_TENANT_USER / SMOKE_TENANT_PASSWORD not set')
  test.use({ actionTimeout: 8_000 })
  // The cases build on each other's rows. Serial also stops Playwright from restarting the worker
  // after a failure, which would re-run beforeAll/afterAll and wipe the rows the later cases need.
  test.describe.configure({ mode: 'serial' })

  const stamp = Date.now()
  const agentTask = `smoke-api-agent-${stamp}`
  const adminTask = `smoke-api-admin-${stamp}`
  const created: string[] = []
  let bearer: APIRequestContext
  let admin: APIRequestContext
  let viewer: APIRequestContext

  const body = (name: string, extra: Record<string, unknown> = {}) => ({
    name, description: 'smoke', prompt: 'smoke: do nothing', schedule: '0 9 * * *', type: 'task', ...extra,
  })
  const row = async (ctx: APIRequestContext, name: string) => {
    const rows = (await (await ctx.get('/api/schedules')).json()) as Array<Record<string, unknown>>
    return rows.find((r) => r.name === name)
  }

  test.beforeAll(async () => {
    bearer = await pwRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } })
    admin = await pwRequest.newContext({ baseURL: BASE })
    expect((await admin.post('/api/auth/login', { data: { username: USER, password: PASSWORD } })).ok()).toBeTruthy()
    viewer = await pwRequest.newContext({ baseURL: BASE })
    expect((await viewer.post('/api/auth/login', { data: { username: TENANT_USER, password: TENANT_PASSWORD } })).ok()).toBeTruthy()
  })

  test.afterAll(async () => {
    for (const name of created) await admin.delete(`/api/schedules/${name}`).catch(() => {})
    await Promise.all([bearer?.dispose(), admin?.dispose(), viewer?.dispose()])
  })

  test('shared token: no tenant and no X-Agent-Id is refused, an agent on its own tenant files a draft there', async () => {
    const refused = await bearer.post('/api/schedules', { data: body(`smoke-api-none-${stamp}`) })
    expect(refused.status()).toBe(400)
    expect(((await refused.json()) as { error: string }).error).toBe('tenant_required')

    const res = await bearer.post('/api/schedules', {
      headers: { 'X-Agent-Id': TENANT_AGENT },
      data: body(agentTask, { agent: TENANT_AGENT }),
    })
    created.push(agentTask)
    expect(res.status()).toBe(200)
    const stored = await row(admin, agentTask)
    expect(stored?.tenantId).toBe(TENANT)
    expect(stored?.status).toBe('draft') // agent-created tasks wait for a person
  })

  test('the pair rule: the fleet main agent cannot serve a non-default tenant, an agent of another tenant cannot be named', async () => {
    const wrongAgent = await admin.post('/api/schedules', { data: body(`smoke-api-pair-${stamp}`, { tenant_id: TENANT, agent: MAIN_AGENT }) })
    expect(wrongAgent.status()).toBe(400)
    const allFanout = await admin.post('/api/schedules', { data: body(`smoke-api-all-${stamp}`, { tenant_id: TENANT, agent: 'all' }) })
    expect(allFanout.status()).toBe(400)
    const unknownTenant = await admin.post('/api/schedules', { data: body(`smoke-api-unk-${stamp}`, { tenant_id: 'no-such-tenant', agent: MAIN_AGENT }) })
    expect(unknownTenant.status()).toBe(400)
  })

  test('PUT allowlist over bearer: status, agent and tenant keys in the body change nothing; a tenant move is refused for a non-human caller', async () => {
    const before = await row(admin, agentTask)
    const put = await bearer.put(`/api/schedules/${agentTask}`, {
      headers: { 'X-Agent-Id': TENANT_AGENT },
      data: { description: 'edited by the agent', status: 'live', tenantId: 'default', enabled: true },
    })
    expect(put.status(), await put.text()).toBe(200)
    const after = await row(admin, agentTask)
    expect(after?.status).toBe('draft') // the review gate is not writable through PUT
    expect(after?.tenantId).toBe(before?.tenantId)
    expect(after?.agent).toBe(TENANT_AGENT)

    // Naming an agent that does not serve the task's tenant is refused outright, not ignored.
    const repoint = await bearer.put(`/api/schedules/${agentTask}`, { headers: { 'X-Agent-Id': TENANT_AGENT }, data: { agent: MAIN_AGENT } })
    expect(repoint.status()).toBe(400)
    expect((await row(admin, agentTask))?.agent).toBe(TENANT_AGENT)

    const move = await bearer.put(`/api/schedules/${agentTask}`, { headers: { 'X-Agent-Id': TENANT_AGENT }, data: { tenant_id: 'default' } })
    expect(move.status()).toBe(403)
    expect((await row(admin, agentTask))?.tenantId).toBe(TENANT)
  })

  test('human admin: a tenant move re-checks the pair and sends the task back to draft', async () => {
    const res = await admin.post('/api/schedules', { data: body(adminTask, { tenant_id: TENANT, agent: TENANT_AGENT }) })
    created.push(adminTask)
    expect(res.status()).toBe(200)

    const live = await admin.post(`/api/schedules/${adminTask}/activate`)
    expect(live.ok()).toBeTruthy()
    expect((await row(admin, adminTask))?.status).toBe('live')

    // The tenant's own agent does not serve the default tenant: the move alone is refused.
    const badMove = await admin.put(`/api/schedules/${adminTask}`, { data: { tenant_id: 'default' } })
    expect(badMove.status()).toBe(400)
    expect((await row(admin, adminTask))?.tenantId).toBe(TENANT)
    expect((await row(admin, adminTask))?.status).toBe('live')

    // Move and re-point the agent together: accepted, back to draft.
    const move = await admin.put(`/api/schedules/${adminTask}`, { data: { tenant_id: 'default', agent: MAIN_AGENT } })
    expect(move.status()).toBe(200)
    expect(await move.json()).toMatchObject({ ok: true, tenant_id: 'default', status: 'draft' })
    const moved = await row(admin, adminTask)
    expect(moved?.tenantId).toBe('default')
    expect(moved?.status).toBe('draft')
  })

  // RBAC runs in shadow mode by default (a would-deny is only logged), so whether a viewer's
  // plain edit is refused depends on RBAC_MODE. What must hold in both modes: the keys that
  // decide ownership and review (status, agent, tenant) never change through a viewer's PUT.
  test('tenant-bound viewer PUT: status, agent and tenant keys change nothing, a tenant move is refused', async () => {
    const before = await row(admin, agentTask)
    for (const data of [{ status: 'live', enabled: true }, { agent: MAIN_AGENT }]) {
      const res = await viewer.put(`/api/schedules/${agentTask}`, { data })
      expect([200, 400, 403], JSON.stringify(data)).toContain(res.status())
    }
    const move = await viewer.put(`/api/schedules/${agentTask}`, { data: { tenant_id: 'default' } })
    expect(move.status()).toBe(403)
    const after = await row(admin, agentTask)
    expect(after?.status).toBe(before?.status)
    expect(after?.agent).toBe(before?.agent)
    expect(after?.tenantId).toBe(before?.tenantId)
  })

  test('tenant-bound viewer: sees only its tenant, never another tenant\'s task, agents or history', async () => {
    const listed = await viewer.get('/api/schedules')
    const rows = (await listed.json()) as Array<{ name: string; tenantId: string }>
    expect(rows.map((r) => r.name), `viewer list: ${listed.status()} ${JSON.stringify(await (await viewer.get('/api/auth/status')).json())}`).toContain(agentTask)
    expect(rows.every((r) => r.tenantId === TENANT)).toBe(true)
    expect(rows.map((r) => r.name)).not.toContain(adminTask) // now in the default tenant

    const agents = (await (await viewer.get('/api/schedules/agents')).json()) as Array<{ name: string }>
    expect(agents.map((a) => a.name)).toEqual([TENANT_AGENT])

    // Another tenant's task is not found (not forbidden): its existence is not theirs to learn.
    expect((await viewer.get(`/api/schedules/${adminTask}/runs`)).status()).toBe(404)
    // A tenant-scoped filter by the viewer cannot widen their view.
    const widened = (await (await viewer.get('/api/schedules?tenant=default')).json()) as Array<{ tenantId: string }>
    expect(widened.every((r) => r.tenantId === TENANT)).toBe(true)
  })
})
