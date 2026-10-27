// The two phases of using up an email_send approval: the send gate RESERVES it (consumed_at, ref `gate-send-...`
// when it read the call as the official sender), the sender ADOPTS that reservation and SEALS the effect
// (used_at, used_ref) with claim mode `send`. Real in-memory database, no mocks: what matters is the guarded
// write, so every adoption condition has a test that fails when that condition is removed from the SQL.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase, getDb, createApproval, getApproval, resolveApproval, listApprovalEvents, claimApproval,
  CONSUME_REPLAY_WINDOW_S, SEND_ADOPT_WINDOW_S, GATE_SEND_REF_PREFIX, adoptReservation,
} from '../db.js'

const HASH = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const WINDOW = 1800
const NOW = 2_000_000_000

let seq = 0
/** An email_send request by `agent` for `hash`, approved by a person's dashboard session at `resolvedAt`. */
async function approved(opts: { agent?: string; hash?: string; tenant?: string; via?: 'dashboard_session' | 'bearer'; resolvedAt?: number } = {}): Promise<string> {
  const id = `ap-${++seq}`
  await createApproval({
    id, agent_id: opts.agent ?? 'agent-a', category: 'email_send', action_description: 'x',
    tenant_id: opts.tenant ?? 'default', human_only: true, content_hash: opts.hash ?? HASH,
  })
  expect(await resolveApproval(id, 'approved', 'human:session:owner', null, opts.via ?? 'dashboard_session')).toBe(true)
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
  it('the gate reserves and the sender adopts it: ONE approval, consumed_at and used_at both set, one journal line each', async () => {
    const id = await approved()
    expect(gate()).toMatchObject({ ok: true, replayed: false, approval: { id } })
    expect(await getApproval(id)).toMatchObject({ consumed_at: NOW, consumed_ref: 'gate-send-1', used_at: null, used_ref: null })

    const r = send('send-1', NOW + 3)
    expect(r).toMatchObject({ ok: true, replayed: false, adopted: true, approval: { id } })
    expect(await getApproval(id)).toMatchObject({ consumed_at: NOW, consumed_by: 'agent-a', consumed_ref: 'gate-send-1', used_at: NOW + 3, used_ref: 'send-1' })
    const ev = await listApprovalEvents(id)
    expect(ev.map((e) => e.event)).toEqual(['consumed', 'used'])
    expect(ev[1]).toMatchObject({ reason: 'adopted_gate_reservation', actor: 'agent-a', ref: 'send-1' })
  })

  it('the old failure: without the send mode the sender meets the gate\'s reservation as already_consumed (control)', async () => {
    const id = await approved()
    gate()
    expect(claimApproval({ ...claim, now: NOW + 1, ref: 'send-1' })).toMatchObject({ ok: false, reason: 'already_consumed', approval: { id } })
    expect((await getApproval(id))?.used_at).toBeNull()
  })

  it('a second sender run on the same approval is already_used and writes nothing', async () => {
    const id = await approved()
    gate()
    send('send-1', NOW + 1)
    const again = send('send-2', NOW + 2)
    expect(again).toMatchObject({ ok: false, reason: 'already_used', approval: { id } })
    expect(await getApproval(id)).toMatchObject({ used_at: NOW + 1, used_ref: 'send-1' })
    expect((await listApprovalEvents(id)).filter((e) => e.event === 'used')).toHaveLength(1)
  })

  it('the gate keeps seeing the one reason it always did: already_consumed, also after the seal', async () => {
    await approved()
    gate()
    send()
    expect(gate('gate-send-2', NOW + 5)).toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('with no gate in front (a scheduled run) the sender reserves and seals in one step', async () => {
    const id = await approved()
    const r = send('send-1', NOW)
    expect(r).toMatchObject({ ok: true, replayed: false, adopted: false, approval: { id } })
    expect(await getApproval(id)).toMatchObject({ consumed_at: NOW, consumed_ref: 'send-1', used_at: NOW, used_ref: 'send-1' })
    expect((await listApprovalEvents(id)).map((e) => e.event)).toEqual(['consumed', 'used'])
    expect((await listApprovalEvents(id))[1].reason).toBe('reserved_and_sealed')
    // ...and that approval is gone for everyone after it
    expect(send('send-2', NOW + 1)).toMatchObject({ ok: false, reason: 'already_used' })
    expect(gate('gate-send-2', NOW + 1)).toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('a retry of the sender\'s lost answer (same ref, inside the replay window) is a replay, not a second use', async () => {
    const id = await approved()
    gate()
    send('send-1', NOW + 1)
    const retry = send('send-1', NOW + 1 + CONSUME_REPLAY_WINDOW_S)
    expect(retry).toMatchObject({ ok: true, replayed: true, adopted: true, approval: { id, used_at: NOW + 1 } })
    expect((await listApprovalEvents(id)).filter((e) => e.event === 'used')).toHaveLength(1)
    // after the replay window the same ref is a second use
    expect(send('send-1', NOW + 2 + CONSUME_REPLAY_WINDOW_S)).toMatchObject({ ok: false, reason: 'already_used' })
  })

  it('a replay does not burn another approval of the same hash', async () => {
    const ids = [await approved(), await approved()]
    gate()
    send('send-1', NOW + 1)
    send('send-1', NOW + 2)
    const rows = await Promise.all(ids.map((id) => getApproval(id)))
    const untouched = ids.filter((_, i) => rows[i]?.consumed_at == null)
    expect(untouched).toHaveLength(1)
    expect(await getApproval(untouched[0])).toMatchObject({ used_at: null, used_ref: null })
    expect(rows.filter((row) => row?.used_ref === 'send-1')).toHaveLength(1)
  })

  it('needs a ref: the seal must be attributable', async () => {
    await approved()
    expect(() => claimApproval({ ...claim, mode: 'send' })).toThrow(/needs a ref/)
  })
})

describe('what the sender may adopt (each condition is in the SQL, each has its test)', () => {
  it('only a reservation made for the official sender: a plain `gate-` ref (a Gmail tool, curl) is not adoptable', async () => {
    const id = await approved()
    gate('gate-' + 'f'.repeat(8))
    expect(send()).toMatchObject({ ok: false, reason: 'already_consumed', approval: { id } })
    expect((await getApproval(id))?.used_at).toBeNull()
  })

  it('...nor one reserved under a ref that is not the gate\'s at all', async () => {
    const id = await approved()
    claimApproval({ ...claim, ref: 'send-9' })
    expect(send('send-1', NOW + 1)).toMatchObject({ ok: false, reason: 'already_consumed', approval: { id } })
    expect((await getApproval(id))?.used_at).toBeNull()
  })

  it('not another agent\'s reservation, and not under another hash', async () => {
    const mine = await approved()
    gate()
    expect(send('s', NOW + 1, { principal: 'agent-b' })).toEqual({ ok: false, reason: 'none' })
    expect(send('s', NOW + 1, { content_hash: OTHER })).toEqual({ ok: false, reason: 'none' })
    expect(send('s', NOW + 1, { tenant_id: 'tenant-b' })).toEqual({ ok: false, reason: 'none' })
    expect((await getApproval(mine))?.used_at).toBeNull()
  })

  it('an agent reserving under its own name cannot be adopted by a sender running as someone else', async () => {
    const id = await approved({ agent: 'agent-b' })
    claimApproval({ ...claim, principal: 'agent-b', ref: 'gate-send-b' })
    expect(send('s', NOW + 1)).toEqual({ ok: false, reason: 'none' })
    expect((await getApproval(id))?.used_at).toBeNull()
  })

  it('the adoption window is SEND_ADOPT_WINDOW_S after the reservation: the edge passes, one second more does not', async () => {
    expect(SEND_ADOPT_WINDOW_S).toBe(120)
    const id = await approved()
    gate()
    expect(send('s-late', NOW + SEND_ADOPT_WINDOW_S + 1)).toMatchObject({ ok: false, reason: 'already_consumed', approval: { id } })
    expect((await getApproval(id))?.used_at).toBeNull()
    expect(send('s-edge', NOW + SEND_ADOPT_WINDOW_S)).toMatchObject({ ok: true, adopted: true })
  })

  it('a use window shorter than the adoption window wins (never adopt past the use window)', async () => {
    const id = await approved({ resolvedAt: NOW - 10 })
    gate()
    expect(send('s', NOW + 61, { window_s: 60 })).toMatchObject({ ok: false, approval: { id } })
    expect((await getApproval(id))?.used_at).toBeNull()
  })

  it('never turns a decision a token made into a mail: a reservation on a row that is not a dashboard-session decision is not adopted', async () => {
    const id = await approved()
    gate()
    getDb().prepare("UPDATE approvals SET resolved_via = 'bearer' WHERE id = ?").run(id)
    expect(send('s', NOW + 1)).toMatchObject({ ok: false })
    expect((await getApproval(id))?.used_at).toBeNull()
  })

  it('a token-decided approval can be neither reserved by the gate nor claimed by the sender', async () => {
    const id = await approved({ via: 'bearer' })
    expect(gate()).toMatchObject({ ok: false, reason: 'not_human_decided' })
    expect(send('s', NOW + 1)).toMatchObject({ ok: false, reason: 'not_human_decided' })
    expect(await getApproval(id)).toMatchObject({ consumed_at: null, used_at: null })
  })

  it('never creates, decides or re-opens an approval: with nothing decided the sender gets none/pending and the table is unchanged', async () => {
    expect(send('s', NOW)).toEqual({ ok: false, reason: 'none' })
    await createApproval({ id: 'open', agent_id: 'agent-a', category: 'email_send', action_description: 'x', tenant_id: 'default', human_only: true, content_hash: HASH })
    expect(send('s', NOW)).toMatchObject({ ok: false, reason: 'pending', approval: { id: 'open' } })
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM approvals').get()).toEqual({ n: 1 })
    expect(await getApproval('open')).toMatchObject({ status: 'pending', consumed_at: null, used_at: null })
  })

  it('an expired decision cannot be reserved and sealed in one step either', async () => {
    await approved({ resolvedAt: NOW - WINDOW - 1 })
    expect(send('s', NOW)).toMatchObject({ ok: false, reason: 'expired' })
  })
})

// claimApproval() picks the candidate with a SELECT that repeats the adoption conditions, and inside one synchronous
// transaction nothing can change between that SELECT and the UPDATE, so through claimApproval() alone a condition
// removed from the UPDATE's WHERE stays invisible. These tests run the UPDATE on its own against a reservation that
// breaks exactly one condition: removing that condition from ADOPT_STATEMENT makes its row adopt, and the test fail.
describe('adoptReservation: the UPDATE guards every condition on its own', () => {
  const since = NOW - SEND_ADOPT_WINDOW_S
  const params = { category: 'email_send', content_hash: HASH, principal: 'agent-a', tenant_id: 'default' }
  const adopt = (id: string, p: Partial<typeof params> = {}) => adoptReservation(id, { ...params, ...p }, since, NOW + 1, 'send-1')
  /** A fresh reservation of the official sender's kind, then one column changed so exactly one condition fails. */
  const reservedWith = async (patch: string, value: unknown) => {
    const id = await approved()
    gate()
    getDb().prepare(`UPDATE approvals SET ${patch} = ? WHERE id = ?`).run(value, id)
    return id
  }

  it('control: the untouched reservation is adopted, and only once', async () => {
    const id = await approved()
    gate()
    expect(adopt(id)).toBe(true)
    expect(await getApproval(id)).toMatchObject({ used_at: NOW + 1, used_ref: 'send-1' })
    expect(adopt(id)).toBe(false)
  })

  const broken: Array<[string, string, unknown]> = [
    ['it is not a dashboard-session decision', 'resolved_via', 'bearer'],
    ['it is not approved', 'status', 'rejected'],
    ['the gate reserved nothing', 'consumed_at', null],
    ['the reservation is older than the adoption window', 'consumed_at', NOW - SEND_ADOPT_WINDOW_S - 1],
    ['another agent reserved it', 'consumed_by', 'agent-b'],
    // consumed_by still says the principal, so only the agent_id condition can refuse this one
    ['the approval belongs to another agent', 'agent_id', 'agent-b'],
    ['the reservation is not for the official sender', 'consumed_ref', 'gate-1'],
    ['it was already sealed', 'used_at', NOW],
  ]
  for (const [why, column, value] of broken) {
    it(`refuses when ${why}`, async () => {
      const id = await reservedWith(column, value)
      expect(adopt(id)).toBe(false)
      expect((await getApproval(id))?.used_ref ?? null).toBeNull()
    })
  }

  it('refuses another hash, another tenant, another category and another principal than the row\'s', async () => {
    const id = await approved()
    gate()
    expect(adopt(id, { content_hash: OTHER })).toBe(false)
    expect(adopt(id, { tenant_id: 'tenant-b' })).toBe(false)
    expect(adopt(id, { category: 'other_category' })).toBe(false)
    expect(adopt(id, { principal: 'agent-b' })).toBe(false)
    expect((await getApproval(id))?.used_at).toBeNull()
  })
})

describe('races', () => {
  it('of 100 senders racing for one reservation exactly one adopts it, and one mail goes', async () => {
    const id = await approved()
    gate()
    const results = Array.from({ length: 100 }, (_, i) => send(`send-${i}`, NOW + 1))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok && r.reason === 'already_used')).toHaveLength(99)
    expect((await listApprovalEvents(id)).filter((e) => e.event === 'used')).toHaveLength(1)
  })

  it('of 100 senders racing with no gate exactly one reserves and seals', async () => {
    const id = await approved()
    const results = Array.from({ length: 100 }, (_, i) => send(`send-${i}`, NOW))
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect((await listApprovalEvents(id)).filter((e) => e.event === 'used')).toHaveLength(1)
  })

  it('two approvals of the same mail stay two mails: each reservation is adopted once', async () => {
    await approved()
    await approved()
    gate('gate-send-1')
    gate('gate-send-2')
    expect(send('s1', NOW + 1)).toMatchObject({ ok: true, adopted: true })
    expect(send('s2', NOW + 1)).toMatchObject({ ok: true, adopted: true })
    expect(send('s3', NOW + 1)).toMatchObject({ ok: false, reason: 'already_used' })
  })
})
