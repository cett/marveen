import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { activateUrl, adoptUrl, applyPendingReviewBadge, authorBadge, authorLine, canAdopt, pendingReviewCount, saveToastKey, statusBadgeKey } from '../../web/modules/schedule-review-ui.js'

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

describe('pendingReviewCount', () => {
  it('counts only the tasks the review gate holds', () => {
    expect(pendingReviewCount([
      { name: 'a', status: 'pending_review' },
      { name: 'b', status: 'live' },
      { name: 'c', status: 'draft' },
      { name: 'd', status: 'pending_review' },
    ])).toBe(2)
  })
  it('is zero for an empty list and for anything that is not a list', () => {
    expect(pendingReviewCount([])).toBe(0)
    expect(pendingReviewCount(null)).toBe(0)
    expect(pendingReviewCount(undefined)).toBe(0)
    expect(pendingReviewCount({ error: 'forbidden' })).toBe(0)
    expect(pendingReviewCount([null, undefined, {}])).toBe(0)
  })
})

describe('applyPendingReviewBadge', () => {
  const badge = () => ({ textContent: '', hidden: true })
  it('shows the count when something is held', () => {
    const b = badge()
    expect(applyPendingReviewBadge(b, [{ status: 'pending_review' }, { status: 'pending_review' }, { status: 'live' }])).toBe(2)
    expect(b).toEqual({ textContent: '2', hidden: false })
  })
  it('hides again at zero (after an activation the list has none held)', () => {
    const b = { textContent: '3', hidden: false }
    applyPendingReviewBadge(b, [{ status: 'live' }])
    expect(b).toEqual({ textContent: '0', hidden: true })
  })
  it('a missing badge element is not an error', () => {
    expect(applyPendingReviewBadge(null, [{ status: 'pending_review' }])).toBe(0)
  })
})

describe('sidebar badge wiring', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', '..', ...p), 'utf-8')

  it('the Tasks sidebar link carries the hidden badge, like the updates and approvals badges', () => {
    const html = read('web', 'index.html')
    const link = html.slice(html.indexOf('data-page="tasks"'), html.indexOf('</a>', html.indexOf('data-page="tasks"')))
    expect(link).toContain('id="schedulesPendingBadge"')
    expect(link).toMatch(/id="schedulesPendingBadge"[^>]*\bhidden\b/)
    expect(link).toContain('sb-badge')
  })

  it('the badge style hides at [hidden] so zero shows nothing', () => {
    expect(read('web', 'css', 'features', 'sidebar.css')).toContain('.pending-review-badge[hidden] { display: none; }')
  })

  it('the count is taken from the unfiltered list and refreshed after every list load', () => {
    const src = read('web', 'modules', 'schedules.js')
    const poll = src.slice(src.indexOf('export async function pollSchedulesBadge'), src.indexOf('export async function loadSchedules'))
    expect(poll).toContain("fetch('/api/schedules')")
    expect(poll).not.toContain('tenant')
    const load = src.slice(src.indexOf('export async function loadSchedules'), src.indexOf('loadSchedulerHeartbeat()', src.indexOf('export async function loadSchedules')))
    expect(load).toContain('pollSchedulesBadge()')
  })

  it('app.js polls it at boot and on an interval', () => {
    const app = read('web', 'app.js')
    expect(app).toContain("m.pollSchedulesBadge())")
    expect(app).toMatch(/setInterval\(\(\) => lazyLoad\('schedules'[^\n]*pollSchedulesBadge\(\)\), 5 \* 60_000\)/)
  })
})

describe('adoptUrl', () => {
  it('sends the hash the list was rendered from, encoded; without one it is the plain adopt call', () => {
    expect(adoptUrl('my-task', 'abc123')).toBe('/api/schedules/my-task/adopt?expected_hash=abc123')
    expect(adoptUrl('a b', 'x/y')).toBe('/api/schedules/a%20b/adopt?expected_hash=x%2Fy')
    expect(adoptUrl('my-task', undefined)).toBe('/api/schedules/my-task/adopt')
  })
})

describe('authorBadge and canAdopt', () => {
  it('only the two blocking states have a badge; none, ok, unknown and missing show nothing', () => {
    expect(authorBadge('inactive')).toEqual({ key: 'tasks.author.inactive', titleKey: 'tasks.author.inactive_title' })
    expect(authorBadge('unverifiable')).toEqual({ key: 'tasks.author.unverifiable', titleKey: 'tasks.author.unverifiable_title' })
    for (const s of ['ok', 'none', 'something_new', '', undefined]) expect(authorBadge(s), String(s)).toBeNull()
  })

  it('the adopt button is for an admin on a blocked author, and for nobody else', () => {
    expect(canAdopt({ authorState: 'inactive' }, true)).toBe(true)
    expect(canAdopt({ authorState: 'unverifiable' }, true)).toBe(true)
    expect(canAdopt({ authorState: 'inactive' }, false)).toBe(false)
    expect(canAdopt({ authorState: 'ok' }, true)).toBe(false)
    expect(canAdopt({ authorState: 'none' }, true)).toBe(false)
    expect(canAdopt({}, true)).toBe(false)
    expect(canAdopt(null, true)).toBe(false)
  })
})

describe('authorLine', () => {
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const at = Date.UTC(2026, 9, 26) / 1000

  it('an admin sees the author, the approver and the date (the time is in seconds)', () => {
    expect(authorLine({ authorLabel: 'author-a', activatedBy: 'admin-a', activatedAt: at }, true, fmt))
      .toEqual({ key: 'tasks.author.admin_approved', params: { author: 'author-a', approver: 'admin-a', date: '2026-10-26' } })
  })

  it('an admin sees an author who was never approved as awaiting, and an approver without an author alone', () => {
    expect(authorLine({ authorLabel: 'author-a' }, true, fmt)).toEqual({ key: 'tasks.author.admin_unapproved', params: { author: 'author-a' } })
    expect(authorLine({ activatedBy: 'admin-a', activatedAt: at }, true, fmt))
      .toEqual({ key: 'tasks.author.admin_approved_only', params: { approver: 'admin-a', date: '2026-10-26' } })
  })

  it('a non-admin gets no name, only approved with the date or awaiting; a live task with no record says nothing', () => {
    const row = { authorLabel: 'leaked-name', activatedBy: 'leaked-admin', activatedAt: at, status: 'live' }
    const line = authorLine(row, false, fmt)
    expect(line).toEqual({ key: 'tasks.author.approved', params: { date: '2026-10-26' } })
    expect(JSON.stringify(line)).not.toContain('leaked')
    expect(authorLine({ status: 'draft' }, false, fmt)).toEqual({ key: 'tasks.author.awaiting', params: {} })
    expect(authorLine({ status: 'pending_review' }, false, fmt)).toEqual({ key: 'tasks.author.awaiting', params: {} })
    expect(authorLine({ status: 'live' }, false, fmt)).toBeNull()
  })

  it('nothing known is nothing shown', () => {
    expect(authorLine({}, true, fmt)).toBeNull()
    expect(authorLine(null, true, fmt)).toBeNull()
    expect(authorLine({ activatedAt: 0, status: 'live' }, false, fmt)).toBeNull()
  })
})

describe('adopt wiring', () => {
  const root = join(__dirname, '../..')
  const src = (p: string) => readFileSync(join(root, p), 'utf-8')

  it('schedules.js renders the badge and the line from the helpers and calls the adopt url with the hash', () => {
    const app = src('web/modules/schedules.js')
    expect(app).toContain('authorBadge(task.authorState)')
    expect(app).toContain('authorLine(task, _canActivateSchedules)')
    expect(app).toContain('canAdopt(task, _canActivateSchedules)')
    expect(app).toContain('fetch(adoptUrl(task.name, task.contentHash)')
  })

  it.each(['en', 'hu'])('%s has every key the helpers and the adopt flow can ask for', (lang) => {
    const file = src(`web/lang/${lang}.js`)
    const keys = [
      'tasks.btn.adopt', 'tasks.author.inactive', 'tasks.author.inactive_title', 'tasks.author.unverifiable', 'tasks.author.unverifiable_title',
      'tasks.author.admin_approved', 'tasks.author.admin_unapproved', 'tasks.author.admin_approved_only', 'tasks.author.approved',
      'tasks.author.awaiting', 'tasks.confirm.adopt', 'tasks.toast.adopted', 'tasks.toast.adopt_error',
    ]
    for (const key of keys) expect(file, key).toContain(`'${key}'`)
  })
})
