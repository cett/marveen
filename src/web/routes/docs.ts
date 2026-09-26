import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { PROJECT_ROOT } from '../../config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Read-only viewer for the user-facing docs (docs/user-guide, docs/fork-guide),
// serving raw markdown for the dashboard's client-side renderer (renderHelpLinks
// -> web/modules/help.js). Sits under /api/* so it inherits the same bearer-
// token/session auth gate as every other user-facing route -- a logged-in B2B
// tenant user can read the guide without repo access, but it is not a public
// endpoint (see rbac.ts: GET /api/docs -> memories:read, the narrowest
// non-admin permission, same tier as /api/workspace and /api/recall reads).
const DOCS_DIR = join(PROJECT_ROOT, 'docs')

// Allowlist: only the two known guide trees (docs/user-guide, docs/fork-guide),
// each with a hu/en language subdir, one filename deep. user-guide slugs are
// lowercase-numbered (01-overview.md); fork-guide slugs carry an uppercase F
// prefix (F01-installation.md) -- both are covered by the mixed-case class.
// Combined with the resolved-path containment check below (belt-and-
// suspenders), this blocks path traversal (../, absolute paths, encoded
// segments) -- the same two-layer pattern as static.ts's
// MODULE_FILENAME_PATTERN/CSS_FILENAME_PATTERN.
export const DOC_PATH_PATTERN = /^(?:user-guide|fork-guide)\/(?:hu|en)\/[A-Za-z0-9-]+\.md$/

export async function tryHandleDocs(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  const match = path.match(/^\/api\/docs\/(.+)$/)
  if (!match || method !== 'GET') return false

  const rel = decodeURIComponent(match[1])
  if (!DOC_PATH_PATTERN.test(rel)) {
    json(res, { error: 'invalid_value', field: 'path', hint: 'Invalid doc path' }, 400)
    return true
  }

  const file = join(DOCS_DIR, rel)
  const docsRoot = resolve(DOCS_DIR) + sep
  if (!resolve(file).startsWith(docsRoot)) {
    json(res, { error: 'invalid_value', field: 'path', hint: 'Invalid doc path' }, 400)
    return true
  }

  if (!existsSync(file) || !statSync(file).isFile()) {
    json(res, { error: 'not_found' }, 404)
    return true
  }

  const content = readFileSync(file, 'utf-8')
  json(res, { path: rel, content })
  return true
}
