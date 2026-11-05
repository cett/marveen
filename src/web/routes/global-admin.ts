import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// "Global admin" is one concept with one definition, used wherever an action must not be open to a tenant's admin:
// the browser enrollment code (browser-enroll.ts) and the process-level diagnostic endpoints (db-context,
// rerank-stats, otel-export-status, tenant-gate-status).
//
// Moved here verbatim from browser-enroll.ts so a security condition has no second copy.
//
// A code buys a full admin token, so only a global admin (the shared token, an admin token of the
// default tenant, or a global-admin session) may ask for one. A tenant-scoped admin must not turn
// a code into a default-tenant admin token. 'device' is deliberately absent: a leaked device key
// must not be able to mint further credentials.
//
// Why 'default' counts as global: a bearer token always resolves to a string tenant (api_tokens.tenant_id is
// NOT NULL DEFAULT 'default', and the legacy dashboard token falls back to 'default' in resolveTenantId), so
// requiring tenantId === null would lock out the main agent's token and the operator token. Null can only come
// from a session of a global-admin user. The consequence, by design and as it already was: the admin token of
// the 'default' tenant is global. A viewer with a null tenant is NOT global: the role is checked too.
export function isGlobalAdmin(ctx: RouteContext): boolean {
  const kindOk = ctx.auth?.kind === 'token' || ctx.auth?.kind === 'session'
  const tenantOk = ctx.tenantId === undefined || ctx.tenantId === null || ctx.tenantId === 'default'
  return kindOk && ctx.role === 'admin' && tenantOk
}

/**
 * Gate for a global-admin-only handler. Returns true when the caller may proceed. Otherwise it writes the 403
 * itself and returns false: the handler must then return true (the request is answered) without writing again.
 * Call it AFTER the path and method match, so an unrelated route never gets this 403.
 * Holds in RBAC shadow mode too: the RBAC table still says admin:all, this is the defence in depth behind it.
 */
export function requireGlobalAdmin(ctx: RouteContext): boolean {
  if (isGlobalAdmin(ctx)) return true
  json(ctx.res, { error: 'forbidden', hint: 'Global admin only' }, 403)
  return false
}
