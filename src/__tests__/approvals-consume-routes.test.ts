// Using up an approved email_send request through the real routes and a real in-memory database:
// POST /api/approvals/:id/consume and POST /api/approvals/claim with the token of the agent that asked,
// the journal at GET /api/approvals/:id/events, the permission that guards them and the window setting.
// The storage rules themselves are in approval-consume.test.ts; this file is about who may call, what
// they are told, and what is left behind.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHmac } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const flags = vi.hoisted(() => ({ enforce: true, storeDir: '' }))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  get APPROVAL_HUMAN_ONLY_ENFORCE() { return flags.enforce },
  // The claim signing key lives in the store directory: a throw-away one per test.
  get STORE_DIR() { return flags.storeDir },
}))

const deliverToChannel = vi.hoisted(() => vi.fn())
vi.mock('../notify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notify.js')>()),
  deliverToChannel,
}))

import { initDatabase, getDb, getApproval, listApprovalEvents, resolveApproval, createApproval } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { parseEmailEnvelope } from '../web/email-envelope.js'
import { APPROVAL_CONSUME_WINDOW_S, parseConsumeWindowSeconds } from '../config.js'
import { ALL_ROLES, hasPermission, resolveRequiredPermission } from '../web/rbac.js'

interface Caller { auth?: RouteContext['auth']; role?: RouteContext['role']; tokenAgentId?: string; tenantId?: string | null }
const MAIN: Caller = { auth: { kind: 'token', tokenName: 'main' }, role: 'fleet_agent', tokenAgentId: 'main-agent' }
const MAIN_ADMIN: Caller = { auth: { kind: 'token', tokenName: 'main' }, role: 'admin', tokenAgentId: 'main-agent' }
const WORKER: Caller = { auth: { kind: 'token', tokenName: 'w' }, role: 'fleet_agent', tokenAgentId: 'worker' }
const MAIN_OTHER_TENANT: Caller = { ...MAIN, tenantId: 'tenant-b' }
const SHARED: Caller = { auth: { kind: 'token', tokenName: 'op' }, role: 'admin' }
const OWNER_SESSION: Caller = { auth: { kind: 'session', user: 'owner' } as RouteContext['auth'], role: 'admin' }
const TENANT_SESSION: Caller = { auth: { kind: 'session', user: 'bob' } as RouteContext['auth'], role: 'agent', tenantId: 'tenant-b' }

async function call(method: string, path: string, caller: Caller, body?: unknown, rawBody?: string) {
  const buf = rawBody !== undefined ? Buffer.from(rawBody) : body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
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
  expect(await tryHandleApprovals(ctx)).toBe(true)
  return out
}

let seq = 0
const envelope = () => ({ to: ['owner@example.com'], subject: `Mail ${++seq}`, body: 'Hello there' })
const hashOf = (env: Record<string, unknown>, agent = 'main-agent'): string => {
  const r = parseEmailEnvelope(env, agent)
  if (!r.ok) throw new Error(r.hint)
  return r.hash
}

/** The main agent asks for one mail; returns the request and the hash of that mail. */
async function ask(env: Record<string, unknown> = envelope()) {
  const out = await call('POST', '/api/approvals', MAIN, { agent_id: 'main-agent', category: 'email_send', action_payload: JSON.stringify(env) })
  expect(out.status).toBe(201)
  return { id: out.body.id as string, hash: out.body.content_hash as string, env }
}
const approveByPerson = async (id: string) => expect(await resolveApproval(id, 'approved', 'human:session:owner', null, 'dashboard_session')).toBe(true)
const consume = (id: string, hash: string, caller: Caller = MAIN, extra: Record<string, unknown> = {}) =>
  call('POST', `/api/approvals/${id}/consume`, caller, { content_hash: hash, ...extra })
const claim = (hash: string, caller: Caller = MAIN, extra: Record<string, unknown> = {}) =>
  call('POST', '/api/approvals/claim', caller, { category: 'email_send', content_hash: hash, ...extra })
const auditRows = () => getDb().prepare("SELECT agent_id, entity_id, detail FROM agent_audit_log WHERE entity = 'approval' AND action = 'consume' ORDER BY id").all() as any[]

beforeEach(() => {
  flags.enforce = true
  flags.storeDir = mkdtempSync(join(tmpdir(), 'claim-key-'))
  seq = 0
  initDatabase(':memory:')
  deliverToChannel.mockReset()
  deliverToChannel.mockResolvedValue(true)
})

describe('POST /api/approvals/:id/consume', () => {
  it('uses an approved request up once, journals it and audits it', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    const out = await consume(id, hash, MAIN, { ref: 'gmail-send-1', consumer: 'email-approval-gate' })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, replayed: false, window_s: APPROVAL_CONSUME_WINDOW_S })
    expect(out.body.approval).toMatchObject({ id, consumed_by: 'main-agent', consumed_ref: 'gmail-send-1' })
    expect(out.body.approval.consumed_at).toEqual(expect.any(Number))
    expect(await getApproval(id)).toMatchObject({ consumed_by: 'main-agent', consumed_ref: 'gmail-send-1' })
    expect((await listApprovalEvents(id)).map((e) => e.event)).toEqual(['consumed'])
    expect(auditRows()).toEqual([{ agent_id: 'main-agent', entity_id: id, detail: expect.stringContaining('"outcome":"consumed"') }])
    expect(auditRows()[0].detail).toContain(hash.slice(0, 12))
    expect(auditRows()[0].detail).not.toContain(hash)
  })

  it('answers a second use 409 already_consumed, and a retry with the same ref as a replay', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    expect((await consume(id, hash, MAIN, { ref: 'r1' })).status).toBe(200)
    const again = await consume(id, hash, MAIN, { ref: 'r2' })
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({ error: 'conflict', reason: 'already_consumed', window_s: APPROVAL_CONSUME_WINDOW_S })
    expect(again.body.approval).toEqual({ id, status: 'approved', consumed_at: expect.any(Number), consumed_by: 'main-agent', consumed_ref: 'r1' })
    const retry = await consume(id, hash, MAIN, { ref: 'r1' })
    expect(retry.status).toBe(200)
    expect(retry.body).toMatchObject({ ok: true, replayed: true })
    expect((await listApprovalEvents(id)).map((e) => e.event)).toEqual(['consumed', 'consume_refused'])
  })

  it('lets exactly one of several simultaneous uses through', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => consume(id, hash, MAIN, { ref: `race-${n}` })))
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(results.filter((r) => r.status === 409).every((r) => r.body.reason === 'already_consumed')).toBe(true)
  })

  it('refuses a request nobody has approved, a rejected one and a different mail, naming the reason', async () => {
    const a = await ask()
    const pending = await consume(a.id, a.hash)
    expect(pending.status).toBe(409)
    expect(pending.body.reason).toBe('not_approved')
    expect(pending.body.approval).toMatchObject({ id: a.id, status: 'pending', consumed_at: null })
    expect(await resolveApproval(a.id, 'rejected', 'human:session:owner', null, 'dashboard_session')).toBe(true)
    expect((await consume(a.id, a.hash)).body.reason).toBe('not_approved')
    const b = await ask()
    await approveByPerson(b.id)
    const other = await consume(b.id, hashOf(envelope()))
    expect(other.status).toBe(409)
    expect(other.body.reason).toBe('hash_mismatch')
    expect((await getApproval(b.id))?.consumed_at).toBeNull()
  })

  it('refuses an approval a token decided, not a person (advisory-era leftovers)', async () => {
    const { id, hash } = await ask()
    expect(await resolveApproval(id, 'approved', 'some-token', null, 'bearer')).toBe(true)
    const out = await consume(id, hash)
    expect(out.status).toBe(409)
    expect(out.body.reason).toBe('not_human_decided')
    expect((await getApproval(id))?.consumed_at).toBeNull()
  })

  it('refuses an approval older than the window', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    getDb().prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - APPROVAL_CONSUME_WINDOW_S - 5, id)
    const out = await consume(id, hash)
    expect(out.status).toBe(409)
    expect(out.body.reason).toBe('expired')
  })

  it('refuses a category that has no hash to bind', async () => {
    await createApproval({ id: 'plain-1', agent_id: 'main-agent', category: 'deploy', action_description: 'x', content_hash: 'a'.repeat(64) })
    await resolveApproval('plain-1', 'approved', 'human:session:owner', null, 'dashboard_session')
    const out = await consume('plain-1', 'a'.repeat(64))
    expect(out.status).toBe(409)
    expect(out.body.reason).toBe('wrong_category')
  })
})

describe('who may use an approval up', () => {
  it('needs the token of an identified agent: a shared token, a session and a tenant user are 403', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    for (const caller of [SHARED, OWNER_SESSION, TENANT_SESSION]) {
      const out = await consume(id, hash, caller)
      expect(out.status).toBe(403)
      expect(out.body).toMatchObject({ error: 'forbidden', reason: 'agent_identity_required' })
      expect((await claim(hash, caller)).status).toBe(403)
    }
    expect((await getApproval(id))?.consumed_at).toBeNull()
  })

  it('is the requesting agent only: another agent is 403 and the row is untouched', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    const out = await consume(id, hash, WORKER)
    expect(out.status).toBe(403)
    expect(out.body).toMatchObject({ error: 'forbidden', reason: 'agent_mismatch' })
    expect(JSON.stringify(out.body)).not.toContain('owner@example.com')
    expect((await getApproval(id))?.consumed_at).toBeNull()
    expect((await listApprovalEvents(id)).map((e) => [e.event, e.reason, e.actor])).toEqual([['consume_refused', 'agent_mismatch', 'worker']])
    expect((await claim(hash, WORKER)).body.reason).toBe('none')
  })

  it('treats another tenant\'s approval as missing', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    const out = await consume(id, hash, MAIN_OTHER_TENANT)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
    expect((await consume('no-such-id', hash)).status).toBe(404)
    expect((await claim(hash, MAIN_OTHER_TENANT)).body.reason).toBe('none')
    expect((await getApproval(id))?.consumed_at).toBeNull()
  })

  it('lets the main agent\'s admin-role token use its own approval', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    expect((await consume(id, hash, MAIN_ADMIN)).status).toBe(200)
  })
})

describe('what the body must hold', () => {
  it('refuses a body that is not JSON, not an object, or has no valid hash', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    const path = `/api/approvals/${id}/consume`
    expect((await call('POST', path, MAIN, undefined, '{nope')).status).toBe(400)
    expect((await call('POST', path, MAIN, [hash])).status).toBe(400)
    expect((await call('POST', path, MAIN, {})).body).toMatchObject({ error: 'invalid_value', field: 'content_hash' })
    expect((await call('POST', path, MAIN, { content_hash: hash.toUpperCase() })).status).toBe(400)
    expect((await call('POST', path, MAIN, { content_hash: hash.slice(1) })).status).toBe(400)
    expect((await getApproval(id))?.consumed_at).toBeNull()
  })

  it('keeps ref and consumer short and printable', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    for (const bad of [{ ref: 'x'.repeat(201) }, { ref: 'tab\there' }, { ref: 'café' }, { ref: 5 }, { consumer: 'y'.repeat(65) }, { consumer: {} }]) {
      const out = await consume(id, hash, MAIN, bad)
      expect(out.status, JSON.stringify(bad)).toBe(400)
      expect(out.body.error).toBe('invalid_value')
    }
    expect((await consume(id, hash, MAIN, { ref: 'x'.repeat(200), consumer: 'y'.repeat(64) })).status).toBe(200)
  })
})

describe('POST /api/approvals/claim', () => {
  it('uses up the approval of the mail it is told the hash of', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    const out = await claim(hash, MAIN, { ref: 'send-1' })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, replayed: false, window_s: APPROVAL_CONSUME_WINDOW_S })
    expect(out.body.approval).toMatchObject({ id, consumed_by: 'main-agent', consumed_ref: 'send-1' })
    expect((await claim(hash, MAIN, { ref: 'send-1' })).body).toMatchObject({ ok: true, replayed: true })
    const second = await claim(hash, MAIN, { ref: 'send-2' })
    expect(second.status).toBe(409)
    expect(second.body.reason).toBe('already_consumed')
    expect(auditRows().map((r) => JSON.parse(r.detail).outcome)).toEqual(['consumed', 'replayed', 'already_consumed'])
  })

  it('says why there is nothing to use, best reason first', async () => {
    const none = await claim(hashOf(envelope()))
    expect(none.status).toBe(409)
    expect(none.body).toMatchObject({ error: 'conflict', reason: 'none' })

    const open = await ask()
    const pending = await claim(open.hash)
    expect(pending.status).toBe(409)
    expect(pending.body).toMatchObject({ reason: 'pending', approval_id: open.id })
    expect(pending.body.approval).toMatchObject({ id: open.id, status: 'pending' })

    expect(await resolveApproval(open.id, 'rejected', 'human:session:owner', null, 'dashboard_session')).toBe(true)
    expect((await claim(open.hash)).body.reason).toBe('rejected')

    const old = await ask()
    await approveByPerson(old.id)
    getDb().prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - APPROVAL_CONSUME_WINDOW_S - 5, old.id)
    expect((await claim(old.hash)).body.reason).toBe('expired')
  })

  it('needs a category and a valid hash, and is no way to use up a plain approval', async () => {
    const hash = hashOf(envelope())
    expect((await call('POST', '/api/approvals/claim', MAIN, { content_hash: hash })).body).toMatchObject({ error: 'required', field: 'category' })
    expect((await call('POST', '/api/approvals/claim', MAIN, { category: 'email_send' })).status).toBe(400)
    expect((await call('POST', '/api/approvals/claim', MAIN, { category: 'email_send', content_hash: 'zz' })).status).toBe(400)
    const wrong = await call('POST', '/api/approvals/claim', MAIN, { category: 'deploy', content_hash: hash })
    expect(wrong.status).toBe(409)
    expect(wrong.body.reason).toBe('wrong_category')
  })
})

describe('GET /api/approvals/:id/events', () => {
  it('lists the journal of one approval, refusals included, oldest first', async () => {
    const { id, hash } = await ask()
    await consume(id, hash)
    await approveByPerson(id)
    await consume(id, hash, MAIN, { ref: 'a' })
    await consume(id, hash, MAIN, { ref: 'b' })
    const out = await call('GET', `/api/approvals/${id}/events`, OWNER_SESSION)
    expect(out.status).toBe(200)
    expect(out.body.approval_id).toBe(id)
    expect(out.body.items.map((e: any) => [e.event, e.reason])).toEqual([
      ['consume_refused', 'not_approved'], ['consumed', null], ['consume_refused', 'already_consumed'],
    ])
    expect(out.body.items[1]).toMatchObject({ actor: 'main-agent', ref: 'a' })
  })

  it('is for the owner and tenant users, not for a fleet agent token; a foreign tenant and a missing id are 404', async () => {
    const { id } = await ask()
    const agent = await call('GET', `/api/approvals/${id}/events`, MAIN)
    expect(agent.status).toBe(403)
    expect((await call('GET', `/api/approvals/${id}/events`, TENANT_SESSION)).status).toBe(404)
    expect((await call('GET', '/api/approvals/nope/events', OWNER_SESSION)).status).toBe(404)
    const own = await createApproval({ id: 'b-1', agent_id: 'x', category: 'deploy', action_description: 'x', tenant_id: 'tenant-b' })
    expect((await call('GET', `/api/approvals/${own.id}/events`, TENANT_SESSION)).status).toBe(200)
  })
})

describe('the permission', () => {
  const PATHS = ['/api/approvals/claim', '/api/approvals/abc/consume', '/api/v1/approvals/claim', '/api/v1/approvals/abc/consume']

  it('is approvals:consume for both routes, ahead of the approvals:write prefix rows', () => {
    for (const p of PATHS) expect(resolveRequiredPermission('POST', p), p).toBe('approvals:consume')
    expect(resolveRequiredPermission('POST', '/api/approvals')).toBe('approvals:write')
    expect(resolveRequiredPermission('PATCH', '/api/approvals/abc')).toBe('approvals:write')
    expect(resolveRequiredPermission('GET', '/api/approvals/abc/events')).toBe('approvals:read')
  })

  it('is held by admin and fleet_agent only: read_only and viewer, who may only look at approvals, may not use one up', () => {
    expect(hasPermission('admin', 'approvals:consume')).toBe(true)
    expect(hasPermission('fleet_agent', 'approvals:consume')).toBe(true)
    for (const role of ALL_ROLES.filter((r) => r !== 'admin')) expect(hasPermission(role, 'approvals:consume'), role).toBe(false)
    expect(hasPermission('viewer', 'approvals:write')).toBe(false)
  })
})

describe('the window setting', () => {
  it('defaults to 30 minutes and pulls a value into 60 s .. 24 h', () => {
    expect(APPROVAL_CONSUME_WINDOW_S).toBe(1800)
    const table: [string | undefined, number][] = [
      [undefined, 1800], ['', 1800], ['  ', 1800], ['abc', 1800], ['-5', 1800], ['12.5', 1800], ['1e3', 1800], ['0x10', 1800],
      ['0', 60], ['5', 60], ['59', 60], ['60', 60], ['900', 900], ['1800', 1800], ['86400', 86400], ['86401', 86400],
      ['999999999', 86400], ['9999999999', 1800],
    ]
    for (const [raw, want] of table) expect(parseConsumeWindowSeconds(raw), String(raw)).toBe(want)
  })
})

// The signature on a 200 answer: an HMAC the send gate checks with store/.claim-signing-key. The expected value is
// recomputed here with node:crypto from the documented text, not with the helper under test.
describe('the signature on a used-up answer', () => {
  const keyPath = () => join(flags.storeDir, '.claim-signing-key')
  const keyBytes = () => Buffer.from(readFileSync(keyPath(), 'utf-8').trim(), 'hex')
  const hmac = (text: string) => createHmac('sha256', keyBytes()).update(text).digest('hex')
  const signedText = (a: Record<string, any>) => ['v1', a.content_hash, a.category, a.agent_id, a.consumed_ref ?? '', String(a.consumed_at)].join('|')

  async function approvedClaim(ref = 'gate-1') {
    const { id, hash } = await ask()
    await approveByPerson(id)
    return { id, hash, out: await claim(hash, MAIN, { ref, consumer: 'email-approval-gate' }) }
  }

  it('is on the claim answer and is the HMAC-SHA256 of v1|hash|category|agent|ref|consumed_at', async () => {
    const { hash, out } = await approvedClaim('gate-abc')
    expect(out.status).toBe(200)
    expect(out.body.sig).toMatch(/^[0-9a-f]{64}$/)
    expect(out.body.approval).toMatchObject({ content_hash: hash, category: 'email_send', agent_id: 'main-agent', consumed_ref: 'gate-abc' })
    expect(signedText(out.body.approval)).toBe(`v1|${hash}|email_send|main-agent|gate-abc|${out.body.approval.consumed_at}`)
    expect(out.body.sig).toBe(hmac(signedText(out.body.approval)))
  })

  it('is on the consume answer, and a replay of the same use carries the same signature', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    const first = await consume(id, hash, MAIN, { ref: 'r1' })
    expect(first.status).toBe(200)
    expect(first.body.sig).toBe(hmac(signedText(first.body.approval)))
    const replay = await consume(id, hash, MAIN, { ref: 'r1' })
    expect(replay.body).toMatchObject({ ok: true, replayed: true })
    expect(replay.body.sig).toBe(first.body.sig)
    const claimReplay = await claim(hash, MAIN, { ref: 'r1' })
    expect(claimReplay.body).toMatchObject({ ok: true, replayed: true, sig: first.body.sig })
  })

  it('changes with every signed field', async () => {
    const { out } = await approvedClaim('gate-1')
    const a = out.body.approval
    const base = { content_hash: a.content_hash, category: a.category, agent_id: a.agent_id, consumed_ref: a.consumed_ref, consumed_at: a.consumed_at }
    expect(out.body.sig).toBe(hmac(signedText(base)))
    const variants: Record<string, any>[] = [
      { ...base, content_hash: 'f'.repeat(64) }, { ...base, category: 'other' }, { ...base, agent_id: 'worker' },
      { ...base, consumed_ref: 'gate-2' }, { ...base, consumed_ref: null }, { ...base, consumed_at: base.consumed_at + 1 },
    ]
    const sigs = new Set([out.body.sig, ...variants.map((v) => hmac(signedText(v)))])
    expect(sigs.size).toBe(variants.length + 1)
    // and another key signs differently
    expect(createHmac('sha256', Buffer.alloc(32, 7)).update(signedText(base)).digest('hex')).not.toBe(out.body.sig)
  })

  it('creates the key file with mode 0600, keeps it, and never returns the key', async () => {
    expect(existsSync(keyPath())).toBe(false)
    const first = await approvedClaim('gate-1')
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600)
    expect(readFileSync(keyPath(), 'utf-8').trim()).toMatch(/^[0-9a-f]{64}$/)
    const keyHex = readFileSync(keyPath(), 'utf-8').trim()
    const second = await approvedClaim('gate-2')
    expect(readFileSync(keyPath(), 'utf-8').trim()).toBe(keyHex)
    for (const out of [first.out, second.out]) expect(JSON.stringify(out.body)).not.toContain(keyHex)
    // no temp file is left beside it
    expect(existsSync(`${keyPath()}.${process.pid}`)).toBe(false)
  })

  it('answers 503 and uses nothing up when the key cannot be read, and works again once it can', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    mkdirSync(keyPath())   // a directory where the key file should be: not readable as a key
    for (const out of [await claim(hash, MAIN, { ref: 'r1' }), await consume(id, hash, MAIN, { ref: 'r1' })]) {
      expect(out.status).toBe(503)
      expect(out.body).toMatchObject({ error: 'internal_error', reason: 'claim_signing_unavailable' })
      expect(out.body.sig).toBeUndefined()
      expect(out.body.approval).toBeUndefined()
    }
    expect(await getApproval(id)).toMatchObject({ consumed_at: null, consumed_by: null })
    rmSync(keyPath(), { recursive: true })
    const ok = await claim(hash, MAIN, { ref: 'r1' })
    expect(ok.status).toBe(200)
    expect(ok.body.sig).toBe(hmac(signedText(ok.body.approval)))
  })

  it('answers 503 for a key file that is not a key (short, not hex), without replacing it', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    for (const junk of ['', 'abc', 'zz'.repeat(32), 'ab'.repeat(16), 'AB'.repeat(32)]) {
      writeFileSync(keyPath(), junk)
      const out = await claim(hash, MAIN, { ref: 'r1' })
      expect(out.status, JSON.stringify(junk)).toBe(503)
      expect(readFileSync(keyPath(), 'utf-8')).toBe(junk)
    }
    expect((await getApproval(id))?.consumed_at).toBeNull()
  })

  it('does not hide the other refusals behind the key: a 409 or 403 has no signature and the usual status', async () => {
    const { hash } = await ask()
    const pending = await claim(hash, MAIN, { ref: 'r1' })
    expect(pending.status).toBe(409)
    expect(pending.body.sig).toBeUndefined()
    expect((await claim(hash, SHARED)).status).toBe(403)
  })
})

// The sender's side of the two phases (claim mode `send`): it adopts the gate's reservation and seals the use, and
// its answer carries a DIFFERENT signature (v2, over the sender's own ref and used_at). The expected values are
// recomputed here with node:crypto from the documented texts, not with the helpers under test.
describe('POST /api/approvals/claim with mode send', () => {
  const keyBytes = () => Buffer.from(readFileSync(join(flags.storeDir, '.claim-signing-key'), 'utf-8').trim(), 'hex')
  const hmac = (text: string) => createHmac('sha256', keyBytes()).update(text).digest('hex')
  const v1 = (a: Record<string, any>) => ['v1', a.content_hash, a.category, a.agent_id, a.consumed_ref ?? '', String(a.consumed_at)].join('|')
  const v2 = (a: Record<string, any>) => ['v2', a.content_hash, a.category, a.agent_id, a.used_ref, String(a.consumed_at), String(a.used_at)].join('|')
  const gateClaim = (hash: string, ref = 'gate-send-1') => claim(hash, MAIN, { ref, consumer: 'email-approval-gate' })
  const sendClaim = (hash: string, ref = 'send-1', caller: Caller = MAIN) => claim(hash, caller, { ref, consumer: 'gmail-send', mode: 'send' })

  async function reserved() {
    const { id, hash } = await ask()
    await approveByPerson(id)
    const gate = await gateClaim(hash)
    expect(gate.status).toBe(200)
    return { id, hash, gate }
  }

  it('adopts the gate\'s reservation: one approval, adopted:true, a v2 signature over the sender\'s own ref', async () => {
    const { id, hash, gate } = await reserved()
    const out = await sendClaim(hash, 'send-1')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, replayed: false, adopted: true, window_s: APPROVAL_CONSUME_WINDOW_S })
    const a = out.body.approval
    expect(a).toMatchObject({ id, consumed_ref: 'gate-send-1', used_ref: 'send-1' })
    expect(a.used_at).toEqual(expect.any(Number))
    expect(v2(a)).toBe(`v2|${hash}|email_send|main-agent|send-1|${a.consumed_at}|${a.used_at}`)
    expect(out.body.sig).toBe(hmac(v2(a)))
    // the gate's answer and the sender's answer are not interchangeable
    expect(out.body.sig).not.toBe(gate.body.sig)
    expect(out.body.sig).not.toBe(hmac(v1(a)))
    expect(gate.body.sig).toBe(hmac(v1(gate.body.approval)))
    expect((await listApprovalEvents(id)).map((e) => e.event)).toEqual(['consumed', 'used'])
    expect(auditRows().map((r) => JSON.parse(r.detail).outcome)).toEqual(['consumed', 'adopted'])
  })

  it('a second sender run is 409 already_used, and the sender\'s retry with its own ref is a replay with the same signature', async () => {
    const { hash } = await reserved()
    const first = await sendClaim(hash, 'send-1')
    const again = await sendClaim(hash, 'send-2')
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({ error: 'conflict', reason: 'already_used' })
    expect(again.body.sig).toBeUndefined()
    const retry = await sendClaim(hash, 'send-1')
    expect(retry.status).toBe(200)
    expect(retry.body).toMatchObject({ ok: true, replayed: true, adopted: true, sig: first.body.sig })
  })

  it('the gate\'s own path is unchanged: no mode, a v1 signature, no adopted field, and after the seal still already_consumed', async () => {
    const { hash, gate } = await reserved()
    expect(gate.body.adopted).toBeUndefined()
    expect(gate.body.approval.used_at ?? null).toBeNull()
    await sendClaim(hash, 'send-1')
    const gate2 = await gateClaim(hash, 'gate-send-2')
    expect(gate2.status).toBe(409)
    expect(gate2.body.reason).toBe('already_consumed')
  })

  it('with no gate in front the sender reserves and seals: adopted:false, still a v2 signature', async () => {
    const { id, hash } = await ask()
    await approveByPerson(id)
    const out = await sendClaim(hash, 'send-1')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, adopted: false })
    expect(out.body.approval).toMatchObject({ consumed_ref: 'send-1', used_ref: 'send-1' })
    expect(out.body.sig).toBe(hmac(v2(out.body.approval)))
  })

  it('needs the sender\'s ref, a known mode, and is a claim-only field', async () => {
    const { id, hash } = await reserved()
    const noRef = await claim(hash, MAIN, { mode: 'send' })
    expect(noRef.status).toBe(400)
    expect(noRef.body).toMatchObject({ field: 'ref' })
    for (const bad of ['burn', 'SEND', '', 1, true, ['send']]) {
      const out = await claim(hash, MAIN, { mode: bad, ref: 'send-1' })
      expect(out.status, JSON.stringify(bad)).toBe(400)
      expect(out.body.field).toBe('mode')
    }
    const byId = await consume(id, hash, MAIN, { mode: 'send', ref: 'send-1' })
    expect(byId.status).toBe(400)
    expect(byId.body.field).toBe('mode')
    expect((await getApproval(id))?.used_at ?? null).toBeNull()
  })

  it('does not open a way around the human decision: a token-decided request, a missing grant, another agent, a shared token', async () => {
    const tokenDecided = await ask()
    expect(await resolveApproval(tokenDecided.id, 'approved', 'agent:main-agent', null, 'bearer')).toBe(true)
    const refused = await sendClaim(tokenDecided.hash)
    expect(refused.status).toBe(409)
    expect(refused.body.reason).toBe('not_human_decided')
    expect(await getApproval(tokenDecided.id)).toMatchObject({ consumed_at: null, used_at: null })

    const { hash } = await reserved()
    const other = await sendClaim(hash, 'send-1', WORKER)
    expect(other.status).toBe(409)
    expect(other.body.reason).toBe('none')
    expect((await sendClaim(hash, 'send-1', SHARED)).status).toBe(403)
    expect((await sendClaim(hash, 'send-1', MAIN_OTHER_TENANT)).status).toBe(409)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM approvals WHERE used_at IS NOT NULL').get()).toEqual({ n: 0 })
  })
})
