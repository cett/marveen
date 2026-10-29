import { getDbContextStats } from '../../db/context.js'
import { BACKGROUND_JOBS } from '../../db/background-jobs.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

/** The most call sites the answer lists. */
export const DB_CONTEXT_TOP_SITES = 20

// GET /api/admin/db-context - the measurement view of the db context counter (db/context.ts): the monotonic counters
// since the process started, when it started and when its boot phase ended (a measurement window is the difference
// of two answers), the calls by kind (expected = carried a context, unexpected = none after boot, anonymous = a route
// served without a credential), the calls by role and by job, and the top call sites without a context.
// Read-only. Admin-only: named in the RBAC table (src/web/rbac.ts), not left to the unlisted-route fallback.
export async function tryHandleDbContext(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/admin/db-context' || ctx.method !== 'GET') return false
  const stats = getDbContextStats()
  const withContext = stats.total - stats.withoutContext
  json(ctx.res, {
    now: Date.now(),
    startedAt: stats.startedAt,
    bootEndedAt: stats.bootEndedAt,
    booting: stats.booting,
    total: stats.total,
    kinds: {
      expected: withContext - stats.anonymous,
      unexpected: stats.unexpected,
      anonymous: stats.anonymous,
      duringBoot: stats.duringBoot,
    },
    tenantMismatches: stats.tenantMismatches,
    byRole: stats.byRole,
    byJob: stats.byJob,
    sites: stats.sites.slice(0, DB_CONTEXT_TOP_SITES),
    lastCallSite: stats.lastCallSite,
    registeredJobs: Object.keys(BACKGROUND_JOBS).length,
  })
  return true
}
