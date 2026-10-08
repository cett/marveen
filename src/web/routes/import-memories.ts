import { createHash } from 'node:crypto'
import {
  getImportSourceTenantId, getImportSource, listImportSources, insertImportSource, updateImportSource,
  deleteImportSource, wipeImportMemories, listImportAuditLogForSource, listImportAuditLog,
  getImportStats, searchImportMemories,
  type ImportSourcePatch,
} from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { crawlSource } from '../import-crawler.js'
import { VALID_INTERVALS } from '../import-config.js'
import { getSecret } from '../vault.js'
import { parsePagination } from '../utils/pagination.js'
import type { RouteContext } from './types.js'

function genId(): string {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8)
}

const VALID_SOURCE_TYPES = ['local', 'gdrive', 'sharepoint', 'confluence']

// Confluence-only precondition: a source may only be
// created, or (re-)enabled, once its vault_token_ref actually resolves to a
// stored secret. This is enforced here rather than left to the crawler
// because a silently-failing scheduled crawl is much harder to notice than
// an immediate 409 at source-creation time. The email is never checked
// against the vault -- it isn't a secret, see the vault_token_ref/
// confluence_email column comments in migration 0041.
function confluenceTokenMissing(vaultTokenRef: string, tenantId: string): boolean {
  return getSecret(vaultTokenRef, tenantId) === null
}

// Normalises a user-supplied Confluence site URL: trims, strips a trailing
// slash (so the crawler can always append '/wiki/api/v2/...' without a
// double slash), and rejects anything that isn't a well-formed http(s) URL.
// Returns null for empty/invalid input.
function normaliseConfluenceBaseUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  try {
    const u = new URL(trimmed)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  } catch { return null }
  return trimmed
}

export async function tryHandleImportMemories(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // Tenant scope: admin role sees/manages all tenants (bypass); scoped callers
  // are restricted to their own tenant_id. Mirrors the deny-by-default
  // tenant-scoping pattern already used elsewhere in the routes layer.
  const isAdmin = ctx.role === 'admin'
  const tenantParam = isAdmin ? (ctx.url.searchParams.get('tenant') ?? null) : null
  const effectiveTenantId: string = tenantParam ?? (isAdmin ? 'default' : (ctx.tenantId ?? 'default'))

  /** Looks up a source's tenant_id; returns null if the source does not exist. */
  function getSourceTenantId(id: string): string | null {
    return getImportSourceTenantId(id)
  }

  /** Cross-tenant ownership guard for a single source. Writes a 403/404 and
   *  returns true when access should be denied; caller must `return true` in
   *  that case. */
  function denySourceAccess(id: string): boolean {
    const tenantId = getSourceTenantId(id)
    if (tenantId === null) { json(res, { error: 'not_found' }, 404); return true }
    if (!isAdmin && tenantId !== (ctx.tenantId ?? 'default')) {
      json(res, { error: 'forbidden', hint: 'Source belongs to a different tenant' }, 403)
      return true
    }
    return false
  }

  // ── GET /api/import/sources ──────────────────────────────────────────────
  if (path === '/api/import/sources' && method === 'GET') {
    json(res, listImportSources(isAdmin && tenantParam === null ? null : effectiveTenantId))
    return true
  }

  // ── POST /api/import/sources ─────────────────────────────────────────────
  if (path === '/api/import/sources' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      type?: string; path?: string; label?: string; interval_hours?: number; enabled?: boolean; tenant_id?: string
      vault_token_ref?: string; confluence_email?: string; base_url?: string
    }

    if (!data.type || !VALID_SOURCE_TYPES.includes(data.type)) {
      json(res, { error: 'invalid_value', field: 'type', hint: `type must be one of: ${VALID_SOURCE_TYPES.join(', ')}` }, 400); return true
    }
    if (!data.path?.trim()) {
      json(res, { error: 'required', field: 'path', hint: 'path is required' }, 400); return true
    }
    const intervalHours = data.interval_hours ?? 4
    if (!VALID_INTERVALS.has(intervalHours)) {
      json(res, { error: 'invalid_value', field: 'interval_hours', hint: `interval_hours must be one of: ${[...VALID_INTERVALS].join(', ')}` }, 400); return true
    }
    const tenantId = isAdmin ? (data.tenant_id?.trim() || 'default') : (ctx.tenantId ?? 'default')

    const vaultTokenRef = data.vault_token_ref?.trim() || null
    const confluenceEmail = data.confluence_email?.trim() || null
    const baseUrl = normaliseConfluenceBaseUrl(data.base_url)
    if (data.type === 'confluence') {
      if (!vaultTokenRef || !confluenceEmail || !baseUrl) {
        const field = !baseUrl ? 'base_url' : !vaultTokenRef ? 'vault_token_ref' : 'confluence_email'
        json(res, { error: 'required', hint: 'Confluence forráshoz base_url, vault_token_ref és confluence_email kötelező (base_url érvényes http(s) URL kell legyen)', field }, 400); return true
      }
      if (confluenceTokenMissing(vaultTokenRef, tenantId)) {
        json(res, {
          error: 'conflict',
          hint: `A vault_token_ref '${vaultTokenRef}' nem található a vaultban. Előbb vedd fel a tokent a vaultba, majd hozd létre a forrást.`,
          field: 'vault_token_ref',
        }, 409); return true
      }
    }

    const now = Math.floor(Date.now() / 1000)
    const id = genId()
    insertImportSource({
      id, type: data.type, path: data.path.trim(), label: data.label?.trim() || null,
      intervalHours, enabled: data.enabled !== false, now, tenantId, vaultTokenRef, confluenceEmail, baseUrl,
    })

    logger.info({ id, type: data.type, path: data.path, tenantId }, 'Import source created')
    json(res, { ok: true, id })
    return true
  }

  // ── PUT /api/import/sources/:id ──────────────────────────────────────────
  const sourceMatch = path.match(/^\/api\/import\/sources\/([a-zA-Z0-9_-]+)$/)
  if (sourceMatch && method === 'PUT') {
    const id = sourceMatch[1]
    if (denySourceAccess(id)) return true
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      label?: string; interval_hours?: number; enabled?: boolean; path?: string
      vault_token_ref?: string; confluence_email?: string; base_url?: string
    }
    const now = Math.floor(Date.now() / 1000)

    if (data.interval_hours !== undefined && !VALID_INTERVALS.has(data.interval_hours)) {
      json(res, { error: 'invalid_value', field: 'interval_hours', hint: `interval_hours must be one of: ${[...VALID_INTERVALS].join(', ')}` }, 400); return true
    }
    if (data.base_url !== undefined && data.base_url.trim() && !normaliseConfluenceBaseUrl(data.base_url)) {
      json(res, { error: 'invalid_value', field: 'base_url', hint: 'base_url must be a valid http(s) URL' }, 400); return true
    }

    // denySourceAccess above proved the row exists
    const existing = getImportSource(id)!

    // Same token-precondition as creation, re-checked here because enabling
    // (or re-pointing vault_token_ref/base_url on) a Confluence source is
    // another path to a scheduled crawl running with no valid credential.
    // Only runs when the request actually touches enablement or the auth
    // fields -- NOT on every PUT to an already-enabled source (e.g. a bare
    // label rename must not start failing just because a token was rotated
    // out of band since the source was last (re-)enabled).
    const touchesAuthRelevantFields = data.enabled !== undefined || data.vault_token_ref !== undefined || data.confluence_email !== undefined || data.base_url !== undefined
    if (existing.type === 'confluence' && touchesAuthRelevantFields) {
      const effectiveEnabled = data.enabled !== undefined ? data.enabled : existing.enabled === 1
      const effectiveVaultTokenRef = data.vault_token_ref !== undefined ? (data.vault_token_ref?.trim() || null) : existing.vault_token_ref
      const effectiveConfluenceEmail = data.confluence_email !== undefined ? (data.confluence_email?.trim() || null) : existing.confluence_email
      const effectiveBaseUrl = data.base_url !== undefined ? normaliseConfluenceBaseUrl(data.base_url) : existing.base_url
      if (effectiveEnabled) {
        if (!effectiveVaultTokenRef || !effectiveConfluenceEmail || !effectiveBaseUrl) {
          const field = !effectiveBaseUrl ? 'base_url' : !effectiveVaultTokenRef ? 'vault_token_ref' : 'confluence_email'
          json(res, { error: 'required', hint: 'Confluence forráshoz base_url, vault_token_ref és confluence_email kötelező', field }, 400); return true
        }
        if (confluenceTokenMissing(effectiveVaultTokenRef, existing.tenant_id)) {
          json(res, {
            error: 'conflict',
            hint: `A vault_token_ref '${effectiveVaultTokenRef}' nem található a vaultban. Előbb vedd fel a tokent a vaultba, majd engedélyezd a forrást.`,
            field: 'vault_token_ref',
          }, 409); return true
        }
      }
    }

    const patch: ImportSourcePatch = {}
    if (data.label !== undefined) patch.label = data.label?.trim() || null
    if (data.interval_hours !== undefined) patch.interval_hours = data.interval_hours
    if (data.enabled !== undefined) patch.enabled = data.enabled ? 1 : 0
    if (data.path !== undefined) patch.path = data.path.trim()
    if (data.vault_token_ref !== undefined) patch.vault_token_ref = data.vault_token_ref?.trim() || null
    if (data.confluence_email !== undefined) patch.confluence_email = data.confluence_email?.trim() || null
    if (data.base_url !== undefined) patch.base_url = normaliseConfluenceBaseUrl(data.base_url)
    updateImportSource(id, now, patch)
    json(res, { ok: true })
    return true
  }

  // ── DELETE /api/import/sources/:id ──────────────────────────────────────
  if (sourceMatch && method === 'DELETE') {
    const id = sourceMatch[1]
    if (denySourceAccess(id)) return true
    if (!deleteImportSource(id)) { json(res, { error: 'not_found' }, 404); return true }
    json(res, { ok: true })
    return true
  }

  // ── POST /api/import/sources/:id/sync ────────────────────────────────────
  const syncMatch = path.match(/^\/api\/import\/sources\/([a-zA-Z0-9_-]+)\/sync$/)
  if (syncMatch && method === 'POST') {
    const id = syncMatch[1]
    if (denySourceAccess(id)) return true
    // Fire-and-forget; the crawl runs in the background
    crawlSource(id).catch(err => logger.error({ sourceId: id, err }, 'Manual sync error'))
    json(res, { ok: true, queued: true })
    return true
  }

  // ── GET /api/import/sources/:id/log ─────────────────────────────────────
  const logMatch = path.match(/^\/api\/import\/sources\/([a-zA-Z0-9_-]+)\/log$/)
  if (logMatch && method === 'GET') {
    const id = logMatch[1]
    if (denySourceAccess(id)) return true
    json(res, listImportAuditLogForSource(id))
    return true
  }

  // ── GET /api/import/log ──────────────────────────────────────────────────
  if (path === '/api/import/log' && method === 'GET') {
    json(res, listImportAuditLog(isAdmin && tenantParam === null ? null : effectiveTenantId))
    return true
  }

  // ── DELETE /api/import/sources/:id/memories ──────────────────────────────
  const wipeSourceMatch = path.match(/^\/api\/import\/sources\/([a-zA-Z0-9_-]+)\/memories$/)
  if (wipeSourceMatch && method === 'DELETE') {
    const id = wipeSourceMatch[1]
    if (denySourceAccess(id)) return true
    json(res, { ok: true, deleted: wipeImportMemories(id) })
    return true
  }

  // ── DELETE /api/import/memories ──────────────────────────────────────────
  // Global wipe across all tenants -- stays admin-only, unlike the per-source
  // endpoints above which are tenant-scoped.
  if (path === '/api/import/memories' && method === 'DELETE') {
    if (!isAdmin) { json(res, { error: 'forbidden', hint: 'Admin role required' }, 403); return true }
    const changes = wipeImportMemories()
    logger.info({ deleted: changes }, 'Import memories wiped')
    json(res, { ok: true, deleted: changes })
    return true
  }

  // ── GET /api/import/stats ─────────────────────────────────────────────────
  if (path === '/api/import/stats' && method === 'GET') {
    json(res, getImportStats(isAdmin && tenantParam === null ? null : effectiveTenantId))
    return true
  }

  // ── GET /api/import/search ───────────────────────────────────────────────
  if (path === '/api/import/search' && method === 'GET') {
    const { url } = ctx
    const q = url.searchParams.get('q')?.trim() || ''

    const page = parsePagination(url.searchParams, res, { defaultLimit: 25, maxLimit: 100 })
    if (!page) return true
    const { limit, offset } = page

    if (!q) { json(res, { items: [], total: 0, offset, limit }); return true }

    const { items, total } = searchImportMemories(q, isAdmin && tenantParam === null ? null : effectiveTenantId, limit, offset)
    json(res, { items, total, offset, limit })
    return true
  }

  return false
}
