// What the Approvals page shows for a human-only request. The server decides such a request only for a
// person logged in to the dashboard with a global admin session (role admin, no tenant); it answers 403
// to every token. These pure helpers decide who the viewer is and which rows would be a dead button for
// them, so the page can mark the row, say how to decide it, and not offer the button. The server stays
// the gate: nothing here grants or checks anything.

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

/** A pending human-only row this viewer cannot decide (it gets no approve/reject button). */
export function isLockedForViewer(row, status) {
  return !!row && row.status === 'pending' && isHumanOnlyRow(row) && !canDecideHumanOnly(status)
}

/** Show the "sign in to decide" banner: at least one pending human-only row is locked for the viewer. */
export function shouldShowHumanOnlyBanner(rows, status) {
  return Array.isArray(rows) && rows.some((r) => isLockedForViewer(r, status))
}
