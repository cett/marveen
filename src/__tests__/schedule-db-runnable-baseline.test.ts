import { describe, expect, it, vi } from 'vitest'

// The skip tracker's restart baseline reads the DB rows themselves (enabled AND
// live), not the tick's task list nor the task-config.json mirror.
const rows = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }))
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, listSchedulesFromDb: vi.fn(() => rows.list) }
})

import { listDbRunnableTaskNames } from '../web/scheduled-tasks-io.js'

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, description: '', prompt: 'p', schedule: '*/30 * * * *', agent: 'main', enabled: 1, created_at: 0,
  type: 'task', skip_if_busy: 0, force_send: 0, status: 'live', ...over,
})

describe('listDbRunnableTaskNames', () => {
  it('lists enabled + live rows only: DB-disabled and draft / pending_review rows are out', () => {
    rows.list = [
      row('live-a'),
      row('off', { enabled: 0 }),
      row('draft', { status: 'draft' }),
      row('review', { status: 'pending_review' }),
      row('live-b', { type: 'command' }),
    ]
    expect(listDbRunnableTaskNames()).toEqual(['live-a', 'live-b'])
  })

  it('is empty for an empty table', () => {
    rows.list = []
    expect(listDbRunnableTaskNames()).toEqual([])
  })
})
