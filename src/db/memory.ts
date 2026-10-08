// Split from the former monolithic src/db.ts (see db/index.ts for the
// re-export surface and boot orchestration).

import { ALLOWED_CHAT_ID } from '../config.js'
import { writeAgentAuditLog } from './audit.js'
import { db } from './connection.js'
import { floatsToBlob, generateEmbedding, linkToNeighbors, syncVecMemoryEmbeddingUpdate } from './vector.js'

export interface Memory {
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
  updated_at: number | null
  agent_id: string
  category: string  // 'hot' | 'warm' | 'cold' | 'shared'
  auto_generated: number
  keywords: string | null
  tenant_id?: string
  embedding: string | null
  embedding_blob: Buffer | null
}

export interface SpanRead {
  id: number
  agent_id: string
  memory_id: number
  read_at: number
  context: 'heartbeat' | 'search' | 'direct' | null
}

export interface MemoryVersion {
  id: number
  memory_id: number
  content: string
  category: string
  keywords: string | null
  changed_at: number
  changed_by: string
  change_type: 'create' | 'update' | 'category_change'
}

export function saveMemory(
  chatId: string,
  content: string,
  sector: 'semantic' | 'episodic',
  topicKey?: string
): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, ?, 1.0, ?, ?)'
  ).run(chatId, topicKey ?? null, content, sector, now, now)
}

// Build a safe FTS5 MATCH expression from a free-form user query.
//
// FTS5 treats AND / OR / NOT / NEAR as reserved operators only when uppercase
// and unquoted -- so we lowercase everything, which turns them into ordinary
// search terms. We also cap the number and length of tokens to bound query
// cost (the sanitizer previously allowed an arbitrary-length prefix expansion
// that could make a single request scan the entire index).
export function buildFtsMatchExpression(query: string): string {
  const MAX_TOKENS = 20
  const MAX_TOKEN_LEN = 64
  const sanitized = query
    .toLowerCase()
    // Replace punctuation with a space (not delete) so "rank-check" / "serper.dev"
    // tokenize the same way unicode61 indexed them (rank + check), instead of
    // fusing into a single unfindable token "rankcheck".
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
  if (!sanitized) return ''
  const tokens = sanitized
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS)
    .map((t) => t.slice(0, MAX_TOKEN_LEN) + '*')
  return tokens.join(' ')
}

// -- Recency-weighted retrieval (Roitman 17.4.2) --
//
// score = λ·relevance + (1−λ)·recency, where recency = exp(−age/τ). Pure
// keyword rank returns whichever memory FTS scores highest regardless of age,
// so a stale fact ("reply tool down") can outrank its own correction ("reply
// tool up"). The blend keeps relevance dominant (λ = 0.7) but breaks
// near-ties in favour of the newer memory.
//
// FTS5 `rank` is bm25: negative, more negative = better. Normalized to 0..1
// via −rank/(1−rank) (monotonic, no unbounded tail). The blend runs in JS on
// an oversampled candidate set rather than in SQL so it does not depend on
// SQLite being compiled with math functions, and stays unit-testable.
export const RECENCY_LAMBDA = 0.7
export const RECENCY_TAU_SEC = 7 * 86400
// Candidates fetched per requested row before re-ranking. Bounded so a broad
// query still touches at most 4x the requested rows.
export const RECENCY_OVERSAMPLE = 4

export interface RecencyRankable {
  rank: number
  created_at: number
}

export function recencyWeightedScore(
  row: RecencyRankable,
  nowSec: number,
  lambda = RECENCY_LAMBDA,
  tauSec = RECENCY_TAU_SEC,
): number {
  const relevance = row.rank < 0 ? -row.rank / (1 - row.rank) : 0
  const ageSec = Math.max(0, nowSec - row.created_at)
  const recency = Math.exp(-ageSec / tauSec)
  return lambda * relevance + (1 - lambda) * recency
}

export function reRankByRecency<T extends RecencyRankable>(
  rows: T[],
  limit: number,
  nowSec: number = Math.floor(Date.now() / 1000),
): T[] {
  return rows
    .map((row) => ({ row, score: recencyWeightedScore(row, nowSec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.row)
}

// Strip the FTS rank column the oversampled queries select for re-ranking, so
// the public return shape stays exactly Memory.
export function withoutRank<T extends { rank: number }>(rows: T[]): Omit<T, 'rank'>[] {
  return rows.map(({ rank: _rank, ...rest }) => rest)
}

export function searchMemories(query: string, chatId: string, limit = 3, tenantId?: string): Memory[] {
  const terms = buildFtsMatchExpression(query)
  if (!terms) return []
  try {
    const tc = tenantId ? ' AND m.tenant_id = ?' : ''
    const tp = tenantId ? [tenantId] : []
    const candidates = db
      .prepare(
        `SELECT m.*, f.rank AS rank FROM memories m
         JOIN memories_fts f ON m.id = f.rowid
         WHERE f.content MATCH ? AND m.chat_id = ?${tc}
         ORDER BY rank
         LIMIT ?`
      )
      .all(terms, chatId, ...tp, limit * RECENCY_OVERSAMPLE) as (Memory & { rank: number })[]
    return withoutRank(reRankByRecency(candidates, limit)) as Memory[]
  } catch {
    return []
  }
}

export function recentMemories(chatId: string, limit = 5, tenantId?: string): Memory[] {
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  return db
    .prepare(`SELECT * FROM memories WHERE chat_id = ?${tc} ORDER BY accessed_at DESC LIMIT ?`)
    .all(chatId, ...tp, limit) as Memory[]
}

export function touchMemory(id: number): void {
  const now = Math.floor(Date.now() / 1000)
  db.prepare(
    'UPDATE memories SET accessed_at = ?, salience = MIN(salience + 0.1, 5.0) WHERE id = ?'
  ).run(now, id)
}

// Mark a batch of memories as just-recalled (bumps accessed_at only). Used by
// the agent-memory read endpoint so that accessed_at reflects real usage --
// without this, agent memories keep accessed_at == created_at forever and any
// "not accessed in N days" staleness check (e.g. the Dream Engine hygiene pass)
// treats even freshly-recalled memories as stale. Salience is intentionally
// left untouched here; this is a lightweight recency stamp, not a ranking bump.
export function touchMemoriesAccessed(ids: number[]): void {
  if (ids.length === 0) return
  const now = Math.floor(Date.now() / 1000)
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(`UPDATE memories SET accessed_at = ? WHERE id IN (${placeholders})`).run(now, ...ids)
}

export function decayMemories(): void {
  const oneWeekAgo = Math.floor(Date.now() / 1000) - 7 * 86400
  // Gentler decay: 0.5% per day, only for memories older than 1 week
  // Never delete -- salience just goes lower but memories persist
  db.prepare('UPDATE memories SET salience = MAX(salience * 0.995, 0.01) WHERE created_at < ?').run(oneWeekAgo)
}

export function getMemoriesForChat(chatId: string, limit = 10, tenantId?: string, category?: string, offset = 0): Memory[] {
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  const cc = category ? ' AND category = ?' : ''
  const cp = category ? [category] : []
  return db
    .prepare(`SELECT * FROM memories WHERE chat_id = ?${tc}${cc} ORDER BY accessed_at DESC LIMIT ? OFFSET ?`)
    .all(chatId, ...tp, ...cp, limit, offset) as Memory[]
}

// Paired with getMemoriesForChat -- same WHERE clause, no LIMIT/OFFSET, for the
// dashboard's "no agent filter" listing pagination (GET /api/memories, no `q`).
export function countMemoriesForChat(chatId: string, tenantId?: string, category?: string): number {
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  const cc = category ? ' AND category = ?' : ''
  const cp = category ? [category] : []
  const row = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE chat_id = ?${tc}${cc}`)
    .get(chatId, ...tp, ...cp) as { n: number }
  return row.n
}

//
// Avoids a SQLite round-trip on every context-fetch by keeping the most
// recently read agent memory lists in a Map for up to MEMORY_CACHE_TTL_MS.
// Any write to the memories table for a given agent evicts that agent's entry.
// The cache is intentionally coarse-grained (per agentId+limit) to stay
// simple and safe under concurrent async paths.

const MEMORY_CACHE_TTL_MS = 60_000

interface MemoryCacheEntry {
  value: Memory[]
  expiresAt: number
}

const memoryCache = new Map<string, MemoryCacheEntry>()

function memoryCacheGet(key: string): Memory[] | null {
  const entry = memoryCache.get(key)
  if (!entry || Date.now() > entry.expiresAt) {
    memoryCache.delete(key)
    return null
  }
  return entry.value
}

function memoryCacheSet(key: string, value: Memory[]): void {
  memoryCache.set(key, { value, expiresAt: Date.now() + MEMORY_CACHE_TTL_MS })
}

function memoryCacheInvalidate(agentId: string): void {
  for (const key of memoryCache.keys()) {
    if (key.startsWith(`${agentId}:`)) memoryCache.delete(key)
  }
}

/** Exposed for tests and diagnostics only. */
export function clearMemoryCache(): void {
  memoryCache.clear()
}

/** Exposed for tests only. */
export function getMemoryCacheSize(): number {
  return memoryCache.size
}

export function saveAgentMemory(
  agentId: string,
  content: string,
  category: string,  // hot, warm, cold, shared
  keywords?: string,
  autoGenerated: boolean = false,
  tenantId: string = 'default',
): { id: number } {
  const now = Math.floor(Date.now() / 1000)
  const { id } = db.prepare(
    'INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords, tenant_id) VALUES (?, ?, ?, ?, 1.0, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
  ).get(ALLOWED_CHAT_ID, null, content, 'semantic', now, now, agentId, category, autoGenerated ? 1 : 0, keywords ?? null, tenantId) as { id: number }

  if (!autoGenerated) {
    try {
      writeAgentAuditLog({ agent_id: agentId, entity: 'memory', action: 'create', entity_id: id, detail: { category, keywords: keywords ?? null } })
    } catch { /* audit failure must not abort the save */ }
  }

  // A new 'shared' row joins EVERY agent's list, not just the author's, so
  // evicting the author alone would leave every other agent serving a list
  // that is missing it. Same call the update path makes, for the same reason.
  if (category === 'shared') clearMemoryCache()
  else memoryCacheInvalidate(agentId)

  // Fire-and-forget: generate embedding, store as Float32 BLOB, then link to
  // semantically similar neighbors. All three steps are best-effort -- Ollama
  // unavailability silently skips them without affecting the saved memory.
  generateEmbedding(content + (keywords ? ' ' + keywords : '')).then(async emb => {
    if (emb) {
      const blob = floatsToBlob(emb)
      db.prepare('UPDATE memories SET embedding_blob = ? WHERE id = ?').run(blob, id)
      syncVecMemoryEmbeddingUpdate(id, blob)
      await linkToNeighbors(id)
    }
  }).catch(() => {})

  return { id }
}

// The category filter belongs in SQL, ahead of the LIMIT. Filtering the rows
// afterwards would answer "the <category> ones among the N most recently
// accessed memories" instead of "the N most recent <category> memories", so an
// older-but-still-active memory would drop out of the list with no truncation
// signal -- invisible to the caller, and worst right after a restart.
export function getAgentMemories(agentId: string, limit: number = 20, category?: string, tenantId?: string, offset = 0): Memory[] {
  const key = `${agentId}:${limit}:${category ?? ''}:${tenantId ?? ''}:${offset}`
  const cached = memoryCacheGet(key)
  if (cached) return cached
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  const result = (category
    ? db.prepare(
        `SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND category = ?${tc} ORDER BY accessed_at DESC LIMIT ? OFFSET ?`
      ).all(agentId, category, ...tp, limit, offset)
    : db.prepare(
        `SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared')${tc} ORDER BY accessed_at DESC LIMIT ? OFFSET ?`
      ).all(agentId, ...tp, limit, offset)) as Memory[]
  memoryCacheSet(key, result)
  return result
}

// Paired with getAgentMemories -- same WHERE clause, no LIMIT/OFFSET, for the
// dashboard's agent-filtered listing pagination (GET /api/memories, no `q`).
export function countAgentMemories(agentId: string, category?: string, tenantId?: string): number {
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  const row = (category
    ? db.prepare(
        `SELECT COUNT(*) AS n FROM memories WHERE (agent_id = ? OR category = 'shared') AND category = ?${tc}`
      ).get(agentId, category, ...tp)
    : db.prepare(
        `SELECT COUNT(*) AS n FROM memories WHERE (agent_id = ? OR category = 'shared')${tc}`
      ).get(agentId, ...tp)) as { n: number }
  return row.n
}

export function searchAgentMemories(agentId: string, query: string, limit: number = 10, tenantId?: string): Memory[] {
  const terms = buildFtsMatchExpression(query)
  if (!terms) return []
  const tc = tenantId ? ' AND m.tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  try {
    const candidates = db.prepare(
      `SELECT m.*, f.rank AS rank FROM memories m
       JOIN memories_fts f ON m.id = f.rowid
       WHERE f.memories_fts MATCH ? AND (m.agent_id = ? OR m.category = 'shared')${tc}
       ORDER BY rank LIMIT ?`
    ).all(terms, agentId, ...tp, limit * RECENCY_OVERSAMPLE) as (Memory & { rank: number })[]
    return withoutRank(reRankByRecency(candidates, limit)) as Memory[]
  } catch {
    const tcFallback = tenantId ? ' AND tenant_id = ?' : ''
    return db.prepare(
      `SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?)${tcFallback} ORDER BY accessed_at DESC LIMIT ?`
    ).all(agentId, `%${query}%`, `%${query}%`, ...tp, limit) as Memory[]
  }
}

export function getMemoryStats(tenantId?: string): { total: number; byAgent: Record<string, number>; byTier: Record<string, number>; withEmbedding: number; importCount: number } {
  const tc = tenantId ? ' AND tenant_id = ?' : ''
  const tp = tenantId ? [tenantId] : []
  const total = (db.prepare(`SELECT COUNT(*) as c FROM memories WHERE 1=1${tc}`).get(...tp) as {c:number}).c
  // Count both the compact binary embedding_blob (the primary store since the
  // 0005 migration) and the legacy JSON `embedding` column. Counting only the
  // legacy column reported 0 vectors after the blob migration emptied it, even
  // though every memory has a blob embedding.
  const withEmbedding = (db.prepare(`SELECT COUNT(*) as c FROM memories WHERE (embedding_blob IS NOT NULL OR embedding IS NOT NULL)${tc}`).get(...tp) as {c:number}).c
  const agentRows = db.prepare(`SELECT agent_id, COUNT(*) as c FROM memories WHERE 1=1${tc} GROUP BY agent_id`).all(...tp) as {agent_id:string, c:number}[]
  const tierRows = db.prepare(`SELECT category, COUNT(*) as c FROM memories WHERE 1=1${tc} GROUP BY category`).all(...tp) as {category:string, c:number}[]
  const byAgent: Record<string, number> = {}
  const byTier: Record<string, number> = {}
  for (const r of agentRows) byAgent[r.agent_id] = r.c
  for (const r of tierRows) byTier[r.category] = r.c
  // Import memories are stored in a separate table (also tenant_id-scoped
  // since migration 0017); include their count in the summary so the
  // dashboard can show "Ebből import: N db".
  let importCount = 0
  try {
    importCount = (db.prepare(`SELECT COUNT(*) as c FROM import_memories WHERE 1=1${tc}`).get(...tp) as {c:number}).c
  } catch { /* table may not exist yet if migration hasn't run */ }
  return { total, byAgent, byTier, withEmbedding, importCount }
}

export function updateMemory(
  id: number,
  content: string,
  category?: string,
  agentId?: string,
  keywords?: string,
  modifiedBy?: string,
): boolean {
  const now = Math.floor(Date.now() / 1000)

  // Read the row's CURRENT owner and category before writing. The agentId
  // parameter is optional and means "reassign to this agent", so it is absent
  // on the ordinary edit -- it cannot be used to decide whose cache went
  // stale. Only the row itself knows that.
  const before = db.prepare('SELECT agent_id, category FROM memories WHERE id = ?').get(id) as
    { agent_id: string | null; category: string | null } | undefined

  // Capture old state before the update so we can write a version record with
  // the correct changed_by (modifiedBy or agentId) without touching agent_id.
  const current = db.prepare(
    'SELECT content, category, keywords, agent_id FROM memories WHERE id = ?'
  ).get(id) as { content: string; category: string; keywords: string | null; agent_id: string } | undefined

  if (current) {
    const newCategory = category || current.category
    const newKeywords = keywords !== undefined ? keywords : current.keywords
    const contentChanged = content !== current.content
    const categoryChanged = newCategory !== current.category
    const keywordsChanged = newKeywords !== current.keywords
    if (contentChanged || categoryChanged || keywordsChanged) {
      const changeType = categoryChanged && !contentChanged ? 'category_change' : 'update'
      const changedBy = modifiedBy || agentId || current.agent_id
      db.prepare(
        'INSERT INTO memory_versions(memory_id, content, category, keywords, changed_at, changed_by, change_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, current.content, current.category, current.keywords, now, changedBy, changeType)
    }
  }

  const sets: string[] = ['content = ?', 'accessed_at = ?', 'updated_at = ?']
  const params: unknown[] = [content, now, now]
  if (category) { sets.push('category = ?'); params.push(category) }
  if (agentId) { sets.push('agent_id = ?'); params.push(agentId) }
  if (keywords !== undefined) { sets.push('keywords = ?'); params.push(keywords) }
  params.push(id)
  const changed = db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0
  if (changed) {
    const actor = modifiedBy || agentId || before?.agent_id || 'unknown'
    try {
      writeAgentAuditLog({ agent_id: actor, entity: 'memory', action: 'update', entity_id: id, detail: { category: category ?? null, keywords: keywords ?? null } })
    } catch { /* audit failure must not abort the update */ }
    if (before?.category === 'shared' || category === 'shared') {
      // A shared row is listed for every agent, so evicting one owner is not
      // enough. Same blunt call the DELETE route makes, for the same reason.
      clearMemoryCache()
    } else {
      if (before?.agent_id) memoryCacheInvalidate(before.agent_id)
      if (agentId && agentId !== before?.agent_id) memoryCacheInvalidate(agentId)
    }
  }
  return changed
}

// ---------------------------------------------------------------------------
// Read helpers behind the /api/memories routes (recall fallbacks, staleness,
// graph, detail). tenantId undefined = unscoped (admin default).
// ---------------------------------------------------------------------------

function memoryTenantFilter(tenantId: string | undefined): { clause: string; params: string[] } {
  return tenantId ? { clause: ' AND tenant_id = ?', params: [tenantId] } : { clause: '', params: [] }
}

// LIKE fallback used when FTS finds nothing for an agent-scoped query.
export function searchMemoriesLikeForAgent(agentId: string, query: string, limit: number, tenantId?: string): Memory[] {
  const { clause, params } = memoryTenantFilter(tenantId)
  return db.prepare(`SELECT * FROM memories WHERE (agent_id = ? OR category = 'shared') AND (content LIKE ? OR keywords LIKE ?)${clause} ORDER BY accessed_at DESC LIMIT ?`)
    .all(agentId, `%${query}%`, `%${query}%`, ...params, limit) as Memory[]
}

// LIKE fallback used when FTS finds nothing for an unscoped-agent query.
export function searchMemoriesLike(query: string, limit: number, tenantId?: string): Memory[] {
  const { clause, params } = memoryTenantFilter(tenantId)
  return db.prepare(`SELECT * FROM memories WHERE content LIKE ?${clause} ORDER BY accessed_at DESC LIMIT ?`)
    .all(`%${query}%`, ...params, limit) as Memory[]
}

// Of `ids`, the memories updated after this agent last read them.
export function listUpdatedSinceLastReadIds(agentId: string, ids: number[]): number[] {
  const rows = db.prepare(`
        SELECT m.id FROM memories m
        LEFT JOIN (
          SELECT memory_id, MAX(read_at) AS last_read
          FROM span_reads WHERE agent_id = ?
          GROUP BY memory_id
        ) sr ON sr.memory_id = m.id
        WHERE m.id IN (${ids.map(() => '?').join(',')})
          AND m.updated_at > COALESCE(sr.last_read, 0)
      `).all(agentId, ...ids) as { id: number }[]
  return rows.map(r => r.id)
}

export function listRecentMemoryIdsForAgent(agentId: string, limit: number): number[] {
  const rows = db.prepare(
    `SELECT id FROM memories WHERE agent_id = ? ORDER BY accessed_at DESC LIMIT ?`
  ).all(agentId, limit) as { id: number }[]
  return rows.map(r => r.id)
}

export interface MemoryGraphNodeRow {
  id: number
  content: string
  agent_id: string
  category: string
  created_at: number
  accessed_at: number
}

// Nodes created inside [fromTs, toTs], oldest first (timeline scrubber).
export function listMemoryGraphNodesInWindow(
  fromTs: number,
  toTs: number,
  agentId?: string,
  tenantId?: string,
): MemoryGraphNodeRow[] {
  const { clause, params } = memoryTenantFilter(tenantId)
  return agentId
    ? db.prepare(
        `SELECT id, content, agent_id, category, created_at, accessed_at
           FROM memories
           WHERE agent_id = ? AND created_at >= ? AND created_at <= ?${clause}
           ORDER BY created_at ASC`
      ).all(agentId, fromTs, toTs, ...params) as MemoryGraphNodeRow[]
    : db.prepare(
        `SELECT id, content, agent_id, category, created_at, accessed_at
           FROM memories
           WHERE created_at >= ? AND created_at <= ?${clause}
           ORDER BY created_at ASC`
      ).all(fromTs, toTs, ...params) as MemoryGraphNodeRow[]
}

// Most recently accessed nodes, newest first (static graph view).
export function listMemoryGraphNodes(limit: number, agentId?: string, tenantId?: string): MemoryGraphNodeRow[] {
  const { clause, params } = memoryTenantFilter(tenantId)
  return agentId
    ? db.prepare(
        `SELECT id, content, agent_id, category, created_at, accessed_at
           FROM memories WHERE agent_id = ?${clause} ORDER BY accessed_at DESC LIMIT ?`
      ).all(agentId, ...params, limit) as MemoryGraphNodeRow[]
    : db.prepare(
        `SELECT id, content, agent_id, category, created_at, accessed_at
           FROM memories${tenantId ? ' WHERE tenant_id = ?' : ''} ORDER BY accessed_at DESC LIMIT ?`
      ).all(...params, limit) as MemoryGraphNodeRow[]
}

export interface MemoryLinkEdgeRow { src_id: number; dst_id: number; weight: number; created_at: number }

// Edges with BOTH endpoints in `ids` and weight >= weightMin. The created_at
// is the edge's, not filtered: an edge may predate the window.
export function listMemoryLinksAmong(ids: number[], weightMin: number): MemoryLinkEdgeRow[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(
    `SELECT src_id, dst_id, weight, created_at FROM memory_links
           WHERE src_id IN (${placeholders}) AND dst_id IN (${placeholders}) AND weight >= ?`
  ).all(...ids, ...ids, weightMin) as MemoryLinkEdgeRow[]
}

// Outgoing-edge count per source id, same weight threshold.
export function listMemoryLinkDegrees(ids: number[], weightMin: number): { src_id: number; degree: number }[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(
    `SELECT src_id, COUNT(*) AS degree FROM memory_links
         WHERE src_id IN (${placeholders}) AND weight >= ?
         GROUP BY src_id`
  ).all(...ids, weightMin) as { src_id: number; degree: number }[]
}

export function listCategoryChangesInWindow(
  ids: number[],
  fromTs: number,
  toTs: number,
): { memory_id: number; changed_at: number; category: string }[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(
    `SELECT mv.memory_id, mv.changed_at, mv.category
           FROM memory_versions mv
           WHERE mv.change_type = 'category_change'
             AND mv.changed_at >= ? AND mv.changed_at <= ?
             AND mv.memory_id IN (${placeholders})`
  ).all(fromTs, toTs, ...ids) as { memory_id: number; changed_at: number; category: string }[]
}

export interface MemoryDetailRow {
  id: number
  content: string
  category: string
  agent_id: string
  keywords: string | null
  created_at: number
  accessed_at: number
}

export function getMemoryDetailRow(id: number): MemoryDetailRow | undefined {
  return db.prepare(
    'SELECT id, content, category, agent_id, keywords, created_at, accessed_at FROM memories WHERE id = ?'
  ).get(id) as MemoryDetailRow | undefined
}

export function countMemoryReads(memoryId: number): number {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM span_reads WHERE memory_id = ?').get(memoryId) as { cnt: number }
  return row.cnt
}

export interface MemoryNeighborRow {
  id: number
  content: string
  category: string
  agent_id: string | null
  weight: number
  direction: string
}

// Up to 5 strongest links in each direction (weight >= 0.75).
export function listMemoryNeighbors(id: number): MemoryNeighborRow[] {
  // SQLite forbids ORDER BY/LIMIT inside individual UNION ALL arms -- wrap each arm in a subquery
  return db.prepare(`
      SELECT * FROM (
        SELECT m.id, m.content, m.category, m.agent_id, ml.weight, 'outgoing' AS direction
        FROM memory_links ml
        JOIN memories m ON m.id = ml.dst_id
        WHERE ml.src_id = ? AND ml.weight >= 0.75
        ORDER BY ml.weight DESC LIMIT 5
      )
      UNION ALL
      SELECT * FROM (
        SELECT m.id, m.content, m.category, m.agent_id, ml.weight, 'incoming' AS direction
        FROM memory_links ml
        JOIN memories m ON m.id = ml.src_id
        WHERE ml.dst_id = ? AND ml.weight >= 0.75
        ORDER BY ml.weight DESC LIMIT 5
      )
    `).all(id, id) as MemoryNeighborRow[]
}

export function listMemoryCategoryHistory(
  memoryId: number,
): { category: string; changed_at: number; changed_by: string }[] {
  return db.prepare(
    `SELECT category, changed_at, changed_by
       FROM memory_versions
       WHERE memory_id = ? AND change_type = 'category_change'
       ORDER BY changed_at ASC`
  ).all(memoryId) as { category: string; changed_at: number; changed_by: string }[]
}

// Originating file and source of an import shadow row (agent_id = 'import').
export function getImportMetaForShadow(
  shadowId: number,
): { file_name: string; file_path: string; source_label: string | null } | null {
  return (db.prepare(`
          SELECT im.file_name, im.file_path,
                 COALESCE(is_.label, is_.path) AS source_label
          FROM import_memories im
          LEFT JOIN import_sources is_ ON is_.id = im.source_id
          WHERE im.memory_shadow_id = ?
        `).get(shadowId) as { file_name: string; file_path: string; source_label: string | null } | null)
}

export function getMemoryById(id: number): Memory | undefined {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined
}

// Owner and tenant of a memory, for the route's tenant gate.
export function getMemoryOwnerRow(id: number): { agent_id: string | null; tenant_id: string } | undefined {
  return db.prepare('SELECT agent_id, tenant_id FROM memories WHERE id = ?').get(id) as
    { agent_id: string | null; tenant_id: string } | undefined
}

// Raw row delete; the route owns the vec/cache/audit side effects.
export function deleteMemoryRow(id: number): number {
  return db.prepare('DELETE FROM memories WHERE id = ?').run(id).changes
}
