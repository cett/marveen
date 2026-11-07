import { json } from '../http-helpers.js'
import { listSenderRouteChecks } from '../../db.js'
import {
  SENDER_ROUTE_AUDIT_DEFAULT_DAYS, SENDER_ROUTE_AUDIT_MAX_DAYS, SENDER_ROUTE_AUDIT_MAX_ROWS, summarizeSenderRouteChecks,
} from '../sender-route-audit.js'
import { requireGlobalAdmin } from './global-admin.js'
import type { RouteContext } from './types.js'

/** Strict integer parse in [1, max]; the default when absent; NaN when malformed. */
function boundedDays(raw: string | null): number {
  if (raw === null || raw === '') return SENDER_ROUTE_AUDIT_DEFAULT_DAYS
  if (!/^\d+$/.test(raw)) return NaN
  const n = Number(raw)
  return n >= 1 && n <= SENDER_ROUTE_AUDIT_MAX_DAYS ? n : NaN
}

// GET /api/admin/sender-route-audit?days=7 - what the sender routing rule decided in the last `days` days (1 to 90,
// default 7), counted from the audit rows, so anyone with admin rights can see in one call how many messages enforce
// mode would refuse and for which sender / recipient pairs, before the mode is switched. Read-only. The answer holds
// counts and the pair shapes only: no message content, no message id, no principal. `since` is the start of the
// window (unix seconds); `truncated` says the window held more than the row limit and the oldest rows are not
// counted. `would_deny` counts every verdict that is not ok (audit mode too), `denied` what enforce actually refused.
// How a message is counted is written in src/web/sender-route-audit.ts. Global admin only: named in the RBAC table
// (src/web/rbac.ts) on both prefixes, and checked here as well.
export async function tryHandleSenderRouteAudit(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/admin/sender-route-audit' || ctx.method !== 'GET') return false
  // The RBAC gate already refuses a non-admin; this holds in shadow mode too.
  if (!requireGlobalAdmin(ctx)) return true
  const days = boundedDays(ctx.url.searchParams.get('days'))
  if (Number.isNaN(days)) {
    json(ctx.res, { error: 'invalid_value', field: 'days', hint: `"days" must be a whole number from 1 to ${SENDER_ROUTE_AUDIT_MAX_DAYS}` }, 400)
    return true
  }
  const since = Math.floor(Date.now() / 1000) - days * 86400
  const { rows, truncated } = await listSenderRouteChecks(since, SENDER_ROUTE_AUDIT_MAX_ROWS)
  json(ctx.res, { days, since, truncated, ...summarizeSenderRouteChecks(rows) })
  return true
}
