// How long an approval request stays open. Pure functions (no DB, no clock) so the rule is testable
// as a table; the route feeds them the category row and the request body.

/** Hard ceiling for a category with no usable timeout (an unknown category, or a NULL/invalid value). */
export const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 1440

/** Longest timeout an admin may set on a category: one week. */
export const MAX_CATEGORY_TIMEOUT_MINUTES = 10080

/**
 * Lifetime of a new approval, in seconds. The category (or the 24 h fallback) is the ceiling; the
 * caller's `timeout_seconds` can only shorten it. A requested value that is not a positive finite
 * number is ignored, so a request can never be unbounded and can never extend what the admin set.
 */
export function resolveApprovalTimeoutSeconds(categoryMinutes: number | null | undefined, requestedSeconds: unknown): number {
  const ceilingMinutes =
    typeof categoryMinutes === 'number' && Number.isFinite(categoryMinutes) && categoryMinutes > 0
      ? categoryMinutes
      : DEFAULT_APPROVAL_TIMEOUT_MINUTES
  const ceiling = Math.floor(ceilingMinutes * 60)
  if (typeof requestedSeconds === 'number' && Number.isFinite(requestedSeconds) && requestedSeconds >= 1) {
    return Math.min(Math.floor(requestedSeconds), ceiling)
  }
  return ceiling
}
