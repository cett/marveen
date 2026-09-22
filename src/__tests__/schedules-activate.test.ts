/**
 * activateSchedule: the only mutation the human-admin-only
 * POST /api/schedules/:name/activate route performs.
 * Real in-memory DB, mirrors the seedScheduleIfAbsent pattern in
 * schedules-seed-noklobber.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { initDatabase, getDb, upsertSchedule, activateSchedule, getScheduleFromDb } from '../db.js'

beforeAll(() => {
  initDatabase(':memory:')
})

afterAll(() => {
  getDb().exec("DELETE FROM schedules WHERE id LIKE 'test-activate-%'")
})

const baseOpts = {
  prompt: 'do the thing',
  description: 'a task',
  schedule: '0 9 * * *',
  agent: 'jarvis',
  type: 'task' as const,
  enabled: true,
  tenant_id: null,
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

describe('activateSchedule', () => {
  it('returns null for a schedule id that does not exist', () => {
    expect(activateSchedule('test-activate-nonexistent')).toBeNull()
  })

  it('flips a draft schedule to live and leaves other columns untouched', () => {
    const id = 'test-activate-draft'
    upsertSchedule(id, { ...baseOpts, status: 'draft' })
    expect(getScheduleFromDb(id)!.status).toBe('draft')

    const activated = activateSchedule(id)
    expect(activated).not.toBeNull()
    expect(activated!.status).toBe('live')
    expect(activated!.prompt).toBe('do the thing')
    expect(activated!.schedule).toBe('0 9 * * *')
    expect(getScheduleFromDb(id)!.status).toBe('live')
  })

  it('flips a pending_review schedule to live', () => {
    const id = 'test-activate-pending'
    upsertSchedule(id, { ...baseOpts, status: 'pending_review' })
    const activated = activateSchedule(id)
    expect(activated!.status).toBe('live')
  })

  it('is idempotent: activating an already-live schedule keeps it live', () => {
    const id = 'test-activate-already-live'
    upsertSchedule(id, { ...baseOpts, status: 'live' })
    const activated = activateSchedule(id)
    expect(activated!.status).toBe('live')
  })

  it('bumps updated_at', async () => {
    const id = 'test-activate-updated-at'
    const created = upsertSchedule(id, { ...baseOpts, status: 'draft' })
    // Ensure a distinct second boundary so updated_at (unix seconds) can move.
    await new Promise(r => setTimeout(r, 1100))
    const activated = activateSchedule(id)
    expect(activated!.updated_at).toBeGreaterThan(created.updated_at)
  })
})
