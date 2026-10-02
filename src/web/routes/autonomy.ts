import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  listAutonomyCategories, getAutonomyCategory, setAutonomyCategoryLevel, setAutonomyCategoryTimeout, writeAgentAuditLog,
  type AutonomyCategoryRow,
} from '../../db.js'
import { MAX_CATEGORY_TIMEOUT_MINUTES } from '../approval-timeout.js'
import type { RouteContext } from './types.js'

// Wire shape kept identical to the retired JSON side-car so the dashboard
// frontend (web/modules/settings.js) needs no changes: camelCase maxLevel,
// boolean locked. Only the storage moved to autonomy_categories (DB). timeoutMinutes is an addition
// the frontend ignores: how long an approval of the category stays open (null = the 24 h ceiling).
function toWireCategory(row: AutonomyCategoryRow) {
  return {
    key: row.key,
    label: row.label,
    level: row.level,
    locked: row.locked === 1,
    maxLevel: row.max_level,
    timeoutMinutes: row.timeout_minutes,
  }
}

export async function tryHandleAutonomy(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/autonomy' && method === 'GET') {
    try {
      const rows = listAutonomyCategories()
      const updated_at = rows.reduce((max, r) => Math.max(max, r.updated_at), 0)
      json(res, { updated_at, categories: rows.map(toWireCategory) })
    } catch (err) {
      logger.error({ err }, 'Failed to load autonomy categories')
      json(res, { error: 'internal_error', hint: 'Could not read autonomy categories' }, 503)
    }
    return true
  }

  if (path === '/api/autonomy' && method === 'POST') {
    try {
      const body = await readBody(req)
      const parsed = JSON.parse(body.toString()) as { key?: unknown; level?: unknown; timeout_minutes?: unknown }
      const { key, level, timeout_minutes } = parsed
      const hasLevel = level !== undefined
      const hasTimeout = 'timeout_minutes' in parsed

      if (!key || typeof key !== 'string' || (!hasLevel && !hasTimeout) || (hasLevel && (typeof level !== 'number' || level < 1 || level > 3))) {
        json(res, { error: 'invalid_value', hint: 'Invalid key or level (must be 1-3)' }, 400)
        return true
      }

      // timeout_minutes: a whole number of minutes, or null to fall back to the 24 h ceiling. Admin only,
      // checked here as well as by the RBAC table (which only logs in shadow mode).
      if (hasTimeout) {
        if (ctx.role !== 'admin') {
          json(res, { error: 'forbidden', hint: 'Only an admin can change an approval timeout' }, 403)
          return true
        }
        if (timeout_minutes !== null && (!Number.isInteger(timeout_minutes) || (timeout_minutes as number) < 1 || (timeout_minutes as number) > MAX_CATEGORY_TIMEOUT_MINUTES)) {
          json(res, { error: 'invalid_value', field: 'timeout_minutes', hint: `timeout_minutes must be a whole number of minutes from 1 to ${MAX_CATEGORY_TIMEOUT_MINUTES}, or null` }, 400)
          return true
        }
      }

      const cat = getAutonomyCategory(key)
      if (!cat) {
        json(res, { error: 'not_found', hint: `Category "${key}" not found` }, 404)
        return true
      }

      if (hasLevel) {
        if (cat.locked && (level as number) > 1) {
          json(res, { error: 'forbidden', hint: `Category "${key}" is locked at level 1 (safety constraint)` }, 403)
          return true
        }

        if ((level as number) > cat.max_level) {
          json(res, { error: 'invalid_value', field: 'level', hint: `Category "${key}" max level is ${cat.max_level}` }, 400)
          return true
        }
      }

      if (hasLevel) setAutonomyCategoryLevel(key, level as number, 'dashboard')
      if (hasTimeout) {
        setAutonomyCategoryTimeout(key, timeout_minutes as number | null, 'dashboard')
        try {
          writeAgentAuditLog({
            agent_id: ctx.auth?.user ?? ctx.auth?.tokenName ?? 'system',
            entity: 'approval',
            action: 'update',
            entity_id: key,
            detail: { autonomy_category: key, timeout_minutes_from: cat.timeout_minutes, timeout_minutes_to: timeout_minutes },
          })
        } catch { /* audit failure must not abort the write */ }
      }
      const updated = getAutonomyCategory(key)
      logger.info({ key, level: updated?.level, timeout_minutes: updated?.timeout_minutes }, 'Autonomy category updated')
      json(res, { ok: true, key, level: updated?.level ?? level, timeoutMinutes: updated?.timeout_minutes ?? null, updated_at: updated?.updated_at })
    } catch (err) {
      logger.error({ err }, 'Failed to update autonomy config')
      json(res, { error: 'internal_error', hint: 'Failed to update' }, 500)
    }
    return true
  }

  return false
}
