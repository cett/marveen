import { listHomoglyphFindings, resolveHomoglyphFinding } from '../../db.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

/**
 * Read side of the homoglyph journal (GATEHOMOGLIFSWEEP816). The triggers on
 * kanban_cards/kanban_comments journal suspicious inserts (writes that bypass
 * the API); this endpoint surfaces them for the periodic sweep. Marking a
 * finding resolved records that someone READ the word and either fixed it by
 * hand or classified it as legitimate content -- the row itself never says
 * which, the fix lives where the text lives.
 */
export async function tryHandleHomoglyphs(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/homoglyphs' && method === 'GET') {
    const includeResolved = url.searchParams.get('all') === '1'
    const rows = listHomoglyphFindings(includeResolved)
    json(res, { findings: rows })
    return true
  }

  const resolveMatch = path.match(/^\/api\/homoglyphs\/(\d+)\/resolve$/)
  if (resolveMatch && method === 'POST') {
    const changed = resolveHomoglyphFinding(Number(resolveMatch[1]))
    json(res, { ok: true, changed })
    return true
  }

  return false
}
