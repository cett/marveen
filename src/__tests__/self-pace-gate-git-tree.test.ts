// A git subcommand that rewrites the working tree it runs in (checkout, switch, merge, pull, rebase, cherry-pick, reset --hard,
// restore --source, read-tree -u, stash pop, apply, am, clean ...) names no protected path, so the word-based rules never see it.
// The self-pace gate judges it by WHERE it runs: refused when the working tree is the install or under it, free in a real path
// outside the install (a git worktree copy). An allowlist (read-only subcommands, fetch, worktree, help), not a list of names.
//
// Every refusal below has an allowed twin (the same command in the worktree copy) and every allow a refused twin.
// Neutral fixture only: a tmp world with a made-up install, no real names, paths or ids.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string // the install
let agentCwd: string // a sub-agent's own directory, UNDER the install
let wt: string // a git worktree copy: a real path outside the install
let wt2: string
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'git-tree-'))
  root = join(base, 'fixture-root')
  wt = join(base, 'worktrees', 'feat')
  wt2 = join(base, 'worktrees', 'feat2')
  agentCwd = join(root, 'agents', 'agent-a')
  for (const r of [root, wt, wt2]) {
    for (const rel of ['scripts/self-pace-gate.mjs', 'scripts/email-send-gate.mjs', 'scripts/hooks/egress-gate.mjs', 'scripts/lib/homoglyph.py', 'scripts/agent-api.sh',
      'scripts/sync-hooks.sh', 'scripts/doctor.sh', 'scripts/gate-onfailure-check.py', 'scripts/secret-gate.ts', 'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts']) touch(join(r, rel))
  }
  mkdirSync(agentCwd, { recursive: true })
  mkdirSync(join(wt, 'sub'), { recursive: true })
  touch(join(root, 'store', 'egress-allowlist.json'), '{"domains":[]}')
  symlinkSync(root, join(base, 'alias-root'))
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const opts = (cwd: string) => ({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const bash = (command: string, cwd: string) => gateDecision('Bash', { command }, opts(cwd))
const ALLOW = { deny: false }
const DENY = { deny: true }
// a git subcommand line per rewriting subcommand (the argument shapes that do not name a protected path)
const REWRITES = [
  'git checkout feature', 'git checkout -b feature', 'git checkout feature -- .', 'git switch feature', 'git switch -c feature', 'git merge feature', 'git merge --ff-only feature',
  'git pull', 'git pull --ff-only origin develop', 'git rebase feature', 'git rebase --continue', 'git cherry-pick abc123', 'git revert abc123', 'git reset --hard',
  'git reset --hard feature', 'git restore --source=feature .', 'git restore .', 'git read-tree -u feature', 'git stash', 'git stash pop', 'git apply change.diff', 'git am change.mbox',
  'git clean -fd', 'git sparse-checkout set src', 'git submodule update --init', 'git bisect start', 'git mv a b', 'git rm a', 'git config core.hooksPath /tmp/h', 'git update-index --assume-unchanged x',
  'git unknown-alias-name', 'git co feature',
]

describe('a sub-agent in the install: a tree-rewriting git is refused, whatever the subcommand', () => {
  it.each(REWRITES)('refused in the agent directory: %s', (command) => {
    expect({ command, r: bash(command, agentCwd) }).toMatchObject({ command, r: DENY })
  })
  it.each(REWRITES)('refused in the install root: %s', (command) => {
    expect({ command, r: bash(command, root) }).toMatchObject({ command, r: DENY })
  })
  it.each(REWRITES)('allowed in the worktree copy (the positive twin): %s', (command) => {
    expect({ command, r: bash(command, wt) }).toEqual({ command, r: ALLOW })
  })
  it.each(['git status', 'git diff', 'git log --oneline -3', 'git show HEAD', 'git blame x', 'git ls-files', 'git add x', 'git commit -m wip', 'git rev-parse HEAD', 'git grep -n x', 'git describe'])(
    'a read-only subcommand is free in the install: %s', (command) => {
      expect({ command, r: bash(command, agentCwd) }).toEqual({ command, r: ALLOW })
    })
  it.each(['git worktree add -b feature ../../../worktrees/feat3 origin/develop','git worktree list', 'git help checkout', 'git version', 'git --version', 'git --help', 'git'])(
    'the subcommands with no tree to rewrite (worktree has its own gate, help, version) are not judged here: %s', (command) => {
      expect({ command, r: bash(command, agentCwd) }).toEqual({ command, r: ALLOW })
    })
})

describe('git fetch is the one harmless extra: free in the install unless it can run a program', () => {
  it.each(['git fetch', 'git fetch origin', 'git fetch origin develop', 'git fetch --all --prune', 'git fetch -p origin', 'git fetch https://example.invalid/r.git develop'])('allowed: %s', (command) => {
    expect({ command, r: bash(command, agentCwd) }).toEqual({ command, r: ALLOW })
  })
  it.each([
    'git fetch --upload-pack=/tmp/evil origin', 'git fetch --upload-pack /tmp/evil origin', 'git fetch --upload-pa=/tmp/evil origin', 'git fetch --receive-pack=x origin', 'git fetch --exec=x origin',
    'git fetch -u origin develop:develop', 'git fetch -pu origin', 'git fetch --update-head-ok origin develop:develop', 'git fetch --update-head origin develop:develop',
    "git fetch 'ext::sh -c touch% /tmp/x'", 'git fetch ext::sh origin', 'git fetch fd::3', "git -c protocol.ext.allow=always fetch 'ext::x'", 'git -ccore.pager=x fetch', 'git --config-env=a=B fetch',
  ])('refused: %s', (command) => {
    expect({ command, r: bash(command, agentCwd) }).toMatchObject({ command, r: DENY })
  })
  it('in the worktree copy even the program-running forms are not this rule\'s business', () => {
    expect(bash('git fetch --upload-pack=/tmp/evil origin', wt)).toEqual(ALLOW)
  })
})

describe('where the command runs: -C, --work-tree, --git-dir, the environment', () => {
  const REPO = () => root
  it('-C a worktree copy from the install is free; -C the install from the worktree copy is refused (both directions)', () => {
    expect(bash(`git -C ${wt} checkout feature`, agentCwd)).toEqual(ALLOW)
    expect(bash(`git -C ${wt} pull`, root)).toEqual(ALLOW)
    expect(bash(`git -C ${REPO()} checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`git -C ${join(root, 'agents')} pull`, wt)).toMatchObject(DENY)
    expect(bash(`git -C ${agentCwd} rebase feature`, wt)).toMatchObject(DENY)
  })
  it('-C chained and relative: each is relative to the one before', () => {
    expect(bash('git -C sub checkout feature', wt)).toEqual(ALLOW)
    expect(bash(`git -C ${wt} -C sub checkout feature`, root)).toEqual(ALLOW)
    expect(bash(`git -C ${base} -C fixture-root checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`git -C ${base} -C fixture-root -C ../worktrees/feat checkout feature`, wt)).toEqual(ALLOW)
    expect(bash('git -C .. checkout feature', agentCwd)).toMatchObject(DENY)
    expect(bash('git -C ../.. checkout feature', agentCwd)).toMatchObject(DENY)
    expect(bash('git -C ../../.. checkout feature', agentCwd)).toEqual(ALLOW) // the directory above the install holds it but is not it
  })
  it('--work-tree decides the tree, the cwd does not', () => {
    expect(bash(`git --work-tree=${REPO()} checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`git --work-tree ${REPO()} checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`git --work-tree=${wt} checkout feature`, agentCwd)).toEqual(ALLOW)
    expect(bash(`git --work-tree ${wt} checkout feature`, root)).toEqual(ALLOW)
  })
  it('an explicit --git-dir inside the install is the install\'s own repository, whatever tree it is pointed at', () => {
    expect(bash(`git --git-dir=${join(root, '.git')} --work-tree=${wt} checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`git --git-dir=${join(root, '.git')} checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`git --git-dir ${join(root, '.git', 'worktrees', 'x')} reset --hard`, wt)).toMatchObject(DENY)
    expect(bash(`git --git-dir=${join(wt, '.git')} --work-tree=${wt} checkout feature`, agentCwd)).toEqual(ALLOW)
  })
  it('GIT_WORK_TREE and GIT_DIR in the environment of the command', () => {
    expect(bash(`GIT_WORK_TREE=${REPO()} git checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`GIT_DIR=${join(root, '.git')} git checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`GIT_DIR=${join(root, '.git')} GIT_WORK_TREE=${wt} git reset --hard`, wt)).toMatchObject(DENY)
    expect(bash(`GIT_WORK_TREE=${wt} git checkout feature`, agentCwd)).toEqual(ALLOW)
    expect(bash(`GIT_WORK_TREE=${wt} GIT_DIR=${join(wt, '.git')} git checkout feature`, root)).toEqual(ALLOW)
    expect(bash('GIT_WORK_TREE=. git checkout feature', agentCwd)).toMatchObject(DENY)
    expect(bash('GIT_WORK_TREE=. git checkout feature', wt)).toEqual(ALLOW)
    expect(bash(`env GIT_WORK_TREE=${REPO()} git checkout feature`, wt)).toMatchObject(DENY)
  })
  it('an option beats the environment, as in git', () => {
    expect(bash(`GIT_WORK_TREE=${wt2} git --work-tree=${wt} checkout feature`, agentCwd)).toEqual(ALLOW)
    expect(bash(`GIT_WORK_TREE=${wt} git --work-tree=${REPO()} checkout feature`, wt)).toMatchObject(DENY)
    // the environment points into the install (a plain directory of it), the option points out of it
    expect(bash(`GIT_WORK_TREE=docs git --work-tree=${wt} checkout feature`, root)).toEqual(ALLOW)
    expect(bash('GIT_WORK_TREE=docs git checkout feature', root)).toMatchObject(DENY)
  })
  it('a wrapper in front of git does not hide it', () => {
    expect(bash('env git checkout feature', agentCwd)).toMatchObject(DENY)
    expect(bash('command git checkout feature', agentCwd)).toMatchObject(DENY)
    expect(bash('nice git pull', agentCwd)).toMatchObject(DENY)
    expect(bash('/usr/bin/git checkout feature', agentCwd)).toMatchObject(DENY)
    expect(bash('env git checkout feature', wt)).toEqual(ALLOW)
  })
})

describe('a cd in front of git (the same compound command, sequential)', () => {
  it('cd into the worktree copy from the install is free, cd into the install from the worktree copy is refused', () => {
    expect(bash(`cd ${wt} && git checkout feature`, agentCwd)).toEqual(ALLOW)
    // after `;` or a newline the git runs wherever the command was if the cd failed: the directory it came from counts too
    expect(bash(`cd ${wt}; git pull`, root)).toMatchObject(DENY)
    expect(bash(`cd ${wt}\ngit rebase feature`, root)).toMatchObject(DENY)
    expect(bash(`cd ${wt}; git pull`, wt2)).toEqual(ALLOW) // every directory in play is outside the install
    expect(bash(`cd ${root} && git checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`cd ${root}; git checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`cd ${root}\ngit checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`cd ${agentCwd} && git pull`, wt)).toMatchObject(DENY)
    expect(bash(`cd ${root}/agents/agent-a/.. && git merge feature`, wt)).toMatchObject(DENY)
  })
  it('the last cd wins', () => {
    expect(bash(`cd ${root} && cd ${wt} && git checkout feature`, wt)).toEqual(ALLOW)
    expect(bash(`cd ${wt} && cd ${root} && git checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`cd ${wt} && cd sub && git checkout feature`, agentCwd)).toEqual(ALLOW)
    expect(bash('cd .. && cd .. && git checkout feature', agentCwd)).toMatchObject(DENY)
    expect(bash(`pushd ${wt} && git checkout feature`, agentCwd)).toEqual(ALLOW)
    expect(bash(`pushd ${root} && git checkout feature`, wt)).toMatchObject(DENY)
  })
  it('git -C after a cd is relative to that cd', () => {
    expect(bash(`cd ${base} && git -C worktrees/feat checkout feature`, agentCwd)).toEqual(ALLOW)
    expect(bash(`cd ${base} && git -C fixture-root checkout feature`, wt)).toMatchObject(DENY)
  })
  it('a pipe, ||, a background job: the command may run in any directory it has been in', () => {
    expect(bash(`cd ${wt} || git checkout feature`, agentCwd)).toMatchObject(DENY) // the cd may fail
    expect(bash(`cd ${wt} | git checkout feature`, agentCwd)).toMatchObject(DENY) // a pipe runs each side in a subshell
    expect(bash(`cd ${wt} & git checkout feature`, agentCwd)).toMatchObject(DENY)
    expect(bash(`cd ${wt} || git checkout feature`, wt2)).toEqual(ALLOW) // every directory in play is outside
    expect(bash(`false && cd ${wt}; git checkout feature`, agentCwd)).toMatchObject(DENY) // the cd may not have run
    expect(bash(`test -d x && cd ${wt}\ngit checkout feature`, agentCwd)).toMatchObject(DENY)
    expect(bash(`test -d x && cd ${wt} && git checkout feature`, agentCwd)).toEqual(ALLOW) // the git only runs after the cd
    expect(bash(`mkdir -p x && cd ${wt} && git checkout feature`, agentCwd)).toEqual(ALLOW)
  })
  it('a subshell, a brace group and a shell keyword hide the cd: refused (fail closed)', () => {
    for (const command of [`(cd ${root}; git checkout feature)`, `(cd ${wt}; git checkout feature)`, `{ cd ${root}; git checkout feature; }`, `if cd ${wt}; then git checkout feature; fi`,
      `for d in a; do git -C ${wt} checkout feature; done`, `cd ${wt} && (git checkout feature)`]) {
      expect({ command, r: bash(command, wt) }).toMatchObject({ command, r: DENY })
    }
    // a command substitution is judged as a command of its own, in the directory the outer command starts in
    for (const command of ['echo $(git checkout feature)', 'x=`git pull`', '$(git merge feature)', 'echo $(git -C ../.. checkout feature)']) {
      expect({ command, r: bash(command, agentCwd) }).toMatchObject({ command, r: DENY })
    }
    expect(bash('echo $(git checkout feature)', wt)).toEqual(ALLOW)
    expect(bash('echo $(git status)', agentCwd)).toEqual(ALLOW)
    expect(bash('(git status)', agentCwd)).toEqual(ALLOW) // no tree-rewriting git inside: nothing to refuse
  })
})

describe('a path that cannot be read off the text is refused, one that can is compared by identity', () => {
  it('variables, substitutions, globs, `cd -`, popd: refused', () => {
    for (const command of ['git -C $UNSET_DIR checkout feature', 'git -C "$(pwd)" checkout feature', 'git -C `pwd` checkout feature', `git -C ${base}/worktrees/* checkout feature`,
      'git --work-tree=$UNSET_DIR checkout feature', 'GIT_WORK_TREE=$UNSET_DIR git checkout feature', 'cd $UNSET_DIR && git checkout feature', 'cd - && git checkout feature',
      'cd "$(mktemp -d)" && git checkout feature', `cd ${base}/work*/feat && git checkout feature`, 'popd && git checkout feature', 'git -C {a,b} checkout feature', 'git -Cx checkout feature']) {
      expect({ command, r: bash(command, wt) }).toMatchObject({ command, r: DENY })
    }
  })
  it('a variable that the same command sets is read', () => {
    expect(bash(`WT=${wt}; cd $WT && git checkout feature`, agentCwd)).toEqual(ALLOW)
    expect(bash(`WT=${root}; cd $WT && git checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`D=${wt} && git -C $D pull`, agentCwd)).toEqual(ALLOW)
  })
  it('the install under a symlinked spelling is the install', () => {
    expect(bash(`git -C ${join(base, 'alias-root')} checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`cd ${join(base, 'alias-root', 'agents')} && git pull`, wt)).toMatchObject(DENY)
    expect(bash(`git --work-tree=${join(base, 'alias-root')} checkout feature`, wt)).toMatchObject(DENY)
    expect(bash('git checkout feature', join(base, 'alias-root'))).toMatchObject(DENY)
  })
  it('a spelling in another letter case is the install on a case-insensitive filesystem (APFS)', () => {
    const insensitive = existsSync(root.replace('fixture-root', 'FIXTURE-ROOT'))
    if (!insensitive) return // a case-sensitive filesystem: a different case is a different directory, nothing to pin
    expect(bash(`git -C ${root.replace('fixture-root', 'FIXTURE-ROOT')} checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`cd ${root.replace('fixture-root', 'Fixture-Root')}/agents && git pull`, wt)).toMatchObject(DENY)
    expect(bash('git checkout feature', root.replace('fixture-root', 'FIXTURE-ROOT'))).toMatchObject(DENY)
  })
  it('a path that does not exist yet is judged by its nearest existing parent', () => {
    expect(bash(`git -C ${join(root, 'agents', 'not-yet-made')} checkout feature`, wt)).toMatchObject(DENY)
    expect(bash(`git -C ${join(base, 'worktrees', 'not-yet-made')} checkout feature`, agentCwd)).toEqual(ALLOW)
  })
  it('the sibling of the install and its parent are not the install', () => {
    const sibling = join(base, 'fixture-root-copy'); mkdirSync(sibling)
    expect(bash(`git -C ${sibling} checkout feature`, agentCwd)).toEqual(ALLOW)
    expect(bash(`git -C ${base} checkout feature`, agentCwd)).toEqual(ALLOW)
  })
})

describe('review findings: ways to move the tree or hide the git that the first version missed', () => {
  it('a cd that fails: `cd /missing; git ...` runs where the command already was', () => {
    expect(bash(`cd ${base}/does-not-exist; git checkout feature`, agentCwd)).toMatchObject(DENY)
    expect(bash(`cd ${base}/does-not-exist\ngit pull`, agentCwd)).toMatchObject(DENY)
    expect(bash(`cd ${base}/does-not-exist || git pull`, agentCwd)).toMatchObject(DENY)
    expect(bash(`cd ${base}/does-not-exist; git checkout feature`, wt)).toEqual(ALLOW)
    expect(bash(`cd ${wt} && git checkout feature`, agentCwd)).toEqual(ALLOW) // the && chain is exact
  })
  it('GIT_WORK_TREE / GIT_DIR / GIT_COMMON_DIR set elsewhere in the command', () => {
    for (const command of [`export GIT_WORK_TREE=${root}; git checkout feature`, `GIT_WORK_TREE=${root}\ngit checkout feature`, `export GIT_DIR=${join(root, '.git')} && git reset --hard`,
      `set -a; GIT_WORK_TREE=${root}; git pull`, `declare -x GIT_WORK_TREE=${root}; git merge feature`, `export GIT_COMMON_DIR=${join(root, '.git')}; git checkout feature`,
      `GIT_COMMON_DIR=${join(root, '.git')} git checkout feature`, `bash -c 'x=1'; export GIT_WORK_TREE=${root} && git checkout feature`]) {
      expect({ command, r: bash(command, wt) }).toMatchObject({ command, r: DENY })
    }
    expect(bash(`export GIT_WORK_TREE=${wt}; git checkout feature`, wt)).toMatchObject(DENY) // even an outside value: refused, not guessed
    expect(bash(`GIT_WORK_TREE=${wt} git checkout feature`, agentCwd)).toEqual(ALLOW) // the prefix of this very git is read
  })
  it('a launcher with an option value in front of git does not hide it', () => {
    for (const command of ['nice -n 5 git checkout feature', 'env -u FOO git checkout feature', 'timeout 5 git pull', 'sudo -u nobody git merge feature', 'xargs git checkout', 'nice -n 5 /usr/bin/git pull', 'time -p git rebase feature']) {
      expect({ command, r: bash(command, agentCwd) }).toMatchObject({ command, r: DENY })
      expect({ command, r: bash(command, wt) }).toEqual({ command, r: ALLOW })
    }
    expect(bash('nice -n 5 git status', agentCwd)).toEqual(ALLOW)
    expect(bash('echo nice git', agentCwd)).toEqual(ALLOW) // no launcher word in front of the git word
  })
  it('a command substitution after a cd is judged as if it ran in the install as well', () => {
    expect(bash(`cd ${root} && echo $(git checkout feature)`, wt)).toMatchObject(DENY)
    expect(bash(`cd ${root}; x=$(git pull)`, wt)).toMatchObject(DENY)
    expect(bash(`cd ${wt} && echo $(git checkout feature)`, wt)).toMatchObject(DENY) // not worth tracking: refused with any cd
    expect(bash('echo $(git checkout feature)', wt)).toEqual(ALLOW) // no cd: the start directory decides
    expect(bash(`cd ${root} && echo $(git status)`, wt)).toEqual(ALLOW)
  })
})

describe('bounds: the decision stays linear and fails closed', () => {
  it('a very long command with a rewriting git is refused without walking it', () => {
    const args = Array.from({ length: 400 }, (_, i) => `f${i}`).join(' ')
    expect(bash(`git checkout feature -- ${args}`, wt)).toMatchObject(DENY)
  })
  it('many cd targets: refused rather than compared one by one', () => {
    const cds = Array.from({ length: 40 }, (_, i) => `cd ${wt}/d${i}`).join(' | ')
    expect(bash(`${cds} | git checkout feature`, wt)).toMatchObject(DENY)
  })
  it('a deep path of the allowed kind is still decided quickly', () => {
    const deep = join(wt, ...Array.from({ length: 60 }, (_, i) => `d${i}`))
    const t0 = Date.now()
    expect(bash(`git -C ${deep} checkout feature`, agentCwd)).toEqual(ALLOW)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('the existing rules are unchanged next to it', () => {
  it('a protected path named by a git read, a staged add, and the other protected commands behave as before', () => {
    expect(bash('git add scripts/hooks/egress-gate.mjs', agentCwd)).toEqual(ALLOW)
    expect(bash('git diff -- scripts/hooks/egress-gate.mjs', agentCwd)).toEqual(ALLOW)
    expect(bash('git log --oneline -- scripts/lib', root)).toEqual(ALLOW)
    expect(bash('git checkout feature -- scripts/hooks/egress-gate.mjs', wt)).toEqual(ALLOW) // the worktree copy is free
    expect(bash('git checkout feature -- scripts/hooks/egress-gate.mjs', root)).toMatchObject(DENY)
    expect(bash('rm -rf scripts', root)).toMatchObject(DENY)
    expect(bash('ls scripts', root)).toEqual(ALLOW)
  })
})
