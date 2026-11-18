// Two decisions on two pending proposals of one live skill (db/skill-revisions.ts decideSkillRevision). Both proposals were
// built against the same live state. A holder transaction keeps the skill row locked; the two decisions queue behind it
// (PostgreSQL: seen in pg_stat_activity, interleave helper, no timing; SQLite: the connection lock). Exactly one activates, the
// other is refused as a stale proposal (its staleness read runs after the lock, so it sees the first activation).
//
// Privacy: neutral fixtures only (global/demo-a, fleet, user-a, admin-a).

import { describe, it, expect } from 'vitest'
import { forUpdate } from '../db/dialect.js'
import { decideSkillRevision, submitPendingRevision } from '../db/skill-revisions.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

const SUBMITTER = { kind: 'human', id: 'user-a' } as const
const DECIDER = { kind: 'human', id: 'admin-a' } as const

async function seedLiveSkill(): Promise<void> {
  await dbx.run(
    "INSERT INTO skills (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at, status) VALUES ('global/demo-a', 'demo-a', '', '# v0\n', 'fleet', 0, NULL, 1, 1, 'live')",
  )
}

async function propose(content: string): Promise<number> {
  const { revision } = await dbx.tx((tx) => submitPendingRevision(tx, {
    skill: { id: 'global/demo-a', tenant_id: 'fleet' }, action: 'modify', content, files: [], actor: SUBMITTER, touchesPrivilege: false,
  }))
  return revision.id
}

describe('skill decision: two activations of one live skill', () => {
  it('exactly one activates, the other is a stale proposal', async () => {
    await seedLiveSkill()
    const p1 = await propose('# v1\n')
    const p2 = await propose('# v2\n')
    const il = interleave()
    il.hold('skill-locked')
    const holder = dbx.tx(async (tx) => {
      await tx.all(`SELECT id FROM skills WHERE id = ? ${forUpdate()}`, 'global/demo-a')
      await il.pass('skill-locked')
    })
    await il.reached('skill-locked')
    const d1 = decideSkillRevision(p1, 'activate', DECIDER)
    const d2 = decideSkillRevision(p2, 'activate', DECIDER)
    try {
      await waitBlockedOnLock(dbx, 2, testDbMode())
    } finally {
      il.open('skill-locked')
      await Promise.allSettled([holder])
    }
    const [r1, r2] = await Promise.all([d1, d2])
    await holder
    expect([r1.outcome, r2.outcome].sort()).toEqual(['activated', 'stale_proposal'])
    const live = await dbx.get<{ content: string }>("SELECT content FROM skills WHERE id = 'global/demo-a'")
    expect(['# v1\n', '# v2\n']).toContain(live?.content)
  })

  // The status condition of the lock (the compare-and-set on the skill's status): a skill revoked after the proposal is not
  // decided, and it is not resurrected. Same answer on both engines.
  it('a skill revoked after the proposal is not decided (skill_not_decidable)', async () => {
    await seedLiveSkill()
    const p = await propose('# v3\n')
    await dbx.run("UPDATE skills SET status = 'disabled' WHERE id = 'global/demo-a'")
    expect((await decideSkillRevision(p, 'activate', DECIDER)).outcome).toBe('skill_not_decidable')
    expect(await dbx.get<{ content: string }>("SELECT content FROM skills WHERE id = 'global/demo-a'")).toEqual({ content: '# v0\n' })
  })
})
