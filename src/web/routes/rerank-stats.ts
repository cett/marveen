import { getRerankStats } from '../../reranker.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// GET /api/admin/rerank-stats - the cross-encoder rerank counter (reranker.ts): how many reranks were asked for, how
// many ran, and how many fell back to the RRF order (by reason: timeout, queue_full, error, unavailable). Monotonic
// since the process started; a measurement window is the difference of two answers. A fallback is a result of lower
// quality that nobody sees otherwise, so a rate that climbs is the signal to look at the worker or the load.
// Read-only. Admin-only: named in the RBAC table (src/web/rbac.ts), not left to the unlisted-route fallback.
export function tryHandleRerankStats(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/admin/rerank-stats' || ctx.method !== 'GET') return Promise.resolve(false)
  // The RBAC gate already refuses a non-admin; this holds in shadow mode too.
  if (ctx.role !== 'admin') {
    json(ctx.res, { error: 'forbidden', hint: 'Admin only' }, 403)
    return Promise.resolve(true)
  }
  json(ctx.res, { now: Date.now(), ...getRerankStats() })
  return Promise.resolve(true)
}
