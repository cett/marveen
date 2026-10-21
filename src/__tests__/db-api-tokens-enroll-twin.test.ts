// enrollDashboardApiToken (facade) and enrollDashboardApiTokenSync (the boot-synchronous twin on the raw
// connection) are two copies of the same two statements. They must agree on every step of a rotation, or the
// token the dashboard enrolls at boot would behave differently from the one a rotation enrolls later.
import { describe, it, expect } from 'vitest'
import { dbx, enrollDashboardApiToken, enrollDashboardApiTokenSync, getDb } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

interface Snapshot { token_hash: string; revoked_at: number | null }

const snapshot = (): Snapshot[] =>
  getDb().prepare("SELECT token_hash, revoked_at FROM api_tokens WHERE name = 'dashboard' ORDER BY token_hash").all() as Snapshot[]

type Enroll = (hash: string, now: number) => Promise<number> | number

// A -> B -> A: the restore of an older token file. Returns what each call answered and the rows after each.
async function scenario(enroll: Enroll): Promise<{ answers: number[]; rows: Snapshot[][] }> {
  const answers: number[] = []
  const rows: Snapshot[][] = []
  for (const [hash, now] of [['hash-a', 100], ['hash-a', 101], ['hash-b', 200], ['hash-a', 300]] as const) {
    answers.push(await enroll(hash, now))
    rows.push(snapshot())
  }
  return { answers, rows }
}

describe('enrollDashboardApiToken and its boot-synchronous twin', () => {
  it('give the same answers and leave the same rows through A, A again, B, A restored', async () => {
    const viaFacade = await scenario(enrollDashboardApiToken)
    await dbx.run('DELETE FROM api_tokens')
    const viaTwin = await scenario(enrollDashboardApiTokenSync)
    expect(viaTwin).toEqual(viaFacade)
  })

  it('both revoke the earlier dashboard row and keep a restored token revoked (the scenario is not vacuous)', async () => {
    const { answers, rows } = await scenario(enrollDashboardApiTokenSync)
    expect(answers).toEqual([1, 0, 1, 0])
    expect(rows[2]).toEqual([{ token_hash: 'hash-a', revoked_at: 200 }, { token_hash: 'hash-b', revoked_at: null }])
    // A is enrolled again: B goes, A stays revoked (a row revoked on purpose is never un-revoked).
    expect(rows[3]).toEqual([{ token_hash: 'hash-a', revoked_at: 200 }, { token_hash: 'hash-b', revoked_at: 300 }])
  })
})
