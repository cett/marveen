// workspace-store.ts — DB helpers for workspace_docs.
//
// App-level vec sync follows the vec_memories pattern (db.ts:2798):
// NO database triggers. Vec operations are fire-and-forget when the extension
// is available; missing extension = silent skip.
//
// Size limits (enforced at the route layer, not here):
//   text   ≤ 2 MB
//   code   ≤ 4 MB
//   binary ≤ 16 MB

import { randomBytes } from 'node:crypto'
import { getDb, generateEmbedding, floatsToBlob } from './db.js'
import { logger } from './logger.js'

export const WORKSPACE_DOC_SIZE_LIMITS: Record<string, number> = {
  text:   2 * 1024 * 1024,
  code:   4 * 1024 * 1024,
  binary: 16 * 1024 * 1024,
}

export type WorkspaceDocType = 'plan' | 'brief' | 'report' | 'notes'
export type WorkspaceContentType = 'text' | 'code' | 'binary'

export interface WorkspaceDoc {
  id: string
  agent_id: string
  tenant_id: string
  doc_key: string | null
  title: string
  content: string | null
  content_type: WorkspaceContentType
  type: WorkspaceDocType
  task_ref: string | null
  size_bytes: number
  last_accessed_at: number | null
  created_at: number
  updated_at: number
}

type DbRow = WorkspaceDoc & { content_blob: Buffer | null; embedding_blob: Buffer | null }

function rowToDoc(r: DbRow): WorkspaceDoc {
  return {
    id: r.id, agent_id: r.agent_id, tenant_id: r.tenant_id,
    doc_key: r.doc_key, title: r.title, content: r.content,
    content_type: r.content_type, type: r.type, task_ref: r.task_ref,
    size_bytes: r.size_bytes, last_accessed_at: r.last_accessed_at,
    created_at: r.created_at, updated_at: r.updated_at,
  }
}

function rowToDocMeta(r: DbRow): WorkspaceDoc {
  return {
    id: r.id, agent_id: r.agent_id, tenant_id: r.tenant_id,
    doc_key: r.doc_key, title: r.title, content: null,
    content_type: r.content_type, type: r.type, task_ref: r.task_ref,
    size_bytes: r.size_bytes, last_accessed_at: r.last_accessed_at,
    created_at: r.created_at, updated_at: r.updated_at,
  }
}

function nanoid12(): string {
  return randomBytes(9).toString('base64url').slice(0, 12)
}

// ── Vec sync helpers (no-op when vec extension not loaded) ───────────────────

let _vecSupported: boolean | null = null

function vecEnabled(): boolean {
  if (_vecSupported !== null) return _vecSupported
  try {
    // Probe: if the virtual table exists, the extension is loaded.
    getDb().prepare("SELECT 1 FROM vec_workspace_docs LIMIT 1").raw(true).all()
    _vecSupported = true
  } catch {
    _vecSupported = false
  }
  return _vecSupported
}

function syncVecDelete(docId: string): void {
  if (!vecEnabled()) return
  try { getDb().prepare('DELETE FROM vec_workspace_docs WHERE doc_id = ?').run(docId) } catch { /* no-op */ }
}

function syncVecUpsert(docId: string, agentId: string, tenantId: string, embeddingBlob: Buffer): void {
  if (!vecEnabled()) return
  try {
    const db = getDb()
    db.prepare('DELETE FROM vec_workspace_docs WHERE doc_id = ?').run(docId)
    db.prepare('INSERT OR IGNORE INTO vec_workspace_docs(doc_id, agent_id, tenant_id, embedding) VALUES(?, ?, ?, ?)')
      .run(docId, agentId, tenantId, embeddingBlob)
  } catch { /* no-op */ }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export interface SaveWorkspaceDocInput {
  agent_id: string
  tenant_id: string
  doc_key?: string | null
  title: string
  content?: string | null
  content_blob?: Buffer | null
  content_type: WorkspaceContentType
  type: WorkspaceDocType
  task_ref?: string | null
  embedding_blob?: Buffer | null
}

export function saveWorkspaceDoc(input: SaveWorkspaceDocInput): WorkspaceDoc {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const content = input.content ?? null
  const contentBlob = input.content_blob ?? null
  const sizeBytes = content
    ? Buffer.byteLength(content, 'utf8')
    : (contentBlob ? contentBlob.byteLength : 0)

  if (input.doc_key) {
    // UPSERT: check if (agent_id, doc_key) already exists
    const existing = db.prepare(
      'SELECT id FROM workspace_docs WHERE agent_id = ? AND doc_key = ?'
    ).get(input.agent_id, input.doc_key) as { id: string } | undefined

    if (existing) {
      db.prepare(`
        UPDATE workspace_docs
        SET title = ?, content = ?, content_blob = ?, content_type = ?, type = ?,
            task_ref = ?, size_bytes = ?, embedding_blob = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.title, content, contentBlob, input.content_type, input.type,
        input.task_ref ?? null, sizeBytes, input.embedding_blob ?? null, now,
        existing.id
      )
      const row = db.prepare('SELECT * FROM workspace_docs WHERE id = ?').get(existing.id) as DbRow
      if (input.embedding_blob && input.content_type !== 'binary') {
        syncVecUpsert(existing.id, input.agent_id, input.tenant_id, input.embedding_blob)
      }
      return rowToDoc(row)
    }
  }

  // INSERT new
  const id = nanoid12()
  db.prepare(`
    INSERT INTO workspace_docs
      (id, agent_id, tenant_id, doc_key, title, content, content_blob, content_type,
       type, task_ref, size_bytes, embedding_blob, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.agent_id, input.tenant_id, input.doc_key ?? null,
    input.title, content, contentBlob, input.content_type,
    input.type, input.task_ref ?? null, sizeBytes,
    input.embedding_blob ?? null, now, now
  )
  const row = db.prepare('SELECT * FROM workspace_docs WHERE id = ?').get(id) as DbRow
  if (input.embedding_blob && input.content_type !== 'binary') {
    syncVecUpsert(id, input.agent_id, input.tenant_id, input.embedding_blob)
  }
  return rowToDoc(row)
}

// Lightweight auth-gate check: returns id/agent_id/tenant_id/content_type/title
// without touching last_accessed_at.  Use this before any ownership/tenant gate.
export function peekWorkspaceDoc(id: string): Pick<WorkspaceDoc, 'id' | 'agent_id' | 'tenant_id' | 'content_type' | 'title'> | null {
  const row = getDb().prepare(
    'SELECT id, agent_id, tenant_id, content_type, title FROM workspace_docs WHERE id = ?'
  ).get(id) as Pick<WorkspaceDoc, 'id' | 'agent_id' | 'tenant_id' | 'content_type' | 'title'> | undefined
  return row ?? null
}

// Freshness probe for callers (context-guard) that only need "when was this
// (agent_id, doc_key) doc last written", polled on a tight interval -- must
// NOT touch last_accessed_at (that's a read-access signal, not a write one).
export function getWorkspaceDocUpdatedAtMs(agentId: string, docKey: string): number | null {
  const row = getDb().prepare(
    'SELECT updated_at FROM workspace_docs WHERE agent_id = ? AND doc_key = ?'
  ).get(agentId, docKey) as { updated_at: number } | undefined
  return row ? row.updated_at * 1000 : null
}

export function getWorkspaceDoc(id: string): WorkspaceDoc | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM workspace_docs WHERE id = ?').get(id) as DbRow | undefined
  if (!row) return null
  const now = Math.floor(Date.now() / 1000)
  db.prepare('UPDATE workspace_docs SET last_accessed_at = ? WHERE id = ?').run(now, id)
  return rowToDoc(row)
}

export function getWorkspaceDocBlob(id: string): Buffer | null {
  const row = getDb().prepare('SELECT content_blob FROM workspace_docs WHERE id = ?').get(id) as { content_blob: Buffer | null } | undefined
  return row?.content_blob ?? null
}

// Escape FTS5 special characters to prevent query-syntax errors on user
// input. Wraps the term in double quotes so it is treated as a phrase, not
// as FTS5 operators -- mirrors artifacts-db.ts's ftsEscape.
function ftsEscape(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

export interface WorkspaceDocSearchResult {
  id: string
  title: string
  agent_id: string
  tenant_id: string
  type: WorkspaceDocType
  task_ref: string | null
  doc_key: string | null
  created_at: number
  updated_at: number
  snippet: string
}

/**
 * Full-text search over workspace_docs (title + content), joined back from
 * the workspace_docs_fts external-content index (migration 0040).
 *
 * Tenant isolation is the critical property here -- kanban 9156e583 exists
 * specifically to bring workspace_docs into memory search, and the explicit
 * requirement is: search is TENANT-scoped, and NO row may cross a
 * tenant boundary, ever. `tenantId` mirrors the GET /api/memories?q
 * `recallTenantId` semantics exactly: `undefined` means "no tenant filter"
 * (admin, no ?tenant= param -- sees every tenant), a string value means
 * "this tenant only" (SQL-level WHERE, not a post-filter). Callers MUST
 * pass `undefined` only for an already-verified admin caller -- see
 * GET /api/memories in web/routes/memories.ts for the one call site.
 */
export function searchWorkspaceDocs(
  q: string,
  opts: { agentId?: string; tenantId?: string; limit: number },
): WorkspaceDocSearchResult[] {
  const conditions: string[] = []
  const params: unknown[] = [ftsEscape(q)]
  if (opts.tenantId !== undefined) { conditions.push('wd.tenant_id = ?'); params.push(opts.tenantId) }
  if (opts.agentId) { conditions.push('wd.agent_id = ?'); params.push(opts.agentId) }
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : ''
  params.push(opts.limit)

  return getDb().prepare(`
    SELECT wd.id, wd.title, wd.agent_id, wd.tenant_id, wd.type,
           wd.task_ref, wd.doc_key, wd.created_at, wd.updated_at,
           snippet(workspace_docs_fts, 1, '[', ']', '...', 15) AS snippet
    FROM workspace_docs_fts
    JOIN workspace_docs wd ON wd.rowid = workspace_docs_fts.rowid
    WHERE workspace_docs_fts MATCH ?
      ${where}
    ORDER BY rank
    LIMIT ?
  `).all(...params) as WorkspaceDocSearchResult[]
}

/**
 * ANN vector search over vec_workspace_docs. Mirrors searchArtifactsByVector
 * (src/db/vector.ts) -- no recency decay, no rerank, those are out of scope
 * here. Candidates are over-fetched (limit*2) so hybridSearchDocs' RRF fusion
 * has enough overlap with FTS results to be meaningful.
 *
 * Same tenant-isolation contract as searchWorkspaceDocs: the ANN hit set is
 * joined back to workspace_docs with the SAME SQL-level tenant/agent WHERE
 * clause, so a vec0 hit can never surface a row outside the caller's scope.
 */
export async function vectorSearchDocs(
  q: string,
  opts: { agentId?: string; tenantId?: string; limit: number },
): Promise<WorkspaceDocSearchResult[]> {
  if (!vecEnabled()) return []
  const queryEmbedding = await generateEmbedding(q).catch(() => null)
  if (!queryEmbedding) return []

  try {
    const queryBlob = floatsToBlob(queryEmbedding)
    const annRows = getDb().prepare(`
      SELECT doc_id, distance
      FROM vec_workspace_docs
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `).all(queryBlob, BigInt(opts.limit * 2)) as { doc_id: string; distance: number }[]

    if (annRows.length === 0) return []

    const conditions: string[] = []
    const ids = annRows.map(r => r.doc_id)
    const params: unknown[] = [...ids]
    if (opts.tenantId !== undefined) { conditions.push('tenant_id = ?'); params.push(opts.tenantId) }
    if (opts.agentId) { conditions.push('agent_id = ?'); params.push(opts.agentId) }
    const where = conditions.length ? `AND ${conditions.join(' AND ')}` : ''
    const placeholders = ids.map(() => '?').join(',')

    const rows = getDb().prepare(`
      SELECT id, title, agent_id, tenant_id, type, task_ref, doc_key,
             created_at, updated_at, content
      FROM workspace_docs
      WHERE id IN (${placeholders}) ${where}
    `).all(...params) as (WorkspaceDocSearchResult & { content: string | null })[]

    const distMap = new Map(annRows.map(r => [r.doc_id, r.distance]))
    return rows
      .map(({ content, ...r }) => ({
        ...r,
        // Plain-text excerpt (no FTS match highlighting available here) so
        // vector-only hits still render something in the UI.
        snippet: content ? content.slice(0, 200) : '',
        score: 1 / (1 + (distMap.get(r.id) ?? Infinity)),
      }))
      .sort((a, b) => b.score - a.score)
      .map(({ score: _score, ...r }) => r)
  } catch (err) {
    logger.debug({ err }, 'vectorSearchDocs: ANN query failed')
    return []
  }
}

/**
 * Hybrid (FTS + vector) search over workspace_docs, fused with Reciprocal
 * Rank Fusion (k=60) -- same constant as memories' hybridSearch. NO graph
 * traversal and NO cross-encoder rerank: both explicitly out of scope for
 * this feature (see card description). Falls back to pure FTS ranking when
 * Ollama/sqlite-vec is unavailable (RRF over a single non-empty list
 * preserves that list's original order).
 */
export async function hybridSearchDocs(
  q: string,
  opts: { agentId?: string; tenantId?: string; limit: number },
): Promise<WorkspaceDocSearchResult[]> {
  const RRF_K = 60
  const overfetch = { ...opts, limit: opts.limit * 2 }

  const ftsResults = searchWorkspaceDocs(q, overfetch)
  const vecResults = await vectorSearchDocs(q, overfetch)

  const scores = new Map<string, number>()
  const byId = new Map<string, WorkspaceDocSearchResult>()

  ftsResults.forEach((d, rank) => {
    scores.set(d.id, (scores.get(d.id) || 0) + 1 / (RRF_K + rank + 1))
    byId.set(d.id, d)
  })
  vecResults.forEach((d, rank) => {
    scores.set(d.id, (scores.get(d.id) || 0) + 1 / (RRF_K + rank + 1))
    // Prefer the FTS entry when both lists hit the same doc -- it carries a
    // real match-highlighted snippet instead of a plain-text excerpt.
    if (!byId.has(d.id)) byId.set(d.id, d)
  })

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.limit)
    .map(([id]) => byId.get(id)!)
}

export interface ListWorkspaceDocsFilter {
  agentId?: string
  tenantId?: string | null
  type?: WorkspaceDocType
  contentType?: WorkspaceContentType
  taskRef?: string
  docKey?: string
  docKeyPrefix?: string
  limit?: number
  metaOnly?: boolean
}

export function listWorkspaceDocs(filter: ListWorkspaceDocsFilter): WorkspaceDoc[] {
  const select = filter.metaOnly
    ? 'SELECT id, agent_id, tenant_id, doc_key, title, content_type, type, task_ref, size_bytes, created_at, updated_at, last_accessed_at'
    : 'SELECT *'
  let sql = `${select} FROM workspace_docs WHERE 1=1`
  const params: unknown[] = []
  if (filter.agentId) { sql += ' AND agent_id = ?'; params.push(filter.agentId) }
  if (filter.tenantId !== null && filter.tenantId !== undefined) {
    sql += ' AND tenant_id = ?'; params.push(filter.tenantId)
  }
  if (filter.type) { sql += ' AND type = ?'; params.push(filter.type) }
  if (filter.contentType) { sql += ' AND content_type = ?'; params.push(filter.contentType) }
  if (filter.taskRef) { sql += ' AND task_ref = ?'; params.push(filter.taskRef) }
  if (filter.docKey) { sql += ' AND doc_key = ?'; params.push(filter.docKey) }
  else if (filter.docKeyPrefix) { sql += ' AND doc_key LIKE ?'; params.push(`${filter.docKeyPrefix}%`) }
  sql += ' ORDER BY updated_at DESC'
  if (filter.limit && filter.limit > 0) { sql += ' LIMIT ?'; params.push(filter.limit) }
  const rows = getDb().prepare(sql).all(...params) as DbRow[]
  return rows.map(r => filter.metaOnly ? rowToDocMeta(r) : rowToDoc(r))
}

export interface PatchWorkspaceDocInput {
  title?: string
  content?: string | null
  content_blob?: Buffer | null
  type?: WorkspaceDocType
  task_ref?: string | null
  embedding_blob?: Buffer | null
}

export function patchWorkspaceDoc(id: string, patch: PatchWorkspaceDocInput): WorkspaceDoc | null {
  const db = getDb()
  const existing = db.prepare('SELECT * FROM workspace_docs WHERE id = ?').get(id) as DbRow | undefined
  if (!existing) return null

  const now = Math.floor(Date.now() / 1000)
  const newContent = 'content' in patch ? patch.content ?? null : existing.content
  const newBlob = 'content_blob' in patch ? patch.content_blob ?? null : existing.content_blob
  const sizeBytes = newContent
    ? Buffer.byteLength(newContent, 'utf8')
    : (newBlob ? newBlob.byteLength : 0)

  db.prepare(`
    UPDATE workspace_docs
    SET title = ?, content = ?, content_blob = ?, type = ?, task_ref = ?,
        size_bytes = ?, embedding_blob = ?, updated_at = ?
    WHERE id = ?
  `).run(
    patch.title ?? existing.title,
    newContent, newBlob,
    patch.type ?? existing.type,
    'task_ref' in patch ? patch.task_ref ?? null : existing.task_ref,
    sizeBytes,
    patch.embedding_blob ?? existing.embedding_blob,
    now, id
  )

  if (patch.embedding_blob && existing.content_type !== 'binary') {
    syncVecUpsert(id, existing.agent_id, existing.tenant_id, patch.embedding_blob)
  }
  const row = db.prepare('SELECT * FROM workspace_docs WHERE id = ?').get(id) as DbRow
  return rowToDoc(row)
}

/**
 * Generate and store a title+content embedding for a workspace doc in
 * vec_workspace_docs. No-op when Ollama is unavailable, the sqlite-vec
 * extension is not loaded, the doc no longer exists, or content_type is
 * 'binary' (mirrors storeArtifactEmbedding's Ollama-free graceful path).
 */
export async function storeWorkspaceDocEmbedding(
  id: string,
  agentId: string,
  tenantId: string,
  text: string,
): Promise<void> {
  if (!text.trim()) return

  const embedding = await generateEmbedding(text).catch(() => null)
  if (!embedding) return

  const existing = getDb().prepare(
    'SELECT content_type FROM workspace_docs WHERE id = ?'
  ).get(id) as { content_type: WorkspaceContentType } | undefined
  if (!existing || existing.content_type === 'binary') return

  const blob = floatsToBlob(embedding)
  getDb().prepare('UPDATE workspace_docs SET embedding_blob = ? WHERE id = ?').run(blob, id)
  syncVecUpsert(id, agentId, tenantId, blob)
}

/**
 * Backfill embeddings for workspace docs saved before this feature existed
 * (or before Ollama was available). Mirrors backfillEmbeddings() in
 * src/db/vector.ts: targets rows with no embedding yet, skips binary
 * content, and sleeps 100ms between rows so as not to overwhelm Ollama.
 */
export async function backfillWorkspaceDocs(): Promise<number> {
  const rows = getDb().prepare(`
    SELECT id, agent_id, tenant_id, title, content FROM workspace_docs
    WHERE embedding_blob IS NULL AND content_type != 'binary' AND content IS NOT NULL
  `).all() as { id: string; agent_id: string; tenant_id: string; title: string; content: string }[]

  let count = 0
  for (const row of rows) {
    const embedding = await generateEmbedding(`${row.title} ${row.content}`).catch(() => null)
    if (embedding) {
      const blob = floatsToBlob(embedding)
      getDb().prepare('UPDATE workspace_docs SET embedding_blob = ? WHERE id = ?').run(blob, row.id)
      syncVecUpsert(row.id, row.agent_id, row.tenant_id, blob)
      count++
    }
    // Small delay to not overwhelm Ollama
    await new Promise(r => setTimeout(r, 100))
  }
  return count
}

export function deleteWorkspaceDoc(id: string): boolean {
  syncVecDelete(id)
  const res = getDb().prepare('DELETE FROM workspace_docs WHERE id = ?').run(id)
  return res.changes > 0
}

// ── TTL sweeper ──────────────────────────────────────────────────────────────
// Deletes docs where:
//   - task_ref IS NULL or the kanban card is 'done'
//   - content_type != 'binary' (binary has separate longer-lived policy)
//   - updated_at older than ttlDays
// Returns count of deleted rows.

export function sweepExpiredWorkspaceDocs(ttlDays: number): number {
  const db = getDb()
  const ttlSeconds = ttlDays * 86400
  const now = Math.floor(Date.now() / 1000)

  // Collect IDs to delete first (so we can clean vec index).
  const toDelete = db.prepare(`
    SELECT wd.id FROM workspace_docs wd
    LEFT JOIN kanban_cards kc ON kc.id = wd.task_ref
    WHERE
      (wd.task_ref IS NULL OR kc.status = 'done')
      AND (? - wd.updated_at) > ?
      AND wd.content_type != 'binary'
  `).all(now, ttlSeconds) as { id: string }[]

  if (!toDelete.length) return 0

  const tx = db.transaction(() => {
    for (const { id } of toDelete) syncVecDelete(id)
    db.prepare(`
      DELETE FROM workspace_docs
      WHERE id IN (
        SELECT wd.id FROM workspace_docs wd
        LEFT JOIN kanban_cards kc ON kc.id = wd.task_ref
        WHERE
          (wd.task_ref IS NULL OR kc.status = 'done')
          AND (? - wd.updated_at) > ?
          AND wd.content_type != 'binary'
      )
    `).run(now, ttlSeconds)
  })
  tx()
  return toDelete.length
}

