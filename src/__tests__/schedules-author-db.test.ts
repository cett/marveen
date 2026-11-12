// The author and activation columns of `schedules` (migration 0096) at the db layer: upsertSchedule writes them in the
// same statement as the rest and keeps the stored value when the caller names none, activateSchedule records the
// activator and leaves the author alone, a seed gets NULL, and the review hash does not move with the author.

import { describe, it, expect } from 'vitest'
import { upsertSchedule, activateSchedule, getScheduleFromDb, seedScheduleIfAbsent, type UpsertScheduleOpts } from '../db/tasks.js'
import { rowToTask } from '../web/scheduled-tasks-io.js'
import { REVIEWED_FIELDS, scheduleContentHash } from '../web/schedule-review.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

const base = (over: Partial<UpsertScheduleOpts> = {}): UpsertScheduleOpts => ({
  prompt: 'p', description: 'd', schedule: '0 9 * * *', agent: 'agent-a', type: 'task',
  enabled: true, tenant_id: 'default', skip_if_busy: false, force_send: false, status: 'draft', ...over,
})
const authorOf = async (id: string) => {
  const r = (await getScheduleFromDb(id))!
  return { userId: r.author_user_id, label: r.author_label, by: r.activated_by, at: r.activated_at }
}

describe('schedules author and activation columns at the db layer', () => {
  it('a new row without an author or activation has NULL in all four', async () => {
    await upsertSchedule('t1', base())
    expect(await authorOf('t1')).toEqual({ userId: null, label: null, by: null, at: null })
  })

  it('a new row with an author and an activation stores them', async () => {
    await upsertSchedule('t1', base({ author: { userId: 7, label: 'user-a' }, activation: { by: 'admin-a', at: 1234 } }))
    expect(await authorOf('t1')).toEqual({ userId: 7, label: 'user-a', by: 'admin-a', at: 1234 })
  })

  it('an upsert that names no author keeps the stored one (a mirror or a toggle must not blank it)', async () => {
    await upsertSchedule('t1', base({ author: { userId: 7, label: 'user-a' }, activation: { by: 'admin-a', at: 1234 } }))
    await upsertSchedule('t1', base({ enabled: false, prompt: 'changed' }))
    expect(await authorOf('t1')).toEqual({ userId: 7, label: 'user-a', by: 'admin-a', at: 1234 })
    expect((await getScheduleFromDb('t1'))!.prompt).toBe('changed')
  })

  it('an upsert that names an author replaces it, and a null author is a deliberate "no user-bound author"', async () => {
    await upsertSchedule('t1', base({ author: { userId: 7, label: 'user-a' }, activation: { by: 'admin-a', at: 1234 } }))
    await upsertSchedule('t1', base({ author: { userId: 8, label: 'user-b' } }))
    expect(await authorOf('t1')).toEqual({ userId: 8, label: 'user-b', by: 'admin-a', at: 1234 })
    await upsertSchedule('t1', base({ author: { userId: null, label: 'token:ci' } }))
    expect(await authorOf('t1')).toEqual({ userId: null, label: 'token:ci', by: 'admin-a', at: 1234 })
  })

  it('an activation of null clears the activator and leaves the author (a task moved to another tenant is activated again)', async () => {
    await upsertSchedule('t1', base({ author: { userId: 7, label: 'user-a' }, activation: { by: 'admin-a', at: 1234 } }))
    await upsertSchedule('t1', base({ activation: null }))
    expect(await authorOf('t1')).toEqual({ userId: 7, label: 'user-a', by: null, at: null })
  })

  it('an upsert that names only an activation leaves the author, and the other way round', async () => {
    await upsertSchedule('t1', base({ author: { userId: 7, label: 'user-a' } }))
    await upsertSchedule('t1', base({ activation: { by: 'admin-a', at: 55 } }))
    expect(await authorOf('t1')).toEqual({ userId: 7, label: 'user-a', by: 'admin-a', at: 55 })
  })

  it('activateSchedule sets the status and records the activator in one statement, and never touches the author', async () => {
    await upsertSchedule('t1', base({ author: { userId: 7, label: 'user-a' } }))
    const row = (await activateSchedule('t1', 'admin-a', 4321))!
    expect(row.status).toBe('live')
    expect(await authorOf('t1')).toEqual({ userId: 7, label: 'user-a', by: 'admin-a', at: 4321 })
  })

  it('activateSchedule without an activator behaves as before: status only', async () => {
    await upsertSchedule('t1', base({ author: { userId: 7, label: 'user-a' }, activation: { by: 'admin-a', at: 99 } }))
    const row = (await activateSchedule('t1'))!
    expect(row.status).toBe('live')
    expect(await authorOf('t1')).toEqual({ userId: 7, label: 'user-a', by: 'admin-a', at: 99 })
    expect(await activateSchedule('missing', 'admin-a')).toBeNull()
  })

  it('activateSchedule defaults the time to now', async () => {
    await upsertSchedule('t1', base())
    const before = Math.floor(Date.now() / 1000)
    await activateSchedule('t1', 'admin-a')
    const at = (await authorOf('t1')).at!
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(before + 5)
  })

  it('seedScheduleIfAbsent inserts a new row with NULL author and activation, and leaves an existing row alone', async () => {
    expect(await seedScheduleIfAbsent('seeded', base({ status: 'live' }))).toBe(true)
    expect(await authorOf('seeded')).toEqual({ userId: null, label: null, by: null, at: null })
    await upsertSchedule('kept', base({ author: { userId: 7, label: 'user-a' }, activation: { by: 'admin-a', at: 5 } }))
    expect(await seedScheduleIfAbsent('kept', base({ prompt: 'from a file' }))).toBe(false)
    expect(await authorOf('kept')).toEqual({ userId: 7, label: 'user-a', by: 'admin-a', at: 5 })
    expect((await getScheduleFromDb('kept'))!.prompt).toBe('p')
  })

  it('rowToTask carries the four values and leaves them undefined for a row without an author', async () => {
    await upsertSchedule('plain', base())
    await upsertSchedule('owned', base({ author: { userId: 7, label: 'user-a' }, activation: { by: 'admin-a', at: 12 } }))
    const plain = rowToTask((await getScheduleFromDb('plain'))!)
    expect([plain.authorUserId, plain.authorLabel, plain.activatedBy, plain.activatedAt]).toEqual([undefined, undefined, undefined, undefined])
    const owned = rowToTask((await getScheduleFromDb('owned'))!)
    expect([owned.authorUserId, owned.authorLabel, owned.activatedBy, owned.activatedAt]).toEqual([7, 'user-a', 'admin-a', 12])
  })

  it('the review hash does not move with the author or the activation (REVIEWED_FIELDS holds none of the four)', async () => {
    await upsertSchedule('t1', base())
    const h1 = scheduleContentHash({ ...rowToTask((await getScheduleFromDb('t1'))!) }, REVIEWED_FIELDS)
    await upsertSchedule('t1', base({ author: { userId: 9, label: 'user-c' }, activation: { by: 'admin-a', at: 777 } }))
    const h2 = scheduleContentHash({ ...rowToTask((await getScheduleFromDb('t1'))!) }, REVIEWED_FIELDS)
    expect(h2).toBe(h1)
    for (const f of ['authorUserId', 'authorLabel', 'activatedBy', 'activatedAt', 'author_user_id', 'author_label', 'activated_by', 'activated_at']) {
      expect(REVIEWED_FIELDS as readonly string[]).not.toContain(f)
    }
    // the hash does move with a reviewed field, so the equality above is not vacuous
    await upsertSchedule('t1', base({ prompt: 'a different prompt' }))
    expect(scheduleContentHash({ ...rowToTask((await getScheduleFromDb('t1'))!) }, REVIEWED_FIELDS)).not.toBe(h1)
  })
})
