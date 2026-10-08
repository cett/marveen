// db/import.ts -- SQL behind the import-memories routes: external file
// sources, their shadow rows in `memories`, the crawl audit log, stats and
// search. tenantId null = every tenant (admin default view).

import { createHash } from 'node:crypto'
import { db } from './connection.js'
import { syncVecMemoryDelete } from './vector.js'

export type ImportSourceRow = {
  id: string; type: string; path: string; label: string | null
  interval_hours: number; enabled: number; last_run_at: number | null
  created_at: number; updated_at: number; tenant_id: string
  vault_token_ref: string | null; confluence_email: string | null; base_url: string | null
}

export type ImportAuditRow = {
  id: number; source_id: string; run_at: number
  files_scanned: number; files_added: number; files_updated: number
  files_skipped_hash: number; files_skipped_secret: number
  files_skipped_size: number; files_skipped_type: number
  error: string | null; tenant_id: string
}

/** The source's tenant_id, or null when the source does not exist. */
export function getImportSourceTenantId(id: string): string | null {
  const row = db.prepare("SELECT tenant_id FROM import_sources WHERE id = ?").get(id) as { tenant_id: string } | undefined
  return row ? row.tenant_id : null
}

export function getImportSource(id: string): ImportSourceRow | undefined {
  return db.prepare("SELECT * FROM import_sources WHERE id = ?").get(id) as ImportSourceRow | undefined
}

export function listImportSources(tenantId: string | null): ImportSourceRow[] {
  return tenantId === null
    ? db.prepare("SELECT * FROM import_sources ORDER BY created_at ASC").all() as ImportSourceRow[]
    : db.prepare("SELECT * FROM import_sources WHERE tenant_id = ? ORDER BY created_at ASC").all(tenantId) as ImportSourceRow[]
}

export function insertImportSource(row: {
  id: string; type: string; path: string; label: string | null
  intervalHours: number; enabled: boolean; now: number; tenantId: string
  vaultTokenRef: string | null; confluenceEmail: string | null; baseUrl: string | null
}): void {
  db.prepare(`
      INSERT INTO import_sources (id, type, path, label, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id, vault_token_ref, confluence_email, base_url)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.type, row.path, row.label, row.intervalHours, row.enabled ? 1 : 0, row.now, row.now, row.tenantId, row.vaultTokenRef, row.confluenceEmail, row.baseUrl)
}

// Columns a PUT may change. An undefined key is left untouched, null clears.
export type ImportSourcePatch = {
  label?: string | null
  interval_hours?: number
  enabled?: 0 | 1
  path?: string
  vault_token_ref?: string | null
  confluence_email?: string | null
  base_url?: string | null
}

const IMPORT_SOURCE_PATCH_COLUMNS = [
  'label', 'interval_hours', 'enabled', 'path', 'vault_token_ref', 'confluence_email', 'base_url',
] as const

export function updateImportSource(id: string, now: number, patch: ImportSourcePatch): void {
  const fields: string[] = ['updated_at = ?']
  const values: unknown[] = [now]
  for (const col of IMPORT_SOURCE_PATCH_COLUMNS) {
    if (patch[col] !== undefined) { fields.push(`${col} = ?`); values.push(patch[col]) }
  }
  values.push(id)
  db.prepare(`UPDATE import_sources SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

function selectShadowIds(sourceId?: string): number[] {
  const rows = sourceId === undefined
    ? db.prepare('SELECT memory_shadow_id FROM import_memories WHERE memory_shadow_id IS NOT NULL').all()
    : db.prepare('SELECT memory_shadow_id FROM import_memories WHERE source_id = ? AND memory_shadow_id IS NOT NULL').all(sourceId)
  return (rows as { memory_shadow_id: number }[]).map(r => r.memory_shadow_id)
}

// NULL out the FK before the shadow rows go so the constraint is not violated.
function detachShadowRows(sourceId?: string): void {
  if (sourceId === undefined) db.prepare('UPDATE import_memories SET memory_shadow_id = NULL').run()
  else db.prepare('UPDATE import_memories SET memory_shadow_id = NULL WHERE source_id = ?').run(sourceId)
}

function deleteShadowMemories(shadowIds: number[]): void {
  if (!shadowIds.length) return
  const ph = shadowIds.map(() => '?').join(',')
  db.prepare(`DELETE FROM memories WHERE id IN (${ph})`).run(...shadowIds)
  for (const id of shadowIds) syncVecMemoryDelete(id)
}

/** Delete a source and its shadow memories. False when the source was absent
 *  (the shadow rows were already detached by then, as before). */
export function deleteImportSource(id: string): boolean {
  const shadowIds = selectShadowIds(id)
  if (shadowIds.length) detachShadowRows(id)
  const changes = db.prepare("DELETE FROM import_sources WHERE id = ?").run(id).changes
  if (!changes) return false
  deleteShadowMemories(shadowIds)
  return true
}

/** Wipe the imported memories of one source (or of every source when
 *  sourceId is undefined) together with their shadow rows. Returns the number
 *  of import_memories rows deleted. */
export function wipeImportMemories(sourceId?: string): number {
  const shadowIds = selectShadowIds(sourceId)
  if (shadowIds.length) detachShadowRows(sourceId)
  const changes = sourceId === undefined
    ? db.prepare("DELETE FROM import_memories").run().changes
    : db.prepare("DELETE FROM import_memories WHERE source_id = ?").run(sourceId).changes
  deleteShadowMemories(shadowIds)
  return changes
}

export function listImportAuditLogForSource(sourceId: string): ImportAuditRow[] {
  return db.prepare(
    "SELECT * FROM import_audit_log WHERE source_id = ? ORDER BY run_at DESC LIMIT 20"
  ).all(sourceId) as ImportAuditRow[]
}

export function listImportAuditLog(tenantId: string | null): ImportAuditRow[] {
  return tenantId === null
    ? db.prepare(
        "SELECT ial.* FROM import_audit_log ial JOIN import_sources s ON s.id = ial.source_id ORDER BY ial.run_at DESC LIMIT 50"
      ).all() as ImportAuditRow[]
    : db.prepare(
        "SELECT ial.* FROM import_audit_log ial JOIN import_sources s ON s.id = ial.source_id WHERE s.tenant_id = ? ORDER BY ial.run_at DESC LIMIT 50"
      ).all(tenantId) as ImportAuditRow[]
}

export function getImportStats(tenantId: string | null): { total: number; bySource: { source_id: string; c: number }[] } {
  const tc = tenantId === null ? '' : ' AND s.tenant_id = ?'
  const tp = tenantId === null ? [] : [tenantId]
  const total = (db.prepare(
    `SELECT COUNT(*) AS c FROM import_memories im JOIN import_sources s ON s.id = im.source_id WHERE 1=1${tc}`
  ).get(...tp) as { c: number }).c
  const bySource = db.prepare(
    `SELECT im.source_id, COUNT(*) AS c FROM import_memories im JOIN import_sources s ON s.id = im.source_id
       WHERE 1=1${tc} GROUP BY im.source_id`
  ).all(...tp) as { source_id: string; c: number }[]
  return { total, bySource }
}

export function searchImportMemories(
  query: string,
  tenantId: string | null,
  limit: number,
  offset: number,
): { items: unknown[]; total: number } {
  const tc = tenantId === null ? '' : ' AND s.tenant_id = ?'
  const tp = tenantId === null ? [] : [tenantId]
  const like = `%${query}%`
  const params = [like, like, like, ...tp]
  const items = db.prepare(`
      SELECT im.id, im.source_id, im.file_path, im.file_name, im.keywords,
             substr(im.content, 1, 300) AS preview, im.created_at, im.updated_at
      FROM import_memories im
      JOIN import_sources s ON s.id = im.source_id
      WHERE (im.content LIKE ? OR im.keywords LIKE ? OR im.file_name LIKE ?)${tc}
      ORDER BY im.updated_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset)
  const total = (db.prepare(`
      SELECT COUNT(*) AS n
      FROM import_memories im
      JOIN import_sources s ON s.id = im.source_id
      WHERE (im.content LIKE ? OR im.keywords LIKE ? OR im.file_name LIKE ?)${tc}
    `).get(...params) as { n: number }).n
  return { items, total }
}

// ---------------------------------------------------------------------------
// Crawler side: bookkeeping around a crawl run and the per-file upsert.
// ---------------------------------------------------------------------------

/** Total characters stored in import_memories (soft-cap input). */
export function sumImportContentSize(): number {
  const row = db.prepare("SELECT SUM(LENGTH(content)) AS s FROM import_memories").get() as { s: number | null }
  return row.s ?? 0
}

export function listEnabledImportSources(): ImportSourceRow[] {
  return db.prepare("SELECT * FROM import_sources WHERE enabled = 1").all() as ImportSourceRow[]
}

export function markImportSourceRun(sourceId: string, runAt: number): void {
  db.prepare("UPDATE import_sources SET last_run_at = ? WHERE id = ?").run(runAt, sourceId)
}

/** Throws on failure: the crawler wraps it so an audit write never escapes. */
export function insertImportAuditLog(
  sourceId: string,
  runAt: number,
  counts: {
    scanned: number; added: number; updated: number
    skippedHash: number; skippedSecret: number; skippedSize: number; skippedType: number
  },
  error?: string,
): void {
  db.prepare(`
      INSERT INTO import_audit_log
        (source_id, run_at, files_scanned, files_added, files_updated,
         files_skipped_hash, files_skipped_secret, files_skipped_size, files_skipped_type, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
    sourceId, runAt,
    counts.scanned, counts.added, counts.updated,
    counts.skippedHash, counts.skippedSecret, counts.skippedSize, counts.skippedType,
    error ?? null,
  )
}

export function upsertImportMemory(
  sourceId: string,
  filePath: string,
  fileName: string,
  hash: string,
  content: string,
  keywords: string,
  now: number,
  tenantId: string,
): 'added' | 'updated' | 'hash_match' {
  const existing = db.prepare(
    "SELECT id, content_hash, content, keywords, memory_shadow_id FROM import_memories WHERE source_id = ? AND file_path = ?"
  ).get(sourceId, filePath) as { id: string; content_hash: string; content: string; keywords: string | null; memory_shadow_id: number | null } | undefined

  if (existing) {
    if (existing.content_hash === hash) {
      db.prepare("UPDATE import_memories SET last_seen_at = ? WHERE id = ?").run(now, existing.id)
      return 'hash_match'
    }
    db.prepare(`
      UPDATE import_memories SET content_hash = ?, content = ?, keywords = ?, last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `).run(hash, content, keywords, now, now, existing.id)
    if (existing.memory_shadow_id) {
      // Keep shadow row in sync with updated content. The stored embedding was
      // computed from the old text, so drop it (and its ANN entry) when the
      // text it was built from changed; link maintenance / the embedding
      // backfill then re-embed from updated_at. A hash-only change (the raw
      // source differs, the extracted text does not) keeps the embedding.
      const textChanged = existing.content !== content || existing.keywords !== keywords
      if (textChanged) {
        db.prepare('UPDATE memories SET content = ?, keywords = ?, updated_at = ?, embedding_blob = NULL WHERE id = ?')
          .run(content, keywords, now, existing.memory_shadow_id)
        syncVecMemoryDelete(existing.memory_shadow_id)
      } else {
        db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(now, existing.memory_shadow_id)
      }
    } else {
      // Create missing shadow row (defensive: migration backfill covers existing rows).
      // agent_id='import' is the discriminator; category='warm' satisfies the CHECK
      // constraint; chat_id and sector are sentinel values for NOT NULL columns.
      const sr = db.prepare(
        `INSERT INTO memories (agent_id, content, category, keywords, chat_id, sector, created_at, accessed_at, updated_at, tenant_id)
         VALUES ('import', ?, 'warm', ?, 'import', 'semantic', ?, ?, ?, ?) RETURNING id`
      ).get(content, keywords, now, now, now, tenantId) as { id: number }
      db.prepare('UPDATE import_memories SET memory_shadow_id = ? WHERE id = ?').run(sr.id, existing.id)
    }
    return 'updated'
  }

  const id = createHash('sha256').update(`${sourceId}:${filePath}`).digest('hex').slice(0, 16)
  db.prepare(`
    INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, keywords, last_seen_at, created_at, updated_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, sourceId, filePath, fileName, hash, content, keywords, now, now, now, tenantId)
  // Create shadow row so the main embedding and link pipelines pick this up.
  // agent_id='import' is the discriminator; category='warm' satisfies the CHECK constraint.
  const sr = db.prepare(
    `INSERT INTO memories (agent_id, content, category, keywords, chat_id, sector, created_at, accessed_at, updated_at, tenant_id)
     VALUES ('import', ?, 'warm', ?, 'import', 'semantic', ?, ?, ?, ?) RETURNING id`
  ).get(content, keywords, now, now, now, tenantId) as { id: number }
  db.prepare('UPDATE import_memories SET memory_shadow_id = ? WHERE id = ?').run(sr.id, id)
  return 'added'
}
