// Edge pins for the approval boundary, through the real PATCH / POST / consume routes and a real in-memory
// database: who may consume a decision (only a person's, or a bearer's on a non-human-only category), which
// agent ids count as "the same agent" for the self-approval guard, and what the content hash binds. Neutral
// fixtures only; every invisible or composed character is written as an escape so it shows in a diff.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const flags = vi.hoisted(() => ({ enforce: true, storeDir: '' }))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
  get APPROVAL_HUMAN_ONLY_ENFORCE() { return flags.enforce },
  get STORE_DIR() { return flags.storeDir },
}))

const deliverToChannel = vi.hoisted(() => vi.fn())
vi.mock('../notify.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../notify.js')>()),
  deliverToChannel,
}))

import { initDatabase, getDb, getApproval, approvalContentHash } from '../db.js'
import { HUMAN_DECIDED_CATEGORY } from '../db/vault.js'
import { EMAIL_SEND_CATEGORY } from '../web/approval-human-only.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'

interface Caller { auth?: RouteContext['auth']; role?: RouteContext['role']; tokenAgentId?: string; tenantId?: string | null }
const MAIN: Caller = { auth: { kind: 'token', tokenName: 'main' }, role: 'fleet_agent', tokenAgentId: 'main-agent' }
const MAIN_ADMIN: Caller = { auth: { kind: 'token', tokenName: 'main' }, role: 'admin', tokenAgentId: 'main-agent' }
const WORKER: Caller = { auth: { kind: 'token', tokenName: 'w' }, role: 'fleet_agent', tokenAgentId: 'worker' }
const SHARED: Caller = { auth: { kind: 'token', tokenName: 'op' }, role: 'admin' }
const decider = (id: string): Caller => ({ auth: { kind: 'token', tokenName: 'x' }, role: 'admin', tokenAgentId: id })

async function call(method: string, path: string, caller: Caller, body?: unknown) {
  const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
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

const patch = (id: string, caller: Caller, body: Record<string, unknown> = { status: 'approved' }) => call('PATCH', `/api/approvals/${id}`, caller, body)
const consume = (id: string, hash: string, caller: Caller) => call('POST', `/api/approvals/${id}/consume`, caller, { content_hash: hash })
const open = async (caller: Caller, agent: string, category: string, extra: Record<string, unknown> = {}, desc = 'do it') => {
  const out = await call('POST', '/api/approvals', caller, { agent_id: agent, category, action_description: desc, ...extra })
  expect([200, 201]).toContain(out.status)
  return out.body as { id: string; content_hash: string; tenant_id: string; agent_id: string; category: string; action_description: string; action_payload: string | null }
}
const row = async (id: string) => (await getApproval(id))!
const hashOfRow = async (id: string) => {
  const r = await row(id)
  return approvalContentHash({ category: r.category, agent_id: r.agent_id, tenant_id: r.tenant_id, action_description: r.action_description, action_payload: r.action_payload })
}
const markHumanOnly = (key: string) => getDb().prepare(
  "INSERT INTO autonomy_categories (key, label, level, locked, max_level, updated_at, updated_by, human_only) VALUES (?, ?, 2, 0, 3, 0, 'test', 1) ON CONFLICT(key) DO UPDATE SET human_only = 1",
).run(key, key)

beforeEach(() => {
  flags.enforce = true
  flags.storeDir = mkdtempSync(join(tmpdir(), 'approval-pins-'))
  initDatabase(':memory:')
  deliverToChannel.mockReset()
  deliverToChannel.mockResolvedValue(true)
})

describe('consume: which resolved_via values may be used up', () => {
  it('a bearer decision on a plain category is consumable (the one allowed bearer route)', async () => {
    const a = await open(WORKER, 'worker', 'deploy')
    expect((await patch(a.id, MAIN_ADMIN)).status).toBe(200)
    expect(await row(a.id)).toMatchObject({ status: 'approved', resolved_via: 'bearer' })
    expect((await consume(a.id, a.content_hash, WORKER)).status).toBe(200)
  })

  it('an approved row whose resolved_via is NULL or an unknown value is not consumable (not_human_decided), and stays unused', async () => {
    for (const via of [null, 'other']) {
      const a = await open(WORKER, 'worker', 'deploy', {}, `legacy ${String(via)}`)
      expect((await patch(a.id, MAIN_ADMIN)).status).toBe(200)
      getDb().prepare('UPDATE approvals SET resolved_via = ? WHERE id = ?').run(via, a.id)
      const out = await consume(a.id, a.content_hash, WORKER)
      expect({ via, status: out.status, reason: out.body.reason }).toEqual({ via, status: 409, reason: 'not_human_decided' })
      expect((await row(a.id)).consumed_at).toBeNull()
    }
  })

  it('a bearer decision on a human-only category is not consumable even when the switch is off (snapshot 1)', async () => {
    flags.enforce = false
    markHumanOnly('deploy')
    const a = await open(WORKER, 'worker', 'deploy')
    expect((await row(a.id)).human_only).toBe(1)
    expect((await patch(a.id, MAIN_ADMIN)).status).toBe(200)
    const out = await consume(a.id, a.content_hash, WORKER)
    expect([out.status, out.body.reason]).toEqual([409, 'not_human_decided'])
  })

  it('a category made human-only AFTER the request keeps the request snapshot: switch off, a bearer decision is consumable; switch on, the decision is refused (403)', async () => {
    flags.enforce = false
    const filed = await open(WORKER, 'worker', 'deploy', {}, 'filed before')
    markHumanOnly('deploy')
    expect((await patch(filed.id, MAIN_ADMIN)).status).toBe(200)
    expect((await consume(filed.id, filed.content_hash, WORKER)).status).toBe(200)
    flags.enforce = true
    const second = await open(WORKER, 'worker', 'file_delete', {}, 'filed before too')
    markHumanOnly('file_delete')
    expect((await patch(second.id, MAIN_ADMIN)).status).toBe(403)
    expect((await row(second.id)).status).toBe('pending')
  })

  it('the two category constants name the same category', () => {
    expect(HUMAN_DECIDED_CATEGORY).toBe(EMAIL_SEND_CATEGORY)
  })
})

describe('self-approval guard: the same agent by identifier, never by accident', () => {
  it.each(['main-agent', 'Main-Agent', 'main-agent\u200b', '  main-agent  '])('a request filed as %j cannot be approved by the main agent (403, still pending)', async (spelling) => {
    const a = await open(SHARED, spelling, 'deploy')
    expect((await patch(a.id, MAIN_ADMIN)).status).toBe(403)
    expect((await row(a.id)).status).toBe('pending')
  })

  it.each(['MAIN-AGENT', 'main-agent\u200b', ' main-agent '])('a decider spelled %j is still the requesting agent (403, still pending)', async (spelling) => {
    const a = await open(SHARED, 'main-agent', 'deploy')
    expect((await patch(a.id, decider(spelling))).status).toBe(403)
    expect((await row(a.id)).status).toBe('pending')
  })

  it('a different agent id is not mistaken for the main agent (no false 403)', async () => {
    for (const other of ['main-agent2', 'main_agent', 'worker', 'mainagent']) {
      const a = await open(SHARED, other, 'deploy')
      expect({ other, status: (await patch(a.id, MAIN_ADMIN)).status }).toEqual({ other, status: 200 })
    }
  })

  it('two ids that both sanitize to empty are not "the same agent" by that emptiness (a decider !! on a request filed as zero-width characters)', async () => {
    const a = await open(SHARED, '\u200b\u200c', 'deploy')
    expect((await patch(a.id, decider('!!'))).status).toBe(200)
  })

  it('the very same id that sanitizes to empty is the same agent: the exact-equal shortcut still refuses (403)', async () => {
    const a = await open(SHARED, '!!', 'deploy')
    expect((await patch(a.id, decider('!!'))).status).toBe(403)
    expect((await row(a.id)).status).toBe('pending')
  })
})

describe('content hash: what it binds', () => {
  const base = { category: 'deploy', agent_id: 'w1', tenant_id: 'default', action_description: 'd', action_payload: 'p' }
  const composed = 'caf\u00e9'
  const decomposed = 'cafe\u0301'

  it.each(['category', 'agent_id', 'tenant_id', 'action_description', 'action_payload'] as const)('%s: composed and decomposed forms of the same text hash alike, and differ from the unaccented text', (field) => {
    const a = approvalContentHash({ ...base, [field]: composed })
    expect(approvalContentHash({ ...base, [field]: decomposed })).toBe(a)
    expect(approvalContentHash({ ...base, [field]: 'cafe' })).not.toBe(a)
  })

  it('an absent payload differs from an empty one', () => {
    expect(approvalContentHash({ ...base, action_payload: null })).not.toBe(approvalContentHash({ ...base, action_payload: '' }))
  })

  it('the hash is tenant-bound over HTTP: the fleet tenant of the caller is in it (not pinned to default)', async () => {
    const a = await open(MAIN, 'main-agent', 'deploy', {}, 't')
    const b = await open({ ...MAIN, tenantId: 'tenant-b' }, 'main-agent', 'deploy', {}, 't')
    expect(a.content_hash).not.toBe(b.content_hash)
    expect(b.content_hash).toBe(approvalContentHash({ category: 'deploy', agent_id: 'main-agent', tenant_id: 'tenant-b', action_description: 't', action_payload: null }))
    expect(a.content_hash).toBe(approvalContentHash({ category: 'deploy', agent_id: 'main-agent', tenant_id: 'default', action_description: 't', action_payload: null }))
  })

  it('an agent-bound admin that files under another spelling is stored under its own id, and the hash recomputes from the stored row', async () => {
    const a = await open(MAIN_ADMIN, ' MAIN-AGENT ', 'deploy')
    expect((await row(a.id)).agent_id).toBe('main-agent')
    expect(a.content_hash).toBe(await hashOfRow(a.id))
  })

  it('with the switch on, a non-canonical category is stored canonical and the hash is of the stored category', async () => {
    const a = await open(SHARED, 'w1', ' Deploy ')
    expect((await row(a.id)).category).toBe('deploy')
    expect(a.content_hash).toBe(await hashOfRow(a.id))
  })
})
