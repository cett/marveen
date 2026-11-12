#!/usr/bin/env node
// tools/qa/t1.mjs -- the T1 gate run in one command.
//
// Today a QA agent runs this by hand for every PR: tsc, the readme fork-diff check, 5 ratchets, the async
// lint of src, the async lint ratchet of the tests, and the full vitest suite (plus a second, override-free
// run of whatever test file failed, because two tests are only green outside an isolated store). This script
// is that table, one command, one JSON report. Nothing here replaces a person's judgment: it runs the
// MACHINE part and reports rc, seconds and the first line of trouble, exactly as it was already being read.
//
//   node tools/qa/t1.mjs [--root <repo>] [--store-dir <dir>] [--home-dir <dir>] [--json <path>]
//                        [--skip-vitest] [--vitest full|related|none] [--base-sha <sha>]
//                        [--ci] [--build] [--lock-timeout-ms <n>]
//
// Exit 0 only when every run step answered rc 0. --skip-vitest is an alias for --vitest none.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { load as yamlLoad } from 'js-yaml'
import { parseArgs, resolveRoot, emit } from './lib/common.mjs'

// -- CI step inventory ------------------------------------------------------
//
// Only these two ci.yml jobs are checked for parity: `security` (npm/pip-audit, semgrep -- needs network, is
// advisory/report-only, never part of what a QA agent reruns by hand) and `qa-scanners` (the promise-misuse
// and vacuous-notThrow scanners, already automated on their own CI job since the 10-29 plan/qa-speedup-cost
// work -- see tools/qa/check-scanners.mjs) are deliberately out of scope for this tool.
export const CHECKED_JOBS = ['build-checks', 'test']

// A `run:` step of a checked job that t1 does not cover, and why. Checked by name, not by exact command text
// (ci.yml reformats whitespace harmlessly); a renamed or deleted step is simply gone from ci.yml's own list,
// which is not this tool's problem to notice.
export const EXCLUDED_STEPS = [
  { job: 'build-checks', name: 'Install dependencies', reason: 'npm ci: the worktree already has its dependencies (node_modules is a symlink to the main checkout); t1 assumes a built environment, like a QA agent\'s manual run.' },
  { job: 'build-checks', name: 'Check SDK is up to date', reason: 'writes src/generated/api.ts and diffs it: mutates the working tree. Run "npm run generate:sdk" by hand if that is in question.' },
  { job: 'build-checks', name: 'Check API spec for breaking changes', reason: 'downloads the oasdiff binary (network) and needs the PR base sha; out of scope for an offline/local T1 run.' },
  { job: 'test', name: 'Install dependencies', reason: 'see build-checks/"Install dependencies" above.' },
  { job: 'test', name: 'Stub external binaries (claude, tmux) for module-load resolution', reason: 'a CI-runner-only workaround for a missing claude/tmux binary; a worktree has the real ones.' },
]

/** The `run:` steps of the checked jobs, as {job, name} pairs, read from the real ci.yml (no guessing). */
export function loadCiSteps(root) {
  const doc = yamlLoad(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'))
  const out = []
  for (const job of CHECKED_JOBS) {
    for (const step of doc.jobs?.[job]?.steps ?? []) {
      if (typeof step.run === 'string') out.push({ job, name: step.name })
    }
  }
  return out
}

/**
 * Every {job, name} pair the DEFAULT_PROFILE and CI_PROFILE step definitions say they cover (a step's `covers`
 * list), plus EXCLUDED_STEPS. One ci.yml step may be covered by more than one t1 row on purpose: the ci.yml
 * step "Async lint ratchet for the tests" bundles the eslint run AND the ratchet comparison in one `run:`
 * block, and t1 reports them as the two separate rows (test-lint, tests-ratchet) a QA agent already reads them
 * as.
 */
function coveredSet(steps) {
  const out = new Set()
  for (const s of steps) for (const c of s.covers ?? []) out.add(`${c.job}::${c.name}`)
  for (const e of EXCLUDED_STEPS) out.add(`${e.job}::${e.name}`)
  return out
}

/** ci.yml `run:` steps of the checked jobs that no t1 row covers and no exclusion names. Empty means parity holds. */
export function uncoveredCiSteps(root, steps) {
  const covered = coveredSet(steps)
  return loadCiSteps(root).filter((s) => !covered.has(`${s.job}::${s.name}`))
}

// -- running one shell/python/node command -----------------------------------

function run(cmd, args, opts) {
  const start = Date.now()
  const r = spawnSync(cmd, args, { cwd: opts.root, env: opts.env ?? process.env, encoding: 'utf8', maxBuffer: 1 << 28, ...opts.spawn })
  const seconds = (Date.now() - start) / 1000
  const rc = r.status ?? (r.signal ? 128 : 1)
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  const firstErrorLine = rc === 0 ? null : (output.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 300)
  return { rc, seconds, firstErrorLine, output }
}

const pyStep = (rel) => (ctx) => run('python3', [path.join(ctx.root, rel)], { root: ctx.root })
const bashStep = (rel, args = []) => (ctx) => run('bash', [path.join(ctx.root, rel), ...args], { root: ctx.root })

// -- preflight: a fresh worktree has no tools/eslint or tools/codemod node_modules (gitignored) --------------

/** Runs `npm ci --prefix <dir> --ignore-scripts` once, only when the toolchain's own node_modules is absent. Returns a message, or null when nothing was needed. */
function ensureToolchain(root, dir, markerRel) {
  if (existsSync(path.join(root, dir, markerRel))) return null
  execFileSync('npm', ['ci', '--prefix', path.join(root, dir), '--ignore-scripts'], { cwd: root, stdio: 'inherit' })
  return `preflight: installed ${dir} (was missing)`
}

export function preflight(root, ci) {
  const messages = []
  const m1 = ensureToolchain(root, 'tools/eslint', 'node_modules/.bin/eslint')
  if (m1) messages.push(m1)
  if (ci) {
    const m2 = ensureToolchain(root, 'tools/codemod', 'node_modules')
    if (m2) messages.push(m2)
  }
  return messages
}

// -- the async lint steps: eslint on src (error mode) and on the tests (ratchet) ---------------------------

function eslintStep(ctx, { testsMode }) {
  const bin = path.join(ctx.root, 'tools/eslint/node_modules/.bin/eslint')
  const cfg = path.join(ctx.root, 'tools/eslint/eslint.config.mjs')
  const out = path.join(ctx.tmp, testsMode ? 'eslint-async-tests.json' : 'eslint-async.json')
  const env = testsMode ? { ...process.env, ESLINT_ASYNC_TESTS: '1' } : process.env
  const r = run(bin, ['-c', cfg, '-f', 'json', '-o', out, 'src'], { root: ctx.root, env })
  // ESLint's own exit code is the finding, not a crash: a nonzero rc with a well-formed report is "findings exist",
  // which the tests-ratchet step (not this one, for the test-lint row) judges. A crash (no report file) stays an error.
  const reportOk = existsSync(out)
  return { ...r, rc: testsMode ? (reportOk ? 0 : r.rc) : r.rc, reportPath: out }
}

function ratchetStep(ctx, reportPath) {
  return run('node', [path.join(ctx.root, 'tools/eslint/tests-ratchet.mjs'), reportPath], { root: ctx.root })
}

// -- a lock for the full vitest suite: at most one at a time on this machine -------------------------------
//
// The box has 10 cores; two full suites at once starve each other into vitest-guard's timeout (plan/qa-speedup-cost
// 7a). The lock is a plain file under the OS temp dir (never a hardcoded /tmp), named by PID, so a dead holder's
// lock is released instead of blocking forever.

const LOCK_NAME = 'marveen-qa-t1-vitest.lock'

export function isPidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Acquires the lock, waiting out a live holder (polling) and discarding a stale one (its PID is dead). Returns a release function. Throws after `timeoutMs` of waiting on a live holder. */
export function acquireVitestLock(lockPath, { timeoutMs = 30 * 60_000, pollMs = 2000, onWait } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return () => { try { if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) rmSync(lockPath, { force: true }) } catch { /* already gone */ } }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let holder = null
      try { holder = Number(readFileSync(lockPath, 'utf8').trim()) } catch { /* race: it just vanished, loop and retry */ }
      if (holder && !isPidAlive(holder)) { try { rmSync(lockPath, { force: true }) } catch { /* raced with someone else's cleanup */ } continue }
      if (Date.now() > deadline) throw new Error(`timed out waiting ${timeoutMs}ms for the vitest lock (held by pid ${holder ?? '?'})`)
      onWait?.(holder)
      spawnSync('sleep', [String(pollMs / 1000)]) // a blocking wait is exactly what "one full suite at a time" needs
    }
  }
}

// -- vitest: full | related | none ------------------------------------------------------------------------

/** Unique file paths named by a vitest text report's " FAIL  <file> > ..." lines. */
export function parseFailedVitestFiles(output) {
  const out = new Set()
  for (const line of output.split('\n')) {
    const m = /^\s*FAIL\s+(\S+)/.exec(line)
    if (m) out.add(m[1])
  }
  return [...out]
}

function vitestGuard(ctx, args, env) {
  return run('python3', [path.join(ctx.root, 'scripts/vitest-guard.py'), '--', ...args], { root: ctx.root, env, spawn: { maxBuffer: 1 << 29 } })
}

/**
 * Says WHY the failed test files of a full run failed, with two small reruns of only those files. A green rerun alone
 * cannot tell a store/home-dependent test from a flaky one (a timing test under a loaded machine is green on the next
 * run too), so the first rerun keeps the same override and the second drops it:
 *   green on the rerun WITH the override   -> flaky (a load or timing effect of the first run, not the override's doing)
 *   red with it, green WITHOUT it          -> override-dependent (the case two tests were fixed for)
 *   red without it too                     -> still red: a real failure
 * A rerun that exits nonzero without any FAIL line (a crash) is reported as unclassifiable, never as green.
 */
function classifyFailures(ctx, failed, overrideEnv) {
  const parts = []
  const again = vitestGuard(ctx, ['run', ...failed], overrideEnv)
  const redWithOverride = parseFailedVitestFiles(again.output)
  if (again.rc !== 0 && redWithOverride.length === 0) return `rerun with the override crashed (rc ${again.rc}) without a FAIL line: cannot classify ${failed.join(', ')}`
  const flaky = failed.filter((f) => !redWithOverride.includes(f))
  if (flaky.length > 0) parts.push(`flaky: green on a rerun with the same override (${flaky.join(', ')})`)
  if (redWithOverride.length > 0) {
    const without = vitestGuard(ctx, ['run', ...redWithOverride], ctx.ambientEnv)
    const redWithout = parseFailedVitestFiles(without.output)
    if (without.rc !== 0 && redWithout.length === 0) {
      parts.push(`rerun without the override crashed (rc ${without.rc}) without a FAIL line: cannot classify ${redWithOverride.join(', ')}`)
    } else {
      const overrideDependent = redWithOverride.filter((f) => !redWithout.includes(f))
      if (overrideDependent.length > 0) parts.push(`override-dependent: green without override (${overrideDependent.join(', ')})`)
      if (redWithout.length > 0) parts.push(`still red without override: ${redWithout.join(', ')}`)
    }
  }
  return parts.join('; ')
}

function vitestStep(ctx) {
  if (ctx.vitestMode === 'none') return { rc: 0, seconds: 0, firstErrorLine: null, note: 'skipped (--vitest none)' }

  if (ctx.vitestMode === 'related') {
    if (!ctx.baseSha) return { rc: 2, seconds: 0, firstErrorLine: '--vitest related needs --base-sha <sha>' }
    const env = { ...ctx.ambientEnv, MARVEEN_STORE_DIR: ctx.storeDir, HOME: ctx.homeDir }
    return run('bash', [path.join(ctx.root, 'scripts/ci-vitest-related.sh'), ctx.baseSha], { root: ctx.root, env })
  }

  // full: at most one on this machine, isolated store and home, never the production store.
  const lockPath = ctx.lockPath ?? path.join(tmpdir(), LOCK_NAME) // the machine-wide lock; a test passes its own path
  const release = acquireVitestLock(lockPath, {
    timeoutMs: ctx.lockTimeoutMs,
    onWait: (holder) => process.stderr.write(`t1: waiting for the vitest lock (held by pid ${holder ?? '?'})...\n`),
  })
  try {
    const env = { ...ctx.ambientEnv, MARVEEN_STORE_DIR: ctx.storeDir, HOME: ctx.homeDir }
    const first = vitestGuard(ctx, ['run'], env)
    if (first.rc === 0) return { ...first, note: null }
    const failed = parseFailedVitestFiles(first.output)
    if (failed.length === 0) return { ...first, note: 'no FAIL lines parsed from the vitest output; see firstErrorLine' }
    return { ...first, note: classifyFailures(ctx, failed, env) }
  } finally {
    release()
  }
}

// -- the step table -----------------------------------------------------------------------------------------
//
// `covers` is what makes uncoveredCiSteps() able to tell a drifted ci.yml from an intentional gap: every row
// below names the ci.yml step(s) it stands in for, in the SAME job and under the SAME name ci.yml uses.

const DEFAULT_PROFILE = [
  { id: 'typecheck', label: 'tsc --noEmit', covers: [{ job: 'build-checks', name: 'Type check' }], run: (ctx) => run('npm', ['run', 'typecheck'], { root: ctx.root }) },
  { id: 'readme-fork-diff', label: 'README fork-diff status', covers: [{ job: 'build-checks', name: 'Check README fork-diff status is fresh' }], run: pyStep('scripts/readme-fork-diff-check.py') },
  { id: 'sqlite-dialect-ratchet', label: 'SQLite dialect ratchet', covers: [{ job: 'test', name: 'SQLite dialect ratchet' }], run: pyStep('scripts/sqlite-dialect-ratchet.py') },
  { id: 'non-ts-db-access-ratchet', label: 'Non-TS direct DB access ratchet', covers: [{ job: 'test', name: 'Non-TS direct DB access ratchet' }], run: pyStep('scripts/non-ts-db-access-ratchet.py') },
  { id: 'db-outside-sql-ratchet', label: 'Raw SQL outside the db layer ratchet', covers: [{ job: 'test', name: 'Raw SQL outside the db layer ratchet' }], run: pyStep('scripts/db-outside-sql-ratchet.py') },
  { id: 'log-message-literal-ratchet', label: 'Log message literal ratchet', covers: [{ job: 'test', name: 'Log message literal ratchet' }], run: pyStep('scripts/log-message-literal-ratchet.py') },
  { id: 'gmail-send-route-ratchet', label: 'Gmail send route ratchet', covers: [{ job: 'test', name: 'Gmail send route ratchet' }], run: pyStep('scripts/gmail-send-route-ratchet.py') },
  { id: 'async-lint-src', label: 'Async lint (src, error mode)', covers: [{ job: 'test', name: 'Async lint (no-floating-promises, no-misused-promises, await-thenable, require-await; FAILS the build)' }], run: (ctx) => eslintStep(ctx, { testsMode: false }) },
  { id: 'test-lint', label: 'Async lint (tests, warning mode)', covers: [{ job: 'test', name: 'Async lint ratchet for the tests (FAILS the build on a new finding)' }], run: (ctx) => { const r = eslintStep(ctx, { testsMode: true }); ctx._testsReportPath = r.reportPath; return r } },
  { id: 'tests-ratchet', label: 'Async lint ratchet for the tests', covers: [{ job: 'test', name: 'Async lint ratchet for the tests (FAILS the build on a new finding)' }], run: (ctx) => ratchetStep(ctx, ctx._testsReportPath) },
  { id: 'vitest', label: 'Vitest (full suite, unless --vitest says otherwise)', covers: [{ job: 'test', name: 'Vitest on the changed files' }, { job: 'test', name: 'Coverage' }], run: vitestStep },
]

const CI_PROFILE = [
  { id: 'css-guard', label: 'CSS design system guard', covers: [{ job: 'build-checks', name: 'CSS design system guard' }], run: bashStep('scripts/css-guard.sh') },
  { id: 'build', label: 'npm run build', covers: [{ job: 'build-checks', name: 'Build' }], run: (ctx) => ctx.build ? run('npm', ['run', 'build'], { root: ctx.root }) : { rc: 0, seconds: 0, firstErrorLine: null, note: 'skipped (pass --build to run it)' } },
  { id: 'check-commit-subjects', label: 'Commit subjects/bodies (kanban-rowid leak)', covers: [{ job: 'build-checks', name: 'Check commit subjects/bodies for internal kanban-rowid leaks' }], run: (ctx) => ctx.baseSha ? run('python3', [path.join(ctx.root, 'scripts/check_commit_subjects.py')], { root: ctx.root, env: { ...process.env, BASE_SHA: ctx.baseSha } }) : { rc: 0, seconds: 0, firstErrorLine: null, note: 'skipped (needs --base-sha; CI runs it on a PR only)' } },
  { id: 'changelog-check', label: 'CHANGELOG updated for API changes', covers: [{ job: 'build-checks', name: 'Check CHANGELOG updated for API changes' }], run: (ctx) => ctx.baseSha ? run('bash', ['-c', ciChangelogCheckScript], { root: ctx.root, env: { ...process.env, BASE_SHA: ctx.baseSha } }) : { rc: 0, seconds: 0, firstErrorLine: null, note: 'skipped (needs --base-sha; CI runs it on a PR only)' } },
  { id: 'eslint-fixture-selftest', label: 'Async lint fixture self-test', covers: [{ job: 'test', name: 'Async lint self-test (fixture, FAILS the build)' }], run: (ctx) => { const a = run('node', [path.join(ctx.root, 'tools/eslint/check-fixture.mjs')], { root: ctx.root }); if (a.rc !== 0) return a; return run('node', [path.join(ctx.root, 'tools/eslint/tests-ratchet-selftest.mjs')], { root: ctx.root }) } },
  { id: 'codemod-selftest', label: 'Db codemod self-test', covers: [{ job: 'test', name: 'Db codemod self-test (fixture, FAILS the build)' }], run: (ctx) => run('node', [path.join(ctx.root, 'tools/codemod/selftest.mjs')], { root: ctx.root }) },
  { id: 'shell-tests', label: 'Shell tests', covers: [{ job: 'test', name: 'Shell tests' }], run: (ctx) => run('bash', ['-c', shellTestsScript], { root: ctx.root }) },
  { id: 'python-tests', label: 'Python tests', covers: [{ job: 'test', name: 'Python tests' }], run: bashStep('scripts/run-python-tests.sh', ['-j', '4']) },
]

// The two multi-line ci.yml `run:` blocks reproduced verbatim where a single execFileSync call does not fit the
// shape (a loop, a conditional diff) -- kept here, next to the step that runs them, not re-typed at the call site.
const shellTestsScript = 'fail=0\nfor f in scripts/__tests__/*.test.sh; do\n  echo "== $f =="\n  bash "$f" || fail=1\ndone\nexit $fail\n'
const ciChangelogCheckScript = `
changed=$(git diff --name-only "$BASE_SHA"...HEAD)
api_changed=$(echo "$changed" | grep -E '^(docs/openapi\\.yaml|src/web/routes/|src/generated/api\\.ts)' || true)
if [ -n "$api_changed" ]; then
  changelog_changed=$(echo "$changed" | grep '^CHANGELOG\\.md' || true)
  if [ -z "$changelog_changed" ]; then
    echo "API-related files changed but CHANGELOG.md was not updated."
    exit 1
  fi
fi
`

export function allSteps(ci) { return ci ? [...DEFAULT_PROFILE, ...CI_PROFILE] : DEFAULT_PROFILE }

/**
 * Runs every step, in order, whatever the earlier ones answered: a failing step (nonzero rc) and even a step that
 * throws (a lock that timed out, say) is recorded as that step's result and the loop goes on, so the report always
 * has a row for every step and the human reads one table, not the first red line.
 */
export function runSteps(steps, ctx) {
  const results = []
  for (const step of steps) {
    let result
    try {
      result = step.run(ctx)
    } catch (err) {
      result = { rc: 1, seconds: 0, firstErrorLine: `step threw: ${String(err?.message ?? err).slice(0, 300)}` }
    }
    results.push({ id: step.id, label: step.label, result })
  }
  return results
}

// -- CLI ----------------------------------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2), {
    defaults: { root: undefined, 'store-dir': undefined, 'home-dir': undefined, json: undefined, vitest: undefined, 'base-sha': undefined, 'lock-timeout-ms': String(30 * 60_000) },
    flags: ['skip-vitest', 'ci', 'build'],
    values: ['root', 'store-dir', 'home-dir', 'json', 'vitest', 'base-sha', 'lock-timeout-ms'],
  })
  const root = resolveRoot(opts.root)
  const ambientEnv = { ...process.env }
  const tmp = mkdtempSync(path.join(tmpdir(), 'qa-t1-'))
  const storeDir = opts['store-dir'] ?? (mkdirSync(path.join(tmp, 'store'), { recursive: true }), path.join(tmp, 'store'))
  const homeDir = opts['home-dir'] ?? (mkdirSync(path.join(tmp, 'home'), { recursive: true }), path.join(tmp, 'home'))
  const vitestMode = opts['skip-vitest'] ? 'none' : (opts.vitest ?? 'full')
  if (!['full', 'related', 'none'].includes(vitestMode)) throw new Error(`--vitest must be full, related or none (got "${vitestMode}")`)

  const ctx = {
    root, tmp, storeDir, homeDir, ambientEnv,
    vitestMode, baseSha: opts['base-sha'], build: opts.build, lockTimeoutMs: Number(opts['lock-timeout-ms']),
  }

  const preflightMessages = preflight(root, opts.ci)
  for (const m of preflightMessages) process.stderr.write(`${m}\n`)

  const uncovered = uncoveredCiSteps(root, allSteps(true))
  const parityStep = {
    id: 'ci-parity', label: 'ci.yml parity (every run: step of build-checks/test is covered or excluded)',
    result: uncovered.length === 0
      ? { rc: 0, seconds: 0, firstErrorLine: null }
      : { rc: 1, seconds: 0, firstErrorLine: `uncovered ci.yml step(s): ${uncovered.map((s) => `${s.job}/"${s.name}"`).join('; ')}` },
  }

  const results = [parityStep, ...runSteps(allSteps(opts.ci), ctx)]

  rmSync(tmp, { recursive: true, force: true })

  const ok = results.every((r) => r.result.rc === 0)
  const report = {
    ok,
    root,
    vitestMode,
    steps: results.map((r) => ({ id: r.id, rc: r.result.rc, seconds: r.result.seconds, firstErrorLine: r.result.firstErrorLine ?? null, note: r.result.note ?? null })),
  }
  const humanLines = results.map((r) => `${r.result.rc === 0 ? 'OK  ' : 'FAIL'} ${r.id} (${r.result.seconds?.toFixed?.(1) ?? '0.0'}s)${r.result.note ? ` -- ${r.result.note}` : ''}`)
  humanLines.push(ok ? 'OK  t1: every step rc 0' : 'FAIL t1: at least one step is nonzero')

  if (opts.json) writeFileSync(opts.json, JSON.stringify(report, null, 2))
  emit(report, humanLines)
  process.exit(ok ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { process.stderr.write(`t1: ${err.stack ?? err}\n`); process.exit(1) })
}
