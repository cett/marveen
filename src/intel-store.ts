// Proactive Intelligence registry store: the four tables behind the
// intel-collector / intel-daily-brief seed tasks.
//
// The registry lives in its own database file (store/intel.db, override with
// the INTEL_DB environment variable), deliberately outside the migrations -
// see docs/database-schema-sources.md. The dashboard is the only process that
// opens it: scripts/intel_db.py is a thin HTTP client over /api/intel/*, so a
// later move of this data to another engine touches this module and nothing
// else. The file is opened on first use, so an install that never runs the
// intel tasks never gets an empty intel.db.
//
// Timestamps are unix seconds, ids are text. The SQL here is deliberately
// plain (no engine-specific functions) for the same reason.

import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { STORE_DIR } from './config.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS known_facts_registry (
  id TEXT PRIMARY KEY,
  title TEXT,
  domain TEXT,
  source TEXT,
  source_tier INTEGER CHECK(source_tier IN (1,2,3)),
  status TEXT CHECK(status IN ('new','evolving','stable','closed')),
  priority_score REAL,
  content TEXT,
  fact_hash TEXT UNIQUE,
  created_at INTEGER,
  updated_at INTEGER,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS watchlist (
  id TEXT PRIMARY KEY,
  title TEXT,
  domain TEXT,
  direction TEXT,
  days_tracked INTEGER,
  notes TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS decision_log (
  id TEXT PRIMARY KEY,
  date INTEGER,
  recommendation TEXT,
  reasoning TEXT,
  assumption TEXT,
  evidence TEXT,
  what_would_falsify TEXT,
  owner_reaction TEXT,
  outcome TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS active_focus (
  id TEXT PRIMARY KEY,
  topic TEXT,
  mode TEXT CHECK(mode IN ('deep','transient')),
  started_at INTEGER,
  expires_at INTEGER,
  status TEXT CHECK(status IN ('active','closed')),
  notes TEXT
);
`

export const FACT_STATUSES = ['new', 'evolving', 'stable', 'closed'] as const
export const FOCUS_MODES = ['deep', 'transient'] as const
export type FactStatus = (typeof FACT_STATUSES)[number]
export type FocusMode = (typeof FOCUS_MODES)[number]

export interface IntelFact {
  id: string
  title: string
  domain: string
  source: string
  source_tier: number
  status: FactStatus
  priority_score: number
  content: string
  fact_hash: string
  created_at: number
  updated_at: number
  expires_at: number | null
}

export interface IntelWatch {
  id: string
  title: string
  domain: string
  direction: string
  days_tracked: number
  notes: string
  created_at: number
  updated_at: number
}

export interface IntelFocus {
  id: string
  topic: string
  mode: FocusMode
  started_at: number
  expires_at: number | null
  status: 'active' | 'closed'
  notes: string
}

let handle: Database.Database | null = null
let handlePath: string | null = null

export function intelDbPath(): string {
  return process.env['INTEL_DB'] || join(STORE_DIR, 'intel.db')
}

function conn(): Database.Database {
  const path = intelDbPath()
  if (handle && handlePath === path) return handle
  closeIntelDb()
  mkdirSync(dirname(path), { recursive: true })
  // Research findings can be sensitive: create the file owner-only, the way
  // the main database file is.
  if (!existsSync(path)) {
    try { closeSync(openSync(path, 'wx', 0o600)) } catch { /* lost a creation race; the open below still works */ }
  }
  handle = new Database(path)
  handle.exec(SCHEMA)
  handlePath = path
  return handle
}

/** Close the handle (tests, or after INTEL_DB changes). The next call reopens. */
export function closeIntelDb(): void {
  if (handle) {
    try { handle.close() } catch { /* already closed */ }
  }
  handle = null
  handlePath = null
}

const nowSecs = (): number => Math.floor(Date.now() / 1000)

/** Create the file and all tables (idempotent). Returns the file path. */
export function initIntelDb(): string {
  conn()
  return intelDbPath()
}

export function getActiveRegistry(days = 14): IntelFact[] {
  const cutoff = nowSecs() - days * 86400
  return conn()
    .prepare(
      `SELECT * FROM known_facts_registry
       WHERE status != 'closed' AND updated_at >= ?
       ORDER BY priority_score DESC, updated_at DESC`,
    )
    .all(cutoff) as IntelFact[]
}

export function getWatchlist(): IntelWatch[] {
  return conn().prepare('SELECT * FROM watchlist ORDER BY created_at DESC').all() as IntelWatch[]
}

export function getActiveFocus(): IntelFocus[] {
  return conn()
    .prepare(
      `SELECT * FROM active_focus
       WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY started_at DESC`,
    )
    .all(nowSecs()) as IntelFocus[]
}

export function dumpActive(days = 14): { registry: IntelFact[]; watchlist: IntelWatch[]; active_focus: IntelFocus[] } {
  return { registry: getActiveRegistry(days), watchlist: getWatchlist(), active_focus: getActiveFocus() }
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * Deterministic fact id: <domain>-<YYYYMMDD>-<sha256(content)[:8]>. The same
 * finding collected twice on the same day maps to the same id, so the
 * collector's repeated hourly runs hit the UPDATE path of upsertFact instead
 * of piling up duplicates. The day is the server's local date.
 */
export function makeFactId(domain: string, content: string, now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  return `${domain}-${day}-${sha256(content).slice(0, 8)}`
}

export interface FactInput {
  id?: string
  title: string
  domain: string
  source: string
  source_tier: 1 | 2 | 3
  content: string
  status?: FactStatus
  priority_score?: number
}

/**
 * Insert or update a fact. `duplicate` is true when the same content is
 * already stored under a DIFFERENT id (fact_hash is unique): a repeat
 * sighting, not an error, and nothing is written.
 */
export function upsertFact(input: FactInput): { id: string; duplicate: boolean } {
  const db = conn()
  const id = input.id || makeFactId(input.domain, input.content)
  const factHash = sha256(input.content).slice(0, 32)
  const status = input.status ?? 'new'
  const priority = Math.max(0, Math.min(1, input.priority_score ?? 0.5))
  const now = nowSecs()

  return db.transaction((): { id: string; duplicate: boolean } => {
    const other = db
      .prepare('SELECT id FROM known_facts_registry WHERE fact_hash = ? AND id != ?')
      .get(factHash, id)
    if (other) return { id, duplicate: true }

    const existing = db.prepare('SELECT id FROM known_facts_registry WHERE id = ?').get(id)
    if (existing) {
      db.prepare(
        `UPDATE known_facts_registry
         SET title=?, domain=?, source=?, source_tier=?, status=?,
             priority_score=?, content=?, fact_hash=?, updated_at=?
         WHERE id=?`,
      ).run(input.title, input.domain, input.source, input.source_tier, status, priority, input.content, factHash, now, id)
    } else {
      db.prepare(
        `INSERT INTO known_facts_registry
           (id, title, domain, source, source_tier, status, priority_score, content, fact_hash, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      ).run(id, input.title, input.domain, input.source, input.source_tier, status, priority, input.content, factHash, now, now)
    }
    return { id, duplicate: false }
  })()
}

export function addWatch(title: string, domain: string, direction: string, notes = ''): string {
  const id = randomUUID()
  const now = nowSecs()
  conn()
    .prepare(
      `INSERT INTO watchlist (id, title, domain, direction, days_tracked, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(id, title, domain, direction, notes, now, now)
  return id
}

export function addFocus(topic: string, mode: FocusMode = 'transient', days: number | null = null, notes = ''): string {
  const id = randomUUID()
  const now = nowSecs()
  const expiresAt = days ? now + days * 86400 : null
  conn()
    .prepare(
      `INSERT INTO active_focus (id, topic, mode, started_at, expires_at, status, notes)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(id, topic, mode, now, expiresAt, notes)
  return id
}

export interface DecisionInput {
  recommendation: string
  reasoning: string
  assumption?: string
  evidence?: string
  what_would_falsify?: string
  owner_reaction?: string
  outcome?: string
}

export function logDecision(input: DecisionInput): string {
  const id = randomUUID()
  const now = nowSecs()
  conn()
    .prepare(
      `INSERT INTO decision_log
         (id, date, recommendation, reasoning, assumption, evidence, what_would_falsify, owner_reaction, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, now, input.recommendation, input.reasoning, input.assumption ?? '', input.evidence ?? '',
      input.what_would_falsify ?? '', input.owner_reaction ?? '', input.outcome ?? '', now,
    )
  return id
}
