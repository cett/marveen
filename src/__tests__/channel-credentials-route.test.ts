// /api/channel-credentials: admin only; the responses never carry a token.
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const TMP = vi.hoisted(() => ({
  dir: (require('node:fs') as typeof import('node:fs')).mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'chan-route-')),
}))
const vault = vi.hoisted(() => new Map<string, string>())
const deliver = vi.hoisted(() => ({ fn: (async (_text: string) => true) as (text: string) => Promise<boolean> }))

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
// The sweep sends its drift alarm through deliverToChannel; replaced so no test reaches a real channel and the
// delivery can be made slow (see the "check without agent_id" test).
vi.mock('../notify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notify.js')>()),
  deliverToChannel: (text: string) => deliver.fn(text),
}))
vi.mock('../web/vault.js', () => ({
  getSecret: (id: string) => vault.get(id) ?? null,
  setSecret: (id: string, _label: string, value: string) => { vault.set(id, value) },
  deleteSecret: (id: string) => vault.delete(id),
}))
vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return { ...actual, channelStateDir: (_p: string, agentDir?: string) => (agentDir ? join(agentDir, '.claude', 'channels', 'telegram') : join(TMP.dir, 'MAIN-AGENT', 'channels', 'telegram')) }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(TMP.dir, name), listAgentNames: () => ['zed', 'amy'] }
})

import { initDatabase, getDb } from '../db.js'
import { tryHandleChannelCredentials } from '../web/routes/channel-credentials.js'
import { hasPermission, resolveRequiredPermission } from '../web/rbac.js'

const TOKEN_ZED = '111111111:ZED-token-aaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_AMY = '222222222:AMY-token-bbbbbbbbbbbbbbbbbbbbbbbbbbb'

function writeChannel(agent: string, token: string, access: object): void {
  const dir = join(TMP.dir, agent, '.claude', 'channels', 'telegram')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`)
  writeFileSync(join(dir, 'access.json'), JSON.stringify(access))
}

async function call(method: string, path: string, body?: object, role: string = 'admin') {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: object }).headers = {}
  setImmediate(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(body ? JSON.stringify(body) : ''))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const out: { status: number; raw: string; body: Record<string, unknown> } = { status: 200, raw: '', body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string | Buffer) { out.raw = String(b ?? ''); try { out.body = JSON.parse(out.raw) as Record<string, unknown> } catch { /* ignore */ } },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const handled = await tryHandleChannelCredentials({ req, res, path: url.pathname, method, url, role, auth: { kind: 'token', tokenName: 'ops' } } as unknown as RouteContext)
  return { ...out, handled }
}

beforeAll(() => { initDatabase(':memory:') })
afterAll(() => { rmSync(TMP.dir, { recursive: true, force: true }) })
beforeEach(() => {
  deliver.fn = async () => true
  vault.clear()
  rmSync(TMP.dir, { recursive: true, force: true })
  mkdirSync(TMP.dir, { recursive: true })
})

describe('/api/channel-credentials', () => {
  it('does not claim other paths', async () => {
    expect((await call('GET', '/api/voice/status')).handled).toBe(false)
  })

  it.each(['fleet_agent', 'agent', 'viewer', 'read_only'])('is closed to the %s role on every route', async (role) => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    for (const [m, p] of [['GET', '/api/channel-credentials'], ['POST', '/api/channel-credentials/adopt'], ['POST', '/api/channel-credentials/check']] as const) {
      const r = await call(m, p, { agent_id: 'zed' }, role)
      expect(r.status, `${role} ${m} ${p}`).toBe(403)
    }
    expect(vault.size).toBe(0)
  })

  it('adopts an agent, lists it, and never returns a token', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    writeChannel('amy', TOKEN_AMY, { allowFrom: ['43'] })

    const adopted = await call('POST', '/api/channel-credentials/adopt', { agent_id: 'zed' })
    expect(adopted.status).toBe(200)
    expect(adopted.body).toEqual({ ok: true, agent_id: 'zed', chats: ['42'], replaced_token: false, bot_id: '111111111' })

    const list = await call('GET', '/api/channel-credentials')
    expect(list.status).toBe(200)
    expect((list.body.adopted as Array<Record<string, unknown>>).map((a) => [a.agent_id, a.chats, a.adopted_by, a.drift_state]))
      .toEqual([['zed', ['42'], 'ops', 'ok']])
    expect(list.body.unadopted).toEqual(['amy'])
    for (const r of [adopted, list]) {
      expect(r.raw).not.toContain(TOKEN_ZED)
      expect(r.raw).not.toContain(TOKEN_AMY)
    }
  })

  it('answers the bad requests with the canonical error tokens', async () => {
    expect((await call('POST', '/api/channel-credentials/adopt', {})).body.error).toBe('required')
    expect((await call('POST', '/api/channel-credentials/adopt', { agent_id: '../x' })).body.error).toBe('invalid_value')
    const unreadable = await call('POST', '/api/channel-credentials/adopt', { agent_id: 'zed' })
    expect(unreadable.status).toBe(404)
    expect(unreadable.body.error).toBe('not_found')

    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    writeChannel('amy', TOKEN_ZED, { allowFrom: ['43'] })
    expect((await call('POST', '/api/channel-credentials/adopt', { agent_id: 'zed' })).status).toBe(200)
    const dupe = await call('POST', '/api/channel-credentials/adopt', { agent_id: 'amy' })
    expect(dupe.status).toBe(409)
    expect(dupe.body.error).toBe('conflict')
  })

  it('check reports the drift state of one agent, 404 for an agent with no record', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    await call('POST', '/api/channel-credentials/adopt', { agent_id: 'zed' })
    expect((await call('POST', '/api/channel-credentials/check', { agent_id: 'zed' })).body).toEqual({ ok: true, agent_id: 'zed', drift_state: 'ok' })
    expect((await call('POST', '/api/channel-credentials/check', { agent_id: 'amy' })).status).toBe(404)
    expect((await call('POST', '/api/channel-credentials/check', { agent_id: '../x' })).status).toBe(400)
  })
})

describe('POST /api/channel-credentials/check without agent_id (the sweep)', () => {
  type Row = { agent_id: string; drift_state: string }
  const states = (body: Record<string, unknown>) => Object.fromEntries((body.adopted as Row[]).map((a) => [a.agent_id, a.drift_state]))

  // The DB is shared by the whole file; the sweep covers every recorded channel, so start from none, and leave
  // none behind: the rows these tests adopt would otherwise change what a test running after them sees
  // (order-dependent under --sequence.shuffle).
  const clearChannelRecords = () => getDb().exec('DELETE FROM channel_allowed_chats; DELETE FROM channel_credential_baseline; DELETE FROM token_usage_shadow')
  beforeEach(clearChannelRecords)
  afterEach(clearChannelRecords)

  it('answers only after every channel has been checked: the response carries the finished drift states', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    writeChannel('amy', TOKEN_AMY, { allowFrom: ['43'] })
    await call('POST', '/api/channel-credentials/adopt', { agent_id: 'zed' })
    await call('POST', '/api/channel-credentials/adopt', { agent_id: 'amy' })
    // Both channels drift, and the owner message is slow: a route that does not wait for the sweep answers with
    // the first channel's state already written and the second one still at its adopted 'ok'.
    writeChannel('zed', '555555555:OTHER-token-ddddddddddddddddddddddd', { allowFrom: ['42'] })
    writeChannel('amy', '666666666:OTHER-token-eeeeeeeeeeeeeeeeeeeeeee', { allowFrom: ['43'] })
    const sent: string[] = []
    deliver.fn = async (text) => { await new Promise((r) => setTimeout(r, 15)); sent.push(text); return true }

    const r = await call('POST', '/api/channel-credentials/check', {})

    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(states(r.body)).toEqual({ zed: 'token', amy: 'token' })
    expect(sent).toHaveLength(2) // both alarms were delivered before the answer, not after it
    expect(r.raw).not.toContain('OTHER-token')
    expect(r.raw).not.toContain(TOKEN_ZED)
    expect(r.raw).not.toContain(TOKEN_AMY)
  })

  it('with nothing drifting every adopted channel reads ok and no alarm is sent', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    await call('POST', '/api/channel-credentials/adopt', { agent_id: 'zed' })
    const send = vi.fn(async (_text: string) => true)
    deliver.fn = send

    const r = await call('POST', '/api/channel-credentials/check', {})

    expect(r.status).toBe(200)
    expect(states(r.body)).toEqual({ zed: 'ok' })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('RBAC: no table row, so the route resolves to admin:all', () => {
  it.each([
    ['GET', '/api/channel-credentials'], ['POST', '/api/channel-credentials/adopt'], ['POST', '/api/channel-credentials/check'],
    ['GET', '/api/v1/channel-credentials'], ['POST', '/api/v1/channel-credentials/adopt'],
  ])('%s %s requires admin:all, which only the admin role holds', (method, path) => {
    expect(resolveRequiredPermission(method, path)).toBeNull()
    for (const role of ['fleet_agent', 'agent', 'viewer', 'read_only'] as const) expect(hasPermission(role, 'admin:all')).toBe(false)
    expect(hasPermission('admin', 'admin:all')).toBe(true)
  })
})
