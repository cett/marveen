// Client-side mirror of src/web/rbac.ts's role -> permission map, for hiding
// or disabling write affordances a session's role cannot use. This is a UX
// layer only -- actual enforcement is server-side (src/web/rbac.ts +
// src/web/authz.ts); RBAC_MODE controls whether the server blocks (currently
// 'shadow' = log-only, see src/config.ts). Keep ROLE_PERMISSIONS in sync with
// rbac.ts by hand -- a mismatch here only affects which controls are shown,
// never what the server actually allows.
//
// Exports:
//   can(permission)              -- true/false for the current session's role
//   getAuthStatus()               -- cached /api/auth/status fetch (shared promise)
//   gate(selector, permission, mode) -- hide/disable matching elements when !can()

/** @typedef {'memories:read'|'memories:write'|'kanban:read'|'kanban:write'|'agents:read'|'messages:write'|'approvals:read'|'approvals:write'|'blackboard:read'|'blackboard:write'|'admin:all'|'federation:read'|'federation:write'} Permission */

const ROLE_PERMISSIONS = {
  admin: new Set([
    'memories:read', 'memories:write', 'kanban:read', 'kanban:write',
    'agents:read', 'messages:write', 'approvals:read', 'approvals:write',
    'blackboard:read', 'blackboard:write', 'admin:all',
    'federation:read', 'federation:write',
  ]),
  agent: new Set([
    'memories:read', 'memories:write', 'kanban:read', 'kanban:write',
    'agents:read', 'messages:write', 'approvals:read',
    'blackboard:read', 'blackboard:write',
    'federation:read', 'federation:write',
  ]),
  read_only: new Set([
    'memories:read', 'kanban:read', 'agents:read', 'blackboard:read',
    'approvals:read', 'approvals:write',
  ]),
  viewer: new Set([
    'memories:read', 'kanban:read', 'agents:read', 'blackboard:read',
    'approvals:read', 'approvals:write',
  ]),
}

let _authPromise = null

/** Cached /api/auth/status fetch, shared across every rbac-client consumer. */
export function getAuthStatus() {
  if (!_authPromise) {
    _authPromise = fetch('/api/auth/status')
      .then(r => r.ok ? r.json() : null)
      .catch(() => null)
  }
  return _authPromise
}

/**
 * True if the current caller's session role grants `permission`.
 *
 * A null role (no session -- either unauthenticated, or the legacy
 * store/.dashboard-token bearer caller) resolves to true, NOT false: the
 * server's own resolveRole() (src/web/authz.ts) defaults the legacy token to
 * 'admin' for every authorization decision it makes, and /api/auth/status
 * deliberately withholds that from API-only callers (see the reverted
 * PR #287 attempt + a5142d81) without changing what the token can actually
 * do. Gating on null here would hide every write control for the primary
 * self-hosted/token-mode operator -- the common case for a solo deployment
 * that has never created a B2B session user. Only an explicit narrower
 * session role (agent/read_only/viewer) restricts the UI.
 */
export async function can(permission) {
  const auth = await getAuthStatus()
  if (!auth || !auth.role) return true
  const perms = ROLE_PERMISSIONS[auth.role]
  return perms ? perms.has(permission) : false
}

/**
 * Hide (default) or disable every element matching `selector` when the
 * current role lacks `permission`. Returns the resolved allowed/denied
 * boolean so callers can branch further (e.g. skip wiring a handler).
 */
export async function gate(selector, permission, mode = 'hide') {
  const allowed = await can(permission)
  if (!allowed) {
    document.querySelectorAll(selector).forEach((el) => {
      if (mode === 'disable') {
        el.disabled = true
        el.setAttribute('data-rbac-disabled', '')
      } else {
        el.hidden = true
      }
    })
  }
  return allowed
}
