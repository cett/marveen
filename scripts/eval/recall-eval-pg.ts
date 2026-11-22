#!/usr/bin/env tsx
// PostgreSQL side of the recall/quality harness . Subcommands:
//
//   load          create a scratch database (marveen_eval_<suffix>), apply the baseline migrations, check the
//                 preflight, copy memories / workspace_docs / artifacts from the prepared SQLite eval copy
//   snapshot      run the full-text stage of every query of the eval dir on that scratch database and write a
//                 Snapshot (same JSON schema as the SQLite baseline; vec stages skipped and named in the meta)
//   compare-fts   FTS-stage metrics of a candidate against the baseline: top-10, top-5, nDCG@10, the stop rule
//
// Usage (the eval dir is the prepared COPY from recall-eval.ts prepare; the admin URL comes from the environment,
// never from the command line, because it carries a password):
//   MARVEEN_PG_EVAL_URL=postgres://... npx tsx scripts/eval/recall-eval-pg.ts load --dir store/eval
//   MARVEEN_PG_EVAL_URL=postgres://... npx tsx scripts/eval/recall-eval-pg.ts snapshot --dir store/eval --out store/eval/pg-fts.json
//   npx tsx scripts/eval/recall-eval-pg.ts compare-fts --base store/eval/baseline-sqlite.json --cand store/eval/pg-fts.json
//
// Exit codes: 0 ok, 1 failure (missing queries, different query set), 2 usage or refusal, 3 STOP (the FTS-stage
// top-10 overlap is below the threshold: report to the architect, do not tune).
//
// Private data: the query set, the snapshots and the scratch database hold memory-derived text. They stay under
// store/ and the scratch database is dropped by the operator; nothing here commits or copies them.
import '../lib/log-to-stderr.js'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { compareFtsStage, buildFtsSnapshot, assertScratchDatabaseName, SCRATCH_DB_PREFIX, FTS_STOP_TOP10, type FtsStageReport } from './recall-eval-fts-stage.js'
import { copyEvalTables, countCorpus, createScratchDatabase, evalPool, runFtsStagePg, withDatabase } from './recall-eval-pg-io.js'
import type { QueryCase, Snapshot } from './recall-eval-lib.js'

const MARKER = '.eval-snapshot'
const PG_LOAD_FILE = 'pg-load.json'

function arg(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}
function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, 'utf8')) as T
}
function writeJson(p: string, v: unknown): void {
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 })
}
function adminUrl(): string | undefined {
  return process.env['MARVEEN_PG_EVAL_URL'] || process.env['MARVEEN_PG_TEST_URL'] || undefined
}
function requirePreparedDir(dir: string): boolean {
  if (existsSync(join(dir, MARKER))) return true
  console.error('FAIL', dir, 'is not a prepared eval dir (run recall-eval.ts prepare first)')
  return false
}

// ---------------------------------------------------------------------------------------------
// load
// ---------------------------------------------------------------------------------------------
async function cmdLoad(argv: string[]): Promise<number> {
  const dir = resolve(arg(argv, '--dir', 'store/eval')!)
  if (!requirePreparedDir(dir)) return 2
  const admin = adminUrl()
  if (!admin) { console.error(`FAIL set MARVEEN_PG_EVAL_URL (an admin URL of a throwaway PostgreSQL server)`); return 2 }
  const sqlitePath = join(dir, 'claudeclaw.db')
  if (!existsSync(sqlitePath)) { console.error('FAIL no eval copy at', sqlitePath); return 2 }

  const database = `${SCRATCH_DB_PREFIX}${randomBytes(4).toString('hex')}`
  assertScratchDatabaseName(database)
  await createScratchDatabase(admin, database)
  const pool = evalPool(withDatabase(admin, database))
  try {
    // the baseline schema first (the same files the server boots with), then the preflight: fail closed on a server
    // without UTF8 or without unaccent, and only then the copy
    const { applyPgMigrations } = await import('../../src/db-migrations-pg.js')
    const { pgPreflight } = await import('../../src/db/pg/index.js')
    await applyPgMigrations(pool) // the default dir: the same baseline the server boots with
    const pre = await pgPreflight(pool)
    const Database = (await import('better-sqlite3')).default
    const src = new Database(sqlitePath, { readonly: true, fileMustExist: true })
    let report
    try {
      report = await copyEvalTables(src, pool)
    } finally {
      src.close()
    }
    const counts = await countCorpus(pool)
    writeJson(join(dir, PG_LOAD_FILE), {
      database,
      loadedAt: new Date().toISOString(),
      warnings: pre.warnings,
      counts,
      tables: Object.fromEntries(Object.entries(report.tables).map(([t, v]) => [t, { rows: v.rows, dropped: v.plan.dropped, generated: v.plan.generated }])),
    })
    console.log(`loaded scratch database ${database}: ${JSON.stringify(counts)}`)
    for (const w of pre.warnings) console.log('warning:', w)
    for (const [t, v] of Object.entries(report.tables)) if (v.plan.dropped.length) console.log(`  ${t}: not copied (SQLite only): ${v.plan.dropped.join(', ')}`)
    return 0
  } finally {
    await pool.end()
  }
}

// ---------------------------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------------------------
async function cmdSnapshot(argv: string[]): Promise<number> {
  const dir = resolve(arg(argv, '--dir', 'store/eval')!)
  if (!requirePreparedDir(dir)) return 2
  const out = resolve(arg(argv, '--out', join(dir, 'pg-fts.json'))!)
  const admin = adminUrl()
  if (!admin) { console.error('FAIL set MARVEEN_PG_EVAL_URL'); return 2 }
  const loadFile = join(dir, PG_LOAD_FILE)
  if (!existsSync(loadFile)) { console.error('FAIL no', PG_LOAD_FILE, '(run load first)'); return 2 }
  const { database } = readJson<{ database: string }>(loadFile)
  assertScratchDatabaseName(database)

  const evalMeta = readJson<{ frozenNowSec: number }>(join(dir, 'eval-meta.json'))
  const { cases } = readJson<{ cases: QueryCase[] }>(join(dir, 'recall-queries.json'))
  const pool = evalPool(withDatabase(admin, database))
  try {
    const runs = await runFtsStagePg(pool, cases, evalMeta.frozenNowSec)
    const snap: Snapshot = buildFtsSnapshot({
      runs,
      corpus: await countCorpus(pool),
      gitSha: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
      frozenNowSec: evalMeta.frozenNowSec,
      querySetSha256: sha256(JSON.stringify(cases)),
    })
    writeJson(out, snap)
    const empty = runs.filter((r) => (r.stages.fts ?? []).length === 0).length
    console.log(`snapshot ${out}: ${runs.length} queries, ${empty} with an empty fts list, backend=${snap.meta.backend}`)
    return 0
  } finally {
    await pool.end()
  }
}

// ---------------------------------------------------------------------------------------------
// compare-fts
// ---------------------------------------------------------------------------------------------
function printReport(rep: FtsStageReport): void {
  const f = (x?: number) => (x === undefined ? 'n/a' : x.toFixed(4))
  for (const k of rep.kinds) {
    console.log(`${k.kind.padEnd(9)} n=${k.queries} (empty baseline: ${k.skippedEmptyBaseline})  fts top10=${f(k.top10)}  fts top5=${f(k.top5)}  nDCG@10=${f(k.ndcgAt10)}  nDCG drop=${f(k.ndcgDrop)}`)
  }
  console.log(`examined: ${rep.examined.length ? rep.examined.join(', ') : 'none'}`)
  if (rep.skipped.length === 0) console.log('skipped: none')
  for (const s of rep.skipped) console.log(`skipped: ${s.kind} x${s.queries} (${s.reason})`)
  for (const w of rep.worst) console.log(`  worst ${w.id}: top10=${f(w.top10)} top5=${f(w.top5)}`)
  for (const x of rep.failures) console.log('FAIL', x)
  if (rep.stop) console.log(`STOP ${rep.stopReason}`)
}

function cmdCompareFts(argv: string[]): number {
  const base = readJson<Snapshot>(resolve(arg(argv, '--base')!))
  const cand = readJson<Snapshot>(resolve(arg(argv, '--cand')!))
  const rep = compareFtsStage(base, cand, FTS_STOP_TOP10)
  printReport(rep)
  if (rep.failures.length) { console.log('FAILED'); return 1 }
  if (rep.stop) return 3
  console.log('OK (FTS stage; the final-stage gate comes with the vector step)')
  return 0
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'load': return cmdLoad(rest)
    case 'snapshot': return cmdSnapshot(rest)
    case 'compare-fts': return cmdCompareFts(rest)
    default: console.error('usage: recall-eval-pg.ts load|snapshot|compare-fts (see file header)'); return 2
  }
}
main().then((rc) => process.exit(rc), (err) => { console.error(err); process.exit(1) })
