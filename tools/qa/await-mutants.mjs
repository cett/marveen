#!/usr/bin/env node
// Per-await mutation sweep: removes, one at a time, every `await` the diff base..HEAD added to src/ and runs
// the tests that import the file (`vitest related --bail 1`). A mutant no test fails on SURVIVED: that await is
// not protected by a test. Replaces the hand-run sweep that locked the working directory for an hour.
//
//   node tools/qa/await-mutants.mjs --base <sha> --workers 4 > mutants.json
//
// Runs from COPIES of the committed HEAD (git archive), one per worker, so the working directory stays free and
// only the commit is tested. Every mutant gets its own MARVEEN_STORE_DIR and HOME. The report is JSON on stdout.
//
// Options: --root <repo> (default cwd)   --workers <n> (default 4)   --work-dir <dir> (default a temp dir)
//          --only <text> (files whose path contains it)   --timeout-sec <n> per mutant (default 900)
//          --list (print the mutant list, run nothing)   --keep (keep the copies)
//          --vitest-bin <path> (default node_modules/.bin/vitest in the copy)
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { loadTypeScript, parseArgs, resolveRoot } from './lib/common.mjs'
import { applyMutant, listAwaitMutants } from './lib/mutants.mjs'

const args = parseArgs(process.argv.slice(2), {
  flags: ['list', 'keep'],
  values: ['root', 'base', 'workers', 'work-dir', 'only', 'timeout-sec', 'vitest-bin'],
  defaults: { workers: '4', 'timeout-sec': '900' },
})
if (!args.base) {
  process.stderr.write('await-mutants: pass --base <sha> (the sweep covers the awaits base..HEAD added)\n')
  process.exit(2)
}
const root = resolveRoot(args.root)
const ts = loadTypeScript(root)
const log = (...a) => process.stderr.write(a.join(' ') + '\n')

let mutants = listAwaitMutants(ts, root, args.base)
if (args.only) mutants = mutants.filter((m) => m.file.includes(args.only))
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim()

if (args.list) {
  process.stdout.write(JSON.stringify({ tool: 'await-mutants', mode: 'list', base: args.base, head, total: mutants.length, mutants }, null, 2) + '\n')
  process.exit(0)
}

const workers = Math.max(1, Math.min(Number(args.workers), mutants.length || 1))
const workDir = args['work-dir'] ? path.resolve(args['work-dir']) : mkdtempSync(path.join(os.tmpdir(), 'qa-await-mutants-'))
mkdirSync(workDir, { recursive: true })
const timeoutMs = Number(args['timeout-sec']) * 1000

/** A copy of the committed tree (no .git), with the dependencies linked, for one worker. */
function makeCopy(w) {
  const dir = path.join(workDir, `copy-${w}`)
  mkdirSync(dir, { recursive: true })
  execFileSync('sh', ['-c', 'git archive "$1" | tar -x -C "$2"', 'sh', head, dir], { cwd: root })
  symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'))
  // vitest.config.ts asks git for the main checkout (`git rev-parse --git-common-dir`): an empty repository
  // of its own makes the copy its own main checkout, so the tests read the copy and never the real tree.
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

/** Runs the tests related to the mutated file. Resolves to { status, firstFailingTest, exitCode }. */
function runRelated(dir, m, runDir) {
  mkdirSync(path.join(runDir, 'store'), { recursive: true })
  mkdirSync(path.join(runDir, 'home'), { recursive: true })
  const outFile = path.join(runDir, 'vitest.json')
  const bin = args['vitest-bin'] ?? path.join(dir, 'node_modules/.bin/vitest')
  return new Promise((resolve) => {
    const child = spawn(bin, ['related', m.file, '--run', '--bail', '1', '--reporter=json', `--outputFile=${outFile}`], {
      cwd: dir,
      env: { ...process.env, MARVEEN_STORE_DIR: path.join(runDir, 'store'), HOME: path.join(runDir, 'home'), CI: '1' },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return resolve({ status: 'timeout', firstFailingTest: null, exitCode: code })
      let rep = null
      try { rep = JSON.parse(readFileSync(outFile, 'utf8')) } catch { /* no report */ }
      if (!rep) return resolve({ status: 'error', firstFailingTest: null, exitCode: code })
      if (rep.numFailedTests > 0 || rep.numFailedTestSuites > 0) {
        let first = null
        for (const f of rep.testResults ?? []) {
          const t = (f.assertionResults ?? []).find((a) => a.status === 'failed')
          if (t) { first = `${path.relative(dir, f.name)} > ${t.fullName}`; break }
          if (f.status === 'failed' && !first) first = `${path.relative(dir, f.name)} (suite failed)`
        }
        return resolve({ status: 'killed', firstFailingTest: first, exitCode: code })
      }
      if (rep.numTotalTests === 0) return resolve({ status: 'no-tests', firstFailingTest: null, exitCode: code })
      resolve({ status: code === 0 ? 'survived' : 'error', firstFailingTest: null, exitCode: code })
    })
  })
}

const results = new Array(mutants.length)
let next = 0
const t0 = Date.now()
log(`await-mutants: ${mutants.length} mutant(s), ${workers} worker(s), HEAD ${head.slice(0, 8)}, copies in ${workDir}`)

async function worker(w) {
  const dir = makeCopy(w)
  for (;;) {
    const i = next++
    if (i >= mutants.length) return
    const m = mutants[i]
    const file = path.join(dir, m.file)
    const original = readFileSync(file, 'utf8')
    const started = Date.now()
    let res
    writeFileSync(file, applyMutant(original, m))
    try {
      res = await runRelated(dir, m, path.join(workDir, `run-${m.id}`))
    } finally {
      writeFileSync(file, original) // the copy is private to this worker; restore before the next mutant
    }
    results[i] = { id: m.id, file: m.file, line: m.line, snippet: m.snippet, ...res, durationMs: Date.now() - started }
    log(`${m.id} ${m.file}:${m.line} ${res.status}${res.firstFailingTest ? ' <- ' + res.firstFailingTest : ''} (${((Date.now() - started) / 1000).toFixed(0)}s)`)
  }
}
await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)))

const count = (s) => results.filter((r) => r.status === s).length
const report = {
  tool: 'await-mutants',
  mode: 'run',
  base: args.base,
  head,
  workers,
  wallSeconds: Math.round((Date.now() - t0) / 1000),
  summary: { total: results.length, killed: count('killed'), survived: count('survived'), noTests: count('no-tests'), errors: count('error'), timeouts: count('timeout') },
  mutants: results,
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n')
log(`await-mutants: ${JSON.stringify(report.summary)} in ${report.wallSeconds}s`)
if (!args.keep && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
process.exit(0)
