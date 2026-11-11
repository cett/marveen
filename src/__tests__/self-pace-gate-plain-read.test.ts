// The self-pace gate's "plain read" rule is ONE predicate for every step that lets a read through, for a reader
// (cat, grep, ls ...) and for a read-only git subcommand alike: it must not be fed into a non-reader, and it must not
// carry an environment that makes it run a program or write a file.
//
// Before: the strict-ancestor step (a word that names the scripts/ directory) let only READERS through, so a read-only
// `git diff scripts/` was refused, while the protected-file step let a git read through without the pipe check, so
// `git ls-files scripts/hooks | xargs rm` was not refused. Both are the same missing predicate.
//
// Neutral fixture only: a tmp world with a made-up install, no real names, paths or ids.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string // the install
let wt: string // a git worktree copy of it (a real path OUTSIDE the install)
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'plain-read-'))
  root = join(base, 'fixture-root')
  wt = join(base, 'worktrees', 'feat')
  for (const r of [root, wt]) {
    touch(join(r, 'scripts', 'self-pace-gate.mjs'))
    touch(join(r, 'scripts', 'email-send-gate.mjs'))
    touch(join(r, 'scripts', 'unrelated.sh'))
    touch(join(r, 'scripts', 'hooks', 'egress-gate.mjs'))
    touch(join(r, 'scripts', 'lib', 'homoglyph.py'))
    for (const rel of ['scripts/agent-api.sh', 'scripts/sync-hooks.sh', 'scripts/doctor.sh', 'scripts/gate-onfailure-check.py', 'scripts/secret-gate.ts',
      'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts', 'src/web/other.ts', 'src/security/other.ts']) touch(join(r, rel))
    touch(join(r, 'templates', 'egress-vendor-hosts.json'), '{"hosts":[]}')
  }
  touch(join(root, 'store', 'egress-allowlist.json'), '{"domains":[]}')
  touch(join(root, 'store', 'egress-vendor-hosts.json'), '{"hosts":[]}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const opts = (cwd: string) => ({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const bash = (command: string, cwd = root) => gateDecision('Bash', { command }, opts(cwd))
const ALLOW = { deny: false }

describe('a strict ancestor (the scripts/ directory): a read-only git subcommand is a plain read, like a reader', () => {
  const ALLOWED = [
    'git diff scripts/', 'git diff scripts', 'git diff --stat scripts/', 'git log --oneline -- scripts', 'git log -- scripts/lib', 'git log -3 scripts/',
    'git status scripts', 'git status --short scripts/', 'git grep -n needle scripts', 'git grep -n needle scripts/hooks', 'git ls-files scripts', 'git ls-files -o scripts/',
    'git show HEAD:scripts/hooks/egress-gate.mjs', 'git blame scripts/lib/homoglyph.py', 'git add scripts/', 'git diff develop -- scripts',
    'git -C /some/worktree diff -- scripts', 'git log --oneline -- scripts | head -5', 'git log --oneline -- scripts | grep fix', 'git diff scripts | wc -l',
  ]
  it.each(ALLOWED)('allows: %s', (command) => {
    expect({ command, r: bash(command) }).toEqual({ command, r: ALLOW })
  })
  // The readers keep their old verdict (the change must not move them).
  it.each(['ls scripts', 'cat scripts/unrelated.sh', 'grep -rn needle scripts', 'ls scripts | head', 'cd scripts', 'cd scripts && ls'])('control, a reader: %s', (command) => {
    expect({ command, r: bash(command) }).toEqual({ command, r: ALLOW })
  })

  // The negative twin of every allow: the same git with an option or an environment that writes a file or runs a
  // program, or whose output goes into a non-reader, stays refused at the strict ancestor.
  const DENIED = [
    'git diff --output=/tmp/o scripts/', 'git diff --output /tmp/o scripts', 'git diff --outp=/tmp/o scripts', 'git diff --out=/tmp/o scripts',
    'git log --output=/tmp/o -- scripts/lib', 'git show --output=/tmp/o HEAD scripts', 'git diff-tree --output=/tmp/o HEAD scripts', 'git rev-list --output=/tmp/o HEAD scripts',
    'git grep -O/tmp/evil needle scripts', 'git grep -Oless needle scripts', 'git grep --open-files-in-pager=/tmp/evil needle scripts', 'git grep --open needle scripts',
    "git -c core.pager='sh -c x' diff scripts/", 'git -ccore.pager=evil diff scripts', 'git -c alias.x=evil log scripts', 'git --config-env=core.pager=X diff scripts', 'git --exec-path=/tmp/e status scripts',
    'git log -- scripts/lib | xargs rm', 'git diff scripts | xargs rm', 'git ls-files scripts | xargs rm -f', 'git log --oneline -- scripts | sh', 'git status scripts | xargs cat',
    'GIT_EXTERNAL_DIFF=/tmp/evil git diff scripts/', 'GIT_PAGER=/tmp/evil git log -- scripts', 'PAGER=/tmp/evil git log scripts', 'LESS=x git diff scripts',
    'git diff --ext-diff scripts/', 'git log --ext-diff -p -- scripts', 'git show --ext-diff HEAD scripts', 'git diff --ext scripts/',
    'git diff --textconv scripts/', 'git log --textconv -p -- scripts', 'git diff --textc scripts/', 'git log --textcon -p -- scripts', 'git diff --ext-d scripts/', 'git diff --ext-diff=x scripts/', 'git show --textconv HEAD -- scripts/lib/homoglyph.py', 'git grep --textconv needle scripts', 'git blame --textconv scripts/lib/homoglyph.py',
    // not a read-only subcommand: refused at the strict ancestor, as before
    'git checkout scripts', 'git checkout -- scripts/', 'git restore scripts', 'git rm -r scripts', 'git clean -fd scripts', 'git stash scripts', 'git reset --hard scripts',
  ]
  it.each(DENIED)('denies: %s', (command) => {
    expect({ command, r: bash(command) }).toMatchObject({ command, r: { deny: true } })
  })
  // the option is a pathspec after `--`, so it is not an option (same rule the protected-file step has always had)
  it('an option-looking word after -- is a pathspec: allowed', () => {
    expect(bash('git diff HEAD -- scripts --output=/tmp/o')).toEqual(ALLOW)
  })
})

describe('a protected file named by the command: a git read now has the same pipe rule as a reader', () => {
  const P = 'scripts/hooks/egress-gate.mjs'
  it.each([
    `git ls-files scripts/hooks | xargs rm`, `git log --oneline -- ${P} | xargs rm`, `git show HEAD -- ${P} | sh`, `git diff -- ${P} | xargs cat`,
    `git ls-files scripts/lib | xargs -I{} rm {}`,
  ])('denies a git read piped into a non-reader: %s', (command) => {
    expect({ command, r: bash(command) }).toMatchObject({ command, r: { deny: true } })
  })
  it.each([
    `git log --oneline -- ${P} | head -5`, `git diff -- ${P} | grep needle`, `git ls-files scripts/hooks | wc -l`, `git show HEAD:${P} | cat`, `git blame ${P} | sort | uniq -c`,
    `git diff -- ${P}`, `git add ${P}`, `git commit -m wip -- ${P}`, 'git grep -n egress -- scripts/hooks',
  ])('allows the same read into a reader, or on its own: %s', (command) => {
    expect({ command, r: bash(command) }).toEqual({ command, r: ALLOW })
  })
  it('the reader rule it copies: a reader into a non-reader is refused, into a reader it is allowed', () => {
    expect(bash(`cat ${P} | xargs rm`)).toMatchObject({ deny: true })
    expect(bash(`cat ${P} | head -3`)).toEqual(ALLOW)
  })
  // A protected FILE whose name is a reader's or git's name: the command word is the protected file, so a plain run of it
  // is a plain run -- but its output into a non-reader is refused like any read's (the rule applies to the name, not
  // only to the case where the real reader runs).
  it('a protected executable named like a reader or git: fed into a non-reader is refused, alone or into a reader it is a plain run', () => {
    touch(join(root, 'scripts', 'hooks', 'cat'))
    touch(join(root, 'scripts', 'hooks', 'git'))
    for (const name of ['cat', 'git status']) {
      expect(bash(`scripts/hooks/${name} | xargs rm`)).toMatchObject({ deny: true })
      expect(bash(`scripts/hooks/${name}`)).toEqual(ALLOW)
      expect(bash(`scripts/hooks/${name} | head -3`)).toEqual(ALLOW)
    }
  })
  it('an unsafe environment on a git read is refused at a protected file too (unchanged)', () => {
    expect(bash(`GIT_EXTERNAL_DIFF=/tmp/evil git diff -- ${P}`)).toMatchObject({ deny: true })
    expect(bash(`PAGER=/tmp/evil git log -- ${P}`)).toMatchObject({ deny: true })
  })
  it('--ext-diff and --textconv on a git read at a protected file are refused now, git grep --extended-regexp is not an --ext-diff', () => {
    expect(bash(`git diff --ext-diff -- ${P}`)).toMatchObject({ deny: true })
    expect(bash(`git log -p --textconv -- ${P}`)).toMatchObject({ deny: true })
    expect(bash(`git grep --extended-regexp needle -- scripts/hooks`)).toEqual(ALLOW)
    expect(bash(`git grep -E needle scripts`)).toEqual(ALLOW)
    expect(bash(`git diff --text -- ${P}`)).toEqual(ALLOW) // --text (treat as text) is a different option from --textconv
  })
})

describe('the worktree copy and an unrelated path are free as before (positive twin of every new refusal)', () => {
  it.each([
    'git diff --output=/tmp/o scripts/', 'git log -- scripts | xargs rm', 'git diff --ext-diff scripts', 'GIT_EXTERNAL_DIFF=/tmp/evil git diff scripts/', 'git ls-files scripts | xargs echo',
  ])('outside the install nothing is protected: %s', (command) => {
    expect({ command, r: bash(command, wt) }).toEqual({ command, r: ALLOW })
  })
  it.each(['git diff', 'git log --oneline -3', 'git status', 'git grep -n needle', 'git log | head', 'git diff --ext-diff', 'git diff --output=/tmp/o'])('no protected word: %s', (command) => {
    expect({ command, r: bash(command) }).toEqual({ command, r: ALLOW })
  })
})

describe('loose ancestors (src, src/web, src/security, store, the root): still loose, the strict rule did not spread', () => {
  // Boo's D1 mutation (strict: false -> true for these) must turn something red AFTER the git reads are allowed at a
  // strict ancestor too, so the git reads alone cannot tell loose from strict any more: a plain, non-destructive,
  // non-read command naming the directory is what separates them (loose lets it run, strict refuses it).
  it.each(['src', 'src/web', 'src/security'])('a non-destructive command naming %s runs (loose)', (dir) => {
    for (const command of [`node tools/run.mjs ${dir}`, `python3 tools/run.py ${dir}`, `npm test -- ${dir}`, `git add ${dir}`, `git diff ${dir}`, `git log --oneline -- ${dir}`, `git status ${dir}`]) {
      expect({ command, r: bash(command) }).toEqual({ command, r: ALLOW })
    }
  })
  it.each(['src', 'src/web', 'src/security'])('a destructive command naming %s is still refused', (dir) => {
    for (const command of [`rm -rf ${dir}`, `mv ${dir} ${dir}.bak`, `ln -sfn /tmp/evil ${dir}`, `git checkout evil -- ${dir}`, `git clean -fd ${dir}`]) {
      expect({ command, r: bash(command) }).toMatchObject({ command, r: { deny: true } })
    }
  })
  it('the strict one (scripts) refuses the same plain command that the loose ones allow', () => {
    for (const command of ['node tools/run.mjs scripts', 'python3 tools/run.py scripts', 'npm test -- scripts']) {
      expect({ command, r: bash(command) }).toMatchObject({ command, r: { deny: true } })
    }
  })
})
