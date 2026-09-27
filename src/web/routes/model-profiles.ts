import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  listModelProfileMap,
  getModelProfileMapEntry,
  setModelProfileMapEntry,
  type ModelProfileMapRow,
} from '../../db.js'
import { isModelProfileId, MODEL_PROFILE_IDS } from '../../model-profiles.js'
import { invalidateModelProfileMapCache } from '../agent-config.js'
import type { RouteContext } from './types.js'

// Wire shape: camelCase profileId/modelId, mirroring the autonomy route's
// toWireCategory (routes/autonomy.ts).
function toWireEntry(row: ModelProfileMapRow) {
  return { profileId: row.profile_id, modelId: row.model_id, updatedAt: row.updated_at, updatedBy: row.updated_by }
}

export async function tryHandleModelProfiles(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (path === '/api/model-profiles' && method === 'GET') {
    try {
      const rows = listModelProfileMap()
      const updated_at = rows.reduce((max, r) => Math.max(max, r.updated_at), 0)
      json(res, { updated_at, profiles: rows.map(toWireEntry) })
    } catch (err) {
      logger.error({ err }, 'Failed to load model profile map')
      json(res, { error: 'internal_error', hint: 'Could not read model profile map' }, 503)
    }
    return true
  }

  if (path === '/api/model-profiles' && (method === 'POST' || method === 'PATCH')) {
    try {
      const body = await readBody(req)
      const { profileId, modelId } = JSON.parse(body.toString())

      if (!isModelProfileId(profileId)) {
        json(res, { error: 'invalid_value', field: 'profileId', hint: `profileId must be one of ${MODEL_PROFILE_IDS.join('|')}` }, 400)
        return true
      }
      if (typeof modelId !== 'string' || !modelId.trim()) {
        json(res, { error: 'invalid_value', field: 'modelId', hint: 'modelId must be a non-empty string' }, 400)
        return true
      }

      const existing = getModelProfileMapEntry(profileId)
      if (!existing) {
        json(res, { error: 'not_found', hint: `Profile "${profileId}" not found` }, 404)
        return true
      }

      setModelProfileMapEntry(profileId, modelId.trim(), 'dashboard')
      invalidateModelProfileMapCache()
      const updated = getModelProfileMapEntry(profileId)
      logger.info({ profileId, modelId: modelId.trim() }, 'Model profile map entry updated')
      json(res, { ok: true, ...toWireEntry(updated as ModelProfileMapRow) })
    } catch (err) {
      logger.error({ err }, 'Failed to update model profile map')
      json(res, { error: 'internal_error', hint: 'Failed to update' }, 500)
    }
    return true
  }

  return false
}
