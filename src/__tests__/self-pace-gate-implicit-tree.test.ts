// R-IMPL: the self-pace gate judges a git / patch / xargs command by the tree it WRITES, not only by the
// protected path it names. `git checkout other` names nothing, yet in the install it replaces the gate
// files with the other branch's. The fixture is a real git install (a `.git` DIRECTORY), a linked
// worktree outside it, a linked worktree INSIDE it (its `.git` is a file) and an agent directory.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { bashProtectedDecision, gateDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let base: string
let root: string // the install: a git repository, `.git` is a directory
let wt: string // a linked worktree OUTSIDE the install (`.git` is a file)
let nested: string // a linked worktree INSIDE the install
let vendor: string // an unrelated repository inside the install (its own `.git` directory)
let agentRepo: string // an agent directory that is a repository of its own
let noGit: string // an install without any repository

const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, stdio: 'pipe' })
const FILES = [
  'scripts/self-pace-gate.mjs', 'scripts/email-send-gate.mjs', 'scripts/doctor.sh', 'scripts/agent-api.sh', 'scripts/sync-hooks.sh',
  'scripts/gate-onfailure-check.py', 'scripts/secret-gate.ts', 'scripts/hooks/egress-gate.mjs', 'scripts/lib/homoglyph.py',
  'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts', 'src/index.ts', 'agents/agent-a/notes.md', 'store/egress-allowlist.json',
]
const build = (dir: string) => { for (const f of FILES) touch(join(dir, f)) }

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'implicit-tree-')))
  root = join(base, 'install'); wt = join(base, 'wt'); nested = join(root, '.worktrees', 'feat')
  vendor = join(root, 'vendor', 'lib'); agentRepo = join(root, 'agents', 'agent-b'); noGit = join(base, 'plain')
  build(root); build(noGit)
  touch(join(agentRepo, 'notes.md'))
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init')
  git(root, 'branch', 'other')
  git(root, 'worktree', 'add', '-q', wt, '-b', 'feat-a')
  git(root, 'worktree', 'add', '-q', nested, '-b', 'feat-b')
  touch(join(vendor, 'a.txt')); git(vendor, 'init', '-q', '-b', 'main')
  git(agentRepo, 'init', '-q', '-b', 'main')
})
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

const opts = (install: string, cwd: string) => ({ scriptsDir: join(install, 'scripts'), storeDir: join(install, 'store'), allowlistPath: join(install, 'store', 'egress-allowlist.json'), cwd })
const decide = (command: string, cwd: string, install = root) => bashProtectedDecision(command, opts(install, cwd))
const denied = (command: string, cwd: string, install = root) => decide(command, cwd, install).deny === true

// hand-written: the git forms that rewrite the tree, none of them names a protected path
const TREE_WRITERS = [
  'git checkout other', 'git switch other', 'git merge other', 'git pull', 'git reset --hard HEAD~1', 'git apply x.diff',
  'git stash', 'git stash pop', 'git stash drop', 'git cherry-pick abc', 'git rebase other', 'git clean -fd', 'git am p.mbox',
  'git read-tree -u HEAD', 'git checkout-index -f -a', 'git revert HEAD', 'git restore --source=other .', 'git branch -D other',
  'git branch newname', 'git tag v1', 'git remote add o https://example.invalid/r.git', 'git worktree remove ../wt', 'git worktree prune',
  'git a-subcommand-that-does-not-exist-yet', 'git update-index --assume-unchanged scripts/doctor.sh',
  'git -c core.worktree=/tmp/x checkout other', 'patch -p1 < x.diff', 'git ls-files -d | xargs rm', "find . -name '*.mjs' | xargs rm",
]
const ROOT_CWDS = () => [root, join(root, 'agents', 'agent-a'), join(root, 'src', 'web'), join(root, 'scripts', 'hooks')]

describe('R-IMPL: the install tree is protected from a command that does not name it', () => {
  it('every tree-writing form is denied from the install root, an agent directory and a subdirectory', () => {
    for (const cwd of ROOT_CWDS()) for (const c of TREE_WRITERS) expect(denied(c, cwd), `${c} @ ${cwd}`).toBe(true)
  })
  it('the same forms are allowed in a linked worktree outside the install', () => {
    for (const c of TREE_WRITERS) expect(denied(c, wt), c).toBe(false)
  })
  it('a worktree INSIDE the install is its own toplevel (its .git is a file): all git work stays allowed', () => {
    for (const c of TREE_WRITERS) expect(denied(c, nested), c).toBe(false)
    expect(denied('git checkout other', join(nested, 'src'))).toBe(false)
  })
  it('an unrelated repository inside the install is not the install tree', () => {
    expect(denied('git checkout main', vendor)).toBe(false)
  })
  it('an agent directory that is a repository of its own is still the agents tree: settings files live there', () => {
    expect(denied('git checkout other', agentRepo)).toBe(true)
  })
  it('the denial carries its own reason, so the message can name the way out', () => {
    expect(decide('git checkout other', root)).toEqual({ deny: true, reason: 'install-tree' })
  })
})

describe('R-IMPL: the positive list keeps the read and prepare forms working in the install', () => {
  const LEGIT = [
    'git status', 'git status -sb', 'git diff', 'git diff HEAD~1', 'git log --oneline -5', 'git show HEAD', 'git blame src/index.ts',
    'git ls-files', 'git add -A', 'git commit -m msg', 'git grep needle', 'git rev-parse HEAD', 'git cat-file -p HEAD', 'git describe --tags',
    'git fetch origin', 'git fetch origin develop:develop', 'git ls-remote origin', 'git merge-base main other', 'git for-each-ref',
    'git worktree add ../install-wt-topic -b topic origin/develop', 'git worktree list', 'git stash list', 'git stash show',
    'git branch', 'git branch --list', 'git branch -a', 'git branch --list "feat*"', 'git branch --show-current', 'git branch -vv',
    'git tag', 'git tag -l', 'git remote -v', 'git remote get-url origin', 'git --version', 'git name-rev HEAD', 'git show-branch',
    'patch --dry-run -p1 < x.diff', 'ls | xargs grep needle', 'git ls-files | xargs wc -l',
  ]
  it('allowed from the install root and from an agent directory', () => {
    for (const c of LEGIT) expect(denied(c, root), `${c} @ root`).toBe(false)
    // from an agent directory `..` is still inside the install (agents/), so the worktree goes to an absolute path outside it
    for (const c of LEGIT.map((x) => x.replace('../install-wt-topic', join(base, 'install-wt-topic')))) expect(denied(c, join(root, 'agents', 'agent-a')), `${c} @ agent-a`).toBe(false)
  })
  it('a listing form is not a way to run a program or reach a remote helper', () => {
    for (const c of ['git fetch --upload-pack=/tmp/x origin', 'git fetch ext::sh', 'git ls-remote --exec=/tmp/x origin', 'git -c alias.x=!id status']) expect(denied(c, root), c).toBe(true)
  })
})

describe('R-IMPL: where the command runs is resolved, not assumed', () => {
  it('-C, --work-tree, GIT_WORK_TREE and GIT_DIR that lead to the install are denied from a worktree', () => {
    for (const c of [`git -C ${root} checkout other`, `git --work-tree=${root} checkout other`, `git --work-tree ${root} checkout other`,
      `GIT_WORK_TREE=${root} git checkout other`, `GIT_DIR=${root}/.git git checkout other`, `git --git-dir=${root}/.git checkout other`,
      `env GIT_WORK_TREE=${root} git checkout other`, `git -C ${wt} -C ${root} checkout other`, `git -C ${wt} -C ../install checkout other`])
      expect(denied(c, wt), c).toBe(true)
  })
  it('an explicit work tree inside the install is denied even when it names no protected path', () => {
    for (const c of [`git --work-tree=${root}/vendor checkout other`, `GIT_WORK_TREE=${root}/vendor git checkout other`, `git --work-tree ${root}/vendor reset --hard`])
      expect(denied(c, wt), c).toBe(true)
    // a work tree OUTSIDE the install, with the git directory of the worktree it runs in
    expect(denied(`git --work-tree=${base}/elsewhere checkout other`, wt)).toBe(false)
  })
  it('an explicit work tree elsewhere still moves the HEAD and index of the install when the cwd is in it', () => {
    expect(denied(`git --work-tree=${wt} checkout other`, root)).toBe(true)
    expect(denied(`GIT_WORK_TREE=${wt} git checkout other`, join(root, 'src'))).toBe(true)
  })
  it('-C into a worktree from the install is allowed; -C back to the install is not', () => {
    expect(denied(`git -C ${wt} checkout other`, root)).toBe(false)
    expect(denied('git -C ../wt checkout other', root)).toBe(false)
    expect(denied('git -C . checkout other', root)).toBe(true)
    expect(denied('git -C .. checkout other', join(root, 'agents', 'agent-a'))).toBe(true)
  })
  it('cd into a worktree with && moves the chain; any other separator keeps the old directory in play', () => {
    expect(denied(`cd ${wt} && git checkout other`, root)).toBe(false)
    expect(denied(`cd ${wt} && git status && git checkout other`, root)).toBe(false)
    expect(denied(`cd ${wt}; git checkout other`, root)).toBe(true)
    expect(denied(`cd ${wt} || git checkout other`, root)).toBe(true)
    expect(denied(`cd ${wt} && git status; git checkout other`, root)).toBe(true)
    expect(denied(`(cd ${wt} && git status); git checkout other`, root)).toBe(true)
    expect(denied(`cd ${root} && git checkout other`, wt)).toBe(true)
  })
  it('a cd target that cannot be resolved denies a tree writer, a resolvable variable does not', () => {
    expect(denied('cd "$SOMEWHERE" && git checkout other', wt)).toBe(true)
    expect(denied('cd $(pwd)/.. && git checkout other', wt)).toBe(true)
    expect(denied(`W=${wt}; cd $W && git checkout other`, root)).toBe(false)
    expect(denied('cd "$SOMEWHERE" && git status', wt)).toBe(false)
  })
  it('an install with no repository at all fails closed for a writer and leaves a worktree outside it alone', () => {
    expect(denied('git checkout other', noGit, noGit)).toBe(true)
    expect(denied('git checkout other', join(noGit, 'agents', 'agent-a'), noGit)).toBe(true)
    expect(denied('git checkout other', wt, noGit)).toBe(false)
    expect(denied('git status', noGit, noGit)).toBe(false)
  })
  it('patch honours -d like a cwd; xargs is judged by what it runs', () => {
    expect(denied(`patch -d ${wt} -p1 < x.diff`, root)).toBe(false)
    expect(denied(`patch -d ${root} -p1 < x.diff`, wt)).toBe(true)
    expect(denied('xargs -n1 rm', root)).toBe(true)
    expect(denied('xargs -I{} mv {} /tmp/x', root)).toBe(true)
    expect(denied('xargs -n1 rm', wt)).toBe(false)
    expect(denied('xargs -n1 grep needle', root)).toBe(false)
  })
})

describe('R-IMPL review round 1: directory tracking, wrappers, text commands, option parsing', () => {
  it('popd, cd -, cd ~- and a plain relative cd name do not narrow the chain to a directory they may not reach', () => {
    expect(denied(`pushd ${wt} && popd && git checkout other`, root)).toBe(true)
    expect(denied(`cd ${wt} && cd - && git checkout other`, root)).toBe(true)
    expect(denied('cd ~- && git checkout other', wt)).toBe(true)
    expect(denied('cd ~+ && git checkout other', wt)).toBe(true)
    // CDPATH may redirect a plain name; ./ and ../ and absolute paths cannot be redirected
    expect(denied('cd vendor/lib && git checkout main', root)).toBe(true)
    expect(denied('cd ./vendor/lib && git checkout main', root)).toBe(false)
    expect(denied('cd ../wt && git checkout other', root)).toBe(false)
  })
  it('a wrapper with a value option does not hide the command', () => {
    for (const c of ['nice -n 5 git checkout other', 'timeout 5 git checkout other', 'sudo -u someone git reset --hard', 'stdbuf -oL git clean -fd',
      `env -C ${wt} git checkout other`, 'nohup nice -n 1 git switch other', 'timeout 5 patch -p1 < x.diff', 'nice -n 5 tar xzf a.tgz'])
      expect(denied(c, root), c).toBe(true)
    // env -C / sudo -D change the directory first: from a worktree that is not a reason to trust the cwd
    expect(denied(`env -C ${root} git checkout other`, wt)).toBe(true)
    expect(denied('sudo -D ../install git checkout other', wt)).toBe(true)
    expect(denied('sudo -D $TARGET git checkout other', wt)).toBe(true)
    expect(denied('find vendor -name x -exec git checkout other {} \\;', root)).toBe(true)
    expect(denied('nice -n 5 git checkout other', wt)).toBe(false)
    expect(denied('nice -n 5 git status', root)).toBe(false)
    expect(denied(`env GIT_WORK_TREE=${root} nice -n 1 git checkout other`, wt)).toBe(true)
  })
  it('a command handed over as text is judged as a command of its own', () => {
    for (const c of ["bash -c 'git checkout other'", 'sh -c "git reset --hard"', "zsh -lc 'git clean -fd'", 'eval git checkout other', 'echo $(git checkout other)',
      'x=`git reset --hard`', "find . -name x -exec git checkout other {} \\;", "bash -c 'bash -c \"bash -c \\\"bash -c git\\ checkout\\ other\\\"\"'",
      `bash -c 'cd ${root} && git checkout other'`])
      expect(denied(c, root), c).toBe(true)
    expect(denied(`sh -c "cd ${wt} && git checkout other"`, root)).toBe(false)
    expect(denied("bash -c 'git status'", root)).toBe(false)
    expect(denied('echo $(git rev-parse HEAD)', root)).toBe(false)
    expect(denied('bash -c "git checkout other"', wt)).toBe(false)
  })
  it('xargs git is judged like the same git typed directly', () => {
    for (const c of ['xargs git checkout', 'git ls-files -d | xargs git rm', 'xargs -I{} git restore {}', 'xargs -n1 git apply']) expect(denied(c, root), c).toBe(true)
    expect(denied('xargs git status', root)).toBe(false)
    expect(denied(`xargs -I{} git -C ${wt} checkout {}`, root)).toBe(false)
    expect(denied('xargs git checkout', wt)).toBe(false)
  })
  it('fetch and ls-remote take an allowlist of options, so an abbreviated long option is refused', () => {
    for (const c of ['git fetch --upload-p=/tmp/x origin', 'git fetch --upl=/tmp/x origin', 'git fetch --exe=/tmp/x', 'git fetch -u origin main:main', 'git fetch --update-head-ok origin',
      'git fetch --server-option=x origin', 'git ls-remote --upload-pack=/tmp/x origin', 'git ls-remote --up=/tmp/x origin', 'git fetch ext::sh'])
      expect(denied(c, root), c).toBe(true)
    for (const c of ['git fetch --prune origin', 'git fetch -p origin', 'git fetch --all --tags', 'git fetch --depth=1 origin main', 'git ls-remote --heads origin', 'git ls-remote --tags origin'])
      expect(denied(c, root), c).toBe(false)
  })
  it('patch reads only under --dry-run / --check / -C as an option, not as the value of another option', () => {
    for (const c of ['patch -o --dry-run -p1 < x.diff', 'patch -r -C -p1 < x.diff', 'patch -i x.diff', 'patch -p1 -z .orig < x.diff', 'patch -B --check < x.diff']) expect(denied(c, root), c).toBe(true)
    for (const c of ['patch -C -p1 < x.diff', 'patch --check -p1 < x.diff', 'patch -p1 --dry-run < x.diff', 'patch --dry-run -i x.diff']) expect(denied(c, root), c).toBe(false)
  })
  it('worktree add takes no --force and no -B (a branch checked out in the install could be reset)', () => {
    for (const c of ['git worktree add -f ../wtx other', 'git worktree add --force ../wtx other', 'git worktree add -B main ../wtx other', 'git worktree add -b topic -f ../wtx other', 'git worktree add --unknown ../wtx'])
      expect(denied(c, root), c).toBe(true)
    for (const c of ['git worktree add -b topic ../wtx origin/develop', 'git worktree add --detach ../wtx', 'git worktree add --no-checkout -q ../wtx other']) expect(denied(c, root), c).toBe(false)
  })
})

describe('R-IMPL: the hook answers with the way out', () => {
  it('denies through the hook entry point and names git worktree add', () => {
    const hook = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'self-pace-gate.mjs')
    const install = dirname(dirname(hook))
    const out = spawnSync('node', [hook], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git checkout other' }, cwd: install }), encoding: 'utf-8' })
    const body = JSON.parse(out.stdout)
    expect(body.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain('git worktree add')
  })
  it('gateDecision passes the reason through', () => {
    expect(gateDecision('Bash', { command: 'git checkout other' }, opts(root, root))).toEqual({ deny: true, reason: 'install-tree' })
  })
})
