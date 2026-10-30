// The approval journal is best effort: three helpers in the approvals route write a row on a refusal or a
// suppressed notice and promise never to throw, so the answer stands when the journal write fails. Each
// test makes the INSERT INTO approval_events statement reject (every other statement runs for real) and
// checks three things: the route answers as it would without the fault, nothing escapes as an unhandled
// rejection, and the statement that failed really was the journal write the helper was meant to make.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const flags = vi.hoisted(() => ({ enforce: true }))
const deliver = vi.hoisted(() => vi.fn<(text: string) => Promise<boolean>>())

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  get APPROVAL_HUMAN_ONLY_ENFORCE() { return flags.enforce },
}))

vi.mock('../notify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notify.js')>()),
  deliverToChannel: deliver,
}))

import { initDatabase, getApproval, getPendingMessages, listApprovalEvents } from '../db.js'
import { dbx } from '../db/facade.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'

interface Caller { auth?: RouteContext['auth']; role?: RouteContext['role']; tokenAgentId?: string }
// Opens requests for the fixtures: the operator's token names no agent.
const OPENER: Caller = { auth: { kind: 'token', tokenName: 'operator' }, role: 'admin' }
const MAIN_TOKEN: Caller = { auth: { kind: 'token', tokenName: 'main' }, role: 'fleet_agent', tokenAgentId: 'main-agent' }
const AGENT_B_TOKEN: Caller = { auth: { kind: 'token', tokenName: 'b' }, role: 'fleet_agent', tokenAgentId: 'agent-b' }
const ADMIN_TOKEN: Caller = { auth: { kind: 'token', tokenName: 'operator' }, role: 'admin' }

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
  const ctx = { req, res, path: url.pathname, method, url, auth: caller.auth, role: caller.role, tokenAgentId: caller.tokenAgentId } as unknown as RouteContext
  expect(await tryHandleApprovals(ctx)).toBe(true)
  return out
}

const ask = (agent: string, category: string, action = 'Send the weekly digest') =>
  call('POST', '/api/approvals', OPENER, { agent_id: agent, category, action_description: action })
const inbox = async (agent: string) => (await getPendingMessages(agent)).map(m => m.content)
const tick = () => new Promise<void>(r => setImmediate(r))

let seq = 0
const askMail = () => call('POST', '/api/approvals', MAIN_TOKEN, {
  agent_id: 'main-agent', category: 'email_send',
  action_payload: JSON.stringify({ to: ['owner@example.com'], subject: `Mail ${++seq}`, body: 'Hello there' }),
})

const INSERT_EVENT = /INSERT INTO approval_events/

interface JournalFault { attempts: Array<{ sql: string; event: unknown }>; restore: () => void }

/**
 * From now on the journal INSERT rejects; every other statement goes to the real implementation. `attempts`
 * records each journal INSERT that was reached, with the event name it carried (the third parameter).
 */
function breakJournal(): JournalFault {
  const real = dbx.run.bind(dbx)
  const attempts: JournalFault['attempts'] = []
  const spy = vi.spyOn(dbx, 'run').mockImplementation((async (sql: string, ...params: unknown[]) => {
    if (INSERT_EVENT.test(sql)) {
      attempts.push({ sql, event: params[2] })
      throw new Error('journal write failed')
    }
    return real(sql, ...params)
  }) as never)
  return { attempts, restore: () => spy.mockRestore() }
}

/** Runs `fn` and returns what escaped as an unhandled rejection while it ran and a few ticks after. */
async function watchRejections(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = []
  const onRejection = (reason: unknown) => { seen.push(reason) }
  process.on('unhandledRejection', onRejection)
  try {
    await fn()
    for (let i = 0; i < 5; i++) await tick()
  } finally {
    process.off('unhandledRejection', onRejection)
  }
  return seen
}

let fault: JournalFault | undefined

beforeEach(() => {
  flags.enforce = true
  seq = 0
  deliver.mockReset()
  deliver.mockResolvedValue(true)
  initDatabase(':memory:')
})

afterEach(() => {
  fault?.restore()
  fault = undefined
})

describe('a fleet agent token resolving a human-only approval (bearer_denied journal)', () => {
  it('writes a bearer_denied row for a human-only request, and none for an ordinary one', async () => {
    const humanOnly = await ask('agent-b', 'email_standing_recipient')
    const ordinary = await ask('agent-b', 'file_write')
    expect(humanOnly.status).toBe(201)
    expect(ordinary.status).toBe(201)

    const refusedHuman = await call('PATCH', `/api/approvals/${humanOnly.body.id}`, AGENT_B_TOKEN, { status: 'approved' })
    const refusedOrdinary = await call('PATCH', `/api/approvals/${ordinary.body.id}`, AGENT_B_TOKEN, { status: 'approved' })
    expect(refusedHuman.status).toBe(403)
    expect(refusedOrdinary.status).toBe(403)

    const humanEvents = await listApprovalEvents(humanOnly.body.id)
    expect(humanEvents.map(e => e.event)).toEqual(['bearer_denied'])
    expect(humanEvents[0]).toMatchObject({ reason: 'human_only_category', actor: 'agent-b' })
    // An ordinary approval is refused the same way but is not a human-only attempt: no journal row.
    expect(await listApprovalEvents(ordinary.body.id)).toEqual([])
  })

  it('still answers 403 and leaves the request pending when the journal write fails', async () => {
    const opened = await ask('agent-b', 'email_standing_recipient')
    fault = breakJournal()
    let answer!: Awaited<ReturnType<typeof call>>
    const escaped = await watchRejections(async () => {
      answer = await call('PATCH', `/api/approvals/${opened.body.id}`, AGENT_B_TOKEN, { status: 'approved' })
    })

    expect(answer.status).toBe(403)
    expect(answer.body).toMatchObject({ error: 'forbidden', hint: 'A fleet agent token cannot resolve approvals' })
    expect((await getApproval(opened.body.id))?.status).toBe('pending')
    expect(escaped).toEqual([])
    // The statement that failed was the bearer_denied journal INSERT, and it was reached exactly once.
    expect(fault.attempts.map(a => a.event)).toEqual(['bearer_denied'])
    expect(fault.attempts[0].sql).toMatch(INSERT_EVENT)
    expect(await listApprovalEvents(opened.body.id)).toEqual([])
  })
})

describe('a non-human token deciding a human-only approval (journal before the refusal)', () => {
  it('enforce on: still refuses with 403 human_only_category when the journal write fails', async () => {
    const opened = await ask('agent-b', 'email_standing_recipient')
    fault = breakJournal()
    let answer!: Awaited<ReturnType<typeof call>>
    const escaped = await watchRejections(async () => {
      answer = await call('PATCH', `/api/approvals/${opened.body.id}`, ADMIN_TOKEN, { status: 'approved' })
    })

    expect(answer.status).toBe(403)
    expect(answer.body).toMatchObject({ error: 'forbidden', code: 'human_only_category' })
    expect((await getApproval(opened.body.id))?.status).toBe('pending')
    expect(escaped).toEqual([])
    expect(fault.attempts.map(a => a.event)).toEqual(['bearer_denied'])
  })

  it('enforce off: the decision still goes through when the advisory journal write fails', async () => {
    flags.enforce = false
    const opened = await ask('agent-b', 'email_standing_recipient')
    fault = breakJournal()
    let answer!: Awaited<ReturnType<typeof call>>
    const escaped = await watchRejections(async () => {
      answer = await call('PATCH', `/api/approvals/${opened.body.id}`, ADMIN_TOKEN, { status: 'approved' })
    })

    expect(answer.status).toBe(200)
    expect((await getApproval(opened.body.id))?.status).toBe('approved')
    expect(escaped).toEqual([])
    expect(fault.attempts.map(a => a.event)).toEqual(['bearer_denied'])
  })
})

describe('the notify_suppressed journal write of a rate-limited email request', () => {
  it('still creates the request and answers 201 when the journal write fails', async () => {
    for (let i = 0; i < 5; i++) expect((await askMail()).status).toBe(201)
    await tick()
    expect(deliver).toHaveBeenCalledTimes(5)

    fault = breakJournal()
    let answer!: Awaited<ReturnType<typeof call>>
    const escaped = await watchRejections(async () => { answer = await askMail() })

    expect(answer.status).toBe(201)
    expect(answer.body).toMatchObject({ category: 'email_send', status: 'pending', human_only: 1 })
    expect((await getApproval(answer.body.id))?.status).toBe('pending')
    expect(escaped).toEqual([])
    // Suppressed: the owner was not told a sixth time, and the failing statement was the suppression row.
    expect(deliver).toHaveBeenCalledTimes(5)
    expect(fault.attempts.map(a => a.event)).toEqual(['notify_suppressed'])
    expect(await listApprovalEvents(answer.body.id)).toEqual([])
  })
})

describe('the owner_unreached journal write after a failed owner message', () => {
  it('still creates the request and still tells the main agent when the journal write fails', async () => {
    deliver.mockResolvedValue(false)
    fault = breakJournal()
    let answer!: Awaited<ReturnType<typeof call>>
    const escaped = await watchRejections(async () => {
      answer = await ask('agent-b', 'email_standing_recipient')
      // The journal write and the main-agent notice run after the answer, in the delivery callback.
      await vi.waitFor(async () => expect((await inbox('main-agent')).some(c => c.startsWith('[OWNER_UNREACHED]'))).toBe(true))
    })

    expect(answer.status).toBe(201)
    expect((await getApproval(answer.body.id))?.status).toBe('pending')
    expect((await inbox('main-agent')).find(c => c.startsWith('[OWNER_UNREACHED]'))).toContain(`id=${answer.body.id}`)
    expect(escaped).toEqual([])
    expect(fault.attempts.map(a => a.event)).toEqual(['owner_unreached'])
    expect(await listApprovalEvents(answer.body.id)).toEqual([])
  })
})
