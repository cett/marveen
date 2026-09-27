import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { listAutonomyCategories, getAutonomyCategory, setAutonomyCategoryLevel, type AutonomyCategoryRow } from '../../db.js'
import type { RouteContext } from './types.js'

// Wire shape kept identical to the retired JSON side-car so the dashboard
// frontend (web/modules/settings.js) needs no changes: camelCase maxLevel,
// boolean locked. Only the storage moved to autonomy_categories (DB).
function toWireCategory(row: AutonomyCategoryRow) {
  return {
    key: row.key,
    label: row.label,
    level: row.level,
    locked: row.locked === 1,
    maxLevel: row.max_level,
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
      const { key, level } = JSON.parse(body.toString())

      if (!key || typeof level !== 'number' || level < 1 || level > 3) {
        json(res, { error: 'invalid_value', hint: 'Invalid key or level (must be 1-3)' }, 400)
        return true
      }

      const cat = getAutonomyCategory(key)
      if (!cat) {
        json(res, { error: 'not_found', hint: `Category "${key}" not found` }, 404)
        return true
      }

      if (cat.locked && level > 1) {
        json(res, { error: 'forbidden', hint: `Category "${key}" is locked at level 1 (safety constraint)` }, 403)
        return true
      }

      if (level > cat.max_level) {
        json(res, { error: 'invalid_value', field: 'level', hint: `Category "${key}" max level is ${cat.max_level}` }, 400)
        return true
      }

      setAutonomyCategoryLevel(key, level, 'dashboard')
      const updated = getAutonomyCategory(key)
      logger.info({ key, level }, 'Autonomy level updated')
      json(res, { ok: true, key, level, updated_at: updated?.updated_at })
    } catch (err) {
      logger.error({ err }, 'Failed to update autonomy config')
      json(res, { error: 'internal_error', hint: 'Failed to update' }, 500)
    }
    return true
  }

  return false
}
