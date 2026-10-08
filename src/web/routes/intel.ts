import {
  FACT_STATUSES,
  FOCUS_MODES,
  addFocus,
  addWatch,
  dumpActive,
  initIntelDb,
  logDecision,
  upsertFact,
  type FactStatus,
  type FocusMode,
} from '../../intel-store.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// /api/intel/* - the proactive-intelligence registry (intel-collector writes,
// intel-daily-brief reads). scripts/intel_db.py is a thin client over these
// routes. Not in the RBAC table, so admin-only like the rest of the internal
// fleet plumbing.

type Body = Record<string, unknown>

function isText(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function optionalText(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

async function readJsonBody(ctx: RouteContext): Promise<Body | null> {
  const raw = await readBody(ctx.req)
  try {
    const data = JSON.parse(raw.toString()) as unknown
    if (data !== null && typeof data === 'object' && !Array.isArray(data)) return data as Body
  } catch {
    // fall through
  }
  json(ctx.res, { error: 'parse_error', hint: 'Body must be a JSON object' }, 400)
  return null
}

function bad(ctx: RouteContext, field: string, hint: string): true {
  json(ctx.res, { error: 'invalid_value', field, hint }, 400)
  return true
}

function missing(ctx: RouteContext, fields: string[], body: Body): string | null {
  return fields.find((f) => !isText(body[f])) ?? null
}

export async function tryHandleIntel(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (!path.startsWith('/api/intel/')) return false

  if (path === '/api/intel/init' && method === 'POST') {
    json(res, { ok: true, db_path: initIntelDb() })
    return true
  }

  // GET /api/intel/dump?days=14 - everything the daily brief reads.
  if (path === '/api/intel/dump' && method === 'GET') {
    const raw = url.searchParams.get('days')
    const days = raw === null ? 14 : Number(raw)
    if (!Number.isFinite(days) || days < 0 || days > 3650) return bad(ctx, 'days', 'days must be a number between 0 and 3650')
    json(res, { ...dumpActive(days), db_path: initIntelDb() })
    return true
  }

  if (path === '/api/intel/facts' && method === 'POST') {
    const body = await readJsonBody(ctx)
    if (!body) return true
    const absent = missing(ctx, ['title', 'domain', 'source', 'content'], body)
    if (absent) return bad(ctx, absent, `${absent} is required`)
    const tier = body['source_tier']
    if (tier !== 1 && tier !== 2 && tier !== 3) return bad(ctx, 'source_tier', 'source_tier must be 1, 2 or 3')
    const status = body['status'] ?? 'new'
    if (typeof status !== 'string' || !(FACT_STATUSES as readonly string[]).includes(status)) {
      return bad(ctx, 'status', `status must be one of ${FACT_STATUSES.join(', ')}`)
    }
    const priority = body['priority_score'] ?? 0.5
    if (typeof priority !== 'number' || !Number.isFinite(priority)) return bad(ctx, 'priority_score', 'priority_score must be a number')
    const id = body['id']
    if (id !== undefined && id !== null && !isText(id)) return bad(ctx, 'id', 'id must be a non-empty string when given')
    const result = upsertFact({
      id: typeof id === 'string' ? id : undefined,
      title: body['title'] as string,
      domain: body['domain'] as string,
      source: body['source'] as string,
      source_tier: tier,
      content: body['content'] as string,
      status: status as FactStatus,
      priority_score: priority,
    })
    json(res, { ok: true, ...result })
    return true
  }

  if (path === '/api/intel/watchlist' && method === 'POST') {
    const body = await readJsonBody(ctx)
    if (!body) return true
    const absent = missing(ctx, ['title', 'domain', 'direction'], body)
    if (absent) return bad(ctx, absent, `${absent} is required`)
    json(res, { ok: true, id: addWatch(body['title'] as string, body['domain'] as string, body['direction'] as string, optionalText(body['notes'])) })
    return true
  }

  if (path === '/api/intel/focus' && method === 'POST') {
    const body = await readJsonBody(ctx)
    if (!body) return true
    if (!isText(body['topic'])) return bad(ctx, 'topic', 'topic is required')
    const mode = body['mode'] ?? 'transient'
    if (typeof mode !== 'string' || !(FOCUS_MODES as readonly string[]).includes(mode)) {
      return bad(ctx, 'mode', `mode must be one of ${FOCUS_MODES.join(', ')}`)
    }
    const days = body['days'] ?? null
    if (days !== null && (typeof days !== 'number' || !Number.isFinite(days) || days < 0 || days > 3650)) {
      return bad(ctx, 'days', 'days must be a number between 0 and 3650, or omitted for no expiry')
    }
    json(res, { ok: true, id: addFocus(body['topic'] as string, mode as FocusMode, days, optionalText(body['notes'])) })
    return true
  }

  if (path === '/api/intel/decisions' && method === 'POST') {
    const body = await readJsonBody(ctx)
    if (!body) return true
    const absent = missing(ctx, ['recommendation', 'reasoning'], body)
    if (absent) return bad(ctx, absent, `${absent} is required`)
    json(res, {
      ok: true,
      id: logDecision({
        recommendation: body['recommendation'] as string,
        reasoning: body['reasoning'] as string,
        assumption: optionalText(body['assumption']),
        evidence: optionalText(body['evidence']),
        what_would_falsify: optionalText(body['what_would_falsify']),
        owner_reaction: optionalText(body['owner_reaction']),
        outcome: optionalText(body['outcome']),
      }),
    })
    return true
  }

  return false
}
