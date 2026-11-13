// The LIKE sites of db/vault.ts go through likeNoCase: the approvals list filter (agent_id / category substring) and the
// gate-send ref prefix of the reservation the sender adopts. SQLite's LIKE folds ASCII case, PostgreSQL's does not, so
// these cells use UPPER and LOWER case on purpose and run on both engines (useTestDb, also in the PG module run).
import { describe, it, expect, beforeEach } from 'vitest'
import { dbx, createApproval, resolveApproval, getApproval, listApprovals, countApprovals, adoptReservation, claimApproval, GATE_SEND_REF_PREFIX, SEND_ADOPT_WINDOW_S } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const HASH = 'a'.repeat(64)
const NOW = 2_000_000_000

let seq = 0
async function seed(agent: string, category: string): Promise<string> {
  const id = `ap-${++seq}`
  await createApproval({ id, agent_id: agent, category, action_description: 'x', tenant_id: 'default', human_only: false, content_hash: HASH })
  return id
}

beforeEach(async () => {
  await dbx.run('DELETE FROM approvals')
  seq = 0
})

describe('listApprovals / countApprovals: agent_id and category are case-blind substring filters', () => {
  async function seedSet(): Promise<Record<string, string>> {
    return {
      upper: await seed('Agent-A', 'Email_Send'),
      lower: await seed('agent-b', 'other'),
      pct: await seed('x%y', 'pct_cat'),
      acute: await seed('Őra-a', 'acute-cat'),
    }
  }
  const ids = async (o: Parameters<typeof listApprovals>[0]): Promise<string[]> => (await listApprovals(o)).map((r) => r.id).sort()

  it('finds an upper-case stored value with a lower-case or mixed-case filter, and the other way round', async () => {
    const s = await seedSet()
    expect(await ids({ agent_id: 'agent-a' })).toEqual([s.upper])
    expect(await ids({ agent_id: 'AGENT-B' })).toEqual([s.lower])
    expect(await ids({ agent_id: 'GENT-a' })).toEqual([s.upper])
    expect(await ids({ category: 'email_send' })).toEqual([s.upper])
    expect(await ids({ category: 'OTHER' })).toEqual([s.lower])
    expect(await countApprovals({ agent_id: 'AGENT' })).toBe(2)
  })

  it('does NOT fold non-ASCII (the two engines agree): O-double-acute is not o-double-acute', async () => {
    const s = await seedSet()
    expect(await ids({ agent_id: 'őra' })).toEqual([])
    expect(await ids({ agent_id: 'Őra' })).toEqual([s.acute])
    expect(await countApprovals({ agent_id: 'őRA' })).toBe(0)
  })

  it('a % or _ in the filter is a literal, not a wildcard', async () => {
    const s = await seedSet()
    expect(await ids({ agent_id: '%' })).toEqual([s.pct])
    expect(await ids({ category: '_' })).toEqual([s.upper, s.pct].sort())   // only the rows whose category holds a real underscore (a wildcard would take all four)
    expect(await countApprovals({ agent_id: 'agent_b' })).toBe(0)
  })
})

describe('the gate-send reservation prefix', () => {
  /** An email_send approval a person approved in a dashboard session and the gate reserved with `ref`. */
  async function reserved(ref: string | null): Promise<string> {
    const id = await seed('agent-a', 'email_send')
    expect(await resolveApproval(id, 'approved', 'human:session:owner', null, 'dashboard_session')).toBe(true)
    await dbx.run('UPDATE approvals SET resolved_at = ?, consumed_at = ?, consumed_by = ?, consumed_ref = ? WHERE id = ?', NOW - 10, NOW, 'agent-a', ref, id)
    return id
  }
  const since = NOW - SEND_ADOPT_WINDOW_S
  const p = { category: 'email_send', content_hash: HASH, principal: 'agent-a', tenant_id: 'default' }
  const adopt = async (id: string): Promise<boolean> => await adoptReservation(id, p, since, NOW + 1, 'send-1')

  it('adopts a reservation whose ref starts with the prefix, in lower case and in upper case', async () => {
    expect(await adopt(await reserved(`${GATE_SEND_REF_PREFIX}1`))).toBe(true)
    expect(await adopt(await reserved(`${GATE_SEND_REF_PREFIX.toUpperCase()}2`))).toBe(true)   // SQLite always folded here: PostgreSQL must agree
  })

  it('refuses a ref that only looks like the prefix, and a missing ref', async () => {
    for (const ref of ['gate-1', 'gateXsend-1', 'xgate-send-1', 'gate-sen', null]) {
      const id = await reserved(ref)
      expect(await adopt(id), String(ref)).toBe(false)
      expect((await getApproval(id))?.used_ref ?? null).toBeNull()
    }
  })

  it('claimApproval in send mode picks the reservation up through the SELECT too (upper-case prefix)', async () => {
    const id = await reserved(`${GATE_SEND_REF_PREFIX.toUpperCase()}3`)
    const out = await claimApproval({ ...p, window_s: 1800, now: NOW + 1, ref: 'send-3', consumer: 'gmail-send', mode: 'send' })
    expect(out).toMatchObject({ ok: true, adopted: true })
    expect((await getApproval(id))?.used_ref).toBe('send-3')
  })

  it('claimApproval in send mode does not adopt a reservation with a foreign ref', async () => {
    const id = await reserved('gateXsend-4')
    const out = await claimApproval({ ...p, window_s: 1800, now: NOW + 1, ref: 'send-4', consumer: 'gmail-send', mode: 'send' })
    expect(out).toMatchObject({ ok: false })
    expect((await getApproval(id))?.used_ref ?? null).toBeNull()
  })
})
