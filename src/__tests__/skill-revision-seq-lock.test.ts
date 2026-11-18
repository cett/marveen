// The revision seq of a skill under concurrency (db/skill-revisions.ts, A15): two writers of one skill must not take the same
// seq (MAX + 1 read by both would fail one of them on UNIQUE(skill_id, seq)). A holder transaction keeps the skill row
// locked; two revision writes queue behind it (PostgreSQL: seen in pg_stat_activity, interleave helper, no timing; SQLite:
// the connection lock). Afterwards the two rows have two distinct seq numbers, and neither write failed.
//
// Privacy: neutral fixtures only (global/demo-a, fleet, user-a).

import { describe, it, expect } from 'vitest'
import { forUpdate } from '../db/dialect.js'
import { writeSkillRevision } from '../db/skill-revisions.js'
import { useTestDb, testDbMode } from './helpers/with-test-db.js'
import { interleave, waitBlockedOnLock } from './helpers/interleave.js'

const { dbx } = useTestDb()

const HUMAN = { kind: 'human', id: 'user-a' } as const

async function seedSkill(): Promise<void> {
  await dbx.run(
    "INSERT INTO skills (id, name, description, content, tenant_id, is_global, created_by, created_at, updated_at) VALUES ('global/demo-a', 'demo-a', '', '# v0\n', 'fleet', 0, NULL, 1, 1)",
  )
}

describe('skill revision seq: two writers of one skill', () => {
  it('queue behind the skill row lock and take two distinct seq numbers', async () => {
    await seedSkill()
    const il = interleave()
    il.hold('skill-locked')
    const holder = dbx.tx(async (tx) => {
      await tx.all(`SELECT id FROM skills WHERE id = ? ${forUpdate()}`, 'global/demo-a')
      await il.pass('skill-locked')
    })
    await il.reached('skill-locked')
    const write = (content: string) => dbx.tx((tx) =>
      writeSkillRevision(tx, { skill: { id: 'global/demo-a', tenant_id: 'fleet', content }, action: 'modify', actor: HUMAN }))
    const w1 = write('# v1\n')
    const w2 = write('# v2\n')
    try {
      await waitBlockedOnLock(dbx, 2, testDbMode())
    } finally {
      il.open('skill-locked')
      await Promise.allSettled([holder])
    }
    const [r1, r2] = await Promise.all([w1, w2])
    await holder
    expect(r1?.seq).toBeDefined()
    expect(r2?.seq).toBeDefined()
    expect([r1!.seq, r2!.seq].sort()).toEqual([1, 2])
    const seqs = await dbx.all<{ seq: number }>("SELECT seq FROM skill_revisions WHERE skill_id = 'global/demo-a' AND action = 'modify' ORDER BY seq")
    expect(seqs.map((s) => s.seq)).toEqual([1, 2])
  })
})
