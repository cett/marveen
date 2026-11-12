export function statusBadgeKey(status: string | undefined): 'tasks.status.pending_review' | 'tasks.status.draft'
export function activateUrl(name: string, contentHash?: string): string
export function saveToastKey(saved: { review_required?: boolean; status?: string; tenant_id?: string } | null | undefined):
  { key: 'tasks.toast.review_required' } | { key: 'tasks.toast.moved_draft'; tenant: string } | { key: 'tasks.toast.updated' }
export function pendingReviewCount(tasks: unknown): number
export function applyPendingReviewBadge(badge: { textContent: string | null; hidden: boolean } | null | undefined, tasks: unknown): number
export function adoptUrl(name: string, contentHash?: string): string
export function authorBadge(authorState: string | undefined): { key: string; titleKey: string } | null
export function canAdopt(task: { authorState?: string } | null | undefined, isAdmin: boolean): boolean
export function authorLine(
  task: { activatedAt?: number; activatedBy?: string; authorLabel?: string; status?: string } | null | undefined,
  isAdmin: boolean,
  formatDate?: (ms: number) => string,
): { key: string; params: Record<string, string> } | null
