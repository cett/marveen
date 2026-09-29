// egress_allowlist CRUD (migration 0056, #985/#984) -- the WebFetch
// egress-gate hook's runtime allowlist, previously store/egress-allowlist.json.
//
// GET is the one endpoint that matters most: the egress-gate hook (running
// OUTSIDE this process, see scripts/hooks/egress-gate.mjs) polls it (disk
// -cached ~30s) to build the list it enforces against. That hook authenticates
// with the plain file-token bearer (store/.dashboard-token), which resolves to
// role==='admin' (src/web/authz.ts) -- so an admin GET with no ?tenant filter
// must return the FULL cross-tenant union, because the hook enforces one
// fleet-wide WebFetch policy (the same hook script is wired identically onto
// every agent's settings.json by ensureEgressGate, not one per tenant). The
// tenant_id column exists for dashboard-side visibility/ownership only
// (decision D1, #985 plan doc) -- it does not partition what the hook
// itself enforces.
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import {
  listEgressAllowlistRows, getEgressAllowlistRow, insertEgressAllowlistEntry, deleteEgressAllowlistEntry,
  type EgressAllowlistType,
} from '../../db.js'
import { isPublicFetchHost } from '../agent-scaffold-hooks.js'
import type { RouteContext } from './types.js'

const VALID_TYPES = new Set<EgressAllowlistType>(['domain', 'prefix', 'quarantine_domain'])

// Tenant scope helper for GET, mirroring schedules.ts / costops-budgets.ts:
// - Admin with no ?tenant= sees every tenant's rows.
// - Admin with ?tenant=<id> sees only that tenant.
// - Non-admin is restricted to their own tenant.
function effectiveTenant(ctx: RouteContext): string | null {
  if (ctx.role === 'admin') return ctx.url.searchParams.get('tenant')
  return ctx.tenantId ?? 'default'
}

// SECURITY: writes (POST/DELETE) are admin-only, full stop -- unlike the
// schedules/costops tenant-scoping this was modeled on. The GET a non-admin
// tenant caller would see is scoped to their own tenant.id, but the hook's
// enforcement GET (admin bearer, no ?tenant filter, see the module doc above)
// unions EVERY tenant's rows into one fleet-wide WebFetch policy. A
// tenant-scoped non-admin write would therefore silently expand what every
// OTHER tenant's agents (and the main agent) can fetch -- a privilege
// escalation, not a scoped edit. Until the hook itself enforces per-tenant
// (it does not, and per the module doc above should not, without a much
// bigger change to how the hook resolves which agent/tenant is calling it),
// only admin may mutate this table.
function requireAdmin(ctx: RouteContext): boolean {
  return ctx.role === 'admin'
}

// A prefix is a full URL prefix (scheme + host, e.g. "https://host/path/"),
// not a bare hostname -- the hook's own prefix check (startsWith) only makes
// sense with one. A quarantine_domain / domain entry is a bare hostname,
// validated the same way the reader-template render already does.
function isValidValueForType(value: string, type: EgressAllowlistType): boolean {
  if (type === 'prefix') {
    try {
      const u = new URL(value)
      return (u.protocol === 'http:' || u.protocol === 'https:') && value.endsWith('/')
    } catch {
      return false
    }
  }
  return isPublicFetchHost(value)
}

export async function tryHandleEgressAllowlist(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  if (!path.startsWith('/api/egress-allowlist')) return false

  if (path === '/api/egress-allowlist' && method === 'GET') {
    const tenant = effectiveTenant(ctx)
    const rows = listEgressAllowlistRows(tenant)
    // Reshaped for the hook's own JSON schema (domains/prefixes/quarantine_domains)
    // alongside the raw `rows` the Settings UI table renders.
    const domains = rows.filter((r) => r.type === 'domain').map((r) => r.value)
    const prefixes = rows.filter((r) => r.type === 'prefix').map((r) => r.value)
    const quarantine_domains = rows.filter((r) => r.type === 'quarantine_domain').map((r) => r.value)
    json(res, { rows, domains, prefixes, quarantine_domains })
    return true
  }

  if (path === '/api/egress-allowlist' && method === 'POST') {
    if (!requireAdmin(ctx)) {
      json(res, { error: 'forbidden', hint: 'Egress allowlist writes are admin-only' }, 403)
      return true
    }
    try {
      const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
      const value = typeof body.value === 'string' ? body.value.trim() : ''
      const type = body.type as EgressAllowlistType
      if (!value) {
        json(res, { error: 'required', field: 'value', hint: 'value must be a non-empty string' }, 400)
        return true
      }
      if (!VALID_TYPES.has(type)) {
        json(res, { error: 'invalid_value', field: 'type', hint: `type must be one of: ${[...VALID_TYPES].join(', ')}` }, 400)
        return true
      }
      if (!isValidValueForType(value, type)) {
        json(res, {
          error: 'invalid_value', field: 'value',
          hint: type === 'prefix'
            ? 'prefix must be a full http(s) URL ending in /'
            : 'value must be a public hostname (no IP literal, no localhost, no scheme/port/path)',
        }, 400)
        return true
      }
      const tenantId = typeof body.tenant_id === 'string' && body.tenant_id.trim() ? body.tenant_id.trim() : 'default'
      const addedBy = ctx.auth?.user ?? ctx.auth?.tokenName ?? ctx.agentId ?? 'dashboard'
      insertEgressAllowlistEntry({ value, type, tenant_id: tenantId, added_by: addedBy })
      logger.info({ value, type, tenantId }, 'Egress allowlist entry added')
      json(res, { ok: true }, 201)
    } catch (err) {
      logger.error({ err }, 'Failed to add egress allowlist entry')
      json(res, { error: 'internal_error', hint: 'Failed to add allowlist entry' }, 500)
    }
    return true
  }

  const idMatch = path.match(/^\/api\/egress-allowlist\/(\d+)$/)
  if (idMatch && method === 'DELETE') {
    if (!requireAdmin(ctx)) {
      json(res, { error: 'forbidden', hint: 'Egress allowlist writes are admin-only' }, 403)
      return true
    }
    const id = parseInt(idMatch[1], 10)
    const row = getEgressAllowlistRow(id)
    if (!row) {
      json(res, { error: 'not_found', hint: `Allowlist entry ${id} not found` }, 404)
      return true
    }
    deleteEgressAllowlistEntry(id)
    logger.info({ id, value: row.value }, 'Egress allowlist entry deleted')
    json(res, { ok: true })
    return true
  }

  return false
}
