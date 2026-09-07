import { createHash } from 'node:crypto'
import { getDb, syncVecMemoryDelete } from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import { crawlSource } from '../import-crawler.js'
import { VALID_INTERVALS } from '../import-config.js'
import type { RouteContext } from './types.js'

function genId(): string {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8)
}

type ImportSource = {
  id: string; type: string; path: string; label: string | null
  interval_hours: number; enabled: number; last_run_at: number | null
  created_at: number; updated_at: number; tenant_id: string
}

type AuditRow = {
  id: number; source_id: string; run_at: number
  files_scanned: number; files_added: number; files_updated: number
  files_skipped_hash: number; files_skipped_secret: number
  files_skipped_size: number; files_skipped_type: number
  error: string | null; tenant_id: string
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
    const row = getDb().prepare("SELECT tenant_id FROM import_sources WHERE id = ?").get(id) as { tenant_id: string } | undefined
    return row ? row.tenant_id : null
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
    const rows = isAdmin && tenantParam === null
      ? getDb().prepare("SELECT * FROM import_sources ORDER BY created_at ASC").all() as ImportSource[]
      : getDb().prepare("SELECT * FROM import_sources WHERE tenant_id = ? ORDER BY created_at ASC").all(effectiveTenantId) as ImportSource[]
    json(res, rows)
    return true
  }

  // ── POST /api/import/sources ─────────────────────────────────────────────
  if (path === '/api/import/sources' && method === 'POST') {
    const body = await readBody(req)
    const data = JSON.parse(body.toString()) as {
      type?: string; path?: string; label?: string; interval_hours?: number; enabled?: boolean; tenant_id?: string
    }

    if (!data.type || !['local', 'gdrive', 'sharepoint'].includes(data.type)) {
      json(res, { error: 'invalid_value', field: 'type', hint: 'type must be local | gdrive | sharepoint' }, 400); return true
    }
    if (!data.path?.trim()) {
      json(res, { error: 'required', field: 'path', hint: 'path is required' }, 400); return true
    }
    const intervalHours = data.interval_hours ?? 4
    if (!VALID_INTERVALS.has(intervalHours)) {
      json(res, { error: 'invalid_value', field: 'interval_hours', hint: `interval_hours must be one of: ${[...VALID_INTERVALS].join(', ')}` }, 400); return true
    }
    const tenantId = isAdmin ? (data.tenant_id?.trim() || 'default') : (ctx.tenantId ?? 'default')

    const now = Math.floor(Date.now() / 1000)
    const id = genId()
    getDb().prepare(`
      INSERT INTO import_sources (id, type, path, label, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(id, data.type, data.path.trim(), data.label?.trim() || null, intervalHours, data.enabled !== false ? 1 : 0, now, now, tenantId)

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
    }
    const now = Math.floor(Date.now() / 1000)
    const db = getDb()

    if (data.interval_hours !== undefined && !VALID_INTERVALS.has(data.interval_hours)) {
      json(res, { error: 'invalid_value', field: 'interval_hours', hint: `interval_hours must be one of: ${[...VALID_INTERVALS].join(', ')}` }, 400); return true
    }

    const fields: string[] = ['updated_at = ?']
    const values: unknown[] = [now]
    if (data.label !== undefined) { fields.push('label = ?'); values.push(data.label?.trim() || null) }
    if (data.interval_hours !== undefined) { fields.push('interval_hours = ?'); values.push(data.interval_hours) }
    if (data.enabled !== undefined) { fields.push('enabled = ?'); values.push(data.enabled ? 1 : 0) }
    if (data.path !== undefined) { fields.push('path = ?'); values.push(data.path.trim()) }
    values.push(id)

    db.prepare(`UPDATE import_sources SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    json(res, { ok: true })
    return true
  }

  // ── DELETE /api/import/sources/:id ──────────────────────────────────────
  if (sourceMatch && method === 'DELETE') {
    const id = sourceMatch[1]
    if (denySourceAccess(id)) return true
    const db = getDb()
    const shadowIds = db.prepare(
      'SELECT memory_shadow_id FROM import_memories WHERE source_id = ? AND memory_shadow_id IS NOT NULL'
    ).all(id) as { memory_shadow_id: number }[]
    // NULL out FK before deleting shadow rows so the FK constraint is not violated.
    if (shadowIds.length) {
      db.prepare('UPDATE import_memories SET memory_shadow_id = NULL WHERE source_id = ?').run(id)
    }
    const changes = db.prepare("DELETE FROM import_sources WHERE id = ?").run(id).changes
    if (!changes) { json(res, { error: 'not_found' }, 404); return true }
    if (shadowIds.length) {
      const ph = shadowIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM memories WHERE id IN (${ph})`).run(...shadowIds.map(r => r.memory_shadow_id))
      for (const r of shadowIds) syncVecMemoryDelete(r.memory_shadow_id)
    }
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
    const rows = getDb().prepare(
      "SELECT * FROM import_audit_log WHERE source_id = ? ORDER BY run_at DESC LIMIT 20"
    ).all(id) as AuditRow[]
    json(res, rows)
    return true
  }

  // ── GET /api/import/log ──────────────────────────────────────────────────
  if (path === '/api/import/log' && method === 'GET') {
    const rows = isAdmin && tenantParam === null
      ? getDb().prepare(
          "SELECT ial.* FROM import_audit_log ial JOIN import_sources s ON s.id = ial.source_id ORDER BY ial.run_at DESC LIMIT 50"
        ).all() as AuditRow[]
      : getDb().prepare(
          "SELECT ial.* FROM import_audit_log ial JOIN import_sources s ON s.id = ial.source_id WHERE s.tenant_id = ? ORDER BY ial.run_at DESC LIMIT 50"
        ).all(effectiveTenantId) as AuditRow[]
    json(res, rows)
    return true
  }

  // ── DELETE /api/import/sources/:id/memories ──────────────────────────────
  const wipeSourceMatch = path.match(/^\/api\/import\/sources\/([a-zA-Z0-9_-]+)\/memories$/)
  if (wipeSourceMatch && method === 'DELETE') {
    const id = wipeSourceMatch[1]
    if (denySourceAccess(id)) return true
    const db = getDb()
    const shadowIds = db.prepare(
      'SELECT memory_shadow_id FROM import_memories WHERE source_id = ? AND memory_shadow_id IS NOT NULL'
    ).all(id) as { memory_shadow_id: number }[]
    if (shadowIds.length) {
      db.prepare('UPDATE import_memories SET memory_shadow_id = NULL WHERE source_id = ?').run(id)
    }
    const changes = db.prepare("DELETE FROM import_memories WHERE source_id = ?").run(id).changes
    if (shadowIds.length) {
      const ph = shadowIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM memories WHERE id IN (${ph})`).run(...shadowIds.map(r => r.memory_shadow_id))
      for (const r of shadowIds) syncVecMemoryDelete(r.memory_shadow_id)
    }
    json(res, { ok: true, deleted: changes })
    return true
  }

  // ── DELETE /api/import/memories ──────────────────────────────────────────
  // Global wipe across all tenants -- stays admin-only, unlike the per-source
  // endpoints above which are tenant-scoped.
  if (path === '/api/import/memories' && method === 'DELETE') {
    if (!isAdmin) { json(res, { error: 'forbidden', hint: 'Admin role required' }, 403); return true }
    const db = getDb()
    const shadowIds = db.prepare(
      'SELECT memory_shadow_id FROM import_memories WHERE memory_shadow_id IS NOT NULL'
    ).all() as { memory_shadow_id: number }[]
    if (shadowIds.length) {
      db.prepare('UPDATE import_memories SET memory_shadow_id = NULL').run()
    }
    const changes = db.prepare("DELETE FROM import_memories").run().changes
    if (shadowIds.length) {
      const ph = shadowIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM memories WHERE id IN (${ph})`).run(...shadowIds.map(r => r.memory_shadow_id))
      for (const r of shadowIds) syncVecMemoryDelete(r.memory_shadow_id)
    }
    logger.info({ deleted: changes }, 'Import memories wiped')
    json(res, { ok: true, deleted: changes })
    return true
  }

  // ── GET /api/import/stats ─────────────────────────────────────────────────
  if (path === '/api/import/stats' && method === 'GET') {
    const db = getDb()
    const statsTc = isAdmin && tenantParam === null ? '' : ' AND s.tenant_id = ?'
    const statsTp = isAdmin && tenantParam === null ? [] : [effectiveTenantId]
    const total = (db.prepare(
      `SELECT COUNT(*) AS c FROM import_memories im JOIN import_sources s ON s.id = im.source_id WHERE 1=1${statsTc}`
    ).get(...statsTp) as { c: number }).c
    const bySource = db.prepare(
      `SELECT im.source_id, COUNT(*) AS c FROM import_memories im JOIN import_sources s ON s.id = im.source_id
       WHERE 1=1${statsTc} GROUP BY im.source_id`
    ).all(...statsTp) as { source_id: string; c: number }[]
    json(res, { total, bySource })
    return true
  }

  // ── GET /api/import/search ───────────────────────────────────────────────
  if (path === '/api/import/search' && method === 'GET') {
    const { url } = ctx
    const q = url.searchParams.get('q')?.trim() || ''
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
    if (!q) { json(res, []); return true }

    const searchTc = isAdmin && tenantParam === null ? '' : ' AND s.tenant_id = ?'
    const searchTp = isAdmin && tenantParam === null ? [] : [effectiveTenantId]
    const rows = getDb().prepare(`
      SELECT im.id, im.source_id, im.file_path, im.file_name, im.keywords,
             substr(im.content, 1, 300) AS preview, im.created_at, im.updated_at
      FROM import_memories im
      JOIN import_sources s ON s.id = im.source_id
      WHERE (im.content LIKE ? OR im.keywords LIKE ? OR im.file_name LIKE ?)${searchTc}
      ORDER BY im.updated_at DESC LIMIT ?
    `).all(`%${q}%`, `%${q}%`, `%${q}%`, ...searchTp, limit)
    json(res, rows)
    return true
  }

  return false
}
