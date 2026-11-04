// The storage layer of the hash-bound approval: using one up by id (consumeApproval) or by the hash of the
// action (claimApproval), opening a request once (createApprovalOnce), and the hash filter on the list.
// Real in-memory database, no mocks: what matters is the guarded write and the classification of a refusal.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, getDb, createApproval, getApproval, resolveApproval, listApprovals, countApprovals,
  listApprovalEvents, consumeApproval, claimApproval, createApprovalOnce,
  CONSUME_REPLAY_WINDOW_S,
} from '../db.js'

const HASH = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const WINDOW = 1800

let seq = 0
/** An email_send request by `agent` for `hash`, decided `status` by a person's session at `resolvedAt`. */
async function decided(opts: {
  agent?: string; hash?: string | null; tenant?: string; category?: string
  status?: 'approved' | 'rejected' | 'timeout'; via?: 'dashboard_session' | 'bearer' | null; resolvedAt?: number; id?: string
}): Promise<string> {
  const id = opts.id ?? `ap-${++seq}`
  await createApproval({
    id, agent_id: opts.agent ?? 'main', category: opts.category ?? 'email_send', action_description: 'x',
    tenant_id: opts.tenant ?? 'default', human_only: true, content_hash: opts.hash === undefined ? HASH : opts.hash,
  })
  const status = opts.status ?? 'approved'
  expect(await resolveApproval(id, status, 'human:session:owner', null, opts.via === undefined ? 'dashboard_session' : opts.via)).toBe(true)
  if (opts.resolvedAt !== undefined) getDb().prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(opts.resolvedAt, id)
  return id
}

const NOW = 2_000_000_000
const base = { content_hash: HASH, principal: 'main', tenant_id: 'default', window_s: WINDOW, now: NOW }

beforeEach(() => {
  initDatabase(':memory:')
  seq = 0
})

describe('consumeApproval', () => {
  it('uses an approved, hash-bound row up once and records who, when and by which ref', async () => {
    const id = await decided({ resolvedAt: NOW - 10 })
    const r = await consumeApproval({ ...base, id, ref: 'send-1', consumer: 'email-approval-gate' })
    expect(r).toMatchObject({ ok: true, replayed: false })
    expect(await getApproval(id)).toMatchObject({ consumed_at: NOW, consumed_by: 'main', consumed_ref: 'send-1' })
    const ev = await listApprovalEvents(id)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ event: 'consumed', actor: 'main', ref: 'send-1', reason: 'email-approval-gate' })
  })

  it('the second use is refused as already_consumed and leaves the first use untouched', async () => {
    const id = await decided({ resolvedAt: NOW - 10 })
    expect((await consumeApproval({ ...base, id, ref: 'send-1' })).ok).toBe(true)
    const again = await consumeApproval({ ...base, id, ref: 'send-2', now: NOW + 5 })
    expect(again).toMatchObject({ ok: false, reason: 'already_consumed' })
    expect(await getApproval(id)).toMatchObject({ consumed_at: NOW, consumed_ref: 'send-1' })
    expect((await listApprovalEvents(id)).map((e) => e.event)).toEqual(['consumed', 'consume_refused'])
    expect((await listApprovalEvents(id))[1].reason).toBe('already_consumed')
  })

  it('of many callers racing for one row exactly one wins', async () => {
    const id = await decided({ resolvedAt: NOW - 10 })
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => consumeApproval({ ...base, id, ref: `r-${i}` })))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok && r.reason === 'already_consumed')).toHaveLength(99)
    expect((await listApprovalEvents(id)).filter((e) => e.event === 'consumed')).toHaveLength(1)
  })

  it('treats the same ref from the same principal inside the replay window as a retry, not a second use', async () => {
    const id = await decided({ resolvedAt: NOW - 10 })
    await consumeApproval({ ...base, id, ref: 'send-1' })
    const retry = await consumeApproval({ ...base, id, ref: 'send-1', now: NOW + CONSUME_REPLAY_WINDOW_S })
    expect(retry).toMatchObject({ ok: true, replayed: true })
    expect((await getApproval(id))?.consumed_at).toBe(NOW)
    expect((await listApprovalEvents(id)).filter((e) => e.event === 'consumed')).toHaveLength(1)
  })

  it('a retry after the replay window, with another ref, or without a ref is refused', async () => {
    const id = await decided({ resolvedAt: NOW - 10 })
    await consumeApproval({ ...base, id, ref: 'send-1' })
    expect(await consumeApproval({ ...base, id, ref: 'send-1', now: NOW + CONSUME_REPLAY_WINDOW_S + 1 })).toMatchObject({ ok: false, reason: 'already_consumed' })
    expect(await consumeApproval({ ...base, id, ref: 'send-2', now: NOW + 1 })).toMatchObject({ ok: false, reason: 'already_consumed' })
    const bare = await decided({ resolvedAt: NOW - 10 })
    await consumeApproval({ ...base, id: bare })
    expect(await consumeApproval({ ...base, id: bare, now: NOW + 1 })).toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('a replay needs the same hash as well: the ref alone does not reopen the row', async () => {
    const id = await decided({ resolvedAt: NOW - 10 })
    await consumeApproval({ ...base, id, ref: 'send-1' })
    expect(await consumeApproval({ ...base, id, content_hash: OTHER, ref: 'send-1', now: NOW + 1 })).toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('refuses another agent as agent_mismatch and does not use the row up', async () => {
    const id = await decided({ resolvedAt: NOW - 10 })
    expect(await consumeApproval({ ...base, id, principal: 'worker' })).toMatchObject({ ok: false, reason: 'agent_mismatch' })
    expect((await getApproval(id))?.consumed_at).toBeNull()
  })

  it('does not accept the same ref from another principal as a replay', async () => {
    const id = await decided({ resolvedAt: NOW - 10 })
    await consumeApproval({ ...base, id, ref: 'send-1' })
    expect(await consumeApproval({ ...base, id, principal: 'worker', ref: 'send-1', now: NOW + 1 })).toMatchObject({ ok: false, reason: 'agent_mismatch' })
  })

  it('answers another tenant exactly like a missing id', async () => {
    const id = await decided({ tenant: 'tenant-b', resolvedAt: NOW - 10 })
    expect(await consumeApproval({ ...base, id })).toEqual({ ok: false, reason: 'not_found' })
    expect(await consumeApproval({ ...base, id: 'nope' })).toEqual({ ok: false, reason: 'not_found' })
    expect((await consumeApproval({ ...base, id, tenant_id: 'tenant-b' })).ok).toBe(true)
    expect(await listApprovalEvents('nope')).toEqual([])
  })

  it('refuses a row that is not approved: pending, rejected, timed out', async () => {
    const pending = 'pend'
    await createApproval({ id: pending, agent_id: 'main', category: 'email_send', action_description: 'x', content_hash: HASH, human_only: true })
    expect(await consumeApproval({ ...base, id: pending })).toMatchObject({ ok: false, reason: 'not_approved' })
    expect(await consumeApproval({ ...base, id: await decided({ status: 'rejected', resolvedAt: NOW - 10 }) })).toMatchObject({ ok: false, reason: 'not_approved' })
    expect(await consumeApproval({ ...base, id: await decided({ status: 'timeout', via: null, resolvedAt: NOW - 10 }) })).toMatchObject({ ok: false, reason: 'not_approved' })
  })

  it('refuses another hash as hash_mismatch, and so a row with no hash at all', async () => {
    const id = await decided({ resolvedAt: NOW - 10 })
    expect(await consumeApproval({ ...base, id, content_hash: OTHER })).toMatchObject({ ok: false, reason: 'hash_mismatch' })
    const old = await decided({ hash: null, resolvedAt: NOW - 10 })
    expect(await consumeApproval({ ...base, id: old })).toMatchObject({ ok: false, reason: 'hash_mismatch' })
    expect(await consumeApproval({ ...base, id: old, content_hash: '' })).toMatchObject({ ok: false, reason: 'hash_mismatch' })
    expect((await getApproval(id))?.consumed_at).toBeNull()
    expect((await getApproval(old))?.consumed_at).toBeNull()
  })

  it('the window edge: resolved exactly one window ago still passes, one second more is expired', async () => {
    const edge = await decided({ resolvedAt: NOW - WINDOW })
    const late = await decided({ resolvedAt: NOW - WINDOW - 1 })
    expect(await consumeApproval({ ...base, id: late })).toMatchObject({ ok: false, reason: 'expired' })
    expect((await consumeApproval({ ...base, id: edge })).ok).toBe(true)
  })

  it('refuses a row a token decided as not_human_decided, and so one with no recorded path', async () => {
    const viaToken = await decided({ via: 'bearer', resolvedAt: NOW - 10 })
    const noPath = await decided({ via: null, resolvedAt: NOW - 10 })
    expect(await consumeApproval({ ...base, id: viaToken })).toMatchObject({ ok: false, reason: 'not_human_decided' })
    expect(await consumeApproval({ ...base, id: noPath })).toMatchObject({ ok: false, reason: 'not_human_decided' })
    expect((await getApproval(viaToken))?.consumed_at).toBeNull()
  })

  it('does not trust the human_only snapshot: a consumable row needs a session decision even when the snapshot is 0', async () => {
    const id = await decided({ via: 'bearer', resolvedAt: NOW - 10 })
    getDb().prepare('UPDATE approvals SET human_only = 0 WHERE id = ?').run(id)
    expect(await consumeApproval({ ...base, id })).toMatchObject({ ok: false, reason: 'not_human_decided' })
  })

  it('refuses a category without a hash binding as wrong_category, even with a matching hash', async () => {
    const id = await decided({ category: 'file_delete', resolvedAt: NOW - 10 })
    expect(await consumeApproval({ ...base, id })).toMatchObject({ ok: false, reason: 'wrong_category' })
    const standing = await decided({ category: 'email_standing_recipient', resolvedAt: NOW - 10 })
    expect(await consumeApproval({ ...base, id: standing })).toMatchObject({ ok: false, reason: 'wrong_category' })
    expect((await getApproval(id))?.consumed_at).toBeNull()
  })

  it('journals every refusal with its reason and the caller', async () => {
    const id = await decided({ resolvedAt: NOW - 10 })
    await consumeApproval({ ...base, id, content_hash: OTHER, ref: 'x-1' })
    expect(await listApprovalEvents(id)).toEqual([expect.objectContaining({ event: 'consume_refused', reason: 'hash_mismatch', actor: 'main', ref: 'x-1' })])
  })
})

describe('claimApproval', () => {
  const claim = { ...base, category: 'email_send' }

  it('finds the usable row by hash and uses it up', async () => {
    const id = await decided({ resolvedAt: NOW - 10 })
    const r = await claimApproval({ ...claim, ref: 'send-1' })
    expect(r).toMatchObject({ ok: true, replayed: false, approval: { id } })
    expect(await getApproval(id)).toMatchObject({ consumed_by: 'main', consumed_ref: 'send-1' })
  })

  it('the second claim is already_consumed, and a retry with the same ref is a replay', async () => {
    const id = await decided({ resolvedAt: NOW - 10 })
    await claimApproval({ ...claim, ref: 'send-1' })
    expect(await claimApproval({ ...claim, ref: 'send-2', now: NOW + 1 })).toMatchObject({ ok: false, reason: 'already_consumed', approval: { id } })
    expect(await claimApproval({ ...claim, ref: 'send-1', now: NOW + 1 })).toMatchObject({ ok: true, replayed: true, approval: { id } })
    expect((await listApprovalEvents(id)).filter((e) => e.event === 'consumed')).toHaveLength(1)
  })

  it('a retry with the same ref after the replay window is already_consumed, not a replay', async () => {
    await decided({ resolvedAt: NOW - 10 })
    await claimApproval({ ...claim, ref: 'send-1' })
    expect(await claimApproval({ ...claim, ref: 'send-1', now: NOW + CONSUME_REPLAY_WINDOW_S })).toMatchObject({ ok: true, replayed: true })
    expect(await claimApproval({ ...claim, ref: 'send-1', now: NOW + CONSUME_REPLAY_WINDOW_S + 1 })).toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('skips a newer row a token decided and uses the older one a person decided', async () => {
    const person = await decided({ resolvedAt: NOW - 100 })
    const token = await decided({ via: 'bearer', resolvedAt: NOW - 10 })
    expect(await claimApproval({ ...claim, ref: 'a' })).toMatchObject({ ok: true, approval: { id: person } })
    expect((await getApproval(token))?.consumed_at).toBeNull()
  })

  it('a replay does not burn a second approval of the same hash', async () => {
    const first = await decided({ resolvedAt: NOW - 20 })
    const second = await decided({ resolvedAt: NOW - 10 })
    await claimApproval({ ...claim, ref: 'send-1' })
    await claimApproval({ ...claim, ref: 'send-1', now: NOW + 1 })
    expect((await getApproval(second))?.consumed_at).toBe(NOW)
    expect((await getApproval(first))?.consumed_at).toBeNull()
  })

  it('uses the newest usable row first, one row per claim', async () => {
    const older = await decided({ resolvedAt: NOW - 100 })
    const newer = await decided({ resolvedAt: NOW - 10 })
    expect(await claimApproval({ ...claim, ref: 'a' })).toMatchObject({ ok: true, approval: { id: newer } })
    expect(await claimApproval({ ...claim, ref: 'b' })).toMatchObject({ ok: true, approval: { id: older } })
    expect(await claimApproval({ ...claim, ref: 'c' })).toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('says none when nothing was ever asked for this hash, and only looks at its own agent, tenant and hash', async () => {
    await decided({ agent: 'worker', resolvedAt: NOW - 10 })
    await decided({ tenant: 'tenant-b', resolvedAt: NOW - 10 })
    await decided({ hash: OTHER, resolvedAt: NOW - 10 })
    expect(await claimApproval(claim)).toEqual({ ok: false, reason: 'none' })
  })

  it('says pending, with the request, while one is open, and an open request beats an old decision', async () => {
    await decided({ status: 'rejected', resolvedAt: NOW - 100 })
    await createApproval({ id: 'open', agent_id: 'main', category: 'email_send', action_description: 'x', content_hash: HASH, human_only: true, timeout_at: NOW + 600 })
    expect(await claimApproval(claim)).toMatchObject({ ok: false, reason: 'pending', approval: { id: 'open' } })
  })

  it('a pending row past its deadline (not swept yet) is not pending', async () => {
    await createApproval({ id: 'late', agent_id: 'main', category: 'email_send', action_description: 'x', content_hash: HASH, human_only: true, timeout_at: NOW - 1 })
    expect(await claimApproval(claim)).toEqual({ ok: false, reason: 'none' })
  })

  it('the latest decision gives the reason: rejected, expired, not_human_decided, and a timeout is none', async () => {
    const rejected = await decided({ status: 'rejected', resolvedAt: NOW - 10 })
    expect(await claimApproval(claim)).toMatchObject({ ok: false, reason: 'rejected', approval: { id: rejected } })
    await decided({ via: 'bearer', resolvedAt: NOW - 5 })
    expect(await claimApproval(claim)).toMatchObject({ ok: false, reason: 'not_human_decided' })
    initDatabase(':memory:')
    await decided({ resolvedAt: NOW - WINDOW - 50 })
    expect(await claimApproval(claim)).toMatchObject({ ok: false, reason: 'expired' })
    initDatabase(':memory:')
    await decided({ status: 'timeout', via: null, resolvedAt: NOW - 10 })
    expect(await claimApproval(claim)).toMatchObject({ ok: false, reason: 'none' })
  })

  it('a later rejection does not take back an earlier approval that is still usable', async () => {
    const approved = await decided({ resolvedAt: NOW - 100 })
    await decided({ status: 'rejected', resolvedAt: NOW - 10 })
    expect(await claimApproval(claim)).toMatchObject({ ok: true, approval: { id: approved } })
  })

  it('refuses a category without a hash binding without touching anything', async () => {
    const id = await decided({ category: 'file_delete', resolvedAt: NOW - 10 })
    expect(await claimApproval({ ...claim, category: 'file_delete' })).toEqual({ ok: false, reason: 'wrong_category' })
    expect((await getApproval(id))?.consumed_at).toBeNull()
  })

  it('does not use a row up for the window edge +1 second, and does at the edge', async () => {
    await decided({ resolvedAt: NOW - WINDOW - 1 })
    expect(await claimApproval(claim)).toMatchObject({ ok: false, reason: 'expired' })
    initDatabase(':memory:')
    await decided({ resolvedAt: NOW - WINDOW })
    expect((await claimApproval(claim)).ok).toBe(true)
  })
})

// Two rows that share a second carry no order of their own. The lookups break the tie by id, so the pick
// does not depend on which row was inserted first: the same pair, inserted either way round, gives one answer.
describe('claimApproval ties inside one second', () => {
  const claimArgs = { ...base, category: 'email_send' }
  const orders: Array<[string, string]> = [['ap-a', 'ap-b'], ['ap-b', 'ap-a']]

  it.each(orders)('picks the same usable row whatever the insertion order (%s then %s)', async (x, y) => {
    await decided({ id: x, resolvedAt: NOW - 10 })
    await decided({ id: y, resolvedAt: NOW - 10 })
    expect(await claimApproval({ ...claimArgs, ref: 'r1' })).toMatchObject({ ok: true, approval: { id: 'ap-b' } })
    expect(await claimApproval({ ...claimArgs, ref: 'r2' })).toMatchObject({ ok: true, approval: { id: 'ap-a' } })
  })

  it.each(orders)('names the same open request whatever the insertion order (%s then %s)', async (x, y) => {
    for (const id of [x, y]) {
      await createApproval({ id, agent_id: 'main', category: 'email_send', action_description: 'x', content_hash: HASH, human_only: true, timeout_at: NOW + 600 })
      getDb().prepare('UPDATE approvals SET requested_at = ? WHERE id = ?').run(NOW - 5, id)
    }
    expect(await claimApproval(claimArgs)).toMatchObject({ ok: false, reason: 'pending', approval: { id: 'ap-b' } })
  })

  it.each(orders)('reads the same latest decision whatever the insertion order (%s then %s)', async (x, y) => {
    const via = (id: string) => (id === 'ap-a' ? { status: 'rejected' as const } : { via: 'bearer' as const })
    await decided({ id: x, resolvedAt: NOW - 10, ...via(x) })
    await decided({ id: y, resolvedAt: NOW - 10, ...via(y) })
    expect(await claimApproval(claimArgs)).toMatchObject({ ok: false, reason: 'not_human_decided', approval: { id: 'ap-b' } })
  })

  it.each(orders)('answers a retry with the same row whatever the insertion order (%s then %s)', async (x, y) => {
    await decided({ id: x, resolvedAt: NOW - 10 })
    await decided({ id: y, resolvedAt: NOW - 10 })
    expect((await consumeApproval({ ...base, id: x, ref: 'send-1' })).ok).toBe(true)
    expect((await consumeApproval({ ...base, id: y, ref: 'send-1' })).ok).toBe(true)
    expect(await claimApproval({ ...claimArgs, ref: 'send-1', now: NOW + 1 })).toMatchObject({ ok: true, replayed: true, approval: { id: 'ap-b' } })
  })
})

describe('createApprovalOnce ties', () => {
  it.each([['ap-a', 'ap-b'], ['ap-b', 'ap-a']] as Array<[string, string]>)(
    'returns the same open row whatever the insertion order (%s then %s)', async (x, y) => {
      for (const id of [x, y]) {
        await createApproval({ id, agent_id: 'main', category: 'email_send', action_description: 'x', content_hash: HASH, human_only: true, timeout_at: NOW + 600 })
        getDb().prepare('UPDATE approvals SET requested_at = ? WHERE id = ?').run(NOW - 5, id)
      }
      // createApprovalOnce reads the clock itself, so the deadline is set far ahead of any real "now".
      getDb().prepare('UPDATE approvals SET timeout_at = ?').run(4_000_000_000)
      const r = await createApprovalOnce({ agent_id: 'main', category: 'email_send', action_description: 'x', content_hash: HASH, human_only: true, max_pending: 10, id: 'ap-new' })
      expect(r).toMatchObject({ ok: true, deduplicated: true, approval: { id: 'ap-b' } })
    })
})

describe('createApprovalOnce', () => {
  const req = { agent_id: 'main', category: 'email_send', action_description: 'x', content_hash: HASH, human_only: true, max_pending: 10 }

  it('returns the open request instead of writing a second one', async () => {
    let n = 0
    const results = await Promise.all(Array.from({ length: 10 }, () => createApprovalOnce({ ...req, id: `req-${++n}` })))
    const rows = getDb().prepare("SELECT id FROM approvals WHERE category = 'email_send'").all()
    expect(rows).toHaveLength(1)
    expect(results.filter((r) => r.ok && !r.deduplicated)).toHaveLength(1)
    expect(results.filter((r) => r.ok && r.deduplicated)).toHaveLength(9)
    const first = results[0]
    expect(first.ok && first.approval.id).toBe('req-1')
    expect((await listApprovalEvents('req-1')).filter((e) => e.event === 'created_deduplicated')).toHaveLength(9)
  })

  it('a different hash, agent or tenant is a request of its own', async () => {
    await createApprovalOnce({ ...req, id: 'a' })
    expect(await createApprovalOnce({ ...req, id: 'b', content_hash: OTHER })).toMatchObject({ ok: true, deduplicated: false })
    expect(await createApprovalOnce({ ...req, id: 'c', agent_id: 'worker' })).toMatchObject({ ok: true, deduplicated: false })
    expect(await createApprovalOnce({ ...req, id: 'd', tenant_id: 'tenant-b' })).toMatchObject({ ok: true, deduplicated: false })
  })

  it('a decided request is no longer open: the same hash again opens a new one', async () => {
    await createApprovalOnce({ ...req, id: 'a' })
    await resolveApproval('a', 'rejected', 'human:session:owner', null, 'dashboard_session')
    expect(await createApprovalOnce({ ...req, id: 'b' })).toMatchObject({ ok: true, deduplicated: false, approval: { id: 'b' } })
  })

  it('an expired pending row neither answers a new request nor counts against the cap', async () => {
    await createApprovalOnce({ ...req, id: 'a', timeout_at: 1 })
    expect(await createApprovalOnce({ ...req, id: 'b', max_pending: 1 })).toMatchObject({ ok: true, deduplicated: false, approval: { id: 'b' } })
  })

  it('stops at the cap of open requests per agent and category, and the cap is per tenant', async () => {
    for (let i = 0; i < 10; i++) expect((await createApprovalOnce({ ...req, id: `r${i}`, content_hash: i.toString(16).padStart(64, '0') })).ok).toBe(true)
    expect(await createApprovalOnce({ ...req, id: 'over', content_hash: 'f'.repeat(64) })).toEqual({ ok: false, reason: 'too_many_pending' })
    expect(await getApproval('over')).toBeUndefined()
    expect((await createApprovalOnce({ ...req, id: 'other-tenant', content_hash: 'f'.repeat(64), tenant_id: 'tenant-b' })).ok).toBe(true)
    expect((await createApprovalOnce({ ...req, id: 'other-agent', content_hash: 'f'.repeat(64), agent_id: 'worker' })).ok).toBe(true)
    // An identical request is still answered with the open one when the agent is at the cap.
    expect(await createApprovalOnce({ ...req, id: 'dup', content_hash: (0).toString(16).padStart(64, '0') })).toMatchObject({ ok: true, deduplicated: true })
  })
})

describe('the content_hash filter of the list', () => {
  it('matches the hash exactly, in the list and in the count', async () => {
    const a = await decided({ resolvedAt: NOW })
    await decided({ hash: OTHER, resolvedAt: NOW })
    await decided({ hash: null, resolvedAt: NOW })
    expect((await listApprovals({ content_hash: HASH })).map((r) => r.id)).toEqual([a])
    expect(await countApprovals({ content_hash: HASH })).toBe(1)
    expect(await listApprovals({ content_hash: HASH.slice(0, 10) })).toEqual([])
    expect((await listApprovals({})).length).toBe(3)
  })

  it('combines with the tenant scope', async () => {
    await decided({ tenant: 'tenant-b', resolvedAt: NOW })
    expect(await listApprovals({ content_hash: HASH, tenantId: 'default' })).toEqual([])
    expect(await listApprovals({ content_hash: HASH, tenantId: 'tenant-b' })).toHaveLength(1)
  })
})

describe('a malformed content hash never matches, creates or uses up a row', () => {
  const UPPER = 'A'.repeat(64)
  const BAD: [string, unknown][] = [
    ['uppercase hex', UPPER],
    ['short', 'a'.repeat(63)],
    ['long', 'a'.repeat(65)],
    ['empty', ''],
    ['64 non-hex characters', 'g'.repeat(64)],
    ['a number', 123],
    ['null', null],
    ['undefined', undefined],
    ['an array that prints as a valid hash', ['a'.repeat(64)]],
  ]

  // A row stored with an uppercase hash and decided by a person: only the validation keeps it unusable.
  async function uppercaseRow(): Promise<string> {
    return decided({ hash: UPPER, resolvedAt: NOW - 10 })
  }

  it.each(BAD)('consumeApproval refuses %s as hash_mismatch and leaves the row alone', async (_name, hash) => {
    const id = await uppercaseRow()
    const own = await decided({ resolvedAt: NOW - 10 })
    expect(await consumeApproval({ ...base, id, content_hash: hash as string })).toMatchObject({ ok: false, reason: 'hash_mismatch' })
    expect(await consumeApproval({ ...base, id: own, content_hash: hash as string })).toMatchObject({ ok: false, reason: 'hash_mismatch' })
    expect((await getApproval(id))?.consumed_at).toBeNull()
    expect((await getApproval(own))?.consumed_at).toBeNull()
  })

  it('consumeApproval still answers not_found, agent_mismatch and wrong_category first for a malformed hash', async () => {
    const other = await decided({ tenant: 'tenant-b', resolvedAt: NOW - 10 })
    const foreign = await decided({ agent: 'worker', resolvedAt: NOW - 10 })
    const file = await decided({ category: 'file_delete', resolvedAt: NOW - 10 })
    expect(await consumeApproval({ ...base, id: other, content_hash: UPPER })).toEqual({ ok: false, reason: 'not_found' })
    expect(await consumeApproval({ ...base, id: foreign, content_hash: UPPER })).toMatchObject({ ok: false, reason: 'agent_mismatch' })
    expect(await consumeApproval({ ...base, id: file, content_hash: UPPER })).toMatchObject({ ok: false, reason: 'wrong_category' })
  })

  it.each(BAD)('claimApproval refuses %s as hash_mismatch and touches nothing', async (_name, hash) => {
    const id = await uppercaseRow()
    expect(await claimApproval({ ...base, category: 'email_send', content_hash: hash as string, ref: 'r' })).toEqual({ ok: false, reason: 'hash_mismatch' })
    expect((await getApproval(id))?.consumed_at).toBeNull()
    expect(await listApprovalEvents(id)).toEqual([])
  })

  it.each(BAD)('createApprovalOnce refuses %s as hash_mismatch and writes no row', async (_name, hash) => {
    const r = await createApprovalOnce({ id: 'new', agent_id: 'main', category: 'email_send', action_description: 'x', content_hash: hash as string, max_pending: 10 })
    expect(r).toEqual({ ok: false, reason: 'hash_mismatch' })
    expect(await getApproval('new')).toBeUndefined()
  })
})
