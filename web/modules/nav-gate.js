// Role-based nav gating for the dashboard shell. UX layer only: the server's
// 403 (src/web/rbac.ts + src/web/authz.ts) is the real protection and stays the
// last word. This hides what a role cannot use, so that a non-admin does not
// land on pages whose every request would be refused once RBAC_MODE=enforce.
//
// The permission a page needs is the permission its main API calls need in
// ENDPOINT_PERMISSION_TABLE (unmapped endpoints fall back to admin:all), checked
// per surface by src/__tests__/rbac-nav-gating.test.ts against the real table.
//
// Three mechanisms, all driven by the data below:
//   1. [data-rbac-perm="<permission>"] in index.html: hidden when the role lacks it
//      (the sidebar links, the "once" tab button, the status block on the overview).
//   2. A router guard (isPageAllowed via setPageGuard): a typed hash, a bookmark or
//      an in-app switchPage() to a gated page lands on the overview instead.
//   3. Empty sidebar groups collapse (a group whose links are all hidden by gating).
//
// Never unhides: other code hides nav links on purpose (vault, audit log, admin).

import { getAuthStatus, roleHas } from './rbac-client.js'

/** Page id -> permission its main data calls need. Pages not listed are open to every role. */
export const PAGE_PERMISSIONS = Object.freeze({
  messages: 'admin:all',
  skills: 'admin:all',
  ideas: 'admin:all',
  artifacts: 'admin:all',
  tokenUsage: 'admin:all',
  updates: 'admin:all',
  settings: 'admin:all',
  backups: 'admin:all',
  connectors: 'admin:all',
  import: 'admin:all',
  federation: 'federation:read',
})

/** Tabs inside an otherwise open page whose data calls need more: page -> tab -> permission. */
export const TAB_PERMISSIONS = Object.freeze({
  tasks: Object.freeze({ once: 'admin:all' }), // background tasks: GET /api/background-tasks
  import: Object.freeze({ migrate: 'admin:all' }), // fleet export/import (the page itself is admin-only too)
})

/** The permission the Claude-status block on the overview needs (GET /api/status). */
export const STATUS_BLOCK_PERMISSION = 'admin:all'

// null = not resolved yet (or no session role, e.g. the legacy bearer token):
// roleHas(null, ...) is true, so nothing is hidden before the role is known.
let _role = null

/** Test hook. */
export function setNavRole(role) { _role = role ?? null }

export function permissionForPage(pageId) {
  return Object.prototype.hasOwnProperty.call(PAGE_PERMISSIONS, pageId) ? PAGE_PERMISSIONS[pageId] : null
}

export function isPageAllowed(pageId, role = _role) {
  const perm = permissionForPage(pageId)
  return perm === null || roleHas(role, perm)
}

export function isTabAllowed(pageId, tab, role = _role) {
  const perm = TAB_PERMISSIONS[pageId]?.[tab]
  return perm === undefined || roleHas(role, perm)
}

/**
 * Hide every [data-rbac-perm] element under `root` whose permission `role` lacks, then
 * collapse sidebar groups left with no visible link. Idempotent, never unhides.
 * Returns the number of elements newly hidden.
 */
export function applyRbacAttrGating(root, role = _role) {
  let hidden = 0
  root.querySelectorAll('[data-rbac-perm]').forEach((el) => {
    if (roleHas(role, el.getAttribute('data-rbac-perm'))) return
    if (!el.hidden) hidden++
    el.hidden = true
    el.setAttribute('data-rbac-hidden', '')
  })
  root.querySelectorAll('.sb-group').forEach((group) => {
    const links = Array.from(group.querySelectorAll('.sb-link'))
    const gatedAway = links.some((l) => l.hasAttribute('data-rbac-hidden'))
    if (gatedAway && links.every((l) => l.hidden)) group.hidden = true
  })
  return hidden
}

/**
 * Resolve the session role once, apply the attribute gating and, when the page the user is
 * already on (a deep link opened before the role was known) is not allowed, leave it.
 * `switchPage` is injected so this module has no router dependency.
 */
export async function initNavGating({ doc = document, currentPage, switchPage }) {
  const auth = await getAuthStatus()
  _role = auth?.role ?? null
  applyRbacAttrGating(doc, _role)
  const page = currentPage?.()
  if (page && !isPageAllowed(page, _role)) switchPage('overview')
}
