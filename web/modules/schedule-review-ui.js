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
