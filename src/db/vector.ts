// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { OLLAMA_URL } from '../config.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { logger } from '../logger.js'
import { TOOL_TIMEOUTS } from '../tool-timeouts.js'
import { rerank } from '../reranker.js'
import { stripMarkup } from '../web/import-utils.js'
import { db, tryLoadVecExtension, vecExtensionLoaded } from './connection.js'
import { Memory, reRankByRecency, searchAgentMemories } from './memory.js'
import { Tenant } from './observability.js'
import { ArtifactPointer } from './sessions.js'

const EMBED_MODEL = 'nomic-embed-text'

// Encode a float32 array as a little-endian binary buffer (4 bytes per value).
export function floatsToBlob(floats: number[]): Buffer {
  const buf = Buffer.allocUnsafe(floats.length * 4)
  for (let i = 0; i < floats.length; i++) buf.writeFloatLE(floats[i], i * 4)
  return buf
}

// Decode a Float32 BLOB back to a number array.
function blobToFloats(blob: Buffer): number[] {
  const count = blob.byteLength >>> 2
  const out = new Array<number>(count)
  for (let i = 0; i < count; i++) out[i] = blob.readFloatLE(i * 4)
  return out
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const resp = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(TOOL_TIMEOUTS['ollama-embedding']),
    })
    const data = await resp.json() as { embedding?: number[] }
    return data.embedding || null
  } catch (err) {
    // Debug-level so it doesn't spam default INFO logs when Ollama isn't
    // running (the common case on most user machines). Enables "why does
    // hybrid search only return FTS results?" diagnostics without noise.
    logger.debug({ err, ollamaUrl: OLLAMA_URL }, 'Embedding generation failed (Ollama not running?)')
    return null
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// Over-fetch factor for cross-encoder reranking: retrieve N*RERANK_FACTOR
// candidates from ANN/cosine, then let the reranker pick the best N.
const RERANK_FACTOR = 5

// Recency decay for vector search: score = base * exp(-lambda * age_days).
// Half-life = ln(2)/0.02 ≈ 35 days. Distinct from the FTS reRankByRecency
// blend (which operates on BM25 rank, not cosine/ANN scores) -- no overlap.
const VECTOR_RECENCY_LAMBDA = 0.02

function vectorRecencyDecay(createdAt: number, nowSec: number): number {
  const ageDays = (nowSec - createdAt) / 86400
  return Math.exp(-VECTOR_RECENCY_LAMBDA * ageDays)
}

async function vectorSearch(
  agentId: string,
  queryEmbedding: number[],
  limit: number = 10,
  crossAgent: boolean = false,
  tenantId?: string
): Promise<Memory[]> {
  let candidates: Memory[] = []
  const nowSec = Math.floor(Date.now() / 1000)
  // Tenant clause applied to non-crossAgent paths only. crossAgent is the
  // graph link-building path (linkToNeighbors) which intentionally crosses
  // agent and tenant boundaries to build the structural knowledge graph.
  const tc = (!crossAgent && tenantId) ? ' AND tenant_id = ?' : ''
  const tp = (!crossAgent && tenantId) ? [tenantId] : []

  // crossAgent skips ANN entirely: the vec_memories index may have orphan rows
  // (entries whose backing memories row was deleted or never backfilled), so an
  // ANN hit set is unreliable for cross-fleet searches. BLOB full-scan is the
  // safe path because it reads directly from the source of truth.
  if (vecExtensionLoaded && !crossAgent) {
    try {
      // ANN path: over-fetch by RERANK_FACTOR to give the reranker headroom.
      const queryBlob = floatsToBlob(queryEmbedding)
      // k must be SQLITE_INTEGER; JS numbers bind as SQLITE_FLOAT in better-sqlite3.
      const annRows = db.prepare(`
        SELECT memory_id, distance
        FROM vec_memories
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `).all(queryBlob, BigInt(limit * RERANK_FACTOR)) as { memory_id: number; distance: number }[]

      if (annRows.length > 0) {
        const ids = annRows.map(r => r.memory_id)
        const placeholders = ids.map(() => '?').join(',')
        const memories = db.prepare(
          `SELECT * FROM memories WHERE id IN (${placeholders}) AND (agent_id = ? OR category = 'shared')${tc}`
        ).all([...ids, agentId, ...tp]) as Memory[]

        const distMap = new Map(annRows.map(r => [r.memory_id, r.distance]))
        // Pipeline step 2: recency boost -- reorder by (proximity * decay) so
        // the cross-encoder sees fresher candidates first within the same
        // similarity tier. Uses 1/(1+distance) as an ANN proximity proxy.
        memories.sort((a, b) => {
          const sA = (1 / (1 + (distMap.get(a.id) ?? Infinity))) * vectorRecencyDecay(a.created_at, nowSec)
          const sB = (1 / (1 + (distMap.get(b.id) ?? Infinity))) * vectorRecencyDecay(b.created_at, nowSec)
          return sB - sA
        })
        candidates = memories
      }
    } catch (err) {
      logger.debug({ err }, 'ANN search failed, falling back to BLOB cosine similarity')
    }
  }

  if (candidates.length === 0) {
    // BLOB cosine fallback: full-scan. Recall ranks by cosine * recency decay;
    // crossAgent (link-building) ranks by pure cosine -- see the scoring note below.
    // crossAgent: skip agent_id/shared filter (same reason as ANN path above).
    const rows = crossAgent
      ? (db.prepare("SELECT * FROM memories WHERE embedding_blob IS NOT NULL OR embedding IS NOT NULL").all() as Memory[])
      : (db.prepare(`SELECT * FROM memories WHERE (embedding_blob IS NOT NULL OR embedding IS NOT NULL) AND (agent_id = ? OR category = 'shared')${tc}`).all(agentId, ...tp) as Memory[])

    const scored = rows.map(m => {
      try {
        const emb: number[] = m.embedding_blob
          ? blobToFloats(m.embedding_blob as Buffer)
          : JSON.parse(m.embedding!) as number[]
        const sim = cosineSimilarity(queryEmbedding, emb)
        // crossAgent is the graph link-building path (linkToNeighbors): rank by
        // pure similarity. The recency decay is a recall-time bias meant to
        // surface fresh memories in search; applying it here suppresses older
        // but genuinely-similar neighbors, which is exactly wrong when wiring the
        // structural graph. Symptom it fixes: a batch of freshly imported docs
        // (decay ~1.0) crowds every neighbor slot with other fresh imports, so
        // established agent memories (decay <1) never get linked even when their
        // cosine is well above the threshold -- imports end up connected only to
        // each other. Recall (crossAgent=false) keeps the recency weighting.
        return { memory: m, score: crossAgent ? sim : sim * vectorRecencyDecay(m.created_at, nowSec) }
      } catch {
        return { memory: m, score: 0 }
      }
    })

    scored.sort((a, b) => b.score - a.score)
    candidates = scored.slice(0, limit * RERANK_FACTOR).map(s => s.memory)
  }

  return candidates.slice(0, limit)
}

// Decay applied to 1-hop neighbor scores added during graph traversal.
// Keeps linked memories visible without letting them outrank direct hits.
const LINK_TRAVERSAL_DECAY = 0.5

export async function hybridSearch(agentId: string, query: string, limit: number = 10, tenantId?: string): Promise<Memory[]> {
  const k = 60 // RRF constant

  // FTS5 results
  const ftsResults = searchAgentMemories(agentId, query, limit * 2, tenantId)

  // Vector results
  const queryEmbedding = await generateEmbedding(query)
  const vecResults = queryEmbedding ? await vectorSearch(agentId, queryEmbedding, limit * 2, false, tenantId) : []

  // Reciprocal Rank Fusion
  const scores: Map<number, number> = new Map()
  const byId: Map<number, Memory> = new Map()

  ftsResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) || 0) + 1 / (k + rank + 1))
    byId.set(m.id, m)
  })

  vecResults.forEach((m, rank) => {
    scores.set(m.id, (scores.get(m.id) || 0) + 1 / (k + rank + 1))
    byId.set(m.id, m)
  })

  // 1-hop graph traversal: expand the top-ranked hits by their linked neighbors.
  // Neighbors receive a decayed fraction of the source memory's RRF score so
  // they surface as contextual context without displacing direct hits.
  const topIds = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id)
  for (const srcId of topIds) {
    const srcScore = scores.get(srcId) ?? 0
    const neighbors = getMemoryNeighbors(srcId, 5)
    for (const { memory, weight } of neighbors) {
      if (byId.has(memory.id)) continue  // already in result set, don't double-add
      const neighborScore = srcScore * weight * LINK_TRAVERSAL_DECAY
      scores.set(memory.id, (scores.get(memory.id) || 0) + neighborScore)
      byId.set(memory.id, memory)
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1])

  // Pipeline step 3: cross-encoder reranker applied to the fused RRF list so
  // the final order seen by callers reflects semantic relevance, not just
  // BM25+cosine rank fusion. Only when flag is ON (default OFF).
  if (getEffectiveSettingValue('MEMORY_RERANK_ENABLED') === '1') {
    const fusedList = ranked.slice(0, limit * RERANK_FACTOR).map(([id]) => byId.get(id)!)
    if (fusedList.length > 0) {
      try {
        return await rerank(query, fusedList, { topK: limit })
      } catch (err) {
        logger.debug({ err }, 'hybridSearch: reranker threw unexpectedly, returning RRF order')
        return fusedList.slice(0, limit)
      }
    }
  }

  return ranked.slice(0, limit).map(([id]) => byId.get(id)!)
}

export async function backfillEmbeddings(): Promise<number> {
  const rows = db.prepare('SELECT id, content, keywords FROM memories WHERE embedding_blob IS NULL').all() as { id: number; content: string; keywords: string | null }[]
  let count = 0
  for (const row of rows) {
    const text = row.content + (row.keywords ? ' ' + row.keywords : '')
    const emb = await generateEmbedding(text)
    if (emb) {
      const blob = floatsToBlob(emb)
      db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(blob, row.id)
      syncVecMemoryEmbeddingUpdate(row.id, blob)
      count++
    }
    // Small delay to not overwhelm Ollama
    await new Promise(r => setTimeout(r, 100))
  }
  return count
}

// ── Import shadow row backfill ────────────────────────────────────────────────

// Creates shadow rows in `memories` for any `import_memories` entry that lacks
// one (memory_shadow_id IS NULL).  Called after initVecSupport() so that vec0
// is loaded when the application-level vec sync (syncVecMemoryEmbeddingUpdate)
// runs during embedding backfill.
export async function backfillImportShadowRows(): Promise<number> {
  type ImportRow = { id: string; content: string; keywords: string | null; updated_at: number }
  const pending = db
    .prepare('SELECT id, content, keywords, updated_at FROM import_memories WHERE memory_shadow_id IS NULL')
    .all() as ImportRow[]
  if (pending.length === 0) return 0

  for (const row of pending) {
    const result = db
      .prepare(
        `INSERT INTO memories (agent_id, content, category, keywords, chat_id, sector, created_at, accessed_at, updated_at)
         VALUES ('import', ?, 'warm', ?, 'import', 'semantic', ?, ?, ?) RETURNING id`,
      )
      .get(row.content, row.keywords, row.updated_at, row.updated_at, row.updated_at) as { id: number }
    db.prepare('UPDATE import_memories SET memory_shadow_id = ? WHERE id = ?').run(result.id, row.id)
  }

  logger.info({ count: pending.length }, 'Backfilled import shadow rows')

  // Strip raw HTML/markup from any previously-crawled HTML import rows.
  // New crawls already strip via import-crawler.ts; this one-time pass cleans
  // rows ingested before that fix.  Runs here (after initVecSupport) so that
  // vec0 is loaded when the application-level vec sync runs on the
  // embedding_blob UPDATE inside the loop below.
  type HtmlImportRow = { import_id: string; content: string; shadow_id: number }
  const htmlRows = db
    .prepare(
      `SELECT im.id AS import_id, im.content, m.id AS shadow_id
       FROM import_memories im
       JOIN memories m ON m.id = im.memory_shadow_id
       WHERE (im.file_name LIKE '%.html' OR im.file_name LIKE '%.htm'
           OR im.file_name LIKE '%.xml'  OR im.file_name LIKE '%.svg')
         AND im.content LIKE '<%'`,
    )
    .all() as HtmlImportRow[]

  if (htmlRows.length > 0) {
    for (const row of htmlRows) {
      const stripped = stripMarkup(row.content)
      db.prepare('UPDATE import_memories SET content = ? WHERE id = ?').run(stripped, row.import_id)
      db.prepare('UPDATE memories SET content = ?, embedding_blob = NULL WHERE id = ?').run(stripped, row.shadow_id)
    }
    logger.info({ count: htmlRows.length }, 'Stripped HTML markup from existing import shadow rows')
  }

  void runLinkMaintenance({ maxAge: 86400 * 30 }).catch(err =>
    logger.warn({ err }, 'Link maintenance after import shadow backfill failed'),
  )
  return pending.length
}

// ── Memory links (F1/F2/F3 semantic graph) ───────────────────────────────────

export interface MemoryLink {
  id: number
  src_id: number
  dst_id: number
  link_type: 'semantic' | 'explicit' | 'entity' | 'cooccurrence'
  weight: number
  created_at: number
  last_traversed_at: number | null
}

/**
 * Upsert a directed link between two memories. If (src, dst, type) already
 * exists the weight is replaced with the new value (INSERT OR REPLACE).
 * Returns the row id of the upserted link.
 */
export function upsertMemoryLink(
  srcId: number,
  dstId: number,
  linkType: MemoryLink['link_type'],
  weight: number,
): number {
  const stmt = db.prepare(
    `INSERT INTO memory_links (src_id, dst_id, link_type, weight)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(src_id, dst_id, link_type) DO UPDATE SET weight = excluded.weight, last_traversed_at = unixepoch()`
  )
  const result = stmt.run(srcId, dstId, linkType, weight) as { lastInsertRowid: number | bigint }
  return Number(result.lastInsertRowid)
}

/**
 * Return the 1-hop neighbors reachable from srcId, ordered by weight desc.
 * Updates last_traversed_at on the traversed edges.
 */
export function getMemoryNeighbors(srcId: number, limit = 10): { memory: Memory; weight: number }[] {
  // Touch traversal timestamp
  db.prepare('UPDATE memory_links SET last_traversed_at = unixepoch() WHERE src_id = ?').run(srcId)

  const rows = db.prepare(
    `SELECT m.*, ml.weight
     FROM memory_links ml
     JOIN memories m ON m.id = ml.dst_id
     WHERE ml.src_id = ?
     ORDER BY ml.weight DESC
     LIMIT ?`
  ).all(srcId, limit) as (Memory & { weight: number })[]

  return rows.map(r => ({ memory: r, weight: r.weight }))
}

/**
 * Delete links whose weight has decayed below threshold or whose endpoints
 * no longer exist. Returns the count of removed links.
 */
/**
 * Return all memory_links where either endpoint is in the given id set.
 * Used by the dashboard graph to fetch edges for a loaded set of memories.
 */
export function getLinksForMemories(ids: number[]): MemoryLink[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(
    `SELECT * FROM memory_links
     WHERE src_id IN (${placeholders}) OR dst_id IN (${placeholders})
     ORDER BY weight DESC`
  ).all(...ids, ...ids) as MemoryLink[]
}

export function pruneMemoryLinks(weightThreshold = 0.1): number {
  const result = db.prepare(
    `DELETE FROM memory_links WHERE weight < ?`
  ).run(weightThreshold) as { changes: number }
  return result.changes
}

/**
 * Create semantic links from a newly saved memory to its top-N cosine
 * neighbors. Skips if no embedding available. Returns link count created.
 */
export async function linkToNeighbors(memoryId: number, maxNeighbors = 5, similarityThreshold = 0.75): Promise<number> {
  const row = db.prepare('SELECT embedding_blob FROM memories WHERE id = ?').get(memoryId) as { embedding_blob: Buffer | null } | undefined
  if (!row?.embedding_blob) return 0

  const agentRow = db.prepare('SELECT agent_id FROM memories WHERE id = ?').get(memoryId) as { agent_id: string | null } | undefined
  if (!agentRow?.agent_id) return 0

  const queryVec = blobToFloats(row.embedding_blob)
  // Import shadow rows (agent_id='import') must search the full fleet so they
  // can link against memories from all agents, not only other import rows.
  const crossAgent = agentRow.agent_id === 'import'
  // Import nodes have lower average cosine similarity (~0.66-0.70) because they
  // are crawled documents, not agent-authored memories. Use a lower threshold so
  // edges actually form. Regular agent memories keep the caller-supplied default.
  const effectiveThreshold = crossAgent ? Math.min(similarityThreshold, 0.65) : similarityThreshold
  const candidates = await vectorSearch(agentRow.agent_id, queryVec, maxNeighbors + 1, crossAgent)

  let linked = 0
  for (const candidate of candidates) {
    if (candidate.id === memoryId) continue
    const candBlob = db.prepare('SELECT embedding_blob FROM memories WHERE id = ?').get(candidate.id) as { embedding_blob: Buffer | null } | undefined
    if (!candBlob?.embedding_blob) continue
    const sim = cosineSimilarity(queryVec, blobToFloats(candBlob.embedding_blob))
    if (sim < effectiveThreshold) continue
    upsertMemoryLink(memoryId, candidate.id, 'semantic', sim)
    linked++
    if (linked >= maxNeighbors) break
  }
  return linked
}

export interface LinkMaintenanceResult {
  reembedded: number
  linksCreated: number
  linksPruned: number
  orphans: number
}

/**
 * Periodic maintenance for the memory link graph:
 * 1. Re-embed memories whose updated_at > last link created_at (stale embeddings).
 * 2. Create/refresh neighbor links for recently updated memories.
 * 3. Prune links below weightThreshold.
 * 4. Count orphan memories: have embedding but 0 outgoing links.
 *
 * Designed to run as a heartbeat scheduled task (e.g. nightly). All steps
 * are best-effort -- Ollama unavailability yields reembedded=0.
 */
export async function runLinkMaintenance(opts: {
  weightThreshold?: number
  maxAge?: number   // seconds: only re-link memories updated within this window
} = {}): Promise<LinkMaintenanceResult> {
  const { weightThreshold = 0.1, maxAge = 7 * 86400 } = opts
  const cutoff = Math.floor(Date.now() / 1000) - maxAge

  // Step 1: backfill embeddings for memories updated recently that lack one
  const needsEmbed = db.prepare(
    `SELECT id, content, keywords FROM memories
     WHERE embedding_blob IS NULL AND updated_at >= ?`
  ).all(cutoff) as { id: number; content: string; keywords: string | null }[]

  let reembedded = 0
  for (const row of needsEmbed) {
    const text = row.content + (row.keywords ? ' ' + row.keywords : '')
    const emb = await generateEmbedding(text)
    if (emb) {
      const blob = floatsToBlob(emb)
      db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(blob, row.id)
      syncVecMemoryEmbeddingUpdate(row.id, blob)
      reembedded++
    }
  }

  // Step 2: re-link memories with embedding updated recently
  const toLink = db.prepare(
    `SELECT id FROM memories WHERE embedding_blob IS NOT NULL AND updated_at >= ?`
  ).all(cutoff) as { id: number }[]

  let linksCreated = 0
  for (const { id } of toLink) {
    linksCreated += await linkToNeighbors(id)
  }

  // Step 3: prune decayed links
  const linksPruned = pruneMemoryLinks(weightThreshold)

  // Step 4: count orphans (have embedding, 0 outgoing semantic links)
  const orphanRow = db.prepare(
    `SELECT COUNT(*) AS c FROM memories
     WHERE embedding_blob IS NOT NULL
       AND id NOT IN (SELECT DISTINCT src_id FROM memory_links WHERE link_type = 'semantic')`
  ).get() as { c: number }
  const orphans = orphanRow.c

  logger.info({ reembedded, linksCreated, linksPruned, orphans }, 'Link maintenance complete')
  return { reembedded, linksCreated, linksPruned, orphans }
}

/**
 * One-time migration: convert any existing JSON-text embeddings to Float32 BLOB
 * and immediately null out the TEXT column to reclaim space. Runs synchronously
 * inside a single transaction so it is safe to call at startup after migrations.
 */
export function migrateExistingEmbeddingsToBLOB(): number {
  const rows = db.prepare(
    'SELECT id, embedding FROM memories WHERE embedding IS NOT NULL AND embedding_blob IS NULL'
  ).all() as { id: number; embedding: string }[]

  if (rows.length === 0) return 0

  const update = db.prepare('UPDATE memories SET embedding_blob = ?, embedding = NULL WHERE id = ?')
  const tx = db.transaction((items: { id: number; embedding: string }[]) => {
    let converted = 0
    for (const row of items) {
      try {
        const floats = JSON.parse(row.embedding) as number[]
        update.run(floatsToBlob(floats), row.id)
        converted++
      } catch {
        // Malformed JSON: leave the row untouched; it will be regenerated by backfillEmbeddings.
      }
    }
    return converted
  })

  const count = tx(rows) as number
  logger.info({ converted: count }, 'Migrated JSON embeddings to Float32 BLOB')
  return count
}

// Application-level vec_memories synchronisation helpers.
//
// These replace the three DROP'd triggers (vec_memories_ai/au/ad). Call them
// wherever the application writes to `memories` so the ANN index stays in sync
// without requiring vec0 to be loaded on every database connection.
export function syncVecMemoryDelete(id: number): void {
  if (!vecExtensionLoaded) return
  try {
    db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(BigInt(id))
  } catch { /* vec0 unavailable at runtime -- no-op */ }
}

export function syncVecMemoryEmbeddingUpdate(id: number, embeddingBlob: Buffer): void {
  if (!vecExtensionLoaded) return
  try {
    db.prepare('DELETE FROM vec_memories WHERE memory_id = ?').run(BigInt(id))
    db.prepare('INSERT OR IGNORE INTO vec_memories(memory_id, embedding) VALUES(?, ?)').run(BigInt(id), embeddingBlob)
  } catch { /* vec0 unavailable at runtime -- no-op */ }
}

export function initVecSupport(): void {
  // Drop any leftover sync triggers first so stale triggers never fire against
  // a missing virtual table (e.g. when the extension failed to load this run).
  db.exec(`
    DROP TRIGGER IF EXISTS vec_memories_ai;
    DROP TRIGGER IF EXISTS vec_memories_au;
    DROP TRIGGER IF EXISTS vec_memories_ad;
  `)

  tryLoadVecExtension()
  if (!vecExtensionLoaded) return

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
      memory_id INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    )
  `)

  // Backfill: push any existing BLOB embeddings not yet in the ANN index.
  const pending = db.prepare(
    'SELECT id, embedding_blob FROM memories WHERE embedding_blob IS NOT NULL AND id NOT IN (SELECT memory_id FROM vec_memories)'
  ).all() as { id: number; embedding_blob: Buffer }[]

  if (pending.length > 0) {
    const insert = db.prepare('INSERT OR IGNORE INTO vec_memories(memory_id, embedding) VALUES(?, ?)')
    const tx = db.transaction(() => {
      // better-sqlite3 binds JS numbers as SQLITE_FLOAT; vec0 INTEGER PRIMARY KEY
      // requires SQLITE_INTEGER. BigInt forces the correct SQLite type.
      for (const row of pending) insert.run(BigInt(row.id), row.embedding_blob)
    })
    tx()
    logger.info({ count: pending.length }, 'Backfilled existing embeddings into vec_memories ANN index')
  }

  // vec_artifacts: ANN index for artifact title+meta embeddings (pointer-only recall).
  // INSERT/UPDATE are handled async in artifacts-db.ts (fire-and-forget).
  // DELETE trigger keeps the index clean when an artifact is removed.
  db.exec(`
    DROP TRIGGER IF EXISTS vec_artifacts_ad;
  `)

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_artifacts USING vec0(
      artifact_rowid INTEGER PRIMARY KEY,
      embedding FLOAT[768]
    )
  `)

  db.exec(`
    CREATE TRIGGER vec_artifacts_ad
    AFTER DELETE ON artifacts
    BEGIN
      DELETE FROM vec_artifacts WHERE artifact_rowid = OLD.rowid;
    END
  `)

  // vec_workspace_docs: ANN index for workspace document embeddings.
  // App-level sync only (no triggers) -- insert/delete handled in workspace-store.ts.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_workspace_docs USING vec0(
      doc_id      TEXT     PRIMARY KEY,
      agent_id    TEXT     PARTITION KEY,
      tenant_id   TEXT,
      embedding   float[768]
    )
  `)
}

/**
 * Search artifacts by semantic similarity against their title+meta embeddings.
 * Returns ArtifactPointer list (no content) sorted by similarity score.
 * Returns empty array when sqlite-vec is unavailable or Ollama is unreachable.
 */
export async function searchArtifactsByVector(
  query: string,
  limit = 10
): Promise<ArtifactPointer[]> {
  if (!vecExtensionLoaded) return []
  const queryEmbedding = await generateEmbedding(query)
  if (!queryEmbedding) return []

  try {
    const queryBlob = floatsToBlob(queryEmbedding)
    const annRows = db.prepare(`
      SELECT artifact_rowid, distance
      FROM vec_artifacts
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `).all(queryBlob, BigInt(limit)) as { artifact_rowid: number; distance: number }[]

    if (annRows.length === 0) return []

    const rowids = annRows.map(r => r.artifact_rowid)
    const placeholders = rowids.map(() => '?').join(',')
    const rows = db.prepare(
      `SELECT rowid, id, title, kind, created_at FROM artifacts WHERE rowid IN (${placeholders})`
    ).all(...rowids) as { rowid: number; id: string; title: string; kind: string; created_at: number }[]

    const distMap = new Map(annRows.map(r => [r.artifact_rowid, r.distance]))
    return rows
      .map(a => ({ id: a.id, title: a.title, kind: a.kind, created_at: a.created_at, score: 1 / (1 + (distMap.get(a.rowid) ?? Infinity)) }))
      .sort((x, y) => y.score - x.score)
  } catch (err) {
    logger.debug({ err }, 'searchArtifactsByVector: ANN query failed')
    return []
  }
}
