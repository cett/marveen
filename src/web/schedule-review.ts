import { createHash } from 'node:crypto'

// Re-review rule for edits to an already-approved schedule.
//
// A caller that is not a human admin (a tenant user, a scoped token, a device key, an agent
// on the shared dashboard token) must not be able to change what a live task EXECUTES
// without a person looking at it again. The PUT route calls reviewTriggerFields() on the
// stored row and the incoming patch; a non-empty result sends the task back to
// pending_review. The rule lives here, in a pure helper, and not in writeScheduledTask:
// the seed, fleet-transfer and the toggle file-mirror call that writer directly and none
// of them is an edit that needs a second pair of eyes.

// Fields whose change never triggers a re-review. Everything else in a patch does, so a
// field added to PUT_FIELDS later is gated by default (fail-closed) rather than silently
// editable on a live task.
//  - description: a label, executed by nothing.
//  - enabled: switching a task off is the fail-safe direction, and switching it back on
//    only re-enables content that was already approved.
export const REVIEW_EXEMPT_FIELDS: ReadonlySet<string> = new Set(['description', 'enabled'])

// The stored fields an approval covers: PUT_FIELDS minus the exempt ones, plus `agent`
// (who executes it). What scheduleContentHash() fingerprints for the activation check.
export const REVIEWED_FIELDS = [
  'prompt', 'schedule', 'agent', 'type', 'skipIfBusy', 'forceSend',
  'targetSession', 'command', 'timeoutMs', 'failThreshold',
] as const

type Scalar = string | number | boolean | null

// One comparable form per value: strings are trimmed, '' / null / undefined are the same
// "unset", and false is also "unset" (skipIfBusy / forceSend default to false, and the
// dashboard sends them on every save whether the row stored a 0 or nothing). Numbers and
// true stay as they are, so 30000 vs '30000' differs by type on purpose: the route has
// validated the body by now and a client that changes the type is changing the value.
export function normalizeReviewValue(value: unknown): Scalar {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof value === 'boolean') return value ? true : null
  if (typeof value === 'number') return value
  // An object/array in a scalar field is not something the API accepts; compare its JSON so
  // it can never compare equal to a stored scalar by accident.
  return JSON.stringify(value)
}

/**
 * The names of the fields in `patch` that differ from the stored `before` row and are not
 * review-exempt, in the order they appear in the patch. An empty array means the edit does
 * not need a re-review. A key whose value is `undefined` is "not sent" and is skipped.
 */
export function reviewTriggerFields(
  before: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): string[] {
  const changed: string[] = []
  for (const [field, incoming] of Object.entries(patch)) {
    if (incoming === undefined || REVIEW_EXEMPT_FIELDS.has(field)) continue
    if (normalizeReviewValue(before[field]) !== normalizeReviewValue(incoming)) changed.push(field)
  }
  return changed
}

// Short, non-reversible fingerprint of a value for the audit trail: the audit row says THAT
// a prompt/command changed and lets two rows be compared, without copying a whole prompt
// (which may hold tenant data) into agent_audit_log.
export function reviewValueSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalizeReviewValue(value))).digest('hex')
}

// Fingerprint of everything the review decision covers, in a fixed field order. The
// activation step compares it with the hash the admin's screen was rendered from, so a
// draft edited between "admin opened it" and "admin clicked Activate" is refused (the
// existing draft-activation TOCTOU as well as the new pending_review one).
export function scheduleContentHash(
  row: Readonly<Record<string, unknown>>,
  fields: ReadonlyArray<string>,
): string {
  const parts = fields.map(f => [f, normalizeReviewValue(row[f])])
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}
