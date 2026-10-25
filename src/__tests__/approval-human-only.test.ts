// Human-only approval categories, against a real in-memory database and real dashboard sessions: the
// category check, the session-only decision, the journal of what was refused, and the autonomy toggle.
// The enforce switch is flipped per test through a live getter on the config mock.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const flags = vi.hoisted(() => ({ enforce: true }))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  get APPROVAL_HUMAN_ONLY_ENFORCE() { return flags.enforce },
}))

// The owner message is not what these tests are about (approval-owner-notice.test.ts covers it); a send
// that reaches the channel keeps the owner_unreached journal rows out of the exact event lists below.
vi.mock('../notify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notify.js')>()),
  deliverToChannel: vi.fn().mockResolvedValue(true),
}))

import { createDashboardUser, getApproval, listApprovalEvents, getAutonomyCategory } from '../db.js'
import { db } from '../db/connection.js'
import { createSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { tryHandleAutonomy } from '../web/routes/autonomy.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { checkCategory, isHumanOnly, humanSessionOf } from '../web/approval-human-only.js'
import { useTestDb } from './helpers/with-test-db.js'

// Spelled out as code points so the source carries no invisible or look-alike character itself.
const ZWSP = String.fromCodePoint(0x200b) // zero-width space
const CYRILLIC_E = String.fromCodePoint(0x0435) // looks like a Latin e
const FULLWIDTH_E = String.fromCodePoint(0xff45) // NFKC folds it to a Latin e

const HASH = '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5'
let cookies: Record<string, string>

function makeUser(name: string, role: string, tenant: string | null): string {
  const u = createDashboardUser(name, HASH)
  db.prepare('UPDATE dashboard_users SET role = ?, tenant_id = ? WHERE id = ?').run(role, tenant, u.id)
  return createSession({ userId: u.id, username: u.username })
}

useTestDb()

beforeEach(() => {
  flags.enforce = true
  _clearSessionCacheForTest()
  cookies = {
    owner: makeUser('owner', 'admin', null), // the first user: global admin
    viewer: makeUser('viewer', 'viewer', null),
    tadmin: makeUser('tadmin', 'admin', 'tenant-b'), // an admin, but of one tenant
    tagent: makeUser('tagent', 'agent', 'tenant-b'),
  }
})

interface Caller {
  auth?: RouteContext['auth']
  role?: RouteContext['role']
  tokenAgentId?: string
  tenantId?: string | null
  cookie?: string
}
const TOKEN: Caller = { auth: { kind: 'token', tokenName: 'main-token' }, role: 'admin', tokenAgentId: 'main-agent' }
// Opens the requests of other agents for the fixtures: the operator's token names no agent. The main agent's own
// token opens requests only as itself (see approvals-agent-bound-admin-own-id.test.ts).
const OPENER: Caller = { auth: { kind: 'token', tokenName: 'operator' }, role: 'admin' }
const sessionOf = (name: string, role: RouteContext['role'], tenant: string | null = null): Caller =>
  ({ auth: { kind: 'session', user: name }, role, tenantId: tenant, cookie: cookies[name] })

async function call(method: string, path: string, caller: Caller, body?: object) {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = caller.cookie ? { cookie: `${SESSION_COOKIE_NAME}=${caller.cookie}` } : {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = {
    req, res, path: url.pathname, method, url, auth: caller.auth, role: caller.role, tokenAgentId: caller.tokenAgentId, tenantId: caller.tenantId,
  } as unknown as RouteContext
  const handled = path.startsWith('/api/autonomy') ? await tryHandleAutonomy(ctx) : await tryHandleApprovals(ctx)
  expect(handled).toBe(true)
  return out
}

async function request(category: string, agent = 'agent-d'): Promise<string> {
  const out = await call('POST', '/api/approvals', OPENER, { agent_id: agent, category, action_description: 'do it' })
  expect(out.status).toBe(201)
  return out.body.id as string
}
const patch = (id: string, caller: Caller, body: object = { status: 'approved' }) => call('PATCH', `/api/approvals/${id}`, caller, body)

describe('the category check', () => {
  const FLOOR = ['email_send', 'email_standing_recipient']

  it('takes a plain category as it is, and lower-cases and trims an ordinary one', async () => {
    expect(await checkCategory('file_write', FLOOR)).toEqual({ ok: true, category: 'file_write' })
    expect(await checkCategory(' File_Write ', FLOOR)).toEqual({ ok: true, category: 'file_write' })
    expect(await checkCategory('email_send', FLOOR)).toEqual({ ok: true, category: 'email_send' })
  })

  it.each([
    ['Email_Send'], [' email_send'], ['email_send' + ZWSP], ['emailsend'], ['email__send'], ['EMAIL_SEND '], [FULLWIDTH_E + 'mail_send'],
  ])('refuses %j as a twin of email_send', async (raw) => {
    const r = await checkCategory(raw, FLOOR)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('category_alias_of_human_only')
  })

  it.each([['email-send'], [CYRILLIC_E + 'mail_send'], ['email_send;x'], [''], ['a'.repeat(65)], ['two words']])('refuses %j as a malformed name', async (raw) => {
    const r = await checkCategory(raw, FLOOR)
    expect(r.ok).toBe(false)
  })

  it('knows the floor, and any column the table adds', async () => {
    expect(await isHumanOnly('email_send')).toBe(true)
    expect(await isHumanOnly('email_standing_recipient')).toBe(true)
    expect(await isHumanOnly('file_write')).toBe(false)
    db.prepare("UPDATE autonomy_categories SET human_only = 1 WHERE key = 'payment'").run()
    expect(await isHumanOnly('payment')).toBe(true)
  })
})

describe('humanSessionOf', () => {
  const reqWith = (cookie?: string) => ({ headers: cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {} }) as any

  it('is the global admin and nobody else', () => {
    expect(humanSessionOf(reqWith(cookies.owner))).toEqual({ user: 'owner' })
    expect(humanSessionOf(reqWith(cookies.viewer))).toBeNull()
    expect(humanSessionOf(reqWith(cookies.tadmin))).toBeNull()
    expect(humanSessionOf(reqWith(cookies.tagent))).toBeNull()
    expect(humanSessionOf(reqWith('forged-cookie'))).toBeNull()
    expect(humanSessionOf(reqWith())).toBeNull()
  })

  it('stops being a person when the user is disabled', () => {
    db.prepare("UPDATE dashboard_users SET disabled = 1 WHERE username = 'owner'").run()
    expect(humanSessionOf(reqWith(cookies.owner))).toBeNull()
  })
})

describe('deciding a human-only approval (enforce)', () => {
  it('refuses every token, whatever the status, leaves the row pending and journals it', async () => {
    for (const status of ['approved', 'rejected', 'timeout']) {
      const id = await request('email_standing_recipient')
      const out = await patch(id, TOKEN, { status, resolved_by: 'owner' })
      expect(out.status).toBe(403)
      expect(out.body).toMatchObject({ error: 'forbidden', code: 'human_only_category' })
      expect(getApproval(id)?.status).toBe('pending')
      expect(listApprovalEvents(id).map((e) => [e.event, e.reason, e.actor])).toEqual([['bearer_denied', 'human_only_category', 'main-agent']])
    }
  })

  it('refuses the shared token, a device and a fleet agent token', async () => {
    const id = await request('email_standing_recipient')
    expect((await patch(id, { auth: { kind: 'token' }, role: 'admin' })).status).toBe(403)
    expect((await patch(id, { auth: { kind: 'device', device: 'phone' } as any, role: 'admin' })).status).toBe(403)
    expect((await patch(id, { auth: { kind: 'token', tokenName: 'a' }, role: 'fleet_agent', tokenAgentId: 'agent-d' })).status).toBe(403)
    expect(getApproval(id)?.status).toBe('pending')
    expect(listApprovalEvents(id)).toHaveLength(3)
  })

  it('refuses a session that is not a global admin: a viewer, a tenant admin, a tenant agent', async () => {
    const id = await request('email_standing_recipient')
    expect((await patch(id, sessionOf('viewer', 'viewer'))).status).toBe(403)
    expect((await patch(id, sessionOf('tadmin', 'admin', 'tenant-b'))).status).toBe(403)
    expect((await patch(id, sessionOf('tagent', 'agent', 'tenant-b'))).status).toBe(403)
    expect(getApproval(id)?.status).toBe('pending')
  })

  it('refuses a request whose cookie is forged, with a token that is otherwise good', async () => {
    const id = await request('email_standing_recipient')
    expect((await patch(id, { ...TOKEN, cookie: 'forged' })).status).toBe(403)
  })

  it('lets the global admin session decide, as a person, whatever the body claims', async () => {
    const id = await request('email_standing_recipient')
    const out = await patch(id, sessionOf('owner', 'admin'), { status: 'approved', resolved_by: 'main-agent' })
    expect(out.status).toBe(200)
    expect(getApproval(id)).toMatchObject({ status: 'approved', resolved_by: 'human:session:owner', resolved_via: 'dashboard_session' })
  })

  it('lets the browser that sends a token and its session cookie decide', async () => {
    const id = await request('email_standing_recipient')
    const out = await patch(id, { ...TOKEN, cookie: cookies.owner })
    expect(out.status).toBe(200)
    expect(getApproval(id)).toMatchObject({ resolved_by: 'human:session:owner', resolved_via: 'dashboard_session' })
  })

  it('does not let the requester of a human-only approval decide it by calling it a person', async () => {
    const id = await request('email_standing_recipient', 'owner')
    const out = await patch(id, sessionOf('owner', 'admin'))
    expect(out.status).toBe(200) // a session is a person, whoever the requesting agent is called
    expect(getApproval(id)?.resolved_by).toBe('human:session:owner')
  })

  it('leaves a category that is not human-only to a token, and records how it arrived', async () => {
    const id = await request('file_write')
    const out = await patch(id, TOKEN)
    expect(out.status).toBe(200)
    expect(getApproval(id)).toMatchObject({ status: 'approved', resolved_by: 'main-agent', resolved_via: 'bearer', human_only: 0 })
    expect(listApprovalEvents(id)).toHaveLength(0)
  })

  it('treats a request as human-only by its snapshot when the set shrinks, and by the category when it grows', async () => {
    const id = await request('payment')
    db.prepare("UPDATE autonomy_categories SET human_only = 1 WHERE key = 'payment'").run()
    expect((await patch(id, TOKEN)).status).toBe(403) // widened after the request: the pending row is covered too
    db.prepare("UPDATE approvals SET human_only = 1 WHERE id = ?").run(id)
    db.prepare("UPDATE autonomy_categories SET human_only = 0 WHERE key = 'payment'").run()
    expect((await patch(id, TOKEN)).status).toBe(403) // narrowed: the snapshot keeps it human-only
  })
})

describe('asking for an approval (enforce)', () => {
  it('stores the canonical category and the human-only snapshot', async () => {
    const id = await request('  File_Write ')
    expect(getApproval(id)).toMatchObject({ category: 'file_write', human_only: 0 })
    const email = await request('email_standing_recipient')
    expect(getApproval(email)).toMatchObject({ category: 'email_standing_recipient', human_only: 1 })
  })

  it.each([['Email_Send'], [' email_send'], ['emailsend'], ['email_send' + ZWSP], ['email-send'], [CYRILLIC_E + 'mail_send'], ['email_send;x']])('refuses %j', async (category) => {
    const out = await call('POST', '/api/approvals', OPENER, { agent_id: 'agent-d', category, action_description: 'x' })
    expect(out.status).toBe(400)
    expect(out.body.field).toBe('category')
    expect(db.prepare('SELECT COUNT(*) AS n FROM approvals').get()).toEqual({ n: 0 })
  })
})

describe('without enforcement (the default)', () => {
  beforeEach(() => { flags.enforce = false })

  it('lets a token decide a human-only approval, and journals that it would have been refused', async () => {
    const id = await request('email_standing_recipient')
    expect((await patch(id, TOKEN)).status).toBe(200)
    expect(getApproval(id)).toMatchObject({ status: 'approved', resolved_by: 'main-agent', resolved_via: 'bearer', human_only: 1 })
    expect(listApprovalEvents(id).map((e) => e.reason)).toEqual(['human_only_category_advisory'])
  })

  it('stores the category as sent, takes the snapshot, and does not refuse a twin spelling', async () => {
    const id = await request('Email_Standing_Recipient')
    expect(getApproval(id)).toMatchObject({ category: 'Email_Standing_Recipient', human_only: 1 })
  })
})

describe('marking a category human-only through the autonomy route', () => {
  const mark = (caller: Caller, key: string, human_only: unknown) => call('POST', '/api/autonomy', caller, { key, human_only })

  it('lets an admin token mark one, and shows it on the list', async () => {
    expect((await mark(TOKEN, 'payment', true)).status).toBe(200)
    expect((await getAutonomyCategory('payment'))?.human_only).toBe(1)
    const list = await call('GET', '/api/autonomy', TOKEN)
    expect(list.body.categories.find((c: any) => c.key === 'payment').humanOnly).toBe(true)
    expect(list.body.categories.find((c: any) => c.key === 'email_send').humanOnly).toBe(true) // the floor
    expect(list.body.categories.find((c: any) => c.key === 'deploy_retry').humanOnly).toBe(false)
  })

  it('does not let a token take the mark off, nor anyone take the floor off', async () => {
    await mark(TOKEN, 'payment', true)
    expect((await mark(TOKEN, 'payment', false)).body.code).toBe('human_session_required')
    expect((await getAutonomyCategory('payment'))?.human_only).toBe(1)
    const floor = await mark(sessionOf('owner', 'admin'), 'email_send', false)
    expect(floor.status).toBe(403)
    expect(floor.body.code).toBe('human_only_floor')
  })

  it('lets the global admin session take a non-floor mark off', async () => {
    await mark(TOKEN, 'payment', true)
    expect((await mark(sessionOf('owner', 'admin'), 'payment', false)).status).toBe(200)
    expect((await getAutonomyCategory('payment'))?.human_only).toBe(0)
  })

  it('refuses a non-admin, and a value that is not a boolean', async () => {
    expect((await mark({ auth: { kind: 'session', user: 'tagent' }, role: 'agent', cookie: cookies.tagent }, 'payment', true)).status).toBe(403)
    expect((await mark(TOKEN, 'payment', 'yes')).status).toBe(400)
  })
})
