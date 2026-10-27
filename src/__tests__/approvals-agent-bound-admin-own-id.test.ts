// POST /api/approvals: an agent-bound admin token (the main agent's `main-agent:<id>`: role admin, a token that
// names an agent) opens an approval request only as the agent it names. Another agent's id is a 403
// (`agent_id_mismatch`), nothing is stored and the refusal is audited (`create_refused`). The operator's token
// (it names no agent), a dashboard session, a fleet_agent's own id and the main agent's own id (any case and
// padding) go through as before. Real in-memory database, the route driven directly.
//
// Mutation proofs (each makes at least one test fail): leave the check out of approvals.ts; run it after
// createApproval; drop the role / kind / tokenAgentId condition in the helper; drop the normalisation; drop
// the audit write; remove the helper call (the source pin).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase, getDb, getApproval } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'

// The audit write can be made to throw, to show the refusal does not depend on it.
const auditFail = vi.hoisted(() => ({ on: false }))
vi.mock('../db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db.js')>()
  return {
    ...real,
    writeAgentAuditLog: (...args: Parameters<typeof real.writeAgentAuditLog>) => {
      if (auditFail.on) throw new Error('audit store down')
      return real.writeAgentAuditLog(...args)
    },
  }
})

vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), MAIN_AGENT_ID: 'main-x' }))

type Who = Pick<RouteContext, 'role' | 'auth' | 'tokenAgentId'>

const MAIN: Who = { role: 'admin', auth: { kind: 'token', tokenName: 'main-agent:main-x' }, tokenAgentId: 'main-x' }
const OPERATOR: Who = { role: 'admin', auth: { kind: 'token', tokenName: 'operator' } }
const SESSION: Who = { role: 'admin', auth: { kind: 'session', user: 'owner' } }
const FLEET: Who = { role: 'fleet_agent', auth: { kind: 'token', tokenName: 'fleet-agent:agent-d' }, tokenAgentId: 'agent-d' }

async function call(as: Who, method: string, path: string, body: object): Promise<{ status: number; body: any }> {
  const buf = Buffer.from(JSON.stringify(body))
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader() {},
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, ...as, agentId: as.tokenAgentId, tenantId: 'default' } as unknown as RouteContext
  expect(await tryHandleApprovals(ctx)).toBe(true)
  return out
}

const open = (as: Who, agentId: string, category = 'file_write') =>
  call(as, 'POST', '/api/approvals', { agent_id: agentId, category, action_description: 'do the thing' })

const approvalCount = (): number => (getDb().prepare('SELECT COUNT(*) AS c FROM approvals').get() as { c: number }).c
const refusals = () => getDb().prepare("SELECT agent_id, entity, detail FROM agent_audit_log WHERE action = 'create_refused'").all() as
  Array<{ agent_id: string; entity: string; detail: string }>

beforeEach(() => {
  initDatabase(':memory:')
})

describe('POST /api/approvals by the main agent token', () => {
  it('another agent\'s id is a 403 agent_id_mismatch: no row, and a create_refused audit row', async () => {
    const r = await open(MAIN, 'agent-d')
    expect(r.status).toBe(403)
    expect(r.body).toMatchObject({ error: 'forbidden', code: 'agent_id_mismatch' })
    expect(approvalCount()).toBe(0)
    const rows = refusals()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: 'main-x', entity: 'approval' })
    expect(JSON.parse(rows[0].detail)).toEqual({
      declared_agent_id: 'agent-d', declared_agent_id_len: 'agent-d'.length, principal: 'main-agent:main-x', principalSource: 'token',
    })
  })

  it('the audit row keeps the first 128 characters of the declared id and its length, whatever was sent', async () => {
    const detailOf = (): any => JSON.parse(refusals().at(-1)!.detail)
    expect((await open(MAIN, 'a'.repeat(128))).status).toBe(403)
    expect(detailOf().declared_agent_id).toBe('a'.repeat(128)) // at the limit: whole
    expect(detailOf().declared_agent_id_len).toBe(128)
    expect((await open(MAIN, 'b'.repeat(129))).status).toBe(403)
    expect(detailOf().declared_agent_id).toBe('b'.repeat(128)) // one over: cut
    expect(detailOf().declared_agent_id_len).toBe(129)
    expect((await open(MAIN, `  ${'c'.repeat(10)}  `)).status).toBe(403)
    expect(detailOf()).toMatchObject({ declared_agent_id: 'c'.repeat(10), declared_agent_id_len: 10 }) // padding is not counted
    const huge = 'd'.repeat(400_000)
    expect((await open(MAIN, huge)).status).toBe(403)
    const row = refusals().at(-1)!
    expect(JSON.parse(row.detail)).toMatchObject({ declared_agent_id: 'd'.repeat(128), declared_agent_id_len: 400_000 })
    expect(row.detail.length).toBeLessThan(512) // the row does not grow with the id
    expect(approvalCount()).toBe(0)
  })

  it('fails closed when the audit write throws: still a 403 with the same body, and no request is stored', async () => {
    auditFail.on = true
    try {
      const r = await open(MAIN, 'agent-d')
      expect(r.status).toBe(403)
      expect(r.body).toMatchObject({ error: 'forbidden', code: 'agent_id_mismatch' })
      expect(approvalCount()).toBe(0)
      expect(refusals()).toHaveLength(0) // the write failed, the refusal did not
    } finally { auditFail.on = false }
  })

  it('an id that only begins or ends like its own is another agent: own id plus a suffix, a prefix of it, a longer id around it', async () => {
    for (const other of ['main-x2', 'main-x-2', 'main-xx', 'main-', 'main', 'x-main-x', 'main-x.bak']) {
      const r = await open(MAIN, other)
      expect(r.status, other).toBe(403)
      expect(r.body, other).toMatchObject({ error: 'forbidden', code: 'agent_id_mismatch' })
    }
    expect(approvalCount()).toBe(0)
    expect(refusals()).toHaveLength(7)
  })

  it('the platform sender names get no exception here', async () => {
    expect((await open(MAIN, 'scheduler')).status).toBe(403)
    expect((await open(MAIN, 'system')).status).toBe(403)
    expect(approvalCount()).toBe(0)
  })

  it('its own id opens the request (201), also in another case and padded', async () => {
    expect((await open(MAIN, 'main-x')).status).toBe(201)
    expect((await open(MAIN, ' MAIN-X ')).status).toBe(201)
    expect(approvalCount()).toBe(2)
    expect(refusals()).toHaveLength(0)
  })

  it('a request opened in another spelling of its own id is stored under the token id, so resolving it with the same token is refused', async () => {
    const created = await open(MAIN, ' MAIN-X ')
    expect(created.status).toBe(201)
    const id = created.body.id as string
    expect((await getApproval(id))?.agent_id).toBe('main-x')
    const r = await call(MAIN, 'PATCH', `/api/approvals/${id}`, { status: 'approved' })
    expect(r.status).toBe(403)
    expect((await getApproval(id))?.status).toBe('pending')
  })

  it('the comparison is on the normalised id: stray characters fall away, and the stored id is still the token\'s', async () => {
    const created = await open(MAIN, 'ma.in-x')
    expect(created.status).toBe(201)
    expect((await getApproval(created.body.id as string))?.agent_id).toBe('main-x')
  })

  it('a token id with upper case is compared case-insensitively too, and the stored id is the token\'s', async () => {
    const mixed: Who = { ...MAIN, tokenAgentId: 'Main-X' }
    const created = await open(mixed, 'main-x')
    expect(created.status).toBe(201)
    expect((await getApproval(created.body.id as string))?.agent_id).toBe('Main-X')
    expect((await open(mixed, 'agent-d')).status).toBe(403)
    // the token side is normalised the same way as the declared side
    const dotted: Who = { ...MAIN, tokenAgentId: 'ma.in-X' }
    expect((await open(dotted, 'main-x')).status).toBe(201)
  })

  it('the email_send branch is unchanged: its own id is let through to the email checks, another id is refused first', async () => {
    const own = await open(MAIN, 'main-x', 'email_send')
    expect(own.status).toBe(400) // past the identity check, stopped by the missing envelope
    expect(own.body).toMatchObject({ field: 'action_payload' })
    expect((await open(MAIN, 'agent-d', 'email_send')).status).toBe(403)
  })

  it('opening as itself and then resolving it with the same token is still refused (the guard compares the same id)', async () => {
    const created = await open(MAIN, 'main-x')
    expect(created.status).toBe(201)
    const id = created.body.id as string
    const r = await call(MAIN, 'PATCH', `/api/approvals/${id}`, { status: 'approved' })
    expect(r.status).toBe(403)
    expect((await getApproval(id))?.status).toBe('pending')
  })
})

describe('every other principal is untouched', () => {
  it('the operator token and a dashboard session may name any agent', async () => {
    expect((await open(OPERATOR, 'agent-d')).status).toBe(201)
    expect((await open(SESSION, 'agent-d')).status).toBe(201)
    expect(refusals()).toHaveLength(0)
  })

  it('only the role admin + kind token + a named agent is held: a session or a non-admin role that carries a token agent id is not', async () => {
    const sessionWithAgent: Who = { role: 'admin', auth: { kind: 'session', user: 'owner' }, tokenAgentId: 'main-x' }
    const nonAdminToken: Who = { role: 'agent' as RouteContext['role'], auth: { kind: 'token', tokenName: 'x' }, tokenAgentId: 'main-x' }
    expect((await open(sessionWithAgent, 'agent-d')).status).toBe(201)
    expect((await open(nonAdminToken, 'agent-d')).status).toBe(201)
    expect(refusals()).toHaveLength(0)
  })

  it('a fleet_agent token: its own id 201, another agent 403 (the existing guard, no create_refused row)', async () => {
    expect((await open(FLEET, 'agent-d')).status).toBe(201)
    expect((await open(FLEET, 'agent-e')).status).toBe(403)
    expect(refusals()).toHaveLength(0)
  })
})

describe('the check stays before the write', () => {
  it('the helper call sits after denyForeignAgent and before createApproval in the route source', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'approvals.ts'), 'utf-8')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    const guard = src.indexOf('denyAgentBoundAdminForeign(ctx')
    const foreign = src.indexOf('denyForeignAgent(ctx')
    const create = src.indexOf('createApproval(')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(foreign)
    expect(guard).toBeLessThan(create)
  })
})
