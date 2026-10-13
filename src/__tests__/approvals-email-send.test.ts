// Asking for an email_send approval through the real route and a real in-memory database: only the main
// agent asks, the body is the envelope of one exact mail, the server rebuilds the hash and the
// description from it, the same open request is not made twice, and the owner is not flooded.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const flags = vi.hoisted(() => ({ enforce: true }))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  get APPROVAL_HUMAN_ONLY_ENFORCE() { return flags.enforce },
}))

const deliverToChannel = vi.hoisted(() => vi.fn())
vi.mock('../notify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notify.js')>()),
  deliverToChannel,
}))

import { initDatabase, getDb, getApproval, listApprovalEvents, getPendingMessages } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { tryHandleAutonomy } from '../web/routes/autonomy.js'
import { parseEmailEnvelope } from '../web/email-envelope.js'

interface Caller { auth?: RouteContext['auth']; role?: RouteContext['role']; tokenAgentId?: string; tenantId?: string | null }
const ADMIN: Caller = { auth: { kind: 'token', tokenName: 'op' }, role: 'admin' }
const MAIN_TOKEN: Caller = { auth: { kind: 'token', tokenName: 'main' }, role: 'fleet_agent', tokenAgentId: 'main-agent' }
const WORKER_TOKEN: Caller = { auth: { kind: 'token', tokenName: 'w' }, role: 'fleet_agent', tokenAgentId: 'worker' }

async function call(method: string, path: string, caller: Caller, body?: object) {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth: caller.auth, role: caller.role, tokenAgentId: caller.tokenAgentId, tenantId: caller.tenantId } as unknown as RouteContext
  const handled = path.startsWith('/api/autonomy') ? await tryHandleAutonomy(ctx) : await tryHandleApprovals(ctx)
  expect(handled).toBe(true)
  return out
}

let seq = 0
/** A distinct mail every call, unless `subject` is given. */
const envelope = (extra: Record<string, unknown> = {}) => ({ to: ['owner@example.com'], subject: `Mail ${++seq}`, body: 'Hello there', ...extra })
const ask = (caller: Caller, env: Record<string, unknown> = envelope(), extra: Record<string, unknown> = {}, agent = 'main-agent') =>
  call('POST', '/api/approvals', caller, { agent_id: agent, category: 'email_send', action_payload: JSON.stringify(env), ...extra })
const hashOf = (env: Record<string, unknown>, agent = 'main-agent'): string => {
  const r = parseEmailEnvelope(env, agent)
  if (!r.ok) throw new Error(r.hint)
  return r.hash
}
const rows = () => getDb().prepare("SELECT * FROM approvals WHERE category = 'email_send'").all() as any[]
const flush = () => new Promise((r) => setImmediate(r))

beforeEach(() => {
  flags.enforce = true
  seq = 0
  initDatabase(':memory:')
  deliverToChannel.mockReset()
  deliverToChannel.mockResolvedValue(true)
})

describe('the request of the main agent', () => {
  it('stores the envelope the server hashed, the hash it computed, and a description it wrote', async () => {
    const env = envelope({ to: ['B@Example.com', 'a@example.com'], bcc: ['hidden@example.com'], subject: 'Plan' })
    const out = await ask(MAIN_TOKEN, env, { action_description: 'harmless note from the agent' })
    expect(out.status).toBe(201)
    const hash = hashOf(env)
    expect(out.body).toMatchObject({ agent_id: 'main-agent', category: 'email_send', content_hash: hash, human_only: 1, status: 'pending' })
    expect(out.body.action_description).not.toContain('harmless note')
    expect(out.body.action_description).toContain('to: B@example.com, a@example.com')
    expect(out.body.action_description).toContain('bcc: hidden@example.com')
    // The stored payload is the canonical form: hashing it again gives the stored hash.
    const parsed = parseEmailEnvelope(env, 'main-agent')
    expect(out.body.action_payload).toBe(parsed.ok && parsed.canon)
    expect(JSON.parse(out.body.action_payload).to).toEqual(['B@example.com', 'a@example.com'])
    expect(parseEmailEnvelope(JSON.parse(out.body.action_payload), 'main-agent')).toMatchObject({ ok: true, hash })
    expect(getApproval(out.body.id)).toMatchObject({ content_hash: hash, action_payload: out.body.action_payload })
  })

  it('needs no description from the requester', async () => {
    expect((await ask(MAIN_TOKEN)).status).toBe(201)
  })

  it('accepts the hash the client computed when it is the server hash, and refuses a different one', async () => {
    const env = envelope()
    expect((await ask(MAIN_TOKEN, env, { content_hash: hashOf(env) })).status).toBe(201)
    const other = envelope()
    const refused = await ask(MAIN_TOKEN, other, { content_hash: hashOf(env) })
    expect(refused.status).toBe(400)
    expect(refused.body).toMatchObject({ error: 'invalid_value', field: 'content_hash', code: 'hash_mismatch' })
    expect(rows()).toHaveLength(1)
    const audit = getDb().prepare("SELECT action FROM agent_audit_log WHERE entity = 'approval' AND action = 'envelope_hash_mismatch'").all()
    expect(audit).toHaveLength(1)
  })

  it('ignores the agent the payload names: the hash is bound to the requester', async () => {
    const env = envelope()
    const out = await ask(MAIN_TOKEN, { ...env, agent: 'worker' })
    expect(out.status).toBe(201)
    expect(out.body.content_hash).toBe(hashOf(env, 'main-agent'))
    expect(out.body.content_hash).not.toBe(hashOf(env, 'worker'))
  })

  it('is described by the server for an admin token naming the main agent too', async () => {
    const out = await ask(ADMIN)
    expect(out.status).toBe(201)
    expect(out.body.agent_id).toBe('main-agent')
  })
})

describe('who may ask', () => {
  it('refuses a sub-agent: its fleet token naming itself, and any token naming it', async () => {
    const own = await ask(WORKER_TOKEN, envelope(), {}, 'worker')
    expect(own.status).toBe(403)
    expect(own.body).toMatchObject({ error: 'forbidden' })
    expect(own.body.hint).toMatch(/main agent/)
    expect((await ask(ADMIN, envelope(), {}, 'worker')).status).toBe(403)
    expect(rows()).toHaveLength(0)
  })

  it('refuses a fleet token that names another agent (the main agent) than its own', async () => {
    expect((await ask(WORKER_TOKEN)).status).toBe(403)
    expect(rows()).toHaveLength(0)
  })

  it('refuses a sub-agent without enforcement as well', async () => {
    flags.enforce = false
    expect((await ask(WORKER_TOKEN, envelope(), {}, 'worker')).status).toBe(403)
  })

  it('gives a spelling that reads as email_send the same rules, and stores the canonical name', async () => {
    flags.enforce = false
    const sub = await call('POST', '/api/approvals', ADMIN, { agent_id: 'worker', category: 'Email_Send', action_description: 'x' })
    expect(sub.status).toBe(403)
    const noPayload = await call('POST', '/api/approvals', ADMIN, { agent_id: 'main-agent', category: 'emailsend', action_description: 'x' })
    expect(noPayload.status).toBe(400)
    const ok = await call('POST', '/api/approvals', ADMIN, { agent_id: 'main-agent', category: ' EMAIL_SEND ', action_payload: JSON.stringify(envelope()) })
    expect(ok.status).toBe(201)
    expect(ok.body).toMatchObject({ category: 'email_send', human_only: 1 })
    expect(ok.body.content_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('what the envelope must be', () => {
  it('needs an action_payload', async () => {
    const out = await call('POST', '/api/approvals', MAIN_TOKEN, { agent_id: 'main-agent', category: 'email_send', action_description: 'send it' })
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'required', field: 'action_payload' })
  })

  it('refuses a payload that is not a JSON object', async () => {
    for (const payload of ['not json', '[]', 'null', '"x"', '5']) {
      const out = await call('POST', '/api/approvals', MAIN_TOKEN, { agent_id: 'main-agent', category: 'email_send', action_payload: payload })
      expect(out.status, payload).toBe(400)
      expect(out.body.field).toBe('action_payload')
    }
    expect((await call('POST', '/api/approvals', MAIN_TOKEN, { agent_id: 'main-agent', category: 'email_send', action_payload: { to: [] } })).status).toBe(400)
  })

  it('refuses a payload larger than 256 KB', async () => {
    const out = await ask(MAIN_TOKEN, envelope({ body: 'x'.repeat(256 * 1024) }))
    expect(out.status).toBe(400)
    expect(out.body.hint).toMatch(/larger than/)
  })

  it('names the field that is wrong', async () => {
    const out = await ask(MAIN_TOKEN, envelope({ to: ['Name <a@example.com>'] }))
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'action_payload', code: 'invalid_envelope', envelope_field: 'to' })
    expect((await ask(MAIN_TOKEN, envelope({ extra: 1 }))).body.envelope_field).toBe('extra')
    expect((await ask(MAIN_TOKEN, envelope({ to: [] }))).body.envelope_field).toBe('to')
    expect(rows()).toHaveLength(0)
  })

  it('refuses a content_hash that is not 64 lowercase hex', async () => {
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), '', 5]) {
      const out = await ask(MAIN_TOKEN, envelope(), { content_hash: bad })
      expect(out.status, String(bad)).toBe(400)
      expect(out.body).toMatchObject({ error: 'invalid_value', field: 'content_hash' })
    }
    expect(rows()).toHaveLength(0)
  })
})

describe('the same mail twice, and too many mails', () => {
  it('answers a repeat of an open request with that request, writes nothing and tells nobody', async () => {
    const env = envelope()
    const first = await ask(MAIN_TOKEN, env)
    await flush()
    const again = await ask(MAIN_TOKEN, env)
    await flush()
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ id: first.body.id, deduplicated: true })
    expect(rows()).toHaveLength(1)
    expect(deliverToChannel).toHaveBeenCalledTimes(1)
    expect(listApprovalEvents(first.body.id).map((e) => e.event)).toEqual(['created_deduplicated'])
  })

  it('ten simultaneous identical requests leave one row and one owner message', async () => {
    const env = envelope()
    const outs = await Promise.all(Array.from({ length: 10 }, () => ask(MAIN_TOKEN, env)))
    await flush()
    expect(rows()).toHaveLength(1)
    expect(outs.filter((o) => o.status === 201)).toHaveLength(1)
    expect(outs.filter((o) => o.status === 200 && o.body.deduplicated)).toHaveLength(9)
    expect(deliverToChannel).toHaveBeenCalledTimes(1)
  })

  it('a decided request is no longer open: the same mail asked again is a new request', async () => {
    const env = envelope()
    const first = await ask(MAIN_TOKEN, env)
    getDb().prepare("UPDATE approvals SET status = 'rejected', resolved_at = 1 WHERE id = ?").run(first.body.id)
    const second = await ask(MAIN_TOKEN, env)
    expect(second.status).toBe(201)
    expect(second.body.id).not.toBe(first.body.id)
  })

  it('the same mail in another tenant is a request of its own', async () => {
    const env = envelope()
    expect((await ask(ADMIN, env, { tenant_id: 'tenant-a' })).status).toBe(201)
    expect((await ask(ADMIN, env, { tenant_id: 'tenant-b' })).status).toBe(201)
    expect((await ask(ADMIN, env, { tenant_id: 'tenant-a' })).status).toBe(200)
  })

  it('stops at ten open requests and says why', async () => {
    for (let i = 0; i < 10; i++) expect((await ask(MAIN_TOKEN)).status).toBe(201)
    const over = await ask(MAIN_TOKEN)
    expect(over.status).toBe(409)
    expect(over.body).toMatchObject({ error: 'conflict', reason: 'too_many_pending' })
    expect(rows()).toHaveLength(10)
  })
})

describe('telling the owner', () => {
  it('announces at most five new requests per hour; the rest wait on the page, journalled', async () => {
    const made: string[] = []
    for (let i = 0; i < 7; i++) {
      const out = await ask(MAIN_TOKEN)
      expect(out.status).toBe(201)
      made.push(out.body.id)
      await flush()
    }
    expect(deliverToChannel).toHaveBeenCalledTimes(5)
    expect(listApprovalEvents(made[5]).map((e) => [e.event, e.reason])).toEqual([['notify_suppressed', 'rate_limited']])
    expect(listApprovalEvents(made[6]).map((e) => e.event)).toEqual(['notify_suppressed'])
    expect(listApprovalEvents(made[4])).toEqual([])
  })

  it('counts requests older than an hour as spent allowance no longer', async () => {
    for (let i = 0; i < 5; i++) await ask(MAIN_TOKEN)
    getDb().prepare('UPDATE approvals SET requested_at = requested_at - 7200').run()
    await flush()
    deliverToChannel.mockClear()
    await ask(MAIN_TOKEN)
    await flush()
    expect(deliverToChannel).toHaveBeenCalledTimes(1)
  })

  it('without enforcement the same allowance keeps the main agent from being told of every request', async () => {
    flags.enforce = false
    for (let i = 0; i < 7; i++) await ask(MAIN_TOKEN)
    expect(getPendingMessages('main-agent')).toHaveLength(5)
  })

  it('shows the owner the server description, not the requester text', async () => {
    await ask(MAIN_TOKEN, envelope({ subject: 'Real subject' }), { action_description: 'a friendly lie' })
    await flush()
    const sent = deliverToChannel.mock.calls[0][0] as string
    expect(sent).toContain('Real subject')
    expect(sent).not.toContain('friendly lie')
  })
})

describe('other categories are as they were', () => {
  it('still need a description, take no envelope, and may carry a hash', async () => {
    const noDesc = await call('POST', '/api/approvals', ADMIN, { agent_id: 'worker', category: 'file_write' })
    expect(noDesc.status).toBe(400)
    expect(noDesc.body.field).toBe('action_description')
    const hash = 'c'.repeat(64)
    const ok = await call('POST', '/api/approvals', WORKER_TOKEN, { agent_id: 'worker', category: 'file_write', action_description: 'write', content_hash: hash, action_payload: 'free text' })
    expect(ok.status).toBe(201)
    expect(ok.body).toMatchObject({ content_hash: hash, action_payload: 'free text', human_only: 0 })
    expect((await call('POST', '/api/approvals', ADMIN, { agent_id: 'worker', category: 'file_write', action_description: 'w', content_hash: 'nope' })).status).toBe(400)
  })

  it('email_standing_recipient is human-only but takes a description and any agent', async () => {
    const out = await call('POST', '/api/approvals', WORKER_TOKEN, { agent_id: 'worker', category: 'email_standing_recipient', action_description: 'add a@example.com' })
    expect(out.status).toBe(201)
    expect(out.body).toMatchObject({ human_only: 1, content_hash: null })
  })
})

describe('GET /api/approvals?content_hash=', () => {
  it('lists the rows of that hash only, with their consume columns', async () => {
    const a = envelope()
    const first = await ask(MAIN_TOKEN, a)
    await ask(MAIN_TOKEN)
    const out = await call('GET', `/api/approvals?content_hash=${hashOf(a)}`, ADMIN)
    expect(out.status).toBe(200)
    expect(out.body.items.map((r: any) => r.id)).toEqual([first.body.id])
    expect(out.body.total).toBe(1)
    expect(out.body.items[0]).toHaveProperty('consumed_at', null)
    expect(out.body.items[0]).toHaveProperty('resolved_via', null)
  })

  it('refuses a malformed hash, and keeps a fleet token to its own rows', async () => {
    expect((await call('GET', `/api/approvals?content_hash=${'A'.repeat(64)}`, ADMIN)).status).toBe(400)
    const a = envelope()
    await ask(MAIN_TOKEN, a)
    await ask(MAIN_TOKEN)
    expect((await call('GET', `/api/approvals?content_hash=${hashOf(a)}`, MAIN_TOKEN)).body.items).toHaveLength(1)
    expect((await call('GET', `/api/approvals?content_hash=${hashOf(a)}`, WORKER_TOKEN)).body.items).toHaveLength(0)
  })

  it('does not cross tenants for a tenant user', async () => {
    const a = envelope()
    await ask(ADMIN, a, { tenant_id: 'tenant-a' })
    const other = { auth: { kind: 'session', user: 'u' } as any, role: 'viewer' as const, tenantId: 'tenant-b' }
    expect((await call('GET', `/api/approvals?content_hash=${hashOf(a)}`, other)).body.items).toHaveLength(0)
    const own = { ...other, tenantId: 'tenant-a' }
    expect((await call('GET', `/api/approvals?content_hash=${hashOf(a)}`, own)).body.items).toHaveLength(1)
  })
})

describe('GET /api/autonomy', () => {
  it('says whether the human-only rule binds on this server', async () => {
    flags.enforce = true
    expect((await call('GET', '/api/autonomy', ADMIN)).body.approvalHumanOnlyEnforce).toBe(true)
    flags.enforce = false
    expect((await call('GET', '/api/autonomy', ADMIN)).body.approvalHumanOnlyEnforce).toBe(false)
  })
})
