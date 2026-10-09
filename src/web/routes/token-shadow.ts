import { json } from '../http-helpers.js'
import { queryTokenShadow, totalsByTokenShadowCategory } from '../../db.js'
import { TOKEN_SHADOW_CATEGORIES, TOKEN_SHADOW_ROUTE, windowStartDay } from '../token-shadow.js'
import type { RouteContext } from './types.js'

const DEFAULT_DAYS = 7
const MAX_DAYS = 90
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

function badValue(ctx: RouteContext, field: string): true {
  json(ctx.res, { error: 'invalid_value', field, hint: `Invalid "${field}" parameter` }, 400)
  return true
}

/** Strict positive-integer parse in [1, max]; the default when absent; NaN when malformed. */
function boundedInt(raw: string | null, dflt: number, max: number): number {
  if (raw === null || raw === '') return dflt
  if (!/^\d+$/.test(raw)) return NaN
  const n = Number(raw)
  return n >= 1 && n <= max ? n : NaN
}

/**
 * GET /api/v1/token-shadow -- admin-only view of the Phase T2 token-usage counter.
 *
 *   ?days=1..90 (default 7)  ?category=<one of the categories>  ?caller=<agent id>
 *   ?route=<substring of the route template>  ?limit=1..1000 (default 200)
 *
 * Returns the total hits per category and the counter rows (day, category, method, route template,
 * caller, caller source, client, target, count) for the window, newest day and busiest shape first.
 * The role check is in the handler on purpose: in shadow mode the RBAC gate lets a non-admin
 * through an unmapped route, and the counter reveals which agent did what.
 */
export async function tryHandleTokenShadow(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (path !== TOKEN_SHADOW_ROUTE || method !== 'GET') return false

  if (ctx.role !== 'admin') {
    json(res, { error: 'forbidden', hint: 'The token shadow counter is admin-only' }, 403)
    return true
  }

  const p = url.searchParams
  const days = boundedInt(p.get('days'), DEFAULT_DAYS, MAX_DAYS)
  if (Number.isNaN(days)) return badValue(ctx, 'days')
  const limit = boundedInt(p.get('limit'), DEFAULT_LIMIT, MAX_LIMIT)
  if (Number.isNaN(limit)) return badValue(ctx, 'limit')
  const category = p.get('category') || undefined
  if (category && !(TOKEN_SHADOW_CATEGORIES as readonly string[]).includes(category)) return badValue(ctx, 'category')

  const filter = {
    fromDay: windowStartDay(Math.floor(Date.now() / 1000), days),
    category,
    caller: p.get('caller') || undefined,
    route: p.get('route') || undefined,
  }
  json(res, {
    days,
    from_day: filter.fromDay,
    totals: totalsByTokenShadowCategory(filter),
    rows: queryTokenShadow({ ...filter, limit }),
  })
  return true
}
