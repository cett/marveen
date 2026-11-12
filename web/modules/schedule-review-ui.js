// Pure helpers for the schedule review gate in the dashboard (no DOM, so they are unit-tested).

// i18n key of the status badge for a task that is not live. A task a person has never
// approved is a draft; an approved task a non-admin changed is waiting for a new approval.
// Anything else non-live (an unknown future status) reads as a draft, the safe label.
export function statusBadgeKey(status) {
  return status === 'pending_review' ? 'tasks.status.pending_review' : 'tasks.status.draft'
}

// URL of the activate call. contentHash is what the list was rendered from; sending it
// back lets the server refuse (409 stale_revision) when the task changed in the meantime.
export function activateUrl(name, contentHash) {
  const base = `/api/schedules/${encodeURIComponent(name)}/activate`
  return contentHash ? `${base}?expected_hash=${encodeURIComponent(contentHash)}` : base
}

// i18n key (and params) of the toast after a successful PUT, from the response body.
export function saveToastKey(saved) {
  if (saved && saved.review_required) return { key: 'tasks.toast.review_required' }
  if (saved && saved.status === 'draft' && saved.tenant_id) return { key: 'tasks.toast.moved_draft', tenant: saved.tenant_id }
  return { key: 'tasks.toast.updated' }
}

// Number of tasks the review gate holds for a person (status pending_review). A never-approved
// draft is not counted: it is a task nobody has asked to run yet, a pending_review one is a task
// that was running and stopped because someone changed it. A non-array reads as zero.
export function pendingReviewCount(tasks) {
  if (!Array.isArray(tasks)) return 0
  return tasks.filter((task) => task && task.status === 'pending_review').length
}

// Show the count on the sidebar badge, hidden at zero (same contract as the approvals and
// updates badges). Takes the element so it is unit-tested without a DOM.
export function applyPendingReviewBadge(badge, tasks) {
  if (!badge) return 0
  const count = pendingReviewCount(tasks)
  badge.textContent = String(count)
  badge.hidden = count === 0
  return count
}

// URL of the adopt call (an admin takes a task over). Same contract as activateUrl: the hash is what the list was
// rendered from, and a changed task is refused with 409 stale_revision instead of being adopted blind.
export function adoptUrl(name, contentHash) {
  const base = `/api/schedules/${encodeURIComponent(name)}/adopt`
  return contentHash ? `${base}?expected_hash=${encodeURIComponent(contentHash)}` : base
}

// i18n keys of the badge (and its tooltip) for an author the run-time check does not accept. Only the two blocking
// states have one: none, ok and anything unknown show nothing, so a future state never shows a wrong word.
export function authorBadge(authorState) {
  if (authorState === 'inactive') return { key: 'tasks.author.inactive', titleKey: 'tasks.author.inactive_title' }
  if (authorState === 'unverifiable') return { key: 'tasks.author.unverifiable', titleKey: 'tasks.author.unverifiable_title' }
  return null
}

// The adopt button is for an admin (admin:all) and only on a task whose author the check does not accept.
export function canAdopt(task, isAdmin) {
  return Boolean(isAdmin && task && authorBadge(task.authorState))
}

// The author line of a list row, as an i18n key plus params, or null when there is nothing to say. activatedAt is a
// unix time in seconds. An admin gets the names (the server sends them to admins only); everyone else gets only
// whether the task was approved and when, or that it is waiting.
export function authorLine(task, isAdmin, formatDate = (ms) => new Date(ms).toLocaleDateString()) {
  if (!task) return null
  const approved = typeof task.activatedAt === 'number' && task.activatedAt > 0
  const date = approved ? formatDate(task.activatedAt * 1000) : ''
  if (isAdmin) {
    if (task.authorLabel && approved && task.activatedBy) return { key: 'tasks.author.admin_approved', params: { author: task.authorLabel, approver: task.activatedBy, date } }
    if (task.authorLabel) return { key: 'tasks.author.admin_unapproved', params: { author: task.authorLabel } }
    if (approved && task.activatedBy) return { key: 'tasks.author.admin_approved_only', params: { approver: task.activatedBy, date } }
    return null
  }
  if (approved) return { key: 'tasks.author.approved', params: { date } }
  if (task.status && task.status !== 'live') return { key: 'tasks.author.awaiting', params: {} }
  return null
}
