#!/usr/bin/env node
// tools/qa/delta-class.mjs -- what a delta (base..HEAD) is made of, counted by a script instead of by hand.
//
// A delta QA starts with the same claim: "this is docs/tests only" or "src changed by N lines". This tool
// computes those facts from `git diff` and prints them as JSON: a class for every changed file, the number of
// lines changed in `src`, the awaits added (the same list tools/qa/await-mutants.mjs --list sweeps), the migrations
// and whether a gate file is touched. It decides NOTHING: there is no "QA not needed" field, what the facts mean
// stays a person's call.
//
//   node tools/qa/delta-class.mjs --base <sha> [--root <repo>] [--ts-root <dir>] [--json <path>]
//
// Classes (one per file, by the first rule that matches; a path no rule names is `src`, so "no src lines" is
// never claimed for a file the rules do not know):
//   migracio   src/migrations/*.sql
//   kapu-fajl  a gate: scripts/hooks/ and scripts/lib/ (except tests), scripts/ files with "gate" in the name, the
//              gate-adjacent scripts and sources self-pace-gate.mjs guards, the secret-gate workflow
//   teszt      __tests__/, *.test.* / *.spec.*, test_*.py, test/ and tests/ directories
//   docs       *.md (also CHANGELOG.md, README.md), LICENSE, and prose or assets under docs/ (txt, rst, images, pdf,
//              html); but a Markdown file under src/, seed-skills/, web/, agents/, personas/ or templates/ is loaded
//              by the product and stays `src`, and any other file under docs/ (docs/openapi.yaml, the API contract
//              the SDK is generated from) is `src`
//   ci/tools   .github/, tools/, package manifests and lock files, tsconfig*, vitest/eslint config
//   src        everything else
// A rename is classed by its new path; when the old path had another class, `oldClass` says so. A file counts
// as src (and as a migration or gate file) when EITHER of its two paths does. `depsChanged` is a fact beside the
// classes: a package.json or package-lock.json in any directory is in the delta (either path of a rename).
//
// Exit 0 when the report was made, 2 on a bad argument. Awaits need the TypeScript of tools/eslint; when it is
// missing `awaitsAdded` is null and `awaitsError` says why (a null, not a zero: nobody counted).
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { emit, loadTypeScript, parseArgs, resolveRoot } from './lib/common.mjs'
import { listAwaitMutants } from './lib/mutants.mjs'

export const CLASSES = ['src', 'teszt', 'docs', 'migracio', 'kapu-fajl', 'ci/tools']

// Scripts and sources that self-pace-gate.mjs treats as gate-adjacent (GATE_ADJACENT_SCRIPTS / _SOURCES).
const GATE_ADJACENT = new Set([
  'scripts/agent-api.sh', 'scripts/sync-hooks.sh', 'scripts/doctor.sh', 'scripts/gate-onfailure-check.py',
  'scripts/secret-gate.ts', 'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts',
])

const DOC_PROSE = /\.(mdx?|txt|rst|png|jpe?g|gif|svg|webp|pdf|html?)$/i

const isTestPath =(p) => /(^|\/)(__tests__|tests?)\//.test(p)
  || /\.(test|spec)\.[cm]?[tj]sx?$/.test(p)
  || /(^|\/)test_[^/]*\.py$/.test(p)

/** The class of one repo-relative path (forward slashes). */
export function classifyPath(p) {
  if (/^src\/migrations\/[^/]+\.sql$/.test(p)) return 'migracio'
  if (GATE_ADJACENT.has(p)) return 'kapu-fajl'
  if (/^scripts\/(hooks|lib)\//.test(p) && !isTestPath(p)) return 'kapu-fajl'
  if (/^scripts\/[^/]*gate[^/]*$/i.test(p) && !isTestPath(p)) return 'kapu-fajl'
  if (p === '.github/workflows/secret-gate.yml') return 'kapu-fajl'
  if (isTestPath(p)) return 'teszt'
  // A Markdown file the product loads at run time (a seed skill, a persona, a prompt) is not documentation.
  if (/^(src|seed-skills|web|agents|personas|templates)\//.test(p)) return 'src'
  if (/\.md$/i.test(p) || /^LICENSE(\..*)?$/.test(p)) return 'docs'
  // Under docs/ only prose and assets are docs. docs/openapi.yaml is the API contract (the source of the generated SDK,
  // checked by CI for breaking changes and by the CHANGELOG rule), so any other file there stays src.
  if (/^docs\//.test(p)) return DOC_PROSE.test(p) ? 'docs' : 'src'
  if (/^(\.github|tools)\//.test(p)
    || /^(package\.json|package-lock\.json|tsconfig[^/]*\.json|vitest\.config\.[cm]?[tj]s|\.gitignore)$/.test(p)
    || /^eslint\.config\.[cm]?[tj]s$/.test(p) || /^\.eslintrc/.test(p)) return 'ci/tools'
  return 'src'
}

/**
 * Parses the output of `git diff --name-status -z -M` and `git diff --numstat -z -M` (the same range) into one
 * entry per changed file. Binary files have no line counts: added/deleted are 0 and `binary` is true.
 */
export function parseDelta(nameStatusZ, numstatZ) {
  const files = new Map()
  const ns = nameStatusZ.split('\0')
  for (let i = 0; i < ns.length && ns[i] !== ''; ) {
    const code = ns[i++]
    const kind = code[0]
    if (kind === 'R' || kind === 'C') {
      const oldPath = ns[i++]
      const newPath = ns[i++]
      files.set(newPath, { path: newPath, oldPath, status: kind, added: 0, deleted: 0, binary: false })
    } else {
      const p = ns[i++]
      files.set(p, { path: p, status: kind, added: 0, deleted: 0, binary: false })
    }
  }
  const nu = numstatZ.split('\0')
  for (let i = 0; i < nu.length && nu[i] !== ''; ) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(nu[i++])
    if (!m) throw new Error(`unexpected numstat record: ${nu[i - 1]}`)
    let p = m[3]
    if (p === '') { i++; p = nu[i++] } // rename: "a\td\t" then the old and the new path as the next two records
    const f = files.get(p)
    if (!f) throw new Error(`numstat names a file name-status did not: ${p}`)
    if (m[1] === '-') f.binary = true
    else { f.added = Number(m[1]); f.deleted = Number(m[2]) }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** Adds the class fields and the delta-level facts. Pure: no git, no file system. */
export function summarize(files) {
  const out = files.map((f) => {
    const cls = classifyPath(f.path)
    const oldClass = f.oldPath ? classifyPath(f.oldPath) : undefined
    return { ...f, class: cls, ...(oldClass && oldClass !== cls ? { oldClass } : {}) }
  })
  const classesOf = (f) => [f.class, f.oldClass ?? f.class]
  const counts = Object.fromEntries(CLASSES.map((c) => [c, 0]))
  for (const f of out) counts[f.class]++
  const srcLinesChanged = out
    .filter((f) => classesOf(f).includes('src'))
    .reduce((n, f) => n + f.added + f.deleted, 0)
  return {
    files: out,
    counts,
    srcLinesChanged,
    migrations: out.filter((f) => classesOf(f).includes('migracio')).map((f) => f.path),
    // data only: a package.json or package-lock.json anywhere (either path of a rename). The lock's lines are
    // ci/tools lines, so they never reach srcLinesChanged, where thousands of them would bury the number.
    depsChanged: out.some((f) => [f.path, f.oldPath].some((p) => p !== undefined && /(^|\/)package(-lock)?\.json$/.test(p))),
    touchesGateFiles: out.some((f) => classesOf(f).includes('kapu-fajl')),
    testsOnly: out.length > 0 && out.every((f) => classesOf(f).every((c) => c === 'teszt')),
    docsOnly: out.length > 0 && out.every((f) => classesOf(f).every((c) => c === 'docs')),
  }
}

const git = (root, args) => execFileSync('git', args, { cwd: root, maxBuffer: 1 << 28 }).toString()

export function deltaClass(root, base, { tsRoot = root } = {}) {
  let head
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
    head = git(root, ['rev-parse', 'HEAD']).trim()
  } catch {
    throw Object.assign(new Error(`not a commit in ${root}: ${base}`), { code: 'bad-base' })
  }
  const range = `${base}..HEAD`
  const nameStatus = git(root, ['diff', '--name-status', '-z', '-M', range])
  const numstat = git(root, ['diff', '--numstat', '-z', '-M', range])
  const report = {
    tool: 'delta-class',
    base,
    head,
    // the awaits are read from the working tree (like await-mutants --list), the rest from the commits
    dirty: git(root, ['status', '--porcelain', '--untracked-files=no']).trim() !== '',
    ...summarize(parseDelta(nameStatus, numstat)),
  }
  try {
    report.awaitsAdded = listAwaitMutants(loadTypeScript(tsRoot), root, base).length
  } catch (err) {
    report.awaitsAdded = null
    report.awaitsError = String(err.message ?? err)
  }
  return report
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2), { flags: [], values: ['root', 'base', 'ts-root', 'json'], defaults: {} })
  } catch (err) {
    process.stderr.write(`delta-class: ${err.message}\n`)
    process.exit(2)
  }
  if (!args.base) {
    process.stderr.write('delta-class: pass --base <sha>\n')
    process.exit(2)
  }
  const root = resolveRoot(args.root)
  let report
  try {
    report = deltaClass(root, args.base, { tsRoot: args['ts-root'] ? resolveRoot(args['ts-root']) : root })
  } catch (err) {
    process.stderr.write(`delta-class: ${err.message}\n`)
    process.exit(err.code === 'bad-base' ? 2 : 1)
  }
  const c = report.counts
  const human = [
    `delta-class ${args.base}..${report.head.slice(0, 9)}: ${report.files.length} files`
      + (report.dirty ? ' (working tree is dirty: awaits read from it)' : ''),
    '  ' + CLASSES.map((k) => `${k} ${c[k]}`).join(', '),
    `  srcLinesChanged ${report.srcLinesChanged}, awaitsAdded ${report.awaitsAdded ?? 'n/a'}, `
      + `migrations ${report.migrations.length}, touchesGateFiles ${report.touchesGateFiles}, `
      + `testsOnly ${report.testsOnly}, docsOnly ${report.docsOnly}, depsChanged ${report.depsChanged}`,
  ]
  if (report.awaitsError) human.push(`  awaits not counted: ${report.awaitsError}`)
  if (args.json) writeFileSync(path.resolve(args.json), JSON.stringify(report, null, 2) + '\n')
  emit(report, human)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
