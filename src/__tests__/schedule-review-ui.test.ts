import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activateUrl, saveToastKey, statusBadgeKey } from '../../web/modules/schedule-review-ui.js'

describe('statusBadgeKey', () => {
  it('a held task and a never-approved task read differently', () => {
    expect(statusBadgeKey('pending_review')).toBe('tasks.status.pending_review')
    expect(statusBadgeKey('draft')).toBe('tasks.status.draft')
  })
  it('an unknown non-live status falls back to the draft label', () => {
    expect(statusBadgeKey('something_new')).toBe('tasks.status.draft')
    expect(statusBadgeKey(undefined)).toBe('tasks.status.draft')
  })
})

describe('activateUrl', () => {
  it('sends the hash the list was rendered from, encoded', () => {
    expect(activateUrl('my-task', 'abc123')).toBe('/api/schedules/my-task/activate?expected_hash=abc123')
    expect(activateUrl('a b', 'x/y')).toBe('/api/schedules/a%20b/activate?expected_hash=x%2Fy')
  })
  it('without a hash it is the plain activate call', () => {
    expect(activateUrl('my-task', undefined)).toBe('/api/schedules/my-task/activate')
    expect(activateUrl('my-task', '')).toBe('/api/schedules/my-task/activate')
  })
})

describe('saveToastKey', () => {
  it('review_required wins, so the editor learns the task is paused', () => {
    expect(saveToastKey({ review_required: true, status: 'pending_review' })).toEqual({ key: 'tasks.toast.review_required' })
  })
  it('a tenant move says it is a draft, with the tenant', () => {
    expect(saveToastKey({ status: 'draft', tenant_id: 'tenant-b' })).toEqual({ key: 'tasks.toast.moved_draft', tenant: 'tenant-b' })
  })
  it('a plain save, or an unreadable response, is the ordinary toast', () => {
    expect(saveToastKey({})).toEqual({ key: 'tasks.toast.updated' })
    expect(saveToastKey(null)).toEqual({ key: 'tasks.toast.updated' })
  })
})

describe('dashboard wiring', () => {
  const root = join(__dirname, '../..')
  const src = (p: string) => readFileSync(join(root, p), 'utf-8')

  it('schedules.js uses the helpers for the badge, the activate call and the save toast', () => {
    const app = src('web/modules/schedules.js')
    expect(app).toContain("t(statusBadgeKey(task.status))")
    expect(app).toContain('fetch(activateUrl(task.name, task.contentHash)')
    expect(app).toContain('saveToastKey(saved)')
  })

  it.each(['en', 'hu'])('%s has the new status and toast strings and the stale_revision error', (lang) => {
    const file = src(`web/lang/${lang}.js`)
    for (const key of ['tasks.status.pending_review', 'tasks.toast.review_required', 'errors.stale_revision']) {
      expect(file, key).toContain(`'${key}'`)
    }
  })
})

describe('dashboard permission wiring', () => {
  const app = readFileSync(join(__dirname, '../../web/modules/schedules.js'), 'utf-8')

  it('editing is gated by schedules:write, and activation and the scheduler heartbeat by admin:all', () => {
    expect(app).toContain("_canWriteSchedules = await can('schedules:write')")
    expect(app).toContain("_canActivateSchedules = await can('admin:all')")
    expect(app).toMatch(/if \(!_canActivateSchedules\) \{ container\.hidden = true; return \}/)
  })

  it('a user who can write but not activate keeps run/toggle/delete and loses only activate', () => {
    expect(app).toContain("...(_canWriteSchedules ? [] : ['run', 'toggle', 'delete'])")
    expect(app).toContain("...(_canActivateSchedules ? [] : ['activate'])")
  })
})
