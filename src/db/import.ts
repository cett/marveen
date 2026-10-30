// db/import.ts -- SQL behind the import-memories routes: external file
// sources, their shadow rows in `memories`, the crawl audit log, stats and
// search. tenantId null = every tenant (admin default view).

import { createHash } from 'node:crypto'
import { dbx } from './facade.js'
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
export async function getImportSourceTenantId(id: string): Promise<string | null> {
  const row = await dbx.get<{ tenant_id: string }>("SELECT tenant_id FROM import_sources WHERE id = ?", id)
  return row ? row.tenant_id : null
}

export async function getImportSource(id: string): Promise<ImportSourceRow | undefined> {
  return dbx.get<ImportSourceRow>("SELECT * FROM import_sources WHERE id = ?", id)
}

export async function listImportSources(tenantId: string | null): Promise<ImportSourceRow[]> {
  return tenantId === null
    ? await dbx.all<ImportSourceRow>("SELECT * FROM import_sources ORDER BY created_at ASC")
    : await dbx.all<ImportSourceRow>("SELECT * FROM import_sources WHERE tenant_id = ? ORDER BY created_at ASC", tenantId)
}

export async function insertImportSource(row: {
  id: string; type: string; path: string; label: string | null
  intervalHours: number; enabled: boolean; now: number; tenantId: string
  vaultTokenRef: string | null; confluenceEmail: string | null; baseUrl: string | null
}): Promise<void> {
  await dbx.run(`
      INSERT INTO import_sources (id, type, path, label, interval_hours, enabled, last_run_at, created_at, updated_at, tenant_id, vault_token_ref, confluence_email, base_url)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `, row.id, row.type, row.path, row.label, row.intervalHours, row.enabled ? 1 : 0, row.now, row.now, row.tenantId, row.vaultTokenRef, row.confluenceEmail, row.baseUrl)
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

export async function updateImportSource(id: string, now: number, patch: ImportSourcePatch): Promise<void> {
  const fields: string[] = ['updated_at = ?']
  const values: unknown[] = [now]
  for (const col of IMPORT_SOURCE_PATCH_COLUMNS) {
    if (patch[col] !== undefined) { fields.push(`${col} = ?`); values.push(patch[col]) }
  }
  values.push(id)
  await dbx.run(`UPDATE import_sources SET ${fields.join(', ')} WHERE id = ?`, ...values)
}

async function selectShadowIds(sourceId?: string): Promise<number[]> {
  const rows = sourceId === undefined
    ? await dbx.all('SELECT memory_shadow_id FROM import_memories WHERE memory_shadow_id IS NOT NULL')
    : await dbx.all('SELECT memory_shadow_id FROM import_memories WHERE source_id = ? AND memory_shadow_id IS NOT NULL', sourceId)
  return (rows as { memory_shadow_id: number }[]).map(r => r.memory_shadow_id)
}

// NULL out the FK before the shadow rows go so the constraint is not violated.
async function detachShadowRows(sourceId?: string): Promise<void> {
  if (sourceId === undefined) await dbx.run('UPDATE import_memories SET memory_shadow_id = NULL')
  else await dbx.run('UPDATE import_memories SET memory_shadow_id = NULL WHERE source_id = ?', sourceId)
}

async function deleteShadowMemories(shadowIds: number[]): Promise<void> {
  if (!shadowIds.length) return
  const ph = shadowIds.map(() => '?').join(',')
  await dbx.run(`DELETE FROM memories WHERE id IN (${ph})`, ...shadowIds)
}

// The ANN index (vec0) is written through the raw handle of vector.ts, not through the facade, so it is kept
// OUT of the transaction bodies below: the callers drop the entries once the transaction has committed.
async function dropVecEntries(shadowIds: number[]): Promise<void> {
  for (const id of shadowIds) await syncVecMemoryDelete(id)
}

/** Delete a source and its shadow memories. False when the source was absent
 *  (the shadow rows were already detached by then, as before). One transaction: the select of the shadow
 *  ids, the detach and the deletes were uninterruptible when the module was synchronous. */
export async function deleteImportSource(id: string): Promise<boolean> {
  const shadowIds = await dbx.tx(async () => {
    const ids = await selectShadowIds(id)
    if (ids.length) await detachShadowRows(id)
    const changes = (await dbx.run("DELETE FROM import_sources WHERE id = ?", id)).changes
    if (!changes) return null
    await deleteShadowMemories(ids)
    return ids
  })
  if (!shadowIds) return false
  await dropVecEntries(shadowIds)
  return true
}

/** Wipe the imported memories of one source (or of every source when
 *  sourceId is undefined) together with their shadow rows. Returns the number
 *  of import_memories rows deleted. One transaction, see deleteImportSource. */
export async function wipeImportMemories(sourceId?: string): Promise<number> {
  const { shadowIds, changes } = await dbx.tx(async () => {
    const ids = await selectShadowIds(sourceId)
    if (ids.length) await detachShadowRows(sourceId)
    const deleted = sourceId === undefined
      ? (await dbx.run("DELETE FROM import_memories")).changes
      : (await dbx.run("DELETE FROM import_memories WHERE source_id = ?", sourceId)).changes
    await deleteShadowMemories(ids)
    return { shadowIds: ids, changes: deleted }
  })
  await dropVecEntries(shadowIds)
  return changes
}

export async function listImportAuditLogForSource(sourceId: string): Promise<ImportAuditRow[]> {
  return dbx.all<ImportAuditRow>("SELECT * FROM import_audit_log WHERE source_id = ? ORDER BY run_at DESC LIMIT 20", sourceId)
}

export async function listImportAuditLog(tenantId: string | null): Promise<ImportAuditRow[]> {
  return tenantId === null
    ? await dbx.all<ImportAuditRow>("SELECT ial.* FROM import_audit_log ial JOIN import_sources s ON s.id = ial.source_id ORDER BY ial.run_at DESC LIMIT 50")
    : await dbx.all<ImportAuditRow>("SELECT ial.* FROM import_audit_log ial JOIN import_sources s ON s.id = ial.source_id WHERE s.tenant_id = ? ORDER BY ial.run_at DESC LIMIT 50", tenantId)
}

export async function getImportStats(tenantId: string | null): Promise<{ total: number; bySource: { source_id: string; c: number }[] }> {
  const tc = tenantId === null ? '' : ' AND s.tenant_id = ?'
  const tp = tenantId === null ? [] : [tenantId]
  const total = ((await dbx.get(`SELECT COUNT(*) AS c FROM import_memories im JOIN import_sources s ON s.id = im.source_id WHERE 1=1${tc}`, ...tp)) as { c: number }).c
  const bySource = (await dbx.all(`SELECT im.source_id, COUNT(*) AS c FROM import_memories im JOIN import_sources s ON s.id = im.source_id
       WHERE 1=1${tc} GROUP BY im.source_id`, ...tp)) as { source_id: string; c: number }[]
  return { total, bySource }
}

export async function searchImportMemories(
  query: string,
  tenantId: string | null,
  limit: number,
  offset: number,
): Promise<{ items: unknown[]; total: number }> {
  const tc = tenantId === null ? '' : ' AND s.tenant_id = ?'
  const tp = tenantId === null ? [] : [tenantId]
  const like = `%${query}%`
  const params = [like, like, like, ...tp]
  const items = await dbx.all(`
      SELECT im.id, im.source_id, im.file_path, im.file_name, im.keywords,
             substr(im.content, 1, 300) AS preview, im.created_at, im.updated_at
      FROM import_memories im
      JOIN import_sources s ON s.id = im.source_id
      WHERE (im.content LIKE ? OR im.keywords LIKE ? OR im.file_name LIKE ?)${tc}
      ORDER BY im.updated_at DESC LIMIT ? OFFSET ?
    `, ...params, limit, offset)
  const total = ((await dbx.get(`
      SELECT COUNT(*) AS n
      FROM import_memories im
      JOIN import_sources s ON s.id = im.source_id
      WHERE (im.content LIKE ? OR im.keywords LIKE ? OR im.file_name LIKE ?)${tc}
    `, ...params)) as { n: number }).n
  return { items, total }
}

// ---------------------------------------------------------------------------
// Crawler side: bookkeeping around a crawl run and the per-file upsert.
// ---------------------------------------------------------------------------

/** Total characters stored in import_memories (soft-cap input). */
export async function sumImportContentSize(): Promise<number> {
  const row = (await dbx.get("SELECT SUM(LENGTH(content)) AS s FROM import_memories")) as { s: number | null }
  return row.s ?? 0
}

export async function listEnabledImportSources(): Promise<ImportSourceRow[]> {
  return dbx.all<ImportSourceRow>("SELECT * FROM import_sources WHERE enabled = 1")
}

export async function markImportSourceRun(sourceId: string, runAt: number): Promise<void> {
  await dbx.run("UPDATE import_sources SET last_run_at = ? WHERE id = ?", runAt, sourceId)
}

/** Throws on failure: the crawler wraps it so an audit write never escapes. */
export async function insertImportAuditLog(
  sourceId: string,
  runAt: number,
  counts: {
    scanned: number; added: number; updated: number
    skippedHash: number; skippedSecret: number; skippedSize: number; skippedType: number
  },
  error?: string,
): Promise<void> {
  await dbx.run(`
      INSERT INTO import_audit_log
        (source_id, run_at, files_scanned, files_added, files_updated,
         files_skipped_hash, files_skipped_secret, files_skipped_size, files_skipped_type, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, sourceId, runAt,
    counts.scanned, counts.added, counts.updated,
    counts.skippedHash, counts.skippedSecret, counts.skippedSize, counts.skippedType,
    error ?? null,
  )
}

export async function upsertImportMemory(
  sourceId: string,
  filePath: string,
  fileName: string,
  hash: string,
  content: string,
  keywords: string,
  now: number,
  tenantId: string,
): Promise<'added' | 'updated' | 'hash_match'> {
  // One transaction: the import row and its shadow `memories` row (and the link between them) are written
  // together; a failure half-way leaves no shadow row without its import row. The ANN entry of a shadow row
  // whose text changed is dropped after the commit (vec0 is not on the facade, see dropVecEntries).
  let staleVecId: number | null = null
  const result = await dbx.tx(async (): Promise<'added' | 'updated' | 'hash_match'> => {
    const existing = await dbx.get<{ id: string; content_hash: string; content: string; keywords: string | null; memory_shadow_id: number | null }>("SELECT id, content_hash, content, keywords, memory_shadow_id FROM import_memories WHERE source_id = ? AND file_path = ?", sourceId, filePath)

    if (existing) {
      if (existing.content_hash === hash) {
        await dbx.run("UPDATE import_memories SET last_seen_at = ? WHERE id = ?", now, existing.id)
        return 'hash_match'
      }
      await dbx.run(`
        UPDATE import_memories SET content_hash = ?, content = ?, keywords = ?, last_seen_at = ?, updated_at = ?
        WHERE id = ?
      `, hash, content, keywords, now, now, existing.id)
      if (existing.memory_shadow_id) {
        // Keep shadow row in sync with updated content. The stored embedding was
        // computed from the old text, so drop it (and its ANN entry) when the
        // text it was built from changed; link maintenance / the embedding
        // backfill then re-embed from updated_at. A hash-only change (the raw
        // source differs, the extracted text does not) keeps the embedding.
        const textChanged = existing.content !== content || existing.keywords !== keywords
        if (textChanged) {
          await dbx.run('UPDATE memories SET content = ?, keywords = ?, updated_at = ?, embedding_blob = NULL WHERE id = ?', content, keywords, now, existing.memory_shadow_id)
          staleVecId = existing.memory_shadow_id
        } else {
          await dbx.run('UPDATE memories SET updated_at = ? WHERE id = ?', now, existing.memory_shadow_id)
        }
      } else {
        // Create missing shadow row (defensive: migration backfill covers existing rows).
        // agent_id='import' is the discriminator; category='warm' satisfies the CHECK
        // constraint; chat_id and sector are sentinel values for NOT NULL columns.
        const sr = (await dbx.get(`INSERT INTO memories (agent_id, content, category, keywords, chat_id, sector, created_at, accessed_at, updated_at, tenant_id)
           VALUES ('import', ?, 'warm', ?, 'import', 'semantic', ?, ?, ?, ?) RETURNING id`, content, keywords, now, now, now, tenantId)) as { id: number }
        await dbx.run('UPDATE import_memories SET memory_shadow_id = ? WHERE id = ?', sr.id, existing.id)
      }
      return 'updated'
    }

    const id = createHash('sha256').update(`${sourceId}:${filePath}`).digest('hex').slice(0, 16)
    await dbx.run(`
      INSERT INTO import_memories (id, source_id, file_path, file_name, content_hash, content, keywords, last_seen_at, created_at, updated_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, id, sourceId, filePath, fileName, hash, content, keywords, now, now, now, tenantId)
    // Create shadow row so the main embedding and link pipelines pick this up.
    // agent_id='import' is the discriminator; category='warm' satisfies the CHECK constraint.
    const sr = (await dbx.get(`INSERT INTO memories (agent_id, content, category, keywords, chat_id, sector, created_at, accessed_at, updated_at, tenant_id)
       VALUES ('import', ?, 'warm', ?, 'import', 'semantic', ?, ?, ?, ?) RETURNING id`, content, keywords, now, now, now, tenantId)) as { id: number }
    await dbx.run('UPDATE import_memories SET memory_shadow_id = ? WHERE id = ?', sr.id, id)
    return 'added'
  })
  if (staleVecId !== null) await syncVecMemoryDelete(staleVecId)
  return result
}
