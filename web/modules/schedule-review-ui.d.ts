export function statusBadgeKey(status: string | undefined): 'tasks.status.pending_review' | 'tasks.status.draft'
export function activateUrl(name: string, contentHash?: string): string
export function saveToastKey(saved: { review_required?: boolean; status?: string; tenant_id?: string } | null | undefined):
  { key: 'tasks.toast.review_required' } | { key: 'tasks.toast.moved_draft'; tenant: string } | { key: 'tasks.toast.updated' }
export function pendingReviewCount(tasks: unknown): number
export function applyPendingReviewBadge(badge: { textContent: string | null; hidden: boolean } | null | undefined, tasks: unknown): number
