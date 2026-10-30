/**
 * activateSchedule / patchSchedule with an async db: every await is a point where a second caller can run.
 * Both write only the columns they own and decide "row exists" from the statement's own match count, so two
 * overlapping calls cannot drop each other's change and a delete in between cannot resurrect or crash a row.
 * Real in-memory DB.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { initDatabase, getDb, upsertSchedule, patchSchedule, activateSchedule, deleteSchedule, getScheduleFromDb } from '../db.js'

beforeAll(() => {
  initDatabase(':memory:')
})

afterEach(() => {
  getDb().exec("DELETE FROM schedules WHERE id LIKE 'test-conc-%'")
})

const baseOpts = {
  prompt: 'do the thing',
  description: 'a task',
  schedule: '0 9 * * *',
  agent: 'boni',
  type: 'task' as const,
  enabled: true,
  tenant_id: null as string | null,
  skip_if_busy: false,
  force_send: false,
  target_session: null,
  command: null,
  timeout_ms: null,
  fail_threshold: null,
  pre_check: null,
  catch_up_max_age_minutes: null,
  stuck_after_minutes: null,
  requires: null,
}

async function seed(id: string, status: 'draft' | 'live' = 'draft') {
  await upsertSchedule(id, { ...baseOpts, status })
}

describe('activateSchedule', () => {
  it('returns null and creates nothing for an id that does not exist', async () => {
    expect(await activateSchedule('test-conc-missing')).toBeNull()
    expect(await getScheduleFromDb('test-conc-missing')).toBeUndefined()
  })

  it('returns null when the row is deleted between two calls, and does not bring it back', async () => {
    await seed('test-conc-gone')
    expect(await deleteSchedule('test-conc-gone')).toBe(true)
    expect(await activateSchedule('test-conc-gone')).toBeNull()
    expect(await getScheduleFromDb('test-conc-gone')).toBeUndefined()
  })

  it('a double activation ends live; both calls return the live row and no other column moves', async () => {
    await seed('test-conc-double')
    const before = (await getScheduleFromDb('test-conc-double'))!
    const [a, b] = await Promise.all([activateSchedule('test-conc-double'), activateSchedule('test-conc-double')])
    expect(a?.status).toBe('live')
    expect(b?.status).toBe('live')
    const after = (await getScheduleFromDb('test-conc-double'))!
    expect({ ...after, status: before.status, updated_at: before.updated_at }).toEqual(before)
    expect(after.status).toBe('live')
  })

  it('touches only the activated row', async () => {
    await seed('test-conc-one')
    await seed('test-conc-two')
    await activateSchedule('test-conc-one')
    expect((await getScheduleFromDb('test-conc-one'))?.status).toBe('live')
    expect((await getScheduleFromDb('test-conc-two'))?.status).toBe('draft')
  })

  it('an activation racing a patch of another column keeps both changes', async () => {
    await seed('test-conc-act-patch')
    const [activated, patched] = await Promise.all([
      activateSchedule('test-conc-act-patch'),
      patchSchedule('test-conc-act-patch', { prompt: 'edited meanwhile' }),
    ])
    expect(activated).not.toBeNull()
    expect(patched).not.toBeNull()
    expect(await getScheduleFromDb('test-conc-act-patch')).toMatchObject({ status: 'live', prompt: 'edited meanwhile' })
  })
})

describe('patchSchedule', () => {
  it('returns null and creates nothing for an id that does not exist', async () => {
    expect(await patchSchedule('test-conc-nope', { prompt: 'x' })).toBeNull()
    expect(await getScheduleFromDb('test-conc-nope')).toBeUndefined()
  })

  it('returns null for a row deleted before the patch, and does not bring it back', async () => {
    await seed('test-conc-patch-gone')
    await deleteSchedule('test-conc-patch-gone')
    expect(await patchSchedule('test-conc-patch-gone', { prompt: 'late' })).toBeNull()
    expect(await getScheduleFromDb('test-conc-patch-gone')).toBeUndefined()
  })

  it('two overlapping patches of different columns both survive (no lost update)', async () => {
    await seed('test-conc-two-patches')
    await Promise.all([
      patchSchedule('test-conc-two-patches', { prompt: 'new prompt' }),
      patchSchedule('test-conc-two-patches', { description: 'new description' }),
    ])
    expect(await getScheduleFromDb('test-conc-two-patches')).toMatchObject({ prompt: 'new prompt', description: 'new description' })
  })

  it('many overlapping patches of distinct columns all land', async () => {
    await seed('test-conc-many')
    await Promise.all([
      patchSchedule('test-conc-many', { prompt: 'p' }),
      patchSchedule('test-conc-many', { description: 'd' }),
      patchSchedule('test-conc-many', { schedule: '5 5 * * *' }),
      patchSchedule('test-conc-many', { agent: 'other' }),
      patchSchedule('test-conc-many', { enabled: false }),
    ])
    expect(await getScheduleFromDb('test-conc-many')).toMatchObject({ prompt: 'p', description: 'd', schedule: '5 5 * * *', agent: 'other', enabled: 0 })
  })

  it('a patch with only unknown fields still answers with the row and changes no data column', async () => {
    await seed('test-conc-unknown')
    const before = (await getScheduleFromDb('test-conc-unknown'))!
    const patched = await patchSchedule('test-conc-unknown', { notAColumn: 'x' } as unknown as Parameters<typeof patchSchedule>[1])
    expect(patched).toMatchObject({ prompt: before.prompt, description: before.description, status: before.status })
  })
})
