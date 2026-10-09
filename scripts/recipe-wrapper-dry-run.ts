#!/usr/bin/env tsx
// Read-only dry run: finds the old "curl + dashboard token" recipes in the live fleet material and
// prints, per hit, `old -> new` (the same call through scripts/agent-api.sh), the owner, and whether
// the endpoint is admin-only for a fleet agent (then the new call carries `--token admin`).
//
//   npx tsx scripts/recipe-wrapper-dry-run.ts [--json] [--install DIR] [--home DIR] [--no-schedules-api]
//
// It never writes to a scanned file and never calls a mutating API: files are read, the schedules
// registry is read with one GET (only when the dashboard answers within 5 s). Exit code is always 0.
//
// Scanned: (a) global skills <home>/.claude/skills, (a2) the main agent's own skills <install>/.claude/skills
// (owner "main"), (b) per-agent skills <install>/agents/*/.claude/skills,
// (c) <install>/CLAUDE.md and <install>/agents/*/CLAUDE.md, (d) <home>/.claude/scheduled-tasks/*,
// (e) the schedules registry (GET /api/schedules). Symlinks that leave a scanned root, binary files,
// node_modules, .git and *.bak are skipped.

import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { planRewrite, type InlineAssignment, type PlanEdit, type PlanManual, type PlanSkip } from './lib/recipe-migrate.js'
// @ts-expect-error plain .mjs, no declaration file
import { agentApi } from './lib/agent-api.mjs'

// ── Report model ────────────────────────────────────────────────────────────

export type Source = 'global-skill' | 'main-skill' | 'agent-skill' | 'claude-md' | 'schedule-file' | 'schedule-api'
export const SOURCES: readonly Source[] = ['global-skill', 'main-skill', 'agent-skill', 'claude-md', 'schedule-file', 'schedule-api']

interface Annotated { block: string | null; where?: string }
export type ReportEdit = Omit<PlanEdit, 'start' | 'end'> & Annotated
export type ReportSkip = PlanSkip & Annotated
export type ReportManual = PlanManual & Annotated
export type ReportInline = InlineAssignment & Annotated

export interface FileReport {
  source: Source
  /** "global", "main" (the main agent's own skills), an agent id, or the agent a schedule belongs to. */
  owner: string
  /** The schedule name for (d) and (e). */
  schedule?: string
  path: string
  edits: ReportEdit[]
  skipped: ReportSkip[]
  manual: ReportManual[]
  assignmentsToDrop: Array<{ line: number; where?: string }>
  inlineAssignments: ReportInline[]
}

export interface SourceCounts { filesScanned: number; filesWithHits: number; edits: number; adminEdits: number; skipped: number; manual: number; mentions: number }

export interface Report {
  install: string
  home: string
  wrapper: string
  notes: string[]
  summary: SourceCounts & { bySource: Record<Source, SourceCounts> }
  files: FileReport[]
}

export interface DryRunOptions {
  install: string
  home: string
  /** Query GET /api/schedules (default true). */
  schedulesApi?: boolean
  /** Injected for tests; defaults to the real dashboard call. */
  fetchSchedules?: () => Promise<unknown[] | { note: string }>
}

// ── Generated blocks in CLAUDE.md ───────────────────────────────────────────

const BLOCK_BEGIN = [/^<!--\s*BEGIN GENERATED:\s*([\w-]+)/, /^<!--\s*(MARVEEN-[A-Z]+):BEGIN/]
const BLOCK_END = [/^<!--\s*END GENERATED:\s*([\w-]+)/, /^<!--\s*MARVEEN-[A-Z]+:END/]

/** For each 1-based line, the name of the managed block it sits in (between marker lines), or null. */
export function generatedBlockMap(text: string): Array<string | null> {
  const out: Array<string | null> = [null]
  let current: string | null = null
  for (const line of text.split('\n')) {
    const begin = BLOCK_BEGIN.map(r => r.exec(line)).find(Boolean)
    if (begin) current = begin[1]
    out.push(current)
    if (BLOCK_END.some(r => r.test(line))) current = null
  }
  return out
}

// ── File walking (read only) ────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__'])
const MAX_BYTES = 2 * 1024 * 1024

function isBinary(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, 4096, 0)
    return buf.subarray(0, n).includes(0)
  } finally { closeSync(fd) }
}

const within = (root: string, p: string): boolean => p === root || p.startsWith(root + sep)

/** Text files under root (paths as seen under root). Symlinks leaving root are not followed. */
function walkText(root: string, seen: Set<string>, notes: string[]): string[] {
  if (!existsSync(root)) return []
  const realRoot = realpathSync(root)
  const files: string[] = []
  const dirsSeen = new Set<string>()
  const visit = (dir: string): void => {
    let real: string
    try { real = realpathSync(dir) } catch { return }
    if (dirsSeen.has(real)) return
    dirsSeen.add(real)
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const name of names.sort()) {
      if (SKIP_DIRS.has(name) || name.endsWith('.bak')) continue
      const p = join(dir, name)
      let target = p
      let lst
      try { lst = lstatSync(p) } catch { continue }
      if (lst.isSymbolicLink()) {
        try { target = realpathSync(p) } catch { continue }
        if (!within(realRoot, target)) { notes.push(`symlink leaving the scanned root not followed: ${p}`); continue }
      }
      let st
      try { st = statSync(target) } catch { continue }
      if (st.isDirectory()) { visit(p); continue }
      if (!st.isFile() || st.size > MAX_BYTES || seen.has(target)) continue
      try { if (isBinary(target)) continue } catch { continue }
      seen.add(target)
      files.push(p)
    }
  }
  visit(root)
  return files
}

const readText = (p: string): string | null => { try { return readFileSync(p, 'utf-8') } catch { return null } }

// ── Scanning ────────────────────────────────────────────────────────────────

type Plan = ReturnType<typeof planRewrite>

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'"
}

/** Collects the plans of one or more text fragments of the same file into a FileReport. */
class FileCollector {
  readonly report: FileReport
  constructor(base: Omit<FileReport, 'edits' | 'skipped' | 'manual' | 'assignmentsToDrop' | 'inlineAssignments'>) {
    this.report = { ...base, edits: [], skipped: [], manual: [], assignmentsToDrop: [], inlineAssignments: [] }
  }
  add(plan: Plan, blocks: Array<string | null> | null, where?: string): void {
    const ann = (line: number): Annotated => ({ block: blocks ? blocks[line] ?? null : null, ...(where ? { where } : {}) })
    for (const e of plan.edits) {
      const { start: _s, end: _e, ...rest } = e
      this.report.edits.push({ ...rest, ...ann(e.line) })
    }
    for (const s of plan.skipped) this.report.skipped.push({ ...s, ...ann(s.line) })
    for (const m of plan.manual) this.report.manual.push({ ...m, ...ann(m.line) })
    for (const l of plan.assignmentsToDrop) this.report.assignmentsToDrop.push({ line: l, ...(where ? { where } : {}) })
    for (const a of plan.inlineAssignments) this.report.inlineAssignments.push({ ...a, ...ann(a.line) })
  }
  get hasHits(): boolean {
    const r = this.report
    return r.edits.length + r.skipped.length + r.manual.length + r.assignmentsToDrop.length + r.inlineAssignments.length > 0
  }
}

/** Strings worth scanning inside a parsed JSON document, with a label of where they sit. */
function jsonStrings(value: unknown, label: string, out: Array<{ where: string; text: string }>): void {
  if (typeof value === 'string') { out.push({ where: label, text: value }); return }
  if (Array.isArray(value)) { value.forEach((v, i) => jsonStrings(v, `${label}[${i}]`, out)); return }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) jsonStrings(v, label ? `${label}.${k}` : k, out)
  }
}

/** A `command` field is shell code; any other string of a task config (a prompt) is markdown. */
const isShellField = (where: string): boolean => /(^|\.)command$/.test(where)

interface Base { wrapper: string; defaultPort: number }

function scanJsonOrText(text: string, base: Base, collector: FileCollector, blocks: Array<string | null> | null, kind: 'json' | 'markdown' | 'code'): void {
  if (kind === 'json') {
    try {
      const parsed: unknown = JSON.parse(text)
      const strings: Array<{ where: string; text: string }> = []
      jsonStrings(parsed, '', strings)
      for (const s of strings) {
        if (!/curl|token/i.test(s.text)) continue
        collector.add(planRewrite(s.text, { ...base, markdown: !isShellField(s.where) }), null, s.where)
      }
      return
    } catch { /* not valid JSON: scan it as text below */ }
  }
  collector.add(planRewrite(text, { ...base, markdown: kind === 'markdown' }), blocks)
}

/** A value from <install>/.env (read only), or null. */
function envValue(install: string, key: string): string | null {
  const m = new RegExp(`^${key}=["']?([^"'\\n]+)`, 'm').exec(readText(join(install, '.env')) ?? '')
  return m ? m[1].trim() : null
}

const mainAgentId = (install: string): string => envValue(install, 'MAIN_AGENT_ID') ?? 'main'

function emptyCounts(): SourceCounts {
  return { filesScanned: 0, filesWithHits: 0, edits: 0, adminEdits: 0, skipped: 0, manual: 0, mentions: 0 }
}

export async function runDryRun(opts: DryRunOptions): Promise<Report> {
  const install = resolve(opts.install)
  const home = resolve(opts.home)
  const wrapper = `bash ${shellQuote(join(install, 'scripts', 'agent-api.sh'))}`
  const base: Base = { wrapper, defaultPort: Number(envValue(install, 'WEB_PORT')) || 3420 }
  const notes: string[] = []
  const seen = new Set<string>()
  const files: FileReport[] = []
  const bySource = Object.fromEntries(SOURCES.map(s => [s, emptyCounts()])) as Record<Source, SourceCounts>

  const scanFile = (source: Source, owner: string, path: string, extra: { schedule?: string; json?: boolean; claudeMd?: boolean } = {}): void => {
    const text = readText(path)
    if (text === null) return
    bySource[source].filesScanned++
    const c = new FileCollector({ source, owner, path, ...(extra.schedule ? { schedule: extra.schedule } : {}) })
    const kind = extra.json ? 'json' : /\.(md|markdown)$/i.test(path) ? 'markdown' : 'code'
    scanJsonOrText(text, base, c, extra.claudeMd ? generatedBlockMap(text) : null, kind)
    if (c.hasHits) files.push(c.report)
  }

  // (a) global skills
  for (const p of walkText(join(home, '.claude', 'skills'), seen, notes)) scanFile('global-skill', 'global', p)

  // (a2) the main agent's own skills. When install and home are the same directory this is the same tree as (a)
  // and the `seen` set keeps every file in the first source.
  for (const p of walkText(join(install, '.claude', 'skills'), seen, notes)) scanFile('main-skill', 'main', p)

  // (b) + (c) per-agent skills and CLAUDE.md
  const agentsDir = join(install, 'agents')
  const agentIds: string[] = []
  if (existsSync(agentsDir)) {
    for (const name of readdirSync(agentsDir).sort()) {
      try { if (lstatSync(join(agentsDir, name)).isDirectory()) agentIds.push(name) } catch { /* skip */ }
    }
  }
  for (const id of agentIds) {
    for (const p of walkText(join(agentsDir, id, '.claude', 'skills'), seen, notes)) scanFile('agent-skill', id, p)
  }
  const claudeMds: Array<[string, string]> = [[mainAgentId(install), join(install, 'CLAUDE.md')]]
  for (const id of agentIds) claudeMds.push([id, join(agentsDir, id, 'CLAUDE.md')])
  for (const [owner, p] of claudeMds) if (existsSync(p)) scanFile('claude-md', owner, p, { claudeMd: true })

  // (d) scheduled-task files (a mirror of the schedules registry)
  const tasksRoot = join(home, '.claude', 'scheduled-tasks')
  const configAgent = new Map<string, string>()
  for (const p of walkText(tasksRoot, seen, notes)) {
    const schedule = p.slice(tasksRoot.length + 1).split(sep)[0]
    if (!configAgent.has(schedule)) {
      let agent = 'global'
      const cfg = readText(join(tasksRoot, schedule, 'task-config.json'))
      if (cfg) { try { const a = (JSON.parse(cfg) as { agent?: unknown }).agent; if (typeof a === 'string' && a) agent = a } catch { /* keep global */ } }
      configAgent.set(schedule, agent)
    }
    scanFile('schedule-file', configAgent.get(schedule) ?? 'global', p, { schedule, json: p.endsWith('.json') })
  }

  // (e) the schedules registry, only when the dashboard answers
  if (opts.schedulesApi !== false) {
    const fetched = await (opts.fetchSchedules ?? (() => fetchSchedules(install)))()
    if (!Array.isArray(fetched)) {
      notes.push(`schedules registry not read: ${fetched.note}`)
    } else {
      for (const item of fetched) {
        if (!item || typeof item !== 'object') continue
        const row = item as Record<string, unknown>
        const name = String(row.name ?? row.id ?? '?')
        const owner = String(row.agent ?? row.agent_id ?? 'global')
        bySource['schedule-api'].filesScanned++
        const c = new FileCollector({ source: 'schedule-api', owner, schedule: name, path: `GET /api/schedules (${name})` })
        for (const field of ['command', 'prompt']) {
          const v = row[field]
          if (typeof v === 'string' && /curl|token/i.test(v)) c.add(planRewrite(v, { ...base, markdown: !isShellField(field) }), null, field)
        }
        if (c.hasHits) files.push(c.report)
      }
    }
  }

  // Totals
  for (const f of files) {
    const t = bySource[f.source]
    t.filesWithHits++
    t.edits += f.edits.length
    t.adminEdits += f.edits.filter(e => e.adminOnly).length
    t.skipped += f.skipped.length
    t.manual += f.manual.filter(m => m.kind !== 'mention').length
    t.mentions += f.manual.filter(m => m.kind === 'mention').length
  }
  const summary = emptyCounts()
  for (const s of SOURCES) for (const k of Object.keys(summary) as Array<keyof SourceCounts>) summary[k] += bySource[s][k]
  return { install, home, wrapper, notes, summary: { ...summary, bySource }, files }
}

async function fetchSchedules(install: string): Promise<unknown[] | { note: string }> {
  try {
    const r = await agentApi('GET', '/api/schedules', undefined, { installDir: install, kind: 'main', timeoutMs: 5000 })
    if (!r.ok) return { note: `GET /api/schedules answered HTTP ${r.status}` }
    const body: unknown = r.body
    if (Array.isArray(body)) return body
    if (body && typeof body === 'object') {
      for (const v of Object.values(body as Record<string, unknown>)) if (Array.isArray(v)) return v
    }
    return { note: 'GET /api/schedules returned an unexpected shape' }
  } catch (e) {
    return { note: `dashboard not reachable (${e instanceof Error ? e.name : 'error'})` }
  }
}

// ── Markdown rendering ──────────────────────────────────────────────────────

const SOURCE_LABEL: Record<Source, string> = {
  'global-skill': 'global skills',
  'main-skill': 'main agent skills',
  'agent-skill': 'agent skills',
  'claude-md': 'CLAUDE.md files',
  'schedule-file': 'scheduled-task files',
  'schedule-api': 'schedules registry (API)',
}

const ownerLabel = (f: FileReport): string => (f.schedule ? `${f.owner} / schedule ${f.schedule}` : f.owner)
const blockTag = (f: FileReport, block: string | null): string =>
  f.source === 'claude-md' ? (block ? ` [generated block: ${block}]` : ' [hand-written]') : ''
const whereTag = (where?: string): string => (where ? ` (${where})` : '')

export function renderMarkdown(r: Report): string {
  const out: string[] = []
  const s = r.summary
  out.push('# Recipe to wrapper dry run (read only)', '')
  out.push(`- install: \`${r.install}\``, `- home: \`${r.home}\``, `- wrapper in replacements: \`${r.wrapper}\``)
  out.push('- `[ADMIN]` = the endpoint is refused to a fleet agent token (RBAC table plus route rules); the new call carries `--token admin`.', '')
  out.push('## Summary', '')
  out.push('| source | files scanned | files with hits | edits | admin-only edits | skipped | manual | prose mentions |', '|---|---:|---:|---:|---:|---:|---:|---:|')
  for (const k of SOURCES) {
    const c = s.bySource[k]
    out.push(`| ${SOURCE_LABEL[k]} | ${c.filesScanned} | ${c.filesWithHits} | ${c.edits} | ${c.adminEdits} | ${c.skipped} | ${c.manual} | ${c.mentions} |`)
  }
  out.push(`| **total** | ${s.filesScanned} | ${s.filesWithHits} | ${s.edits} | ${s.adminEdits} | ${s.skipped} | ${s.manual} | ${s.mentions} |`, '')
  if (r.notes.length) { out.push('Notes:', ...r.notes.map(n => `- ${n}`), '') }

  out.push('## Edits (old -> new)', '')
  const withEdits = r.files.filter(f => f.edits.length || f.assignmentsToDrop.length || f.inlineAssignments.length)
  if (!withEdits.length) out.push('_none_', '')
  for (const f of withEdits) {
    out.push(`### ${ownerLabel(f)}: \`${f.path}\``, '')
    out.push('```diff')
    for (const e of f.edits) {
      out.push(`L${e.line}:${e.adminOnly ? ' [ADMIN]' : ''}${blockTag(f, e.block)}${whereTag(e.where)} ${e.method} ${e.path}`)
      for (const l of e.old.split('\n')) out.push(`- ${l}`)
      for (const l of e.replacement.split('\n')) out.push(`+ ${l}`)
    }
    for (const a of f.assignmentsToDrop) out.push(`L${a.line}:${whereTag(a.where)} drop this line: a token or base URL assignment whose variable is only used by converted calls`)
    for (const a of f.inlineAssignments) out.push(`L${a.line}:${blockTag(f, a.block)}${whereTag(a.where)} remove the inline assignment \`${a.text}\` (its variable is only used by converted calls)`)
    out.push('```', '')
  }

  out.push('## Skipped (dashboard calls left alone)', '')
  const withSkips = r.files.filter(f => f.skipped.length)
  if (!withSkips.length) out.push('_none_', '')
  for (const f of withSkips) {
    for (const k of f.skipped) out.push(`- ${ownerLabel(f)} \`${f.path}\` L${k.line}${blockTag(f, k.block)}${whereTag(k.where)}: ${k.reason}  \n  \`${k.snippet}\``)
  }
  out.push('')

  out.push('## Manual (credential uses the tool cannot convert)', '')
  const withManual = r.files.filter(f => f.manual.some(m => m.kind !== 'mention'))
  if (!withManual.length) out.push('_none_', '')
  for (const f of withManual) {
    for (const m of f.manual.filter(x => x.kind !== 'mention')) out.push(`- ${ownerLabel(f)} \`${f.path}\` L${m.line}${blockTag(f, m.block)}${whereTag(m.where)} [${m.kind}]: ${m.reason}  \n  \`${m.snippet}\``)
  }
  out.push('')

  out.push('## Prose mentions of a token file (documentation, review by hand)', '')
  const withMentions = r.files.filter(f => f.manual.some(m => m.kind === 'mention'))
  if (!withMentions.length) out.push('_none_', '')
  for (const f of withMentions) {
    const lines = f.manual.filter(m => m.kind === 'mention').map(m => `L${m.line}${m.block ? ` (${m.block})` : ''}`)
    out.push(`- ${ownerLabel(f)} \`${f.path}\`: ${lines.join(', ')}`)
  }
  out.push('')
  return out.join('\n')
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { json: boolean; install: string; home: string; api: boolean } {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  const o = { json: false, install: repo, home: homedir(), api: true }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') o.json = true
    else if (a === '--install' && argv[i + 1]) o.install = argv[++i]
    else if (a === '--home' && argv[i + 1]) o.home = argv[++i]
    else if (a === '--no-schedules-api') o.api = false
    else process.stderr.write(`recipe-wrapper-dry-run: ignoring unknown argument ${a}\n`)
  }
  return o
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2))
  const report = await runDryRun({ install: a.install, home: a.home, schedulesApi: a.api })
  process.stdout.write(a.json ? JSON.stringify(report, null, 2) + '\n' : renderMarkdown(report) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { process.stderr.write(`recipe-wrapper-dry-run: ${e instanceof Error ? e.message : String(e)}\n`) }).finally(() => { process.exitCode = 0 })
}
