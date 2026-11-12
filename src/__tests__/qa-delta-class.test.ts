// tools/qa/delta-class.mjs: the class of every changed file and the delta-level facts (src lines, awaits added,
// migrations, gate files). The git facts are checked against a throwaway repository built here (real git, real
// commits), so a rename, a deletion, a binary file and an odd file name are what git itself reports. The tool
// states facts and never a decision: no test expects, and the report has no, "QA not needed" field.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CLASSES, classifyPath, parseDelta, summarize, deltaClass,
// @ts-expect-error -- plain .mjs tool script, no types
} from '../../tools/qa/delta-class.mjs'

interface FileEntry { path: string; oldPath?: string; status: string; class: string; oldClass?: string; added: number; deleted: number; binary: boolean }
interface Report {
  base: string; head: string; dirty: boolean; files: FileEntry[]; counts: Record<string, number>
  srcLinesChanged: number; awaitsAdded: number | null; awaitsError?: string
  migrations: string[]; touchesGateFiles: boolean; testsOnly: boolean; docsOnly: boolean
}
const delta = deltaClass as (root: string, base: string, opts?: { tsRoot?: string }) => Report
const parse = parseDelta as (ns: string, nu: string) => Array<{ path: string; oldPath?: string; status: string; added: number; deleted: number; binary: boolean }>
const classify = classifyPath as (p: string) => string

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const TOOL = path.join(REPO_ROOT, 'tools', 'qa', 'delta-class.mjs')
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'qa-fixture', GIT_AUTHOR_EMAIL: 'qa-fixture@example.invalid',
  GIT_COMMITTER_NAME: 'qa-fixture', GIT_COMMITTER_EMAIL: 'qa-fixture@example.invalid',
}

let repo: string
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: GIT_ENV }).toString().trim()
const put = (rel: string, text: string | Buffer) => {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
  writeFileSync(path.join(repo, rel), text)
}
const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}\n`).join('')
const commit = (msg: string) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD') }
const byPath = (r: Report, p: string) => r.files.find((f) => f.path === p)!

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'qa-delta-class-'))
  git('init', '-q')
})
afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

// The base commit has one file of every class, plus the files the delta renames and deletes.
function baseCommit() {
  put('src/a.ts', 'export const a = 1\nexport const b = 2\n')
  put('src/__tests__/a.test.ts', "import { it } from 'vitest'\nit('x', () => {})\n")
  put('docs/guide.md', lines(4, 'doc'))
  put('src/migrations/0001_init.sql', 'CREATE TABLE t (id INTEGER);\n')
  put('scripts/hooks/guard.py', lines(5, 'guard'))
  put('tools/qa/tool.mjs', lines(5, 'tool'))
  put('.github/workflows/ci.yml', lines(3, 'ci'))
  put('src/gone.ts', lines(6, 'gone'))
  put('src/move.ts', lines(20, 'move'))
  put('src/edit-old.ts', lines(20, 'edit'))
  return commit('base')
}

describe('classifyPath', () => {
  const table: Array<[string, string]> = [
    ['src/server.ts', 'src'],
    ['src/web/routes/skills.ts', 'src'],
    ['web/app.js', 'src'],
    ['scripts/ci-vitest-related.sh', 'src'],
    ['src/migrations/0095_skill_revision_prev_state.sql', 'migracio'],
    ['src/migrations/README.md', 'src'],
    ['src/__tests__/qa-t1.test.ts', 'teszt'],
    ['src/foo.test.ts', 'teszt'],
    ['src/foo.spec.mts', 'teszt'],
    ['scripts/tests/run.sh', 'teszt'],
    ['scripts/hooks/test_ledger_outbound.py', 'teszt'],
    ['docs/openapi.yaml', 'docs'],
    ['docs/api-deprecation-policy.md', 'docs'],
    ['CHANGELOG.md', 'docs'],
    ['README.md', 'docs'],
    ['tools/qa/README.md', 'docs'],
    ['LICENSE', 'docs'],
    ['seed-skills/fleet-helper/SKILL.md', 'src'],
    ['personas/agent-a.md', 'src'],
    ['src/prompts/system.md', 'src'],
    ['.github/workflows/ci.yml', 'ci/tools'],
    ['tools/qa/t1.mjs', 'ci/tools'],
    ['package.json', 'ci/tools'],
    ['package-lock.json', 'ci/tools'],
    ['tsconfig.json', 'ci/tools'],
    ['vitest.config.ts', 'ci/tools'],
    ['scripts/hooks/destructive-gate.py', 'kapu-fajl'],
    ['scripts/hooks/shell_rescan_lib.py', 'kapu-fajl'],
    ['scripts/hooks/send-invocation-cases.json', 'kapu-fajl'],
    ['scripts/self-pace-gate.mjs', 'kapu-fajl'],
    ['scripts/email-send-gate.mjs', 'kapu-fajl'],
    ['scripts/agent-api.sh', 'kapu-fajl'],
    ['scripts/sync-hooks.sh', 'kapu-fajl'],
    ['scripts/doctor.sh', 'kapu-fajl'],
    ['scripts/gate-onfailure-check.py', 'kapu-fajl'],
    ['src/security/secret-gate.ts', 'kapu-fajl'],
    ['src/web/hook-registration-guard.ts', 'kapu-fajl'],
    ['.github/workflows/secret-gate.yml', 'kapu-fajl'],
    // a runtime "gate" in src/ is product code, not one of the hook gates a delta QA has to tread carefully around
    ['src/context-restart-gate.ts', 'src'],
    ['src/quota-gate.ts', 'src'],
    // the test of a gate is a test, not a gate file
    ['src/__tests__/gate-scripts-selfedit.test.ts', 'teszt'],
    // a path no rule names is src, so "no src lines" is never claimed for an unknown file
    ['Dockerfile', 'src'],
    ['something/unknown.bin', 'src'],
  ]
  it.each(table)('%s -> %s', (p, cls) => { expect(classify(p)).toBe(cls) })

  it('every class the table expects is a declared class, and every class is reachable', () => {
    const seen = new Set(table.map(([, c]) => c))
    expect([...seen].sort()).toEqual([...CLASSES].sort())
  })

  it('a migration wins over everything: the .sql in src/migrations is never a test or src', () => {
    expect(classify('src/migrations/0001_x.sql')).toBe('migracio')
  })
})

describe('parseDelta and summarize (no git)', () => {
  it('reads a modify, an add, a delete and a rename with its three-record numstat form', () => {
    const ns = ['M', 'src/a.ts', 'A', 'src/b.ts', 'D', 'src/c.ts', 'R092', 'src/old.ts', 'src/new.ts', ''].join('\0')
    const nu = ['3\t1\tsrc/a.ts', '5\t0\tsrc/b.ts', '0\t7\tsrc/c.ts', '1\t1\t', 'src/old.ts', 'src/new.ts', ''].join('\0')
    const files = parse(ns, nu)
    expect(files.map((f) => [f.path, f.status, f.added, f.deleted, f.oldPath])).toEqual([
      ['src/a.ts', 'M', 3, 1, undefined],
      ['src/b.ts', 'A', 5, 0, undefined],
      ['src/c.ts', 'D', 0, 7, undefined],
      ['src/new.ts', 'R', 1, 1, 'src/old.ts'],
    ])
  })

  it('a binary file has no line counts and is marked', () => {
    const files = parse(['A', 'src/x.png', ''].join('\0'), ['-\t-\tsrc/x.png', ''].join('\0'))
    expect(files[0]).toMatchObject({ path: 'src/x.png', added: 0, deleted: 0, binary: true })
  })

  it('a numstat record for a file name-status did not list is an error, not a silent skip', () => {
    expect(() => parse(['M', 'src/a.ts', ''].join('\0'), ['1\t1\tsrc/other.ts', ''].join('\0'))).toThrow(/did not/)
  })

  it('a garbled numstat record is an error', () => {
    expect(() => parse(['M', 'src/a.ts', ''].join('\0'), ['nonsense', ''].join('\0'))).toThrow(/unexpected numstat/)
  })

  it('an empty delta is neither testsOnly nor docsOnly (vacuous truth is not a fact)', () => {
    expect(summarize([])).toMatchObject({ srcLinesChanged: 0, testsOnly: false, docsOnly: false, touchesGateFiles: false, migrations: [] })
  })

  it('a cross-class rename counts as src, as a gate file and as a migration when EITHER path is one', () => {
    const r = summarize([
      { path: 'docs/was-src.md', oldPath: 'src/was-src.ts', status: 'R', added: 2, deleted: 3, binary: false },
      { path: 'docs/was-gate.md', oldPath: 'scripts/hooks/was-gate.py', status: 'R', added: 0, deleted: 0, binary: false },
      { path: 'docs/was-mig.md', oldPath: 'src/migrations/0002_was.sql', status: 'R', added: 0, deleted: 0, binary: false },
    ])
    expect(r.srcLinesChanged).toBe(5)
    expect(r.touchesGateFiles).toBe(true)
    expect(r.migrations).toEqual(['docs/was-mig.md'])
    expect(r.docsOnly).toBe(false)
    expect(r.files.map((f: FileEntry) => [f.class, f.oldClass])).toEqual([['docs', 'src'], ['docs', 'kapu-fajl'], ['docs', 'migracio']])
  })
})

describe('deltaClass on a throwaway repository', () => {
  it('classes every file of a mixed delta and reports the delta-level facts', () => {
    const base = baseCommit()
    put('src/a.ts', 'export const a = 1\nexport const b = 2\nexport async function f() {\n  return await Promise.resolve(3)\n}\n')
    put('src/__tests__/a.test.ts', "import { it } from 'vitest'\nit('x', async () => { await Promise.resolve() })\n")
    put('docs/guide.md', lines(4, 'doc') + 'one more\n')
    put('src/migrations/0002_more.sql', 'CREATE TABLE u (id INTEGER);\n')
    put('scripts/hooks/guard.py', lines(5, 'guard') + 'extra\n')
    put('tools/qa/tool.mjs', lines(5, 'tool') + 'async function g() { await 1 }\n')
    put('.github/workflows/ci.yml', lines(3, 'ci') + 'more\n')
    git('rm', '-q', 'src/gone.ts')
    git('mv', 'src/move.ts', 'tools/qa/move.mjs')
    git('mv', 'src/edit-old.ts', 'src/edit-new.ts')
    put('src/edit-new.ts', lines(19, 'edit') + 'edited line\n')
    commit('delta')

    const r = delta(repo, base, { tsRoot: REPO_ROOT })
    expect(r.files.map((f) => [f.path, f.status, f.class])).toEqual([
      ['.github/workflows/ci.yml', 'M', 'ci/tools'],
      ['docs/guide.md', 'M', 'docs'],
      ['scripts/hooks/guard.py', 'M', 'kapu-fajl'],
      ['src/__tests__/a.test.ts', 'M', 'teszt'],
      ['src/a.ts', 'M', 'src'],
      ['src/edit-new.ts', 'R', 'src'],
      ['src/gone.ts', 'D', 'src'],
      ['src/migrations/0002_more.sql', 'A', 'migracio'],
      ['tools/qa/move.mjs', 'R', 'ci/tools'],
      ['tools/qa/tool.mjs', 'M', 'ci/tools'],
    ])
    expect(r.counts).toEqual({ src: 3, teszt: 1, docs: 1, migracio: 1, 'kapu-fajl': 1, 'ci/tools': 3 })
    // src/a.ts +3 lines, src/edit-new.ts 1 added + 1 deleted (a rename with one edited line), src/gone.ts 6 deleted, and
    // the pure rename src/move.ts -> tools/qa/move.mjs (src by its OLD path) adds 0 + 0
    expect(byPath(r, 'src/a.ts')).toMatchObject({ added: 3, deleted: 0 })
    expect(byPath(r, 'src/edit-new.ts')).toMatchObject({ oldPath: 'src/edit-old.ts', added: 1, deleted: 1 })
    expect(byPath(r, 'src/gone.ts')).toMatchObject({ added: 0, deleted: 6 })
    expect(byPath(r, 'tools/qa/move.mjs')).toMatchObject({ oldPath: 'src/move.ts', oldClass: 'src', added: 0, deleted: 0 })
    expect(r.srcLinesChanged).toBe(3 + 2 + 6)
    expect(r.migrations).toEqual(['src/migrations/0002_more.sql'])
    expect(r.touchesGateFiles).toBe(true)
    expect(r.testsOnly).toBe(false)
    expect(r.docsOnly).toBe(false)
    expect(r.dirty).toBe(false)
    expect(r.head).toBe(git('rev-parse', 'HEAD'))
  })

  it('awaitsAdded is the await-mutants list: only awaits added to src, not to a test or a tool', () => {
    const base = baseCommit()
    put('src/a.ts', 'export const a = 1\nexport const b = 2\nexport async function f() {\n  const x = await Promise.resolve(3)\n  return await Promise.resolve(x)\n}\n')
    put('src/__tests__/a.test.ts', "import { it } from 'vitest'\nit('x', async () => { await Promise.resolve(); await Promise.resolve() })\n")
    put('tools/qa/tool.mjs', lines(5, 'tool') + 'async function g() { await 1 }\n')
    commit('awaits')
    expect(delta(repo, base, { tsRoot: REPO_ROOT }).awaitsAdded).toBe(2)
  })

  it('renames are found even when the repository is configured not to detect them (diff.renames=false)', () => {
    git('config', 'diff.renames', 'false')
    const base = baseCommit()
    git('mv', 'src/move.ts', 'src/moved.ts')
    commit('pure rename')
    const r = delta(repo, base, { tsRoot: REPO_ROOT })
    expect(r.files).toHaveLength(1)
    expect(r.files[0]).toMatchObject({ path: 'src/moved.ts', oldPath: 'src/move.ts', status: 'R', added: 0, deleted: 0 })
    expect(r.srcLinesChanged).toBe(0)
  })

  it('an await that was already there is not "added"', () => {
    put('src/a.ts', 'export async function f() {\n  return await Promise.resolve(1)\n}\n')
    const base = commit('base with an await')
    put('src/a.ts', 'export async function f() {\n  return await Promise.resolve(1)\n}\nexport const z = 1\n')
    commit('touch the file, not the await')
    expect(delta(repo, base, { tsRoot: REPO_ROOT }).awaitsAdded).toBe(0)
  })

  it('without a TypeScript the awaits are null with the reason (nobody counted), the rest of the report stands', () => {
    const base = baseCommit()
    put('src/a.ts', 'export const a = 3\n')
    commit('edit')
    const r = delta(repo, base) // tsRoot defaults to the throwaway repo, which has no tools/eslint
    expect(r.awaitsAdded).toBeNull()
    expect(r.awaitsError).toMatch(/typescript not found/)
    expect(r.srcLinesChanged).toBe(3) // 2 lines deleted, 1 added
  })

  it('a docs-only delta: docsOnly, no src lines, no gate file, no await', () => {
    const base = baseCommit()
    put('docs/guide.md', 'rewritten\n')
    put('README.md', 'readme\n')
    put('CHANGELOG.md', 'log\n')
    commit('docs')
    const r = delta(repo, base, { tsRoot: REPO_ROOT })
    expect(r).toMatchObject({ docsOnly: true, testsOnly: false, srcLinesChanged: 0, touchesGateFiles: false, awaitsAdded: 0, migrations: [] })
  })

  it('a tests-only delta: testsOnly, and a deleted test is still a test', () => {
    const base = baseCommit()
    put('src/__tests__/b.test.ts', lines(12, 'unrelated test text')) // not similar enough to be read as a rename
    git('rm', '-q', 'src/__tests__/a.test.ts')
    commit('tests')
    const r = delta(repo, base, { tsRoot: REPO_ROOT })
    expect(r).toMatchObject({ testsOnly: true, docsOnly: false, srcLinesChanged: 0, touchesGateFiles: false })
    expect(r.counts.teszt).toBe(2)
  })

  it('one src line in an otherwise docs delta is not docsOnly and is counted', () => {
    const base = baseCommit()
    put('docs/guide.md', 'rewritten\n')
    put('src/a.ts', 'export const a = 1\nexport const b = 3\n')
    commit('mixed')
    const r = delta(repo, base, { tsRoot: REPO_ROOT })
    expect(r.docsOnly).toBe(false)
    expect(r.srcLinesChanged).toBe(2)
  })

  it('a migration is reported by path, a changed (not added) one too', () => {
    const base = baseCommit()
    put('src/migrations/0001_init.sql', 'CREATE TABLE t (id INTEGER, name TEXT);\n')
    commit('edit a shipped migration')
    const r = delta(repo, base, { tsRoot: REPO_ROOT })
    expect(r.migrations).toEqual(['src/migrations/0001_init.sql'])
    expect(r.counts.migracio).toBe(1)
  })

  it('a gate script touched alone sets touchesGateFiles and leaves src at 0', () => {
    const base = baseCommit()
    put('scripts/hooks/guard.py', 'changed\n')
    commit('gate')
    const r = delta(repo, base, { tsRoot: REPO_ROOT })
    expect(r).toMatchObject({ touchesGateFiles: true, srcLinesChanged: 0, testsOnly: false })
  })

  it('a binary file under src is class src with no line counts', () => {
    const base = baseCommit()
    put('src/logo.png', Buffer.from([0, 1, 2, 0, 255, 0, 3]))
    commit('binary')
    const r = delta(repo, base, { tsRoot: REPO_ROOT })
    expect(byPath(r, 'src/logo.png')).toMatchObject({ class: 'src', binary: true, added: 0, deleted: 0 })
    expect(r.srcLinesChanged).toBe(0)
    expect(r.counts.src).toBe(1)
  })

  it('a file name with a space and a non-ASCII letter comes through whole (git is run with -z)', () => {
    const base = baseCommit()
    put('src/with space ü.ts', 'export const u = 1\n')
    put('docs/élő.md', 'x\n')
    commit('odd names')
    const r = delta(repo, base, { tsRoot: REPO_ROOT })
    expect(byPath(r, 'src/with space ü.ts')).toMatchObject({ class: 'src', added: 1 })
    expect(byPath(r, 'docs/élő.md')).toMatchObject({ class: 'docs' })
  })

  it('an empty delta (base is HEAD) lists no file and is neither testsOnly nor docsOnly', () => {
    const base = baseCommit()
    const r = delta(repo, base, { tsRoot: REPO_ROOT })
    expect(r.files).toEqual([])
    expect(r).toMatchObject({ srcLinesChanged: 0, awaitsAdded: 0, testsOnly: false, docsOnly: false, touchesGateFiles: false })
  })

  it('dirty is true when a tracked file has an uncommitted change (the awaits read the tree), untracked files do not count', () => {
    const base = baseCommit()
    put('src/new-untracked.ts', 'export const n = 1\n')
    expect(delta(repo, base, { tsRoot: REPO_ROOT }).dirty).toBe(false)
    put('src/a.ts', 'export const a = 99\n')
    expect(delta(repo, base, { tsRoot: REPO_ROOT }).dirty).toBe(true)
  })

  it('a base that is not a commit is an error with the bad-base code', () => {
    baseCommit()
    expect(() => delta(repo, 'no-such-ref', { tsRoot: REPO_ROOT })).toThrow(/not a commit/)
    try { delta(repo, 'no-such-ref', { tsRoot: REPO_ROOT }) } catch (err) { expect((err as { code?: string }).code).toBe('bad-base') }
  })

  it('the report states facts only: no field that decides whether QA is needed', () => {
    const base = baseCommit()
    put('docs/guide.md', 'x\n')
    commit('docs')
    const keys = Object.keys(delta(repo, base, { tsRoot: REPO_ROOT })).sort()
    expect(keys).toEqual(['awaitsAdded', 'base', 'counts', 'dirty', 'docsOnly', 'files', 'head', 'migrations', 'srcLinesChanged', 'testsOnly', 'tool', 'touchesGateFiles'])
  })
})

describe('the command line', () => {
  const run = (args: string[]) => {
    try {
      const stdout = execFileSync('node', [TOOL, ...args], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
      return { rc: 0, stdout, stderr: '' }
    } catch (err) {
      const e = err as { status: number; stdout: Buffer; stderr: Buffer }
      return { rc: e.status, stdout: e.stdout.toString(), stderr: e.stderr.toString() }
    }
  }

  it('prints the JSON report on stdout, exit 0', () => {
    const base = baseCommit()
    put('src/a.ts', 'export const a = 5\n')
    commit('edit')
    const out = execFileSync('node', [TOOL, '--base', base, '--root', repo, '--ts-root', REPO_ROOT], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    expect((JSON.parse(out.toString()) as Report).srcLinesChanged).toBe(3)
  })

  it('writes the report to --json too', () => {
    const base = baseCommit()
    put('docs/guide.md', 'x\n')
    commit('docs')
    const target = path.join(repo, '..', `${path.basename(repo)}-report.json`)
    try {
      execFileSync('node', [TOOL, '--base', base, '--root', repo, '--ts-root', REPO_ROOT, '--json', target], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
      expect((JSON.parse(readFileSync(target, 'utf8')) as Report).docsOnly).toBe(true)
    } finally { rmSync(target, { force: true }) }
  })

  it('exits 2 without --base, with a base that is no commit, and with an unknown option', () => {
    baseCommit()
    expect(run(['--root', repo]).rc).toBe(2)
    expect(run(['--base', 'no-such-ref', '--root', repo]).rc).toBe(2)
    expect(run(['--base', 'HEAD', '--bogus']).rc).toBe(2)
    expect(run(['--base', 'no-such-ref', '--root', repo]).stderr).toMatch(/not a commit/)
  })
})
