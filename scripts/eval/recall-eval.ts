#!/usr/bin/env tsx
// Recall/quality baseline harness (PostgreSQL migration, Phase 0 gate).
//
// Freezes what the CURRENT retrieval pipeline returns for a fixed query set so a later backend
// (tsvector + pgvector) can be compared against it. Subcommands:
//
//   prepare       copy the live DB into an isolated eval dir (SQLite backup API, read-only on the
//                 source), drop orphan vec rows from the COPY, write eval-meta.json
//   gen-queries   derive the query set from the corpus in the eval dir (seeded, reproducible)
//   embed         fetch Ollama embeddings for every query once and cache them (pins determinism)
//   snapshot      run the real pipeline (frozen clock, embeddings from the cache, no network)
//                 and write the ordered ids per stage
//   compare       baseline vs candidate snapshot, with the accepted thresholds; exit 1 on failure
//
// Usage (the eval dir is a COPY; snapshot refuses to run against anything else):
//   npx tsx scripts/eval/recall-eval.ts prepare   --out store/eval
//   npx tsx scripts/eval/recall-eval.ts gen-queries --dir store/eval [--seed 1] [--memories 140 --docs 40]
//   npx tsx scripts/eval/recall-eval.ts embed     --dir store/eval
//   MARVEEN_STORE_DIR=$PWD/store/eval npx tsx scripts/eval/recall-eval.ts snapshot --dir store/eval --out baseline-sqlite.json
//   npx tsx scripts/eval/recall-eval.ts compare   --base a.json --cand b.json
//
// The real-data query set, the embedding cache and the baseline contain private memory content or
// ids: keep them under store/ (gitignored), never commit them.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runCases } from './recall-eval-run.js'
import {
  compareSnapshots,
  DEFAULT_THRESHOLDS,
  embedKey as libEmbedKey,
  keywordQuery,
  leadingWords,
  phraseSpan,
  seededRng,
  stripAccents,
  type QueryCase,
  type Snapshot,
} from './recall-eval-lib.js'

const EMBED_MODEL = 'nomic-embed-text'
const MARKER = '.eval-snapshot'

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

// ---------------------------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------------------------
async function cmdPrepare(argv: string[]): Promise<number> {
  const out = resolve(arg(argv, '--out', 'store/eval')!)
  const src = resolve(arg(argv, '--src', join(process.env['MARVEEN_LIVE_STORE'] ?? 'store', 'claudeclaw.db'))!)
  if (!existsSync(src)) { console.error('FAIL source db not found:', src); return 2 }
  mkdirSync(out, { recursive: true, mode: 0o700 })
  const dest = join(out, 'claudeclaw.db')
  if (existsSync(dest) && !argv.includes('--force')) { console.error('FAIL', dest, 'exists (use --force to replace)'); return 2 }

  const Database = (await import('better-sqlite3')).default
  const { load } = await import('sqlite-vec')
  const source = new Database(src, { readonly: true, fileMustExist: true })
  await source.backup(dest) // consistent snapshot, source untouched
  source.close()

  const copy = new Database(dest)
  load(copy)
  const orphanDocs = copy.prepare('DELETE FROM vec_workspace_docs WHERE doc_id NOT IN (SELECT id FROM workspace_docs)').run().changes
  const orphanMem = copy.prepare('DELETE FROM vec_memories WHERE memory_id NOT IN (SELECT id FROM memories)').run().changes
  const orphanArt = copy.prepare('DELETE FROM vec_artifacts WHERE artifact_rowid NOT IN (SELECT rowid FROM artifacts)').run().changes
  copy.close()

  const frozenNowSec = Math.floor(Date.now() / 1000)
  writeFileSync(join(out, MARKER), 'eval snapshot copy: safe to initialise/migrate\n')
  writeJson(join(out, 'eval-meta.json'), { frozenNowSec, source: src, orphansDroppedFromCopy: { vec_workspace_docs: orphanDocs, vec_memories: orphanMem, vec_artifacts: orphanArt } })
  console.log(`prepared ${dest}  frozenNowSec=${frozenNowSec}  orphans dropped from the COPY: docs=${orphanDocs} memories=${orphanMem} artifacts=${orphanArt}`)
  return 0
}

// ---------------------------------------------------------------------------------------------
// gen-queries
// ---------------------------------------------------------------------------------------------
interface MemRow { id: number; agent_id: string; tenant_id: string; content: string; keywords: string | null; category: string }
interface DocRow { id: string; agent_id: string; tenant_id: string; title: string; content: string | null }
interface ArtRow { id: string; title: string }

/** Quota per group proportional to sqrt(size), at least 1, trimmed to the total. */
function sqrtQuotas(sizes: Record<string, number>, total: number): Record<string, number> {
  const keys = Object.keys(sizes).filter((k) => sizes[k] > 0)
  const weight = Object.fromEntries(keys.map((k) => [k, Math.sqrt(sizes[k])]))
  const sum = keys.reduce((a, k) => a + weight[k], 0) || 1
  const quotas: Record<string, number> = {}
  for (const k of keys) quotas[k] = Math.min(sizes[k], Math.max(1, Math.round((weight[k] / sum) * total)))
  return quotas
}

async function cmdGenQueries(argv: string[]): Promise<number> {
  const dir = resolve(arg(argv, '--dir', 'store/eval')!)
  if (!existsSync(join(dir, MARKER))) { console.error('FAIL', dir, 'is not a prepared eval dir'); return 2 }
  const seed = Number(arg(argv, '--seed', '1'))
  const nMem = Number(arg(argv, '--memories', '140'))
  const nDoc = Number(arg(argv, '--docs', '40'))
  const rng = seededRng(seed)
  const Database = (await import('better-sqlite3')).default
  const db = new Database(join(dir, 'claudeclaw.db'), { readonly: true, fileMustExist: true })

  const shuffle = <T,>(a: T[]): T[] => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b[i], b[j]] = [b[j], b[i]] } return b }
  const cases: QueryCase[] = []
  const seen = new Set<string>()
  const add = (c: Omit<QueryCase, 'id'>) => {
    const key = `${c.kind}|${c.agentId ?? ''}|${c.text.toLowerCase()}`
    if (!c.text || c.text.length < 4 || seen.has(key)) return false
    seen.add(key)
    cases.push({ ...c, id: `${c.kind}:${String(cases.filter((x) => x.kind === c.kind).length + 1).padStart(3, '0')}` })
    return true
  }

  const mems = db.prepare("SELECT id, agent_id, tenant_id, content, keywords, category FROM memories WHERE length(content) >= 40 ORDER BY id").all() as MemRow[]
  const byAgent: Record<string, MemRow[]> = {}
  for (const m of mems) (byAgent[m.agent_id] ??= []).push(m)
  const quotas = sqrtQuotas(Object.fromEntries(Object.entries(byAgent).map(([k, v]) => [k, v.length])), nMem)
  const styles: ((m: MemRow) => { style: string; text?: string })[] = [
    (m) => ({ style: 'keywords', text: keywordQuery(m.keywords, 3) }),
    (m) => ({ style: 'phrase', text: phraseSpan(m.content, 5, rng) }),
    (m) => ({ style: 'question', text: leadingWords(m.content, 8) }),
    (m) => ({ style: 'noaccent', text: (() => { const p = phraseSpan(m.content, 5, rng); return p ? stripAccents(p) : undefined })() }),
  ]
  let styleIdx = 0
  for (const agent of Object.keys(quotas).sort()) {
    let taken = 0
    for (const m of shuffle(byAgent[agent])) {
      if (taken >= quotas[agent]) break
      for (let t = 0; t < styles.length; t++) {
        const s = styles[(styleIdx + t) % styles.length](m)
        if (s.text && add({ kind: 'memory', agentId: m.agent_id, tenantId: m.tenant_id, text: s.text, style: s.style })) { taken++; styleIdx++; break }
      }
    }
  }

  const docs = db.prepare("SELECT id, agent_id, tenant_id, title, content FROM workspace_docs WHERE content_type IN ('text','code') ORDER BY id").all() as DocRow[]
  const docQuotas = sqrtQuotas(Object.fromEntries(Object.entries(docs.reduce<Record<string, number>>((a, d) => ((a[d.agent_id] = (a[d.agent_id] ?? 0) + 1), a), {}))), nDoc)
  const docByAgent: Record<string, DocRow[]> = {}
  for (const d of docs) (docByAgent[d.agent_id] ??= []).push(d)
  let docIdx = 0
  for (const agent of Object.keys(docQuotas).sort()) {
    let taken = 0
    for (const d of shuffle(docByAgent[agent])) {
      if (taken >= docQuotas[agent]) break
      const useTitle = docIdx++ % 2 === 0
      const text = useTitle ? d.title : d.content ? phraseSpan(d.content, 6, rng) : undefined
      if (text && add({ kind: 'doc', agentId: useTitle ? undefined : d.agent_id, tenantId: d.tenant_id, text, style: useTitle ? 'title' : 'phrase' })) taken++
    }
  }

  for (const a of db.prepare('SELECT id, title FROM artifacts ORDER BY rowid').all() as ArtRow[]) add({ kind: 'artifact', text: a.title, style: 'title' })

  writeJson(join(dir, 'recall-queries.json'), { seed, cases })
  const byKind = cases.reduce<Record<string, number>>((a, c) => ((a[c.kind] = (a[c.kind] ?? 0) + 1), a), {})
  console.log(`generated ${cases.length} queries`, byKind, 'sha256', sha256(JSON.stringify(cases)).slice(0, 12))
  return 0
}

// ---------------------------------------------------------------------------------------------
// embed
// ---------------------------------------------------------------------------------------------
const embedKey = (prompt: string) => libEmbedKey(prompt, EMBED_MODEL)

async function cmdEmbed(argv: string[]): Promise<number> {
  const dir = resolve(arg(argv, '--dir', 'store/eval')!)
  const ollama = arg(argv, '--ollama', process.env['OLLAMA_URL'] ?? 'http://localhost:11434')!
  const { cases } = readJson<{ cases: QueryCase[] }>(join(dir, 'recall-queries.json'))
  const cachePath = join(dir, 'query-embeddings.json')
  const cache: Record<string, number[]> = existsSync(cachePath) ? readJson(cachePath) : {}
  let fetched = 0
  for (const c of cases) {
    const key = embedKey(c.text)
    if (cache[key]) continue
    const resp = await fetch(`${ollama}/api/embeddings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: c.text.slice(0, 2000) }),
    })
    const data = (await resp.json()) as { embedding?: number[] }
    if (!data.embedding || data.embedding.length !== 768) { console.error('FAIL no 768-dim embedding for', c.id); return 1 }
    cache[key] = data.embedding
    fetched++
  }
  writeJson(cachePath, cache)
  console.log(`embeddings cached: ${Object.keys(cache).length} (${fetched} fetched)`)
  return 0
}

// ---------------------------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------------------------
async function cmdSnapshot(argv: string[]): Promise<number> {
  const dir = resolve(arg(argv, '--dir', 'store/eval')!)
  const out = resolve(arg(argv, '--out', join(dir, 'baseline-sqlite.json'))!)
  if (!existsSync(join(dir, MARKER))) { console.error('FAIL', dir, 'is not a prepared eval dir (refusing to touch anything else)'); return 2 }
  if (resolve(process.env['MARVEEN_STORE_DIR'] ?? '') !== dir) {
    console.error('FAIL MARVEEN_STORE_DIR must equal the eval dir', dir, '(got', process.env['MARVEEN_STORE_DIR'] ?? '<unset>', ')')
    return 2
  }
  const evalMeta = readJson<{ frozenNowSec: number }>(join(dir, 'eval-meta.json'))
  const { cases } = readJson<{ cases: QueryCase[] }>(join(dir, 'recall-queries.json'))
  const embeddings = readJson<Record<string, number[]>>(join(dir, 'query-embeddings.json'))

  // The cross-encoder rerank is backend independent but slow (minutes per run on CPU). `--rerank off|on`
  // pins the flag in the eval COPY's system_config so the fast RRF-only baseline and the slow reranked one
  // can both be frozen; the default `as-is` keeps whatever the live config had at prepare time.
  const rerankMode = arg(argv, '--rerank', 'as-is')!
  if (!['as-is', 'on', 'off'].includes(rerankMode)) { console.error('FAIL --rerank must be as-is|on|off'); return 2 }
  if (rerankMode !== 'as-is') {
    const Database = (await import('better-sqlite3')).default
    const cfgDb = new Database(join(dir, 'claudeclaw.db'))
    cfgDb.prepare(
      "INSERT INTO system_config(key, value, updated_at) VALUES('MEMORY_RERANK_ENABLED', ?, unixepoch()) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run(rerankMode === 'on' ? '1' : '0')
    cfgDb.close()
  }

  // Determinism: frozen clock, embeddings only from the cache (a miss is an error, never a live call).
  const frozenMs = evalMeta.frozenNowSec * 1000
  Date.now = () => frozenMs
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input)
    if (!url.endsWith('/api/embeddings')) return realFetch(input as never, init as never)
    const prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt
    const emb = embeddings[embedKey(prompt)]
    if (!emb) throw new Error(`embedding cache miss for prompt "${prompt.slice(0, 40)}"`)
    return new Response(JSON.stringify({ embedding: emb }), { status: 200 })
  }) as typeof fetch

  const conn = await import('../../src/db/connection.js')
  conn.initDatabase()
  const db = conn.getDb()
  if (!conn.vecExtensionLoaded) { console.error('FAIL sqlite-vec did not load'); return 1 }
  const { getEffectiveSettingValue } = await import('../../src/settings-store.js')
  const rerankEnabled = getEffectiveSettingValue('MEMORY_RERANK_ENABLED') === '1'

  const runs = await runCases(db, cases, embeddings, evalMeta.frozenNowSec)

  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  const snap: Snapshot = {
    meta: {
      createdAt: new Date(evalMeta.frozenNowSec * 1000).toISOString(),
      gitSha: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
      backend: 'sqlite+sqlite-vec',
      vecVersion: (db.prepare('select vec_version() v').get() as { v: string }).v,
      frozenNowSec: evalMeta.frozenNowSec,
      rerankEnabled,
      embedModel: EMBED_MODEL,
      corpus: { memories: count('select count(*) n from memories'), workspace_docs: count('select count(*) n from workspace_docs'), artifacts: count('select count(*) n from artifacts') },
      querySetSha256: sha256(JSON.stringify(cases)),
      notes: ['vec_prod mirrors src/db/vector.ts vectorSearch (ANN + filter + recency); vec_exact = filter-then-exact-L2 (the PG target)', 'orphan vec rows were dropped from the COPY by prepare'],
    },
    runs,
  }
  writeJson(out, snap)
  const empty = runs.filter((r) => (r.stages.final ?? []).length === 0).length
  console.log(`snapshot ${out}: ${runs.length} queries, ${empty} with an empty final list, rerank=${rerankEnabled}`)
  return 0
}

// ---------------------------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------------------------
function cmdCompare(argv: string[]): number {
  const base = readJson<Snapshot>(resolve(arg(argv, '--base')!))
  const cand = readJson<Snapshot>(resolve(arg(argv, '--cand')!))
  const rep = compareSnapshots(base, cand, DEFAULT_THRESHOLDS)
  for (const k of rep.kinds) {
    const f = (x?: number) => (x === undefined ? 'n/a' : x.toFixed(4))
    console.log(`${k.kind.padEnd(9)} n=${k.queries} (empty baseline: ${k.skippedEmptyBaseline})  vec recall@10=${f(k.vecRecallAt10)}  fts recall@10=${f(k.ftsRecallAt10)}  final top5=${f(k.finalTop5Overlap)}  nDCG@10=${f(k.finalNdcgAt10)}  MRR=${f(k.finalMrr)}`)
  }
  for (const w of rep.worst) console.log(`  worst ${w.id}: top5=${w.finalTop5Overlap?.toFixed(2)} ndcg=${w.finalNdcgAt10?.toFixed(3)}`)
  for (const f of rep.failures) console.log('FAIL', f)
  console.log(rep.pass ? 'PASS' : 'FAILED')
  return rep.pass ? 0 : 1
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'prepare': return cmdPrepare(rest)
    case 'gen-queries': return cmdGenQueries(rest)
    case 'embed': return cmdEmbed(rest)
    case 'snapshot': return cmdSnapshot(rest)
    case 'compare': return cmdCompare(rest)
    default: console.error('usage: recall-eval.ts prepare|gen-queries|embed|snapshot|compare (see file header)'); return 2
  }
}
main().then((rc) => process.exit(rc), (err) => { console.error(err); process.exit(1) })
