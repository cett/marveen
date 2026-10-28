/**
 * Schedule CRUD helpers in src/db/tasks.ts that had no direct test coverage:
 * countSchedules, listSchedulesFromDb (tenant/fleet filtering), patchSchedule
 * (camelCase->snake_case column mapping + allowlist), deleteSchedule,
 * setScheduleEnabled. Real in-memory DB, mirrors the upsertSchedule/
 * activateSchedule pattern in schedules-activate.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  initDatabase,
  getDb,
  upsertSchedule,
  countSchedules,
  listSchedulesFromDb,
  patchSchedule,
  deleteSchedule,
  setScheduleEnabled,
  getScheduleFromDb,
} from '../db.js'

beforeAll(() => {
  initDatabase(':memory:')
})

afterAll(() => {
  getDb().exec("DELETE FROM schedules WHERE id LIKE 'test-crud-%'")
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

describe('countSchedules', () => {
  it('reflects the current row count', async () => {
    const before = await countSchedules()
    await upsertSchedule('test-crud-count-1', baseOpts)
    expect(await countSchedules()).toBe(before + 1)
    await upsertSchedule('test-crud-count-2', baseOpts)
    expect(await countSchedules()).toBe(before + 2)
  })
})

describe('listSchedulesFromDb', () => {
  it('filters to a single tenant when tenantId is given', async () => {
    await upsertSchedule('test-crud-list-tenant-a', { ...baseOpts, tenant_id: 'tenant-crud-a' })
    await upsertSchedule('test-crud-list-tenant-b', { ...baseOpts, tenant_id: 'tenant-crud-b' })
    const rows = await listSchedulesFromDb({ tenantId: 'tenant-crud-a' })
    expect(rows.every(r => r.tenant_id === 'tenant-crud-a')).toBe(true)
    expect(rows.some(r => r.id === 'test-crud-list-tenant-a')).toBe(true)
    expect(rows.some(r => r.id === 'test-crud-list-tenant-b')).toBe(false)
  })

  it('returns every row, whatever its tenant, when no tenantId is given', async () => {
    await upsertSchedule('test-crud-list-all-a', { ...baseOpts, tenant_id: 'tenant-crud-c' })
    await upsertSchedule('test-crud-list-all-b', { ...baseOpts, tenant_id: 'tenant-crud-d' })
    const rows = await listSchedulesFromDb()
    expect(rows.some(r => r.id === 'test-crud-list-all-a')).toBe(true)
    expect(rows.some(r => r.id === 'test-crud-list-all-b')).toBe(true)
  })

  it('a row with no tenant (older than the tenant migration) belongs to the default tenant only', async () => {
    await upsertSchedule('test-crud-list-legacy', { ...baseOpts, tenant_id: null })
    expect((await listSchedulesFromDb({ tenantId: 'default' })).some(r => r.id === 'test-crud-list-legacy')).toBe(true)
    expect((await listSchedulesFromDb({ tenantId: 'tenant-crud-a' })).some(r => r.id === 'test-crud-list-legacy')).toBe(false)
  })
})

describe('patchSchedule', () => {
  it('returns null for a schedule id that does not exist', async () => {
    expect(await patchSchedule('test-crud-patch-nonexistent', { prompt: 'x' })).toBeNull()
  })

  it('updates only the given columns and leaves the rest untouched', async () => {
    const id = 'test-crud-patch-basic'
    await upsertSchedule(id, baseOpts)
    const patched = await patchSchedule(id, { prompt: 'updated prompt' })
    expect(patched!.prompt).toBe('updated prompt')
    expect(patched!.schedule).toBe('0 9 * * *')
    expect(patched!.description).toBe('a task')
  })

  it('maps camelCase patch keys to snake_case columns', async () => {
    const id = 'test-crud-patch-camel'
    await upsertSchedule(id, baseOpts)
    const patched = await patchSchedule(id, { skip_if_busy: true, force_send: true } as Partial<typeof baseOpts>)
    expect(patched!.skip_if_busy).toBe(1)
    expect(patched!.force_send).toBe(1)
  })

  it('silently ignores keys not in the column allowlist', async () => {
    const id = 'test-crud-patch-unknown'
    await upsertSchedule(id, baseOpts)
    const patched = await patchSchedule(id, { notARealColumn: 'nope' } as unknown as Partial<typeof baseOpts>)
    expect(patched).not.toBeNull()
    expect(patched!.prompt).toBe('do the thing')
  })

  it('bumps updated_at', async () => {
    const id = 'test-crud-patch-updated-at'
    const created = await upsertSchedule(id, baseOpts)
    await new Promise(r => setTimeout(r, 1100))
    const patched = await patchSchedule(id, { prompt: 'later' })
    expect(patched!.updated_at).toBeGreaterThan(created.updated_at)
  })
})

describe('deleteSchedule', () => {
  it('returns true and removes the row when it existed', async () => {
    const id = 'test-crud-delete-existing'
    await upsertSchedule(id, baseOpts)
    expect(await deleteSchedule(id)).toBe(true)
    expect(await getScheduleFromDb(id)).toBeUndefined()
  })

  it('returns false for a schedule id that does not exist', async () => {
    expect(await deleteSchedule('test-crud-delete-nonexistent')).toBe(false)
  })
})

describe('setScheduleEnabled', () => {
  it('flips enabled to false and returns true', async () => {
    const id = 'test-crud-enable-off'
    await upsertSchedule(id, { ...baseOpts, enabled: true })
    expect(await setScheduleEnabled(id, false)).toBe(true)
    expect((await getScheduleFromDb(id))!.enabled).toBe(0)
  })

  it('flips enabled to true and returns true', async () => {
    const id = 'test-crud-enable-on'
    await upsertSchedule(id, { ...baseOpts, enabled: false })
    expect(await setScheduleEnabled(id, true)).toBe(true)
    expect((await getScheduleFromDb(id))!.enabled).toBe(1)
  })

  it('returns false for a schedule id that does not exist', async () => {
    expect(await setScheduleEnabled('test-crud-enable-nonexistent', true)).toBe(false)
  })
})
