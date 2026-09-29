// Model-fallback-on-limit config -- lets the dashboard Settings page manage
// the model_fallback_* system_config rows (enable toggle + chain editor +
// revert-after-minutes) through the UI instead of hand-editing the DB or
// calling the API directly with curl. Global, admin-only: this is a
// fleet-wide safety-net policy, not tenant data (same rationale as
// costops-budgets.ts).
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { readModelFallbackConfig, writeModelFallbackConfig } from '../model-fallback-store.js'
import type { ModelFallbackConfig } from '../../model-fallback.js'
import type { RouteContext } from './types.js'

export async function tryHandleModelFallback(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path !== '/api/model-fallback') return false

  if (ctx.role !== 'admin') {
    json(res, { error: 'forbidden', hint: 'Model-fallback config is admin-only' }, 403)
    return true
  }

  if (method === 'GET') {
    json(res, readModelFallbackConfig())
    return true
  }

  if (method === 'PUT') {
    let body: Record<string, unknown>
    try {
      body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    } catch {
      json(res, { error: 'parse_error', hint: 'Invalid JSON body' }, 400)
      return true
    }

    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      json(res, { error: 'invalid_value', field: 'enabled', hint: 'enabled must be a boolean' }, 400)
      return true
    }
    if (body.chain !== undefined) {
      if (!Array.isArray(body.chain) || !body.chain.every((m) => typeof m === 'string' && m.trim().length > 0)) {
        json(res, { error: 'invalid_value', field: 'chain', hint: 'chain must be an array of non-empty strings' }, 400)
        return true
      }
      if (body.chain.length < 2) {
        json(res, { error: 'invalid_value', field: 'chain', hint: 'chain needs at least a primary + one fallback model' }, 400)
        return true
      }
    }
    if (body.revertAfterMinutes !== undefined) {
      const v = body.revertAfterMinutes
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        json(res, { error: 'invalid_value', field: 'revertAfterMinutes', hint: 'revertAfterMinutes must be a positive number' }, 400)
        return true
      }
    }

    const saved = writeModelFallbackConfig(body as Partial<ModelFallbackConfig>)
    logger.info({ enabled: saved.enabled, chainLength: saved.chain.length, revertAfterMinutes: saved.revertAfterMinutes }, 'Model-fallback config updated')
    json(res, saved)
    return true
  }

  return false
}
