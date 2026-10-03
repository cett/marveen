import { json } from '../http-helpers.js'
import { getDb } from '../../db.js'
import {
  SHADOW_DECISIONS,
  queryShadowLog,
  summarizeShadowLog,
  type ShadowDecision,
  type ShadowLogFilter,
} from '../rbac-shadow-log.js'
import type { RouteContext } from './types.js'

const ROUTE = '/api/rbac/shadow-log'

function badValue(ctx: RouteContext, field: string): true {
  json(ctx.res, { error: 'invalid_value', field, hint: `Invalid "${field}" parameter` }, 400)
  return true
}

/** Strict non-negative integer parse; undefined when the param is absent. NaN when malformed. */
function intParam(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined
  return /^\d+$/.test(raw) ? Number(raw) : NaN
}

/**
 * GET /api/v1/rbac/shadow-log -- admin-only view of the persisted RBAC gate decisions.
 *
 *   ?decision=would-deny|denied|permitted  ?tenant=  ?principal=  ?role=  ?permission=
 *   ?route=<substring>  ?from=<unix s>  ?to=<unix s>  ?since_hours=<n>  ?limit=  ?offset=
 *   ?summary=1   aggregate counts + top denial shapes instead of rows
 *
 * The role check is in the handler on purpose: in shadow mode the gate lets a
 * non-admin through, and this endpoint exposes other callers' activity.
 */
export async function tryHandleRbacShadowLog(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (path !== ROUTE || method !== 'GET') return false

  if (ctx.role !== 'admin') {
    json(res, { error: 'forbidden', hint: 'The RBAC shadow log is admin-only' }, 403)
    return true
  }

  const p = url.searchParams
  const filter: ShadowLogFilter = {}

  const decision = p.get('decision')
  if (decision) {
    if (!SHADOW_DECISIONS.includes(decision as ShadowDecision)) return badValue(ctx, 'decision')
    filter.decision = decision as ShadowDecision
  }
  const tenant = p.get('tenant')
  if (tenant) filter.tenantId = tenant
  const principal = p.get('principal')
  if (principal) filter.principal = principal
  const role = p.get('role')
  if (role) filter.role = role
  const permission = p.get('permission')
  if (permission) filter.permission = permission
  const routeFilter = p.get('route')
  if (routeFilter) filter.route = routeFilter

  const from = intParam(p.get('from'))
  if (Number.isNaN(from)) return badValue(ctx, 'from')
  const to = intParam(p.get('to'))
  if (Number.isNaN(to)) return badValue(ctx, 'to')
  const sinceHours = intParam(p.get('since_hours'))
  if (Number.isNaN(sinceHours)) return badValue(ctx, 'since_hours')
  if (from !== undefined && sinceHours !== undefined) return badValue(ctx, 'since_hours')
  filter.from = sinceHours !== undefined ? Math.floor(Date.now() / 1000) - sinceHours * 3600 : from
  filter.to = to

  const db = getDb()

  const summary = p.get('summary')
  if (summary === '1' || summary === 'true') {
    json(res, summarizeShadowLog(db, { from: filter.from, to: filter.to, tenantId: filter.tenantId }))
    return true
  }

  const limit = intParam(p.get('limit'))
  if (Number.isNaN(limit) || limit === 0) return badValue(ctx, 'limit')
  const offset = intParam(p.get('offset'))
  if (Number.isNaN(offset)) return badValue(ctx, 'offset')
  filter.limit = limit
  filter.offset = offset

  json(res, queryShadowLog(db, filter))
  return true
}
