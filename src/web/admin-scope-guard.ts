// A bearer token that holds the admin ROLE is not a global admin DATABASE scope.
//
// The main-agent token (and every other admin bearer) resolves to role `admin` in the tenant `default`, so on PostgreSQL its
// request runs as a TENANT context (`runAsRequest`: only a tenant-less admin SESSION gets the unrestricted `admin` context).
// The installation-wide tables (system_config: settings, the model-fallback chain, the terminal-input switch, the federation
// document; dashboard_users of every tenant) are privileged-only under row-level security, so for that context:
//   - a write is refused by the database (42501), which the request handler answers as the generic 403 `forbidden` (or, where a
//     route swallows the error itself, as a 500), and
//   - a read of dashboard_users silently returns ZERO rows: the admin gets `200 {"users": []}`, a false "there are no users".
//
// Decision (owner, 2026-11-27): the main token stays a tenant database role; these operations are done from an admin SESSION.
// This guard only makes the refusal explicit and early: on PostgreSQL, a caller that holds the admin role but runs in a
// non-privileged database context gets `403 {error: 'forbidden', code: 'admin_session_required'}` on exactly the routes below,
// BEFORE the route runs (nothing is validated, nothing is written, nothing is read as empty). It grants nothing and removes
// nothing: the same caller was already refused (or, for the users list, shown an empty list).
//
// Deliberately NOT guarded:
//   - SQLite (no row-level security: the bearer works there, and must keep working),
//   - a caller whose role is not `admin` (the route's own role gate answers it, with the answer it always had),
//   - a tenant-admin SESSION on the users list (its tenant's users are a real answer, not an empty one; see `bearerOnly`),
//   - a privileged database context (a global admin session): it passes untouched.

import { currentDbContext, noteRlsRefusal } from '../db/context.js'
import { dbxDialect } from '../db/facade.js'
import { logger } from '../logger.js'
import { json } from './http-helpers.js'
import { refusalRouteKey } from './rls-refusal-response.js'
import type { RouteContext } from './routes/types.js'

export const ADMIN_SESSION_REQUIRED_CODE = 'admin_session_required'
export const ADMIN_SESSION_REQUIRED_HINT = 'This operation needs a global admin session (dashboard login); the bearer token runs in a tenant database scope that cannot reach it.'

interface AdminScopeRoute {
  method: string
  /** Matched against the normalised path (the `/api/v1` prefix is already stripped). */
  path: RegExp
  /**
   * The route is guarded only for a bearer token (`auth.kind === 'token'`). The users list answers a tenant-admin SESSION with the
   * users of its own tenant, which is a real answer; only a bearer gets the silent empty list.
   */
  bearerOnly?: boolean
}

/**
 * Every route that reaches a privileged-only table (system_config, every tenant's dashboard_users) on behalf of an admin caller.
 * One list, one guard: a new such route is added HERE (and gets a cell in admin-scope-guard.pg.test.ts), not guarded in the route.
 */
export const ADMIN_SCOPE_ROUTES: readonly AdminScopeRoute[] = [
  { method: 'POST', path: /^\/api\/settings$/ },
  { method: 'PUT', path: /^\/api\/model-fallback$/ },
  { method: 'POST', path: /^\/api\/terminal-input$/ },
  { method: 'PUT', path: /^\/api\/federation\/peers$/ },
  { method: 'POST', path: /^\/api\/federation\/peers$/ },
  { method: 'PATCH', path: /^\/api\/federation\/peers\/[^/]+$/ },
  { method: 'DELETE', path: /^\/api\/federation\/peers\/[^/]+$/ },
  { method: 'POST', path: /^\/api\/federation\/peers\/[^/]+\/rotate-inbound-token$/ },
  { method: 'POST', path: /^\/api\/federation\/enabled$/ },
  { method: 'POST', path: /^\/api\/federation\/routing-mode$/ },
  { method: 'POST', path: /^\/api\/federation\/remove$/ },
  { method: 'GET', path: /^\/api\/auth\/users$/, bearerOnly: true },
]

/** The guarded entry a request matches, or undefined. */
export function adminScopeRouteFor(method: string, path: string): AdminScopeRoute | undefined {
  return ADMIN_SCOPE_ROUTES.find((r) => r.method === method && r.path.test(path))
}

/** True when the running database context may read and write the privileged-only tables (a system job or an unrestricted admin). */
function contextIsPrivileged(): boolean {
  const role = currentDbContext()?.role
  return role === 'system' || role === 'admin'
}

/**
 * Answers 403 `admin_session_required` and returns true when the request is an admin-role caller on a guarded route whose
 * database context is not privileged (PostgreSQL only); returns false, writing nothing, in every other case. It must run INSIDE
 * the request's database context (`runAsRequest`), because the decision reads that context, not the credential.
 *
 * The refusal is logged at warn and counted per route in the db-context view (`rlsRefusals`, the same counter a database refusal
 * uses), so the answer does not hide a caller that keeps trying.
 */
export function answerAdminScopeRefusal(ctx: RouteContext): boolean {
  if (dbxDialect() !== 'pg') return false
  if (ctx.role !== 'admin') return false
  const route = adminScopeRouteFor(ctx.method, ctx.path)
  if (!route) return false
  if (route.bearerOnly && ctx.auth?.kind !== 'token') return false
  if (contextIsPrivileged()) return false
  const key = refusalRouteKey(ctx.method, ctx.path)
  noteRlsRefusal(key)
  logger.warn({ event: 'admin-scope-refusal', route: key, kind: ctx.auth?.kind, dbRole: currentDbContext()?.role }, 'admin route refused: the caller runs in a tenant database scope, a global admin session is needed')
  json(ctx.res, { error: 'forbidden', code: ADMIN_SESSION_REQUIRED_CODE, hint: ADMIN_SESSION_REQUIRED_HINT }, 403)
  return true
}

/**
 * The dispatch of a request behind the guard: the one function web.ts calls inside `runAsRequest`, so a cell can run the
 * same composition. `dispatch` runs only when the guard did not answer.
 */
export async function dispatchBehindAdminScopeGuard(ctx: RouteContext, dispatch: () => Promise<boolean>): Promise<boolean> {
  if (answerAdminScopeRefusal(ctx)) return true
  return dispatch()
}
