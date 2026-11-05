import { getOtelExportOverview } from '../otel-push-exporter.js'
import { json } from '../http-helpers.js'
import { requireGlobalAdmin } from './global-admin.js'
import type { RouteContext } from './types.js'

// GET /api/admin/otel-export-status - the state of the OTLP push exporter, seen from outside the exporter: whether the
// export is on and has an endpoint, and for traces, metrics and logs the consecutive failures, the failed and the
// rejected counts, the last error and the last success. The exporter's own failure counters travel over the channel
// that is failing, so a collector that is down shows nowhere else. The endpoint URL and the headers are never in the
// answer (they can carry a credential). Read-only. Admin-only: named in the RBAC table (src/web/rbac.ts), not left to
// the unlisted-route fallback.
export function tryHandleOtelExportStatus(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/admin/otel-export-status' || ctx.method !== 'GET') return Promise.resolve(false)
  // The RBAC gate already refuses a non-admin; this holds in shadow mode too. Global admin only.
  if (!requireGlobalAdmin(ctx)) return Promise.resolve(true)
  json(ctx.res, { now: Date.now(), ...getOtelExportOverview() })
  return Promise.resolve(true)
}
