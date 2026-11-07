// PIN tests for the KNOWN LIMITS of the implicit-tree rule: the text command behind an unknown cd, the wrapper chdir,
// the text command behind a wrapper, nested substitutions and the words in front of an xargs command.
// A pin names the boundary: what the gate DOES stop and what it still lets through. The cells that are let
// through are documented in the changelog and the PR as known limits; they are asserted here so that a later
// change (a fix, or a regression) flips a named test and has to be decided on purpose, not by accident.
// The install itself keeps its own protection: the same commands run FROM the install are denied wherever the
// command names its target in a way the gate reads.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { bashProtectedDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

let base: string
let root: string // the install: a git repository, `.git` is a directory
let wt: string // a linked worktree outside the install

const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, stdio: 'pipe' })
const FILES = ['scripts/self-pace-gate.mjs', 'scripts/doctor.sh', 'scripts/agent-api.sh', 'src/index.ts', 'agents/agent-a/notes.md', 'store/egress-allowlist.json']

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'known-limits-')))
  root = join(base, 'install'); wt = join(base, 'wt')
  for (const f of FILES) touch(join(root, f))
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init')
  git(root, 'branch', 'other')
  git(root, 'worktree', 'add', '-q', wt, '-b', 'feat-a')
})
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

const opts = (cwd: string) => ({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const denied = (command: string, cwd: string) => bashProtectedDecision(command, opts(cwd)).deny === true
// the commands below spell the install path as @R@ and the unknown target as "$X"
const at = (c: string) => c.replaceAll('@R@', root)

describe('known limit 1: a text command (sh -c / bash -c / eval) behind an UNKNOWN cd is judged from the known cwd', () => {
  it('LIMIT: from a worktree, the unknown cd target is lost for the nested text', () => {
    for (const c of [`cd "$X" && bash -c 'git checkout other'`, `cd "$X" && sh -c 'git checkout other'`, `cd "$X" && eval "git checkout other"`])
      expect(denied(c, wt), c).toBe(false)
  })
  it('the boundary: the same unknown cd with the git command itself, and the nested text from the install, are denied', () => {
    expect(denied(`cd "$X" && git checkout other`, wt)).toBe(true)
    for (const c of [`cd "$X" && bash -c 'git checkout other'`, `cd "$X" && sh -c 'git checkout other'`]) expect(denied(c, root), c).toBe(true)
  })
})

describe('known limit 2: a wrapper that changes directory (env -C, sudo -D) names its target in a way the gate reads', () => {
  it('boundary: every spelling of the chdir with a literal install path, before or after other wrapper words, is denied', () => {
    for (const c of ['env -C @R@ git checkout other', 'env -C@R@ git checkout other', 'env --chdir=@R@ git checkout other', 'env --chdir @R@ git checkout other',
      'sudo -D @R@ git checkout other', 'sudo -u nobody -D @R@ git checkout other', 'sudo -D @R@ -u nobody git checkout other',
      'env -i -C @R@ git checkout other', 'env A=1 -C @R@ git checkout other', 'env -C @R@ nice git checkout other', 'env -C @R@ env git checkout other',
      'nice -n 1 env -C @R@ git checkout other', `env -S '-C @R@ git checkout other'`, 'nice env -C @R@ git checkout other'])
      expect(denied(at(c), wt), c).toBe(true)
  })
  it('boundary: a chdir target that is a variable is an unknown directory, and a write there is denied', () => {
    expect(denied('env -C "$X" git checkout other', wt)).toBe(true)
  })
  it('the chdir never RELAXES the verdict: a chdir into the worktree from the install is still denied (over-deny, the safe side)', () => {
    expect(denied(`env -C ${wt} git checkout other`, root)).toBe(true)
  })
})

describe('known limit 3: sh -c / eval / find -exec behind a wrapper (timeout, nice -n N) is not followed', () => {
  it('LIMIT: the wrapper hides the text command, so the nested git write is not seen', () => {
    for (const c of [`timeout 5 sh -c 'git checkout other'`, `nice -n 1 sh -c 'git checkout other'`]) expect(denied(c, root), c).toBe(false)
    for (const c of [`nice -n 1 sh -c 'cd @R@ && git checkout other'`, `timeout 5 sh -c 'cd @R@ && git checkout other'`]) expect(denied(at(c), wt), c).toBe(false)
  })
  it('the boundary: without the wrapper the text command is followed and denied', () => {
    expect(denied(`sh -c 'git checkout other'`, root)).toBe(true)
    expect(denied(at(`sh -c 'cd @R@ && git checkout other'`), wt)).toBe(true)
    expect(denied(at(`nohup bash -c "cd @R@; git checkout other"`), wt)).toBe(true)
  })
})

describe('known limit 4: substitutions', () => {
  it('boundary: nested $( ) and backtick substitution, up to depth 8, is followed', () => {
    const wrap = (n: number) => { let s = 'cd @R@ && git checkout other'; for (let i = 0; i < n; i++) s = `echo $(${s})`; return s }
    for (const n of [1, 2, 3, 6, 8]) expect(denied(at(wrap(n)), wt), `depth ${n}`).toBe(true)
    expect(denied(at('echo `echo $(cd @R@ && git checkout other)`'), wt)).toBe(true)
    expect(denied('echo $(echo $(cd "$X" && git checkout other))', wt)).toBe(true)
  })
  it('LIMIT: a >( ) inside a <( ) behind an unknown cd is not followed', () => {
    expect(denied('echo <(echo >(cd "$X" && git checkout other))', wt)).toBe(false)
  })
})

describe('known limit 6: the words an xargs puts in front of its command (env -C, sh -c) are not read', () => {
  it('LIMIT: from a worktree, xargs env -C and xargs sh -c hide the install as the target', () => {
    for (const c of ['echo other | xargs env -C @R@ git checkout', `echo other | xargs sh -c 'cd @R@ && git checkout other'`]) expect(denied(at(c), wt), c).toBe(false)
  })
  it('the boundary: xargs git with the path, xargs env with GIT_WORK_TREE, and every xargs form from the install are denied', () => {
    for (const c of ['echo other | xargs git -C @R@ checkout', 'echo other | xargs nice git -C @R@ checkout', 'echo other | xargs env GIT_WORK_TREE=@R@ git checkout']) expect(denied(at(c), wt), c).toBe(true)
    for (const c of ['echo other | xargs env -C @R@ git checkout', `echo other | xargs sh -c 'git checkout other'`]) expect(denied(at(c), root), c).toBe(true)
  })
})
