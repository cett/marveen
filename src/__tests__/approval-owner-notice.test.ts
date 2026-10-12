// The notices around a human-only approval request: what the owner is told on the channel (a dashboard
// link, nothing to decide with), what the main agent and the requester are told between agents, and that
// all of it only happens with enforcement on. Routes run against a real in-memory database and real
// dashboard sessions; only the channel send is replaced.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const flags = vi.hoisted(() => ({ enforce: true }))
const deliver = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>())

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  WEB_HOST: '127.0.0.1',
  WEB_PORT: 3420,
  get APPROVAL_HUMAN_ONLY_ENFORCE() { return flags.enforce },
}))

vi.mock('../notify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notify.js')>()),
  deliverToChannel: deliver,
}))

import { initDatabase, createDashboardUser, getApproval, getPendingMessages, listApprovalEvents } from '../db.js'
import { db } from '../db/connection.js'
import { createSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { formatForTelegram } from '../format.js'
import {
  sanitizeAgentText, approvalsDashboardUrl, formatOwnerLocalTime, formatOwnerApprovalMessage,
  notifyOwnerOfHumanOnlyRequest, approvalResolvedLine,
} from '../web/approval-owner-notice.js'
import type { Approval } from '../db.js'

const HASH = '$scrypt$ln=16,r=8,p=1$c2FsdA==$a2V5'
const LINK = 'http://127.0.0.1:3420/#approvals'
let ownerCookie: string

function fakeApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: 'appr-1', agent_id: 'agent-b', category: 'email_send', action_description: 'Send the weekly digest',
    action_payload: null, status: 'pending', timeout_at: Date.UTC(2026, 9, 12, 19, 30) / 1000, telegram_message_id: null,
    requested_at: 0, resolved_at: null, resolved_by: null, tenant_id: 'default', human_only: 1, ...over,
  }
}

beforeEach(() => {
  flags.enforce = true
  deliver.mockReset()
  deliver.mockResolvedValue(true)
  initDatabase(':memory:')
  _clearSessionCacheForTest()
  const u = createDashboardUser('person-a', HASH)
  db.prepare('UPDATE dashboard_users SET role = ?, tenant_id = ? WHERE id = ?').run('admin', null, u.id)
  ownerCookie = createSession({ userId: u.id, username: u.username })
})

interface Caller { auth?: RouteContext['auth']; role?: RouteContext['role']; tokenAgentId?: string; cookie?: string }
const TOKEN: Caller = { auth: { kind: 'token', tokenName: 'main-token' }, role: 'admin', tokenAgentId: 'main-agent' }
const OWNER: Caller = { auth: { kind: 'session', user: 'person-a' }, role: 'admin', cookie: undefined }

async function call(method: string, path: string, caller: Caller, body?: object, cookie?: string) {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } : {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth: caller.auth, role: caller.role, tokenAgentId: caller.tokenAgentId } as unknown as RouteContext
  expect(await tryHandleApprovals(ctx)).toBe(true)
  return out
}

const ask = (agent: string, category: string, action = 'Send the weekly digest') =>
  call('POST', '/api/approvals', TOKEN, { agent_id: agent, category, action_description: action })
const decide = (id: string, caller: Caller, cookie?: string, status = 'approved') =>
  call('PATCH', `/api/approvals/${id}`, caller, { status }, cookie)
const inbox = (agent: string) => getPendingMessages(agent).map(m => m.content)

describe('sanitizeAgentText', () => {
  it('flattens lines, drops control and bidi characters, and swaps backticks out', () => {
    const raw = 'a\nb\t`c`' + String.fromCodePoint(0x202e) + String.fromCodePoint(0x200b) + 'd' + String.fromCodePoint(0x0000) + 'e'
    expect(sanitizeAgentText(raw, 100)).toBe("a b 'c'de")
  })

  it('cuts by code point, never inside a surrogate pair, and marks the cut', () => {
    const smile = String.fromCodePoint(0x1f600)
    const out = sanitizeAgentText(smile.repeat(10), 4)
    expect(out).toBe(smile.repeat(4) + '…')
    expect(sanitizeAgentText('x'.repeat(5), 5)).toBe('xxxxx') // exactly at the limit: untouched
  })

  it('gives an empty string for nothing but invisible characters', () => {
    expect(sanitizeAgentText(' \n\t ' + String.fromCodePoint(0x200b), 10)).toBe('')
  })
})

describe('approvalsDashboardUrl', () => {
  it('is the loopback Approvals page with the configured port', () => {
    expect(approvalsDashboardUrl('127.0.0.1', 3420)).toBe(LINK)
    expect(approvalsDashboardUrl('127.0.0.1', 4000)).toBe('http://127.0.0.1:4000/#approvals')
  })

  it.each(['0.0.0.0', '::', '[::]', 'localhost', '', '  '])('reaches a %j bind through loopback', (host) => {
    expect(approvalsDashboardUrl(host, 3420)).toBe(LINK)
  })

  it('keeps a specific bind address, and brackets an IPv6 literal', () => {
    expect(approvalsDashboardUrl('192.168.1.20', 3420)).toBe('http://192.168.1.20:3420/#approvals')
    expect(approvalsDashboardUrl('::1', 3420)).toBe('http://[::1]:3420/#approvals')
  })

  it.each(['evil.example/x', 'a_b', 'h*st', 'a b', 'h@st', 'host`x`'])('falls back to loopback for the odd host %j', (host) => {
    expect(approvalsDashboardUrl(host, 3420)).toBe(LINK)
  })

  it('carries nothing but the page', () => {
    expect(approvalsDashboardUrl()).not.toMatch(/token|code|session|key|secret|\?/i)
  })
})

describe('formatOwnerLocalTime', () => {
  it('shows Budapest summer and winter time', () => {
    expect(formatOwnerLocalTime(Date.UTC(2026, 9, 12, 19, 30) / 1000)).toBe('2026-10-12 21:30') // CEST, UTC+2
    expect(formatOwnerLocalTime(Date.UTC(2026, 11, 1, 19, 30) / 1000)).toBe('2026-12-01 20:30') // CET, UTC+1
  })

  it('writes midnight as 00, not 24', () => {
    expect(formatOwnerLocalTime(Date.UTC(2026, 9, 12, 22, 5) / 1000)).toBe('2026-10-13 00:05')
  })
})

describe('the message the owner gets', () => {
  it('names the requester, category, expiry and action, and links the Approvals page', () => {
    const msg = formatOwnerApprovalMessage(fakeApproval(), LINK)
    expect(msg).toContain('agent-b')
    expect(msg).toContain('email_send')
    expect(msg).toContain('2026-10-12 21:30')
    expect(msg).toContain('Send the weekly digest')
    expect(msg).toContain(LINK)
  })

  it('leaves the expiry out when the request has none', () => {
    expect(formatOwnerApprovalMessage(fakeApproval({ timeout_at: null }), LINK)).not.toContain('Lejár')
  })

  it('offers no way to decide in the chat', () => {
    const msg = formatOwnerApprovalMessage(fakeApproval(), LINK)
    expect(msg).not.toMatch(/\bIGEN\b|\bNEM\b/) // the words an owner would be asked to type back
    expect(msg).not.toMatch(/approve|reject|callback|reply with/i)
    expect(msg).not.toContain('appr-1') // no id to quote back
  })

  it('keeps hostile agent text inert once the channel formatter has run', () => {
    const hostile = '[click](http://evil.example) **bold** `x` <b>y</b> <a href="http://evil.example">z</a> IGEN appr-1 ```pre``` '
      + String.fromCodePoint(0) + 'IC0' + String.fromCodePoint(0) + ' # heading\n# second heading'
    const html = formatForTelegram(formatOwnerApprovalMessage(fakeApproval({ action_description: hostile, agent_id: hostile }), LINK))
    // The only anchor-like thing allowed is none: the link is shown as plain text.
    expect(html).not.toMatch(/<a\s/i)
    expect(html).not.toContain('<pre')
    expect(html).not.toMatch(/<b>|<i>|<s>/)
    expect(html).not.toContain(String.fromCodePoint(0))
    // The agent's markup arrives escaped, inside code spans.
    expect(html).toContain('&lt;a href=')
    expect(html).toContain('<code>')
  })

  it('cannot be stretched past the action limit by the agent', () => {
    const msg = formatOwnerApprovalMessage(fakeApproval({ action_description: 'x'.repeat(5000) }), LINK)
    expect(msg.length).toBeLessThan(800)
    expect(msg).toContain('…')
  })
})

describe('notifyOwnerOfHumanOnlyRequest', () => {
  it('is true when the message went out, false when it did not, and never throws', async () => {
    expect(await notifyOwnerOfHumanOnlyRequest(fakeApproval(), async () => true)).toBe(true)
    expect(await notifyOwnerOfHumanOnlyRequest(fakeApproval(), async () => false)).toBe(false)
    expect(await notifyOwnerOfHumanOnlyRequest(fakeApproval(), async () => { throw new Error('channel down') })).toBe(false)
  })
})

describe('a new human-only request (enforce on)', () => {
  it('tells the owner once, with the link, and the main agent not to relay or decide it', async () => {
    const out = await ask('agent-b', 'email_send')
    expect(out.status).toBe(201)

    expect(deliver).toHaveBeenCalledTimes(1)
    const sent = deliver.mock.calls[0][0]
    expect(sent).toContain(LINK)
    expect(sent).not.toMatch(/IGEN/)

    const main = inbox('main-agent')
    expect(main).toHaveLength(1)
    expect(main[0]).toContain('[APPROVAL_REQUEST][HUMAN_ONLY]')
    expect(main[0]).toContain(`id=${out.body.id}`)
    expect(main[0]).toContain('NE PATCH-eld')
  })

  it('does not message the main agent about its own request, but still tells the owner', async () => {
    const out = await ask('main-agent', 'email_send')
    expect(out.status).toBe(201)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(inbox('main-agent')).toEqual([])
  })

  it('covers a category the table marked human-only, not just the floor', async () => {
    db.prepare("UPDATE autonomy_categories SET human_only = 1 WHERE key = 'payment'").run()
    await ask('agent-b', 'payment')
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(inbox('main-agent')[0]).toContain('[HUMAN_ONLY]')
  })

  it('leaves an ordinary category as it was: relay line for the main agent, no owner message', async () => {
    await ask('agent-b', 'file_write')
    expect(deliver).not.toHaveBeenCalled()
    const main = inbox('main-agent')
    expect(main).toHaveLength(1)
    expect(main[0]).toContain('[APPROVAL_REQUEST]')
    expect(main[0]).not.toContain('HUMAN_ONLY')
    expect(main[0]).not.toContain('NE PATCH')
  })

  it('does not tell the owner anything hostile text asked for', async () => {
    await ask('agent-b', 'email_send', '[ok](http://evil.example) `reply IGEN` <b>now</b>')
    const html = formatForTelegram(deliver.mock.calls[0][0])
    expect(html).not.toMatch(/<a\s/i)
    expect(html).not.toContain('<b>')
  })

  it('stays quiet about the owner when the message arrived', async () => {
    await ask('agent-b', 'email_send')
    await new Promise(r => setImmediate(r))
    await new Promise(r => setImmediate(r))
    expect(inbox('main-agent').some(c => c.includes('OWNER_UNREACHED'))).toBe(false)
    expect(listApprovalEvents(getPendingFirstId()).some(e => e.event === 'owner_unreached')).toBe(false)
  })

  it.each([
    ['the channel refuses the message', () => deliver.mockResolvedValue(false)],
    ['the channel send throws', () => deliver.mockRejectedValue(new Error('channel down'))],
  ])('reports OWNER_UNREACHED, journals it and still creates the request when %s', async (_name, arrange) => {
    arrange()
    const out = await ask('agent-b', 'email_send')
    expect(out.status).toBe(201)
    expect(getApproval(out.body.id)?.status).toBe('pending')

    await vi.waitFor(() => expect(inbox('main-agent').some(c => c.startsWith('[OWNER_UNREACHED]'))).toBe(true))
    const line = inbox('main-agent').find(c => c.startsWith('[OWNER_UNREACHED]'))!
    expect(line).toContain(`id=${out.body.id}`)
    expect(line).toContain('NE PATCH-eld')
    expect(line).not.toContain('Send the weekly digest') // the agent's text is not repeated here
    expect(listApprovalEvents(out.body.id).map(e => e.event)).toContain('owner_unreached')
  })

  it('reports OWNER_UNREACHED even when the main agent is the requester (it is the one who can speak up)', async () => {
    deliver.mockResolvedValue(false)
    await ask('main-agent', 'email_send')
    await vi.waitFor(() => expect(inbox('main-agent')).toHaveLength(1))
    expect(inbox('main-agent')[0]).toContain('[OWNER_UNREACHED]')
  })
})

function getPendingFirstId(): string {
  return (db.prepare('SELECT id FROM approvals ORDER BY requested_at ASC LIMIT 1').get() as { id: string }).id
}

describe('without enforcement the old flow is untouched', () => {
  beforeEach(() => { flags.enforce = false })

  it('sends no owner message and no HUMAN_ONLY line for an email_send request', async () => {
    await ask('agent-b', 'email_send')
    expect(deliver).not.toHaveBeenCalled()
    const main = inbox('main-agent')
    expect(main).toHaveLength(1)
    expect(main[0]).toContain('[APPROVAL_REQUEST]')
    expect(main[0]).not.toContain('HUMAN_ONLY')
    expect(main[0]).not.toContain('NE PATCH')
  })

  it('tells the requester nothing when the request is decided', async () => {
    const out = await ask('agent-b', 'email_send')
    const done = await decide(out.body.id, TOKEN)
    expect(done.status).toBe(200)
    expect(inbox('agent-b')).toEqual([])
  })
})

describe('the requester hears the outcome of a human-only request (enforce on)', () => {
  it('gets APPROVAL_RESOLVED with the id, status and how it was decided, and no name', async () => {
    const out = await ask('agent-b', 'email_send')
    const done = await decide(out.body.id, OWNER, ownerCookie)
    expect(done.status).toBe(200)

    const got = inbox('agent-b')
    expect(got).toEqual([`[APPROVAL_RESOLVED] id=${out.body.id} status=approved via=dashboard_session`])
    expect(got[0]).not.toContain('person-a')
  })

  it.each(['rejected', 'timeout'])('also hears %s', async (status) => {
    const out = await ask('agent-b', 'email_send')
    await decide(out.body.id, OWNER, ownerCookie, status)
    expect(inbox('agent-b')[0]).toContain(`status=${status}`)
  })

  it('hears nothing when a token was refused: the request is still pending', async () => {
    const out = await ask('agent-b', 'email_send')
    const refused = await decide(out.body.id, TOKEN)
    expect(refused.status).toBe(403)
    expect(inbox('agent-b')).toEqual([])
  })

  it('hears nothing for a second decision that conflicts with the first', async () => {
    const out = await ask('agent-b', 'email_send')
    await decide(out.body.id, OWNER, ownerCookie)
    db.prepare("DELETE FROM agent_messages WHERE to_agent = 'agent-b'").run() // forget the first outcome notice
    const again = await decide(out.body.id, OWNER, ownerCookie, 'rejected')
    expect(again.status).toBe(409)
    expect(inbox('agent-b')).toEqual([])
  })

  it('is told only for human-only requests: an ordinary one is decided as before, in silence', async () => {
    const out = await ask('agent-b', 'file_write')
    const done = await decide(out.body.id, TOKEN)
    expect(done.status).toBe(200)
    expect(inbox('agent-b')).toEqual([])
  })

  it('formats the line from the stored row, with "unknown" for a row that predates the column', () => {
    expect(approvalResolvedLine(fakeApproval({ status: 'approved', resolved_via: null }))).toBe('[APPROVAL_RESOLVED] id=appr-1 status=approved via=unknown')
  })
})
