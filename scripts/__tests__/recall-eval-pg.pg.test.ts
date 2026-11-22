// The PostgreSQL side of the recall harness on a SYNTHETIC eval copy: the loader copies the three tables
// into a cloned test database, the full-text stage runs through the production search functions on that backend, and
// the FTS-stage comparison sees what it should. PostgreSQL only (the default suite does not carry it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createPgTestDb, type PgTestDb } from '../../src/__tests__/helpers/pg-test-db.js'
import { copyEvalTables, countCorpus, runFtsStagePg } from '../eval/recall-eval-pg-io.js'
import { buildFtsSnapshot, compareFtsStage } from '../eval/recall-eval-fts-stage.js'
import type { QueryCase } from '../eval/recall-eval-lib.js'

const NOW = 1_800_000_000
let pgDb: PgTestDb
let src: Database.Database

/** The SQLite eval copy, reduced to the columns the loader reads, plus one SQLite-only column (dropped on copy). */
function syntheticSqlite(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE memories (id INTEGER PRIMARY KEY, chat_id TEXT, topic_key TEXT, content TEXT, sector TEXT, salience REAL,
      created_at INTEGER, accessed_at INTEGER, agent_id TEXT, category TEXT, auto_generated INTEGER, keywords TEXT,
      embedding TEXT, updated_at INTEGER, embedding_blob BLOB, tenant_id TEXT, vec_side TEXT, fts TEXT);
    CREATE TABLE workspace_docs (id TEXT PRIMARY KEY, agent_id TEXT, tenant_id TEXT, doc_key TEXT, title TEXT, content TEXT,
      content_blob BLOB, content_type TEXT, type TEXT, task_ref TEXT, size_bytes INTEGER, embedding_blob BLOB,
      last_accessed_at INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, agent_id TEXT, title TEXT, kind TEXT, mime TEXT, content TEXT, meta TEXT,
      source TEXT, cloud_url TEXT, created_at INTEGER, updated_at INTEGER, tenant_id TEXT);
  `)
  const mem = db.prepare(`INSERT INTO memories (id, chat_id, content, sector, salience, created_at, accessed_at, agent_id, category,
    auto_generated, keywords, tenant_id, vec_side) VALUES (?, 'chat-1', ?, 'semantic', 1, ?, ?, ?, ?, 0, ?, ?, 'legacy')`)
  // 1: own row, accented; 2: another tenant; 3: shared row of another agent; 4: unrelated
  mem.run(1, 'Árvíztűrő tükörfúrógép a raktárban', NOW, NOW, 'agent-a', 'warm', 'gep,raktar', 'default')
  mem.run(2, 'Tükörfúrógép tenant B másolata', NOW, NOW, 'agent-a', 'warm', null, 'tenant-b')
  mem.run(3, 'Megosztott jegyzet a tükörfúrógépről', NOW, NOW, 'agent-b', 'shared', null, 'default')
  mem.run(4, 'egyéb szöveg semmi közös', NOW, NOW, 'agent-a', 'warm', null, 'default')
  const doc = db.prepare(`INSERT INTO workspace_docs (id, agent_id, tenant_id, title, content, content_type, type, size_bytes,
    created_at, updated_at) VALUES (?, 'agent-a', ?, ?, ?, 'text', 'report', 0, ?, ?)`)
  doc.run('doc-1', 'default', 'Heti jelentés', 'a gyorsítótár ürítése után a riport újraépül', NOW, NOW)
  doc.run('doc-2', 'tenant-b', 'Heti jelentés B', 'gyorsítótár tenant B', NOW, NOW)
  db.prepare(`INSERT INTO artifacts (id, agent_id, title, kind, mime, content, meta, created_at, updated_at, tenant_id)
    VALUES ('art-1', 'agent-a', 'Kanban riport', 'text', 'text/plain', ?, '{}', ?, ?, 'default')`).run('C:\\temp\\riport kanban', NOW, NOW)
  return db
}

const CASES: QueryCase[] = [
  { id: 'memory:001', kind: 'memory', agentId: 'agent-a', tenantId: 'default', text: 'tukorfurogep', style: 'noaccent' },
  { id: 'memory:002', kind: 'memory', agentId: 'agent-a', tenantId: 'tenant-b', text: 'tukorfurogep', style: 'noaccent' },
  { id: 'doc:001', kind: 'doc', tenantId: 'default', text: 'gyorsitotar', style: 'phrase' },
  { id: 'doc:002', kind: 'doc', tenantId: 'tenant-b', text: 'gyorsitotar', style: 'phrase' },
  { id: 'artifact:001', kind: 'artifact', text: 'riport', style: 'title' },
]

beforeAll(async () => {
  pgDb = await createPgTestDb()
  src = syntheticSqlite()
})

afterAll(async () => {
  src?.close()
  if (pgDb) await pgDb.close()
})

const idsOf = (runs: Awaited<ReturnType<typeof runFtsStagePg>>, id: string) =>
  new Set(runs.find((r) => r.id === id)!.stages.fts)

describe('the loader: the copy keeps the rows and names what it drops', () => {
  it('the row counts on PostgreSQL equal the SQLite copy; the SQLite-only column is dropped, the generated one is left to PostgreSQL', async () => {
    const report = await copyEvalTables(src, pgDb.pool)
    expect(await countCorpus(pgDb.pool)).toEqual({ memories: 4, workspace_docs: 2, artifacts: 1 })
    expect(report.tables.memories.plan.dropped).toEqual(['vec_side'])
    expect(report.tables.memories.plan.generated).toEqual(['fts'])
    // the generated tsvector was computed by PostgreSQL from the copied content (the search below relies on it)
    const r = await pgDb.pool.query<{ n: string }>('SELECT count(*) AS n FROM memories WHERE fts IS NOT NULL')
    expect(Number(r.rows[0].n)).toBe(4)
  })

  it('a text artifact keeps its backslashes byte for byte (a bytea column, not an escape string)', async () => {
    const r = await pgDb.pool.query<{ t: string }>("SELECT convert_from(content, 'UTF8') AS t FROM artifacts WHERE id = 'art-1'")
    expect(r.rows[0].t).toBe('C:\\temp\\riport kanban')
  })
})

describe('the full-text stage on PostgreSQL, through the production search functions', () => {
  it('an accent-free word finds the accented row and the shared row, never the other tenant', async () => {
    const runs = await runFtsStagePg(pgDb.pool, CASES, NOW)
    expect(idsOf(runs, 'memory:001')).toEqual(new Set(['1', '3']))
    expect(idsOf(runs, 'memory:002')).toEqual(new Set(['2']))
  })

  it('the workspace doc phrase follows the same tenant rule, and the artifact title is found', async () => {
    const runs = await runFtsStagePg(pgDb.pool, CASES, NOW)
    expect(idsOf(runs, 'doc:001')).toEqual(new Set(['doc-1']))
    expect(idsOf(runs, 'doc:002')).toEqual(new Set(['doc-2']))
    expect(idsOf(runs, 'artifact:001')).toEqual(new Set(['art-1']))
  })

  it('every run carries the fts stage only: the vector stages are not computed on PostgreSQL before the vector step', async () => {
    const runs = await runFtsStagePg(pgDb.pool, CASES, NOW)
    for (const r of runs) expect(Object.keys(r.stages)).toEqual(['fts'])
    const snap = buildFtsSnapshot({ runs, corpus: await countCorpus(pgDb.pool), gitSha: 'test', frozenNowSec: NOW, querySetSha256: 'q' })
    expect(snap.meta.notes?.some((n) => /vec stages are NOT computed/.test(n))).toBe(true)
  })

  it('two runs over the same database are identical (determinism of the stage)', async () => {
    const a = await runFtsStagePg(pgDb.pool, CASES, NOW)
    const b = await runFtsStagePg(pgDb.pool, CASES, NOW)
    expect(b).toEqual(a)
  })
})

describe('the FTS-stage comparison over the PostgreSQL run', () => {
  it('a run compared with itself passes the stop rule; a candidate that loses a hit stops', async () => {
    const runs = await runFtsStagePg(pgDb.pool, CASES, NOW)
    const base = buildFtsSnapshot({ runs, corpus: {}, gitSha: 'b', frozenNowSec: NOW, querySetSha256: 'q' })
    const same = compareFtsStage(base, base)
    expect(same.stop).toBe(false)
    expect(same.kinds.find((k) => k.kind === 'memory')!.top10).toBe(1)

    // the candidate loses the shared row for memory:001: top-10 overlap 0.5 there, memory mean (0.5 + 1) / 2 = 0.75
    const lost = runs.map((r) => (r.id === 'memory:001' ? { ...r, stages: { fts: ['1'] } } : r))
    const cand = buildFtsSnapshot({ runs: lost, corpus: {}, gitSha: 'c', frozenNowSec: NOW, querySetSha256: 'q' })
    const rep = compareFtsStage(base, cand)
    expect(rep.kinds.find((k) => k.kind === 'memory')!.top10).toBeCloseTo(0.75, 12)
    expect(rep.stop).toBe(true)
    // both sides carry an fts stage for every kind here, so every kind is compared
    expect(rep.skipped).toEqual([])
    expect(rep.examined).toEqual(['memory', 'doc', 'artifact'])
    expect(rep.kinds.map((k) => k.kind)).toEqual(['memory', 'doc', 'artifact'])
  })
})
