import { getTenantGateStatus } from '../../db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// GET /api/admin/tenant-gate-status - the database-side facts the tenant skill gate rollout report
// (scripts/tenant-gate-rollout-check.py) needs: which gate migrations are applied, the per-agent
// tenant context rows the prompt hook writes, and multi-tenant agents with no channel binding.
// Read-only. Under /api/admin/, so the RBAC prefix rule makes it admin-only.
export async function tryHandleTenantGateStatus(ctx: RouteContext): Promise<boolean> {
  if (ctx.path !== '/api/admin/tenant-gate-status' || ctx.method !== 'GET') return false
  json(ctx.res, getTenantGateStatus())
  return true
}
