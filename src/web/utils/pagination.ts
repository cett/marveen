import type http from 'node:http'
import { json } from '../http-helpers.js'

export interface PaginationParams {
  limit: number
  offset: number
}

export interface PaginationDefaults {
  defaultLimit: number
  maxLimit: number
}

/**
 * Parses and validates ?limit=&offset= for a list endpoint, mirroring the
 * error shape audit-log.ts established first. Writes the 400 response and
 * returns null on an invalid value -- callers must `return true` immediately
 * when this returns null, without writing any further response.
 */
export function parsePagination(
  params: URLSearchParams,
  res: http.ServerResponse,
  defaults: PaginationDefaults
): PaginationParams | null {
  const limitParam = params.get('limit')
  const limit = limitParam ? Math.min(parseInt(limitParam, 10), defaults.maxLimit) : defaults.defaultLimit
  if (isNaN(limit) || limit < 1) {
    json(res, { error: 'invalid_value', field: 'limit', hint: 'Invalid "limit" parameter' }, 400)
    return null
  }

  const offsetParam = params.get('offset')
  const offset = offsetParam ? parseInt(offsetParam, 10) : 0
  if (isNaN(offset) || offset < 0) {
    json(res, { error: 'invalid_value', field: 'offset', hint: 'Invalid "offset" parameter' }, 400)
    return null
  }

  return { limit, offset }
}
