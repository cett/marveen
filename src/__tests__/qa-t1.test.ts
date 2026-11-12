// tools/qa/t1.mjs: the T1 gate run in one command. These tests cover t1's OWN logic (parity with ci.yml, the
// vitest-lock, the full/related/none switch, preflight idempotency) -- not the ratchets and scanners it calls,
// which have their own tests. node:child_process is mocked throughout (spawnSync/execFileSync pass through to
// the real implementation unless a test overrides them), so no test here actually runs tsc, a ratchet or vitest.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// The defaults are deliberately NOT a passthrough to the real child_process: a t1 step that spawns something its test did
// not expect (a mutated branch that skips a guard, say) must fail loudly here, not start a real full vitest run inside
// a test. `sleep` (the lock's polling wait) is the one harmless call that answers ok.
const { execFileSyncMock, spawnSyncMock, defaultSpawn } = vi.hoisted(() => {
  const defaultSpawn = (cmd: string) => (cmd === 'sleep'
    ? { status: 0, stdout: '', stderr: '' }
    : { status: 97, stdout: '', stderr: `unmocked spawnSync: ${cmd}` })
  return { execFileSyncMock: vi.fn(), spawnSyncMock: vi.fn(), defaultSpawn }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: execFileSyncMock, spawnSync: spawnSyncMock }
})

import {
  CHECKED_JOBS, EXCLUDED_STEPS, loadCiSteps, uncoveredCiSteps, allSteps, runSteps, preflight,
  isPidAlive, acquireVitestLock, parseFailedVitestFiles,
// @ts-expect-error -- plain .mjs tool script, no types
} from '../../tools/qa/t1.mjs'

interface StepDef { id: string; run: (ctx: unknown) => { rc: number; seconds?: number; firstErrorLine?: string | null; note?: string | null } }
const findStep = (steps: StepDef[], id: string): StepDef => steps.find((s) => s.id === id)!

const REPO_ROOT = path.resolve(__dirname, '..', '..')
let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'qa-t1-test-'))
  // mockReset drops every queued once-value and per-test implementation of the previous test, then the safe defaults go back
  execFileSyncMock.mockReset().mockImplementation(() => '')
  spawnSyncMock.mockReset().mockImplementation(defaultSpawn)
})
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

function fakeCiRoot(extraStep?: { job: 'build-checks' | 'test'; name: string }) {
  mkdirSync(path.join(tmp, '.github', 'workflows'), { recursive: true })
  const extra = extraStep ? `\n      - name: ${extraStep.name}\n        run: echo hi\n` : ''
  const target = extraStep?.job ?? 'build-checks'
  const yaml = `
jobs:
  security:
    steps:
      - name: Install dependencies
        run: npm ci
      - name: Security audit
        run: npm audit --audit-level=high
  build-checks:
    steps:
      - name: Checkout
        uses: actions/checkout@v5
      - name: Install dependencies
        run: npm ci
      - name: Type check
        run: npm run typecheck${target === 'build-checks' ? extra : ''}
  test:
    steps:
      - name: SQLite dialect ratchet
        run: python3 scripts/sqlite-dialect-ratchet.py${target === 'test' ? extra : ''}
`
  writeFileSync(path.join(tmp, '.github', 'workflows', 'ci.yml'), yaml)
  return tmp
}

describe('ci.yml parity', () => {
  it('holds against the REAL ci.yml: every run: step of build-checks/test is covered by a t1 row or excluded', () => {
    expect(uncoveredCiSteps(REPO_ROOT, allSteps(true))).toEqual([])
  })

  it('CHECKED_JOBS deliberately leaves out security (network/advisory) and qa-scanners (already automated elsewhere)', () => {
    expect(CHECKED_JOBS).toEqual(['build-checks', 'test'])
    expect(CHECKED_JOBS).not.toContain('security')
    expect(CHECKED_JOBS).not.toContain('qa-scanners')
  })

  it('every EXCLUDED_STEPS entry carries a reason, and is a real step name of a checked job', () => {
    const real = new Set(loadCiSteps(REPO_ROOT).map((s: { job: string; name: string }) => `${s.job}::${s.name}`))
    for (const e of EXCLUDED_STEPS) {
      expect(typeof e.reason).toBe('string')
      expect(e.reason.length).toBeGreaterThan(10)
      expect(real.has(`${e.job}::${e.name}`), `${e.job}/"${e.name}" is not a real ci.yml step any more`).toBe(true)
    }
  })

  it('MUTANT: a step added to ci.yml that no row covers and no exclusion names turns parity red', () => {
    const root = fakeCiRoot({ job: 'build-checks', name: 'Some brand new check nobody wrote a t1 row for' })
    const uncovered = uncoveredCiSteps(root, allSteps(true))
    expect(uncovered).toEqual([{ job: 'build-checks', name: 'Some brand new check nobody wrote a t1 row for' }])
  })

  it('a fixture that only repeats steps the rows already cover (and the excluded "Install dependencies") stays green', () => {
    const root = fakeCiRoot()
    expect(uncoveredCiSteps(root, allSteps(true))).toEqual([])
  })

  it('MUTANT: dropping a row\'s own coverage (a ratchet "forgotten") turns parity red for that ci.yml step', () => {
    const steps = allSteps(true).filter((s: StepDef) => s.id !== 'sqlite-dialect-ratchet')
    const uncovered = uncoveredCiSteps(REPO_ROOT, steps)
    expect(uncovered).toEqual([{ job: 'test', name: 'SQLite dialect ratchet' }])
  })
})

describe('preflight: the fresh-worktree eslint/codemod toolchain install', () => {
  function worktree({ eslintInstalled = false, codemodInstalled = false } = {}) {
    mkdirSync(path.join(tmp, 'tools', 'eslint', 'node_modules', '.bin'), { recursive: true })
    mkdirSync(path.join(tmp, 'tools', 'codemod'), { recursive: true })
    if (eslintInstalled) writeFileSync(path.join(tmp, 'tools', 'eslint', 'node_modules', '.bin', 'eslint'), '#!/bin/sh\n')
    if (codemodInstalled) mkdirSync(path.join(tmp, 'tools', 'codemod', 'node_modules'), { recursive: true })
    return tmp
  }

  it('runs npm ci for tools/eslint when its eslint binary is missing', () => {
    const root = worktree({ eslintInstalled: false })
    execFileSyncMock.mockImplementation(() => '')
    const messages = preflight(root, false)
    expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    expect(execFileSyncMock).toHaveBeenCalledWith('npm', ['ci', '--prefix', path.join(root, 'tools/eslint'), '--ignore-scripts'], expect.objectContaining({ cwd: root }))
    expect(messages).toHaveLength(1)
  })

  it('a second call is a no-op once the binary is there (idempotent)', () => {
    const root = worktree({ eslintInstalled: false })
    execFileSyncMock.mockImplementation(() => { writeFileSync(path.join(root, 'tools/eslint/node_modules/.bin/eslint'), '#!/bin/sh\n'); return '' })
    preflight(root, false)
    execFileSyncMock.mockClear()
    const messages = preflight(root, false)
    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(messages).toEqual([])
  })

  it('does not touch tools/codemod without --ci', () => {
    const root = worktree({ eslintInstalled: true, codemodInstalled: false })
    preflight(root, false)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('--ci also installs tools/codemod when its node_modules is missing', () => {
    const root = worktree({ eslintInstalled: true, codemodInstalled: false })
    execFileSyncMock.mockImplementation(() => '')
    const messages = preflight(root, true)
    expect(execFileSyncMock).toHaveBeenCalledWith('npm', ['ci', '--prefix', path.join(root, 'tools/codemod'), '--ignore-scripts'], expect.anything())
    expect(messages).toHaveLength(1)
  })
})

describe('isPidAlive', () => {
  it('is true for this very process and false for a pid nobody has', () => {
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(999999)).toBe(false)
  })
})

describe('acquireVitestLock: at most one full suite at a time, a dead holder does not block forever', () => {
  const lockPath = () => path.join(tmp, 'vitest.lock')

  it('acquires, writes this pid, and release() removes the file', () => {
    const release = acquireVitestLock(lockPath(), { timeoutMs: 1000, pollMs: 10 })
    expect(existsSync(lockPath())).toBe(true)
    expect(readFileSync(lockPath(), 'utf8').trim()).toBe(String(process.pid))
    release()
    expect(existsSync(lockPath())).toBe(false)
  })

  it('a live holder blocks a second acquire until it times out', () => {
    const release = acquireVitestLock(lockPath(), { timeoutMs: 1000, pollMs: 10 })
    const start = Date.now()
    expect(() => acquireVitestLock(lockPath(), { timeoutMs: 150, pollMs: 10 })).toThrow(/timed out/)
    expect(Date.now() - start).toBeGreaterThanOrEqual(140)
    release()
  })

  it('a stale lock (a dead pid) is released and the waiter proceeds immediately, not after the timeout', () => {
    writeFileSync(lockPath(), '999999')
    const start = Date.now()
    const release = acquireVitestLock(lockPath(), { timeoutMs: 5000, pollMs: 10 })
    expect(Date.now() - start).toBeLessThan(2000)
    expect(readFileSync(lockPath(), 'utf8').trim()).toBe(String(process.pid))
    release()
  })

  it('release() only removes the file while it still names this pid (no stealing someone else\'s fresh lock)', () => {
    const release = acquireVitestLock(lockPath(), { timeoutMs: 1000, pollMs: 10 })
    writeFileSync(lockPath(), '12345') // someone else took it over after a stale-takeover race, in this scenario
    release()
    expect(existsSync(lockPath())).toBe(true)
  })
})

describe('parseFailedVitestFiles', () => {
  it('reads unique file paths off " FAIL  <file> > ..." lines, ignoring everything else', () => {
    const out = ' FAIL  src/__tests__/a.test.ts > suite > case\nsome unrelated noise\n FAIL  src/__tests__/b.test.ts > x\n FAIL  src/__tests__/a.test.ts > another case\n'
    expect(parseFailedVitestFiles(out)).toEqual(['src/__tests__/a.test.ts', 'src/__tests__/b.test.ts'])
  })

  it('is empty when nothing failed', () => {
    expect(parseFailedVitestFiles(' Test Files  3 passed (3)\n')).toEqual([])
  })
})

describe('the vitest step: full | related | none', () => {
  function ctxFor(mode: 'full' | 'related' | 'none', extra: Record<string, unknown> = {}) {
    mkdirSync(path.join(tmp, 'store'), { recursive: true })
    mkdirSync(path.join(tmp, 'home'), { recursive: true })
    return {
      root: REPO_ROOT, tmp, storeDir: path.join(tmp, 'store'), homeDir: path.join(tmp, 'home'),
      ambientEnv: { ...process.env }, vitestMode: mode, baseSha: undefined, build: false, lockTimeoutMs: 2000, lockPath: path.join(tmp, 'vitest.lock'),
      ...extra,
    }
  }
  const vitestStepRun = () => findStep(allSteps(true), 'vitest').run

  it('none: skips without spawning anything', () => {
    const result = vitestStepRun()(ctxFor('none')) as { rc: number; note?: string }
    expect(result.rc).toBe(0)
    expect(result.note).toMatch(/skipped/)
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('related without --base-sha is a usage error, not a spawn', () => {
    const result = vitestStepRun()(ctxFor('related')) as { rc: number; firstErrorLine?: string }
    expect(result.rc).toBe(2)
    expect(result.firstErrorLine).toMatch(/--base-sha/)
    expect(spawnSyncMock).not.toHaveBeenCalled()
  })

  it('related with --base-sha delegates to scripts/ci-vitest-related.sh, isolated store and home, no lock', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'ci-vitest-related: no changed files, skipping.\n', stderr: '' })
    const ctx = ctxFor('related', { baseSha: 'abc123' })
    const result = vitestStepRun()(ctx) as { rc: number }
    expect(result.rc).toBe(0)
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [string, string[], { env: Record<string, string>; cwd: string }]
    expect(cmd).toBe('bash')
    expect(args).toEqual([path.join(REPO_ROOT, 'scripts/ci-vitest-related.sh'), 'abc123'])
    expect(opts.env.MARVEEN_STORE_DIR).toBe(ctx.storeDir)
    expect(opts.env.HOME).toBe(ctx.homeDir)
  })

  it('full: a clean run calls vitest-guard once, under the isolated store/home, through the lock', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: ' Test Files  3 passed (3)\n', stderr: '' })
    const ctx = ctxFor('full')
    const result = vitestStepRun()(ctx) as { rc: number; note: string | null }
    expect(result.rc).toBe(0)
    expect(result.note).toBeNull()
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [string, string[], { env: Record<string, string> }]
    expect(cmd).toBe('python3')
    expect(args).toEqual([path.join(REPO_ROOT, 'scripts/vitest-guard.py'), '--', 'run'])
    expect(opts.env.MARVEEN_STORE_DIR).toBe(ctx.storeDir)
  })

  const RUN_ARGS = (...files: string[]) => [path.join(REPO_ROOT, 'scripts/vitest-guard.py'), '--', 'run', ...files]
  const failedOut = (...files: string[]) => ({ status: 1, stdout: `${files.map((f) => ` FAIL  ${f} > x\n`).join('')} Test Files  ${files.length} failed\n`, stderr: '' })
  const greenOut = { status: 0, stdout: ' Test Files  1 passed (1)\n', stderr: '' }
  const envOf = (callIndex: number) => (spawnSyncMock.mock.calls[callIndex] as [string, string[], { env: Record<string, string> }])[2].env
  const argsOf = (callIndex: number) => (spawnSyncMock.mock.calls[callIndex] as [string, string[]])[1]

  it('full: a failed file that is green on a rerun with the SAME override is a flake (load, timing), not override-dependent', () => {
    spawnSyncMock.mockReturnValueOnce(failedOut('src/__tests__/timing.test.ts')).mockReturnValueOnce(greenOut)
    const ctx = ctxFor('full')
    const result = vitestStepRun()(ctx) as { rc: number; note: string | null }
    expect(result.rc).toBe(1) // the first run's rc is what t1 reports: t1 never turns a red run green
    expect(result.note).toMatch(/^flaky: green on a rerun with the same override \(src\/__tests__\/timing\.test\.ts\)$/)
    expect(spawnSyncMock).toHaveBeenCalledTimes(2)
    expect(argsOf(1)).toEqual(RUN_ARGS('src/__tests__/timing.test.ts'))
    expect(envOf(1).MARVEEN_STORE_DIR).toBe(ctx.storeDir) // the override is still on for this rerun
  })

  it('full: red with the override but green WITHOUT it is override-dependent (the third run drops the override)', () => {
    spawnSyncMock.mockReturnValueOnce(failedOut('src/__tests__/envy.test.ts')).mockReturnValueOnce(failedOut('src/__tests__/envy.test.ts')).mockReturnValueOnce(greenOut)
    const ctx = ctxFor('full')
    const result = vitestStepRun()(ctx) as { note: string | null }
    expect(result.note).toMatch(/^override-dependent: green without override \(src\/__tests__\/envy\.test\.ts\)$/)
    expect(spawnSyncMock).toHaveBeenCalledTimes(3)
    expect(envOf(1).MARVEEN_STORE_DIR).toBe(ctx.storeDir)
    expect(envOf(2).MARVEEN_STORE_DIR).toBe(ctx.ambientEnv.MARVEEN_STORE_DIR) // the ambient value, not the isolated override
    expect(argsOf(2)).toEqual(RUN_ARGS('src/__tests__/envy.test.ts'))
  })

  it('full: red without the override too is a real failure, and says so', () => {
    spawnSyncMock.mockReturnValueOnce(failedOut('src/__tests__/real.test.ts')).mockReturnValueOnce(failedOut('src/__tests__/real.test.ts')).mockReturnValueOnce(failedOut('src/__tests__/real.test.ts'))
    const result = vitestStepRun()(ctxFor('full')) as { note: string | null }
    expect(result.note).toBe('still red without override: src/__tests__/real.test.ts')
  })

  it('full: several failed files are sorted into their groups, each file once, and only the red ones go on to the next rerun', () => {
    const a = 'src/__tests__/a-flaky.test.ts'; const b = 'src/__tests__/b-envy.test.ts'; const c = 'src/__tests__/c-real.test.ts'
    spawnSyncMock
      .mockReturnValueOnce(failedOut(a, b, c))
      .mockReturnValueOnce(failedOut(b, c))
      .mockReturnValueOnce(failedOut(c))
    const result = vitestStepRun()(ctxFor('full')) as { note: string | null }
    expect(argsOf(1)).toEqual(RUN_ARGS(a, b, c))
    expect(argsOf(2)).toEqual(RUN_ARGS(b, c))
    expect(result.note).toBe(`flaky: green on a rerun with the same override (${a}); override-dependent: green without override (${b}); still red without override: ${c}`)
  })

  it('full: a rerun that exits nonzero without any FAIL line is "cannot classify", never green', () => {
    spawnSyncMock.mockReturnValueOnce(failedOut('src/__tests__/x.test.ts')).mockReturnValueOnce({ status: 124, stdout: 'timeout\n', stderr: '' })
    const result = vitestStepRun()(ctxFor('full')) as { note: string | null }
    expect(result.note).toMatch(/rerun with the override crashed \(rc 124\).*cannot classify src\/__tests__\/x\.test\.ts/)
  })

  it('full: a first run that fails without any FAIL line (a crash) is reported as that, with no rerun', () => {
    spawnSyncMock.mockReturnValueOnce({ status: 137, stdout: 'killed\n', stderr: '' })
    const result = vitestStepRun()(ctxFor('full')) as { rc: number; note: string | null }
    expect(result.rc).toBe(137)
    expect(result.note).toMatch(/no FAIL lines parsed/)
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
  })

  it('full: releases the lock even when vitest-guard itself throws', () => {
    spawnSyncMock.mockImplementation(() => { throw new Error('boom') })
    const ctx = ctxFor('full')
    expect(() => vitestStepRun()(ctx)).toThrow('boom')
    expect(existsSync(ctx.lockPath as string)).toBe(false)
  })

  it('full: goes through the lock: a live holder keeps it waiting, and nothing is spawned until the lock is its own', () => {
    const ctx = ctxFor('full', { lockTimeoutMs: 100 })
    writeFileSync(ctx.lockPath as string, String(process.pid)) // a live holder (this very process stands in for another t1)
    expect(() => vitestStepRun()(ctx)).toThrow(/timed out waiting/)
    expect(spawnSyncMock.mock.calls.filter((c) => (c[0] as string) !== 'sleep')).toEqual([])
  })
})

describe('a representative sample of DEFAULT_PROFILE/CI_PROFILE rows run the exact command', () => {
  function ctx(extra: Record<string, unknown> = {}) {
    return { root: REPO_ROOT, tmp, ambientEnv: { ...process.env }, build: false, baseSha: undefined, ...extra }
  }
  const stepRun = (id: string) => findStep(allSteps(true), id).run

  it('typecheck runs "npm run typecheck" at the repo root', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' })
    stepRun('typecheck')(ctx())
    expect(spawnSyncMock).toHaveBeenCalledWith('npm', ['run', 'typecheck'], expect.objectContaining({ cwd: REPO_ROOT }))
  })

  it('readme-fork-diff runs the exact script path', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' })
    stepRun('readme-fork-diff')(ctx())
    expect(spawnSyncMock).toHaveBeenCalledWith('python3', [path.join(REPO_ROOT, 'scripts/readme-fork-diff-check.py')], expect.anything())
  })

  it('css-guard (--ci row) runs scripts/css-guard.sh', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' })
    stepRun('css-guard')(ctx())
    expect(spawnSyncMock).toHaveBeenCalledWith('bash', [path.join(REPO_ROOT, 'scripts/css-guard.sh')], expect.anything())
  })

  it('build is a no-op without --build, and runs "npm run build" with it', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' })
    const skipped = stepRun('build')(ctx({ build: false })) as { rc: number; note?: string }
    expect(skipped.rc).toBe(0)
    expect(spawnSyncMock).not.toHaveBeenCalled()
    stepRun('build')(ctx({ build: true }))
    expect(spawnSyncMock).toHaveBeenCalledWith('npm', ['run', 'build'], expect.anything())
  })

  it('check-commit-subjects and changelog-check are skipped without --base-sha, and run with it', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' })
    const skipped = stepRun('check-commit-subjects')(ctx()) as { rc: number; note?: string }
    expect(skipped.rc).toBe(0)
    expect(skipped.note).toMatch(/needs --base-sha/)
    stepRun('check-commit-subjects')(ctx({ baseSha: 'abc' }))
    expect(spawnSyncMock).toHaveBeenCalledWith('python3', [path.join(REPO_ROOT, 'scripts/check_commit_subjects.py')], expect.objectContaining({ env: expect.objectContaining({ BASE_SHA: 'abc' }) }))
  })

  it('shell-tests and python-tests each run from the repo root', () => {
    spawnSyncMock.mockReturnValue({ status: 0, stdout: '', stderr: '' })
    stepRun('python-tests')(ctx())
    expect(spawnSyncMock).toHaveBeenCalledWith('bash', [path.join(REPO_ROOT, 'scripts/run-python-tests.sh'), '-j', '4'], expect.objectContaining({ cwd: REPO_ROOT }))
  })
})

describe('runSteps: a failing step does not stop the others', () => {
  const ok = (id: string) => ({ id, label: id, run: () => ({ rc: 0, seconds: 0.1, firstErrorLine: null }) })

  it('a nonzero step, a step that throws and a green step all get a row, in order, and every step ran', () => {
    const ran: string[] = []
    const steps = [
      { id: 'a', label: 'a', run: () => { ran.push('a'); return { rc: 1, seconds: 0.2, firstErrorLine: 'first red line' } } },
      { id: 'b', label: 'b', run: () => { ran.push('b'); throw new Error('lock timed out') } },
      { id: 'c', label: 'c', run: () => { ran.push('c'); return { rc: 0, seconds: 0.3, firstErrorLine: null } } },
    ]
    const results = runSteps(steps, {})
    expect(ran).toEqual(['a', 'b', 'c'])
    expect(results.map((r: { id: string }) => r.id)).toEqual(['a', 'b', 'c'])
    expect(results[0].result.rc).toBe(1)
    expect(results[1].result).toMatchObject({ rc: 1, firstErrorLine: 'step threw: lock timed out' })
    expect(results[2].result.rc).toBe(0)
  })

  it('all green stays all green', () => {
    expect(runSteps([ok('a'), ok('b')], {}).every((r: { result: { rc: number } }) => r.result.rc === 0)).toBe(true)
  })

  it('a real step def that fails (rc from the spawned command) reports its first output line and does not throw', () => {
    spawnSyncMock.mockReturnValue({ status: 1, stdout: 'nope\n', stderr: '' })
    const r = findStep(allSteps(true), 'typecheck').run({ root: REPO_ROOT, tmp, ambientEnv: process.env, build: false, baseSha: undefined } as never)
    expect(r.rc).not.toBe(0)
    expect(r.firstErrorLine).toBe('nope')
  })
})
