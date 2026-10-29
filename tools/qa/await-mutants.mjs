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
//          --ts-root <dir> (where tools/eslint/node_modules/typescript is; default --root)
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { loadTypeScript, parseArgs, resolveRoot } from './lib/common.mjs'
import { applyMutant, listAwaitMutants } from './lib/mutants.mjs'

const args = parseArgs(process.argv.slice(2), {
  flags: ['list', 'keep'],
  values: ['root', 'base', 'ts-root', 'workers', 'work-dir', 'only', 'timeout-sec', 'vitest-bin'],
  defaults: { workers: '4', 'timeout-sec': '900' },
})
if (!args.base) {
  process.stderr.write('await-mutants: pass --base <sha> (the sweep covers the awaits base..HEAD added)\n')
  process.exit(2)
}
const root = resolveRoot(args.root)
const ts = loadTypeScript(args['ts-root'] ? resolveRoot(args['ts-root']) : root)
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

/**
 * Runs the tests related to `m.file`. `baseline` is the set of tests that already fail in the copy WITHOUT a
 * mutation (a test that depends on the checkout path or the host fails there whatever the mutant does): a
 * mutant is killed only by a failure outside that set, and --bail leaves room for the known failures.
 * Resolves to { status, firstFailingTest, exitCode, failing }.
 */
function runRelated(dir, m, runDir, baseline = null) {
  mkdirSync(path.join(runDir, 'store'), { recursive: true })
  mkdirSync(path.join(runDir, 'home'), { recursive: true })
  const outFile = path.join(runDir, 'vitest.json')
  const bin = args['vitest-bin'] ?? path.join(dir, 'node_modules/.bin/vitest')
  const bail = baseline === null ? [] : ['--bail', String(baseline.size + 1)]
  const failedIn = (rep) => {
    const out = []
    for (const f of rep.testResults ?? []) {
      const rel = path.relative(dir, f.name)
      const tests = (f.assertionResults ?? []).filter((a) => a.status === 'failed')
      for (const t of tests) out.push(`${rel} > ${t.fullName}`)
      if (f.status === 'failed' && tests.length === 0) out.push(`${rel} (suite failed)`)
    }
    return out
  }
  return new Promise((resolve) => {
    const child = spawn(bin, ['related', m.file, '--run', ...bail, '--reporter=json', `--outputFile=${outFile}`], {
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
      const failing = failedIn(rep)
      if (baseline === null) {
        // the unmutated run: it only records which tests fail on their own
        return resolve({ status: rep.numTotalTests === 0 ? 'no-tests' : 'baseline', firstFailingTest: null, exitCode: code, failing })
      }
      const fresh = failing.filter((t) => !baseline.has(t))
      if (fresh.length > 0) return resolve({ status: 'killed', firstFailingTest: fresh[0], exitCode: code, failing })
      if (rep.numTotalTests === 0) return resolve({ status: 'no-tests', firstFailingTest: null, exitCode: code, failing })
      resolve({ status: code === 0 || failing.length > 0 ? 'survived' : 'error', firstFailingTest: null, exitCode: code, failing })
    })
  })
}

const t0 = Date.now()
log(`await-mutants: ${mutants.length} mutant(s), ${workers} worker(s), HEAD ${head.slice(0, 8)}, copies in ${workDir}`)
const dirs = Array.from({ length: workers }, (_, w) => makeCopy(w))

/** Runs fn(item, copyDir, index) over the items on the workers; every worker owns one copy. */
async function pool(items, fn) {
  let next = 0
  await Promise.all(dirs.map(async (dir) => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await fn(items[i], dir, i)
    }
  }))
}

// Phase 1: the unmutated related tests of every touched file, to learn which of them fail on their own.
const files = [...new Set(mutants.map((m) => m.file))]
const baselines = new Map()
await pool(files, async (file, dir, i) => {
  const res = await runRelated(dir, { file }, path.join(workDir, `base-${i}`))
  baselines.set(file, { status: res.status, failing: res.failing ?? [] })
  log(`baseline ${file}: ${res.status}, ${(res.failing ?? []).length} test(s) fail without a mutant`)
})

// Phase 2: one mutant at a time per worker.
const results = new Array(mutants.length)
await pool(mutants, async (m, dir, i) => {
  const base = baselines.get(m.file)
  const started = Date.now()
  let res
  if (base.status !== 'baseline') {
    // no related tests, or the unmutated run itself crashed or timed out: the mutant cannot be judged
    res = { status: base.status === 'no-tests' ? 'no-tests' : 'baseline-error', firstFailingTest: null, exitCode: null }
  } else {
    const file = path.join(dir, m.file)
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, applyMutant(original, m))
    try {
      res = await runRelated(dir, m, path.join(workDir, `run-${m.id}`), new Set(base.failing))
    } finally {
      writeFileSync(file, original) // the copy is private to this worker; restore before the next mutant
    }
  }
  results[i] = { id: m.id, file: m.file, line: m.line, snippet: m.snippet, status: res.status, firstFailingTest: res.firstFailingTest, exitCode: res.exitCode, durationMs: Date.now() - started }
  log(`${m.id} ${m.file}:${m.line} ${res.status}${res.firstFailingTest ? ' <- ' + res.firstFailingTest : ''} (${((Date.now() - started) / 1000).toFixed(0)}s)`)
})

const count = (s) => results.filter((r) => r.status === s).length
const report = {
  tool: 'await-mutants',
  mode: 'run',
  base: args.base,
  head,
  workers,
  wallSeconds: Math.round((Date.now() - t0) / 1000),
  summary: { total: results.length, killed: count('killed'), survived: count('survived'), noTests: count('no-tests'), baselineErrors: count('baseline-error'), errors: count('error'), timeouts: count('timeout') },
  baselines: [...baselines].map(([file, b]) => ({ file, status: b.status, failingWithoutMutant: b.failing })),
  mutants: results,
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n')
log(`await-mutants: ${JSON.stringify(report.summary)} in ${report.wallSeconds}s`)
if (!args.keep && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true })
process.exit(0)
