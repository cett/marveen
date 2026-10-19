// The two phases of using up an email_send approval: the send gate RESERVES it (consumed_at, ref `gate-send-...`
// when it read the call as the official sender), the sender ADOPTS that reservation and SEALS the effect
// (used_at, used_ref) with claim mode `send`. Real in-memory database, no mocks: what matters is the guarded
// write, so every adoption condition has a test that fails when that condition is removed from the SQL.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, getDb, createApproval, getApproval, resolveApproval, listApprovalEvents, claimApproval,
  CONSUME_REPLAY_WINDOW_S, SEND_ADOPT_WINDOW_S, GATE_SEND_REF_PREFIX,
} from '../db.js'

const HASH = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const WINDOW = 1800
const NOW = 2_000_000_000

let seq = 0
/** An email_send request by `agent` for `hash`, approved by a person's dashboard session at `resolvedAt`. */
function approved(opts: { agent?: string; hash?: string; tenant?: string; via?: 'dashboard_session' | 'bearer'; resolvedAt?: number } = {}): string {
  const id = `ap-${++seq}`
  createApproval({
    id, agent_id: opts.agent ?? 'agent-a', category: 'email_send', action_description: 'x',
    tenant_id: opts.tenant ?? 'default', human_only: true, content_hash: opts.hash ?? HASH,
  })
  expect(resolveApproval(id, 'approved', 'human:session:owner', null, opts.via ?? 'dashboard_session')).toBe(true)
  getDb().prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(opts.resolvedAt ?? NOW - 10, id)
  return id
}

const claim = { category: 'email_send', content_hash: HASH, principal: 'agent-a', tenant_id: 'default', window_s: WINDOW, now: NOW }
/** The gate's reservation: no mode, the intent in the ref prefix. */
const gate = (ref = `${GATE_SEND_REF_PREFIX}1`, now = NOW) => claimApproval({ ...claim, now, ref, consumer: 'email-approval-gate' })
/** The sender's claim. */
const send = (ref = 'send-1', now = NOW + 1, extra: Record<string, unknown> = {}) => claimApproval({ ...claim, now, ref, consumer: 'gmail-send', mode: 'send', ...extra })

beforeEach(() => {
  initDatabase(':memory:')
  seq = 0
})

describe('claim mode send: the two phases of one approval', () => {
  it('the gate reserves and the sender adopts it: ONE approval, consumed_at and used_at both set, one journal line each', () => {
    const id = approved()
    expect(gate()).toMatchObject({ ok: true, replayed: false, approval: { id } })
    expect(getApproval(id)).toMatchObject({ consumed_at: NOW, consumed_ref: 'gate-send-1', used_at: null, used_ref: null })

    const r = send('send-1', NOW + 3)
    expect(r).toMatchObject({ ok: true, replayed: false, adopted: true, approval: { id } })
    expect(getApproval(id)).toMatchObject({ consumed_at: NOW, consumed_by: 'agent-a', consumed_ref: 'gate-send-1', used_at: NOW + 3, used_ref: 'send-1' })
    const ev = listApprovalEvents(id)
    expect(ev.map((e) => e.event)).toEqual(['consumed', 'used'])
    expect(ev[1]).toMatchObject({ reason: 'adopted_gate_reservation', actor: 'agent-a', ref: 'send-1' })
  })

  it('the old failure: without the send mode the sender meets the gate\'s reservation as already_consumed (control)', () => {
    const id = approved()
    gate()
    expect(claimApproval({ ...claim, now: NOW + 1, ref: 'send-1' })).toMatchObject({ ok: false, reason: 'already_consumed', approval: { id } })
    expect(getApproval(id)?.used_at).toBeNull()
  })

  it('a second sender run on the same approval is already_used and writes nothing', () => {
    const id = approved()
    gate()
    send('send-1', NOW + 1)
    const again = send('send-2', NOW + 2)
    expect(again).toMatchObject({ ok: false, reason: 'already_used', approval: { id } })
    expect(getApproval(id)).toMatchObject({ used_at: NOW + 1, used_ref: 'send-1' })
    expect(listApprovalEvents(id).filter((e) => e.event === 'used')).toHaveLength(1)
  })

  it('the gate keeps seeing the one reason it always did: already_consumed, also after the seal', () => {
    approved()
    gate()
    send()
    expect(gate('gate-send-2', NOW + 5)).toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('with no gate in front (a scheduled run) the sender reserves and seals in one step', () => {
    const id = approved()
    const r = send('send-1', NOW)
    expect(r).toMatchObject({ ok: true, replayed: false, adopted: false, approval: { id } })
    expect(getApproval(id)).toMatchObject({ consumed_at: NOW, consumed_ref: 'send-1', used_at: NOW, used_ref: 'send-1' })
    expect(listApprovalEvents(id).map((e) => e.event)).toEqual(['consumed', 'used'])
    expect(listApprovalEvents(id)[1].reason).toBe('reserved_and_sealed')
    // ...and that approval is gone for everyone after it
    expect(send('send-2', NOW + 1)).toMatchObject({ ok: false, reason: 'already_used' })
    expect(gate('gate-send-2', NOW + 1)).toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('a retry of the sender\'s lost answer (same ref, inside the replay window) is a replay, not a second use', () => {
    const id = approved()
    gate()
    send('send-1', NOW + 1)
    const retry = send('send-1', NOW + 1 + CONSUME_REPLAY_WINDOW_S)
    expect(retry).toMatchObject({ ok: true, replayed: true, adopted: true, approval: { id, used_at: NOW + 1 } })
    expect(listApprovalEvents(id).filter((e) => e.event === 'used')).toHaveLength(1)
    // after the replay window the same ref is a second use
    expect(send('send-1', NOW + 2 + CONSUME_REPLAY_WINDOW_S)).toMatchObject({ ok: false, reason: 'already_used' })
  })

  it('a replay does not burn another approval of the same hash', () => {
    const ids = [approved(), approved()]
    gate()
    send('send-1', NOW + 1)
    send('send-1', NOW + 2)
    const untouched = ids.filter((id) => getApproval(id)?.consumed_at == null)
    expect(untouched).toHaveLength(1)
    expect(getApproval(untouched[0])).toMatchObject({ used_at: null, used_ref: null })
    expect(ids.filter((id) => getApproval(id)?.used_ref === 'send-1')).toHaveLength(1)
  })

  it('needs a ref: the seal must be attributable', () => {
    approved()
    expect(() => claimApproval({ ...claim, mode: 'send' })).toThrow(/needs a ref/)
  })
})

describe('what the sender may adopt (each condition is in the SQL, each has its test)', () => {
  it('only a reservation made for the official sender: a plain `gate-` ref (a Gmail tool, curl) is not adoptable', () => {
    const id = approved()
    gate('gate-' + 'f'.repeat(8))
    expect(send()).toMatchObject({ ok: false, reason: 'already_consumed', approval: { id } })
    expect(getApproval(id)?.used_at).toBeNull()
  })

  it('...nor one reserved under a ref that is not the gate\'s at all', () => {
    const id = approved()
    claimApproval({ ...claim, ref: 'send-9' })
    expect(send('send-1', NOW + 1)).toMatchObject({ ok: false, reason: 'already_consumed', approval: { id } })
    expect(getApproval(id)?.used_at).toBeNull()
  })

  it('not another agent\'s reservation, and not under another hash', () => {
    const mine = approved()
    gate()
    expect(send('s', NOW + 1, { principal: 'agent-b' })).toEqual({ ok: false, reason: 'none' })
    expect(send('s', NOW + 1, { content_hash: OTHER })).toEqual({ ok: false, reason: 'none' })
    expect(send('s', NOW + 1, { tenant_id: 'tenant-b' })).toEqual({ ok: false, reason: 'none' })
    expect(getApproval(mine)?.used_at).toBeNull()
  })

  it('an agent reserving under its own name cannot be adopted by a sender running as someone else', () => {
    const id = approved({ agent: 'agent-b' })
    claimApproval({ ...claim, principal: 'agent-b', ref: 'gate-send-b' })
    expect(send('s', NOW + 1)).toEqual({ ok: false, reason: 'none' })
    expect(getApproval(id)?.used_at).toBeNull()
  })

  it('the adoption window is SEND_ADOPT_WINDOW_S after the reservation: the edge passes, one second more does not', () => {
    expect(SEND_ADOPT_WINDOW_S).toBe(120)
    const id = approved()
    gate()
    expect(send('s-late', NOW + SEND_ADOPT_WINDOW_S + 1)).toMatchObject({ ok: false, reason: 'already_consumed', approval: { id } })
    expect(getApproval(id)?.used_at).toBeNull()
    expect(send('s-edge', NOW + SEND_ADOPT_WINDOW_S)).toMatchObject({ ok: true, adopted: true })
  })

  it('a use window shorter than the adoption window wins (never adopt past the use window)', () => {
    const id = approved({ resolvedAt: NOW - 10 })
    gate()
    expect(send('s', NOW + 61, { window_s: 60 })).toMatchObject({ ok: false, approval: { id } })
    expect(getApproval(id)?.used_at).toBeNull()
  })

  it('never turns a decision a token made into a mail: a reservation on a row that is not a dashboard-session decision is not adopted', () => {
    const id = approved()
    gate()
    getDb().prepare("UPDATE approvals SET resolved_via = 'bearer' WHERE id = ?").run(id)
    expect(send('s', NOW + 1)).toMatchObject({ ok: false })
    expect(getApproval(id)?.used_at).toBeNull()
  })

  it('a token-decided approval can be neither reserved by the gate nor claimed by the sender', () => {
    const id = approved({ via: 'bearer' })
    expect(gate()).toMatchObject({ ok: false, reason: 'not_human_decided' })
    expect(send('s', NOW + 1)).toMatchObject({ ok: false, reason: 'not_human_decided' })
    expect(getApproval(id)).toMatchObject({ consumed_at: null, used_at: null })
  })

  it('never creates, decides or re-opens an approval: with nothing decided the sender gets none/pending and the table is unchanged', () => {
    expect(send('s', NOW)).toEqual({ ok: false, reason: 'none' })
    createApproval({ id: 'open', agent_id: 'agent-a', category: 'email_send', action_description: 'x', tenant_id: 'default', human_only: true, content_hash: HASH })
    expect(send('s', NOW)).toMatchObject({ ok: false, reason: 'pending', approval: { id: 'open' } })
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM approvals').get()).toEqual({ n: 1 })
    expect(getApproval('open')).toMatchObject({ status: 'pending', consumed_at: null, used_at: null })
  })

  it('an expired decision cannot be reserved and sealed in one step either', () => {
    approved({ resolvedAt: NOW - WINDOW - 1 })
    expect(send('s', NOW)).toMatchObject({ ok: false, reason: 'expired' })
  })
})

describe('races', () => {
  it('of 100 senders racing for one reservation exactly one adopts it, and one mail goes', () => {
    const id = approved()
    gate()
    const results = Array.from({ length: 100 }, (_, i) => send(`send-${i}`, NOW + 1))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok && r.reason === 'already_used')).toHaveLength(99)
    expect(listApprovalEvents(id).filter((e) => e.event === 'used')).toHaveLength(1)
  })

  it('of 100 senders racing with no gate exactly one reserves and seals', () => {
    const id = approved()
    const results = Array.from({ length: 100 }, (_, i) => send(`send-${i}`, NOW))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(listApprovalEvents(id).filter((e) => e.event === 'used')).toHaveLength(1)
  })

  it('two approvals of the same mail stay two mails: each reservation is adopted once', () => {
    approved()
    approved()
    gate('gate-send-1')
    gate('gate-send-2')
    expect(send('s1', NOW + 1)).toMatchObject({ ok: true, adopted: true })
    expect(send('s2', NOW + 1)).toMatchObject({ ok: true, adopted: true })
    expect(send('s3', NOW + 1)).toMatchObject({ ok: false, reason: 'already_used' })
  })
})
