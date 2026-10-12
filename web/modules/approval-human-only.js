// What the Approvals page shows for a human-only request. The server decides such a request only for a
// person logged in to the dashboard with a global admin session (role admin, no tenant); it answers 403
// to every token. These pure helpers decide who the viewer is and which rows would be a dead button for
// them, so the page can mark the row, say how to decide it, and not offer the button. The server stays
// the gate: nothing here grants or checks anything.
//
// The lock applies only while the server enforces the rule (`human_only_enforced` in the status answer).
// With the rule off (advisory) a token may still decide such a request, so the button stays active and
// no banner is shown. A missing or non-true flag reads as "not enforced": an older server does not know
// the field, and a viewer whose status probe failed gets the page as it was before this rule existed.

/** The row is a human-only request (the stored snapshot flag from GET /api/approvals). */
export function isHumanOnlyRow(row) {
  return !!row && Number(row.human_only) === 1
}

/**
 * The viewer can decide a human-only request: a password-login session of a global admin. Anything
 * else (a token, a device key, a tenant-scoped user, no answer from the probe) cannot. An absent
 * `tenant_id` is not read as "global": only an explicit null is.
 */
export function canDecideHumanOnly(status) {
  return !!status
    && status.authenticated === true
    && status.method === 'session'
    && status.role === 'admin'
    && status.tenant_id === null
}

/**
 * The server enforces the human-only rule (the status answer says so). Only an explicit `true` counts:
 * absent (an older server), false, null, a string and a failed probe are all "not enforced".
 */
export function isHumanOnlyEnforced(status) {
  return !!status && status.human_only_enforced === true
}

/**
 * A pending human-only row this viewer cannot decide (it gets no approve/reject button). `enforced` is
 * the server flag (see isHumanOnlyEnforced); anything but `true` means advisory and nothing is locked.
 */
export function isLockedForViewer(row, status, enforced) {
  return enforced === true && !!row && row.status === 'pending' && isHumanOnlyRow(row) && !canDecideHumanOnly(status)
}

/** Show the "sign in to decide" banner: at least one pending human-only row is locked for the viewer. */
export function shouldShowHumanOnlyBanner(rows, status, enforced) {
  return Array.isArray(rows) && rows.some((r) => isLockedForViewer(r, status, enforced))
}
