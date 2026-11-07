// R-IMPL: the self-pace gate judges a git / patch / xargs command by the tree it WRITES, not only by the
// protected path it names. `git checkout other` names nothing, yet in the install it replaces the gate
// files with the other branch's. The fixture is a real git install (a `.git` DIRECTORY), a linked
// worktree outside it, a linked worktree INSIDE it (its `.git` is a file) and an agent directory.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { bashProtectedDecision, gateDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
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
  it('patch: a long option that is not spelled in full (getopt abbreviation) or not known is never a dry run', () => {
    // --ou is --output, so --dry-run after it is the FILE NAME it writes to, not the flag
    for (const c of ['patch --ou --dry-run -p1 < x.diff', 'patch --out --dry-run < x.diff', 'patch --dry -p1 < x.diff', 'patch --dr x.diff', 'patch --che < x.diff', 'patch --made-up-option --dry-run < x.diff', 'patch --dry-run --made-up-option < x.diff'])
      expect(denied(c, root), c).toBe(true)
    for (const c of ['patch --dry-run --forward --quiet -p1 < x.diff', 'patch --check --reverse -p1 < x.diff', 'patch --dry-run --reject-file r.rej -i x.diff', 'patch --dry-run --debug=1 < x.diff'])
      expect(denied(c, root), c).toBe(false)
  })
  it('worktree add takes no --force and no -B (a branch checked out in the install could be reset)', () => {
    for (const c of ['git worktree add -f ../wtx other', 'git worktree add --force ../wtx other', 'git worktree add -B main ../wtx other', 'git worktree add -b topic -f ../wtx other', 'git worktree add --unknown ../wtx'])
      expect(denied(c, root), c).toBe(true)
    for (const c of ['git worktree add -b topic ../wtx origin/develop', 'git worktree add --detach ../wtx', 'git worktree add --no-checkout -q ../wtx other']) expect(denied(c, root), c).toBe(false)
  })
})

describe('R-IMPL: a git directory of the install, reached from a worktree', () => {
  const link = () => join(base, 'gitlink')
  beforeAll(() => { symlinkSync(join(root, '.git'), link()) })
  it('GIT_DIR / --git-dir into the install .git: a writer is refused from a worktree cwd, in every spelling', () => {
    for (const w of ['checkout other', 'reset --hard', 'merge other', 'stash pop']) {
      expect(denied(`GIT_DIR=${root}/.git git ${w}`, wt), w).toBe(true)
      expect(denied(`git --git-dir=${root}/.git ${w}`, wt), w).toBe(true)
      expect(denied(`git --git-dir ${root}/.git ${w}`, wt), w).toBe(true)
      expect(denied(`export GIT_DIR=${root}/.git; git ${w}`, wt), w).toBe(true)
      expect(denied(`GIT_DIR=${link()} git ${w}`, wt), `symlink ${w}`).toBe(true)
      expect(denied(`GIT_DIR=../install/.git git ${w}`, wt), `relative ${w}`).toBe(true)
    }
  })
  it('the same git directory with a positive-list reader stays allowed', () => {
    for (const c of ['log --oneline -3', 'diff', 'status', 'show HEAD', 'ls-files']) {
      expect(denied(`GIT_DIR=${root}/.git git ${c}`, wt), c).toBe(false)
      expect(denied(`git --git-dir=${link()} ${c}`, wt), c).toBe(false)
    }
  })
  it('the own git directory of a linked worktree is that worktree: the legitimate use', () => {
    expect(denied(`GIT_DIR=${root}/.git/worktrees/wt git checkout other`, wt)).toBe(false)
    expect(denied(`git --git-dir=${root}/.git/worktrees/wt checkout other`, wt)).toBe(false)
    expect(denied(`GIT_DIR=${wt}/.git git checkout other`, wt)).toBe(false) // the .git FILE points at it
  })
  it('-c core.worktree goes through the same work tree resolution', () => {
    expect(denied(`git -c core.worktree=${root} checkout other`, wt)).toBe(true)
    expect(denied(`git -c core.worktree=${root}/vendor reset --hard`, wt)).toBe(true)
    expect(denied(`git -c core.worktree=${base}/elsewhere checkout other`, wt)).toBe(false)
  })
})

describe('R-IMPL: only a VALID .git entry makes a toplevel', () => {
  let fakeDir: string; let fakeLink: string; let fakeFile: string
  beforeAll(() => {
    fakeDir = join(root, 'src', 'deep', 'fake'); fakeLink = join(root, 'src', 'deep', 'link'); fakeFile = join(root, 'src', 'deep', 'file')
    mkdirSync(join(fakeDir, '.git'), { recursive: true }) // empty: git steps over it
    mkdirSync(fakeLink, { recursive: true }); symlinkSync(join(root, '.git'), join(fakeLink, '.git'))
    mkdirSync(fakeFile, { recursive: true }); writeFileSync(join(fakeFile, '.git'), `gitdir: ${root}/.git\n`)
  })
  it('an empty .git directory, a symlink to the install .git and a gitfile that points at it are still the install', () => {
    for (const cwd of [fakeDir, fakeLink, fakeFile]) {
      for (const c of ['git checkout other', 'git reset --hard', `cd ${cwd} && git checkout other`]) expect(denied(c, cwd), `${c} @ ${cwd}`).toBe(true)
      expect(denied('git status', cwd)).toBe(false)
    }
  })
  it('a real repository and a linked worktree inside the install are still their own toplevel', () => {
    expect(denied('git checkout main', vendor)).toBe(false)
    expect(denied('git checkout other', nested)).toBe(false)
    expect(denied('git checkout other', wt)).toBe(false)
  })
})

describe('R-IMPL: isGitDir mirrors git (HEAD content, objects AND refs)', () => {
  const dirs: Record<string, string> = {}
  const mk = (name: string, head: string | null, sub: string[]) => {
    const d = join(root, 'src', 'deep', 'gd-' + name); mkdirSync(d, { recursive: true })
    const g = join(d, '.git'); mkdirSync(g, { recursive: true })
    for (const s of sub) mkdirSync(join(g, s), { recursive: true })
    if (head !== null) writeFileSync(join(g, 'HEAD'), head)
    dirs[name] = d
  }
  beforeAll(() => {
    mk('emptyhead', '', ['objects', 'refs'])
    mk('garbage', 'not a head\n', ['objects', 'refs'])
    mk('noheadfile', null, ['objects', 'refs'])
    mk('norefs', 'ref: refs/heads/main\n', ['objects'])
    mk('noobjects', 'ref: refs/heads/main\n', ['refs'])
    mk('badref', 'ref: /etc/passwd\n', ['objects', 'refs'])
    mk('shorthex', 'abc123\n', ['objects', 'refs'])
    mk('symref', 'ref: refs/heads/main\n', ['objects', 'refs'])
    mk('hex40', 'a'.repeat(40) + '\n', ['objects', 'refs'])
    mk('hex64', 'b'.repeat(64) + '\n', ['objects', 'refs'])
    const real = join(root, 'src', 'deep', 'gd-real'); mkdirSync(real, { recursive: true }); git(real, 'init', '-q', '-b', 'main'); dirs.real = real
    // a commondir file: HEAD is valid, there is no objects/ or refs/ of its own, the commondir names the shared directory
    const mkc = (name: string, common: string | null) => {
      mk(name, 'ref: refs/heads/main\n', [])
      if (common !== null) writeFileSync(join(dirs[name], '.git', 'commondir'), common)
    }
    mkc('commonjunk', 'junk\n') // names a directory that does not exist
    mkc('commonempty', '')
    mkc('commonblank', '\n')
    mkc('commonnofile', null) // no commondir at all: nothing to follow
    mkc('commonhollow', '../hollow\n') // names a directory with HEAD but no objects/refs
    mkdirSync(join(root, 'src', 'deep', 'gd-commonhollow', 'hollow'), { recursive: true }); writeFileSync(join(root, 'src', 'deep', 'gd-commonhollow', 'hollow', 'HEAD'), 'ref: refs/heads/main\n')
    mkc('commonchain', '../middle\n') // names a directory that itself only has a commondir: no chain
    const mid = join(root, 'src', 'deep', 'gd-commonchain', 'middle'); mkdirSync(mid, { recursive: true }); writeFileSync(join(mid, 'HEAD'), 'ref: refs/heads/main\n'); writeFileSync(join(mid, 'commondir'), `${join(real, '.git')}\n`)
    // valid: the commondir (relative to the gitdir, or absolute) names a real repository's git directory
    mkc('commonrel', `${relative(join(root, 'src', 'deep', 'gd-commonrel', '.git'), join(real, '.git'))}\n`)
    mkc('commonabs', `${join(real, '.git')}\n`)
    // parsed as git does: only TRAILING whitespace is cut, so these name nothing (git steps over them), while the
    // same valid path with trailing blanks, tabs and CRLF still names the real repository
    const relTo = (name: string) => relative(join(root, 'src', 'deep', 'gd-' + name, '.git'), join(real, '.git'))
    mkc('commonlead', ` ${relTo('commonlead')}\n`)
    mkc('commontab', `\t${relTo('commontab')}\n`)
    mkc('commonmulti', `${relTo('commonmulti')}\njunk\n`)
    mkc('commonnul', `${relTo('commonnul')}\0\n`)
    mkc('commontrail', `${relTo('commontrail')} \t\r\n\n`)
    // trailing characters JS \s would cut but git's isspace (blank, tab, CR, LF) does not: the path then names nothing
    mkc('commonnbsp', `${relTo('commonnbsp')} \n`)
    mkc('commonvt', `${relTo('commonvt')}\u000b\n`)
    mkc('commonff', `${relTo('commonff')}\u000c\n`)
    mkc('commonls', `${relTo('commonls')} \n`)
  })
  it('a .git git would step over (empty or garbage HEAD, no HEAD, objects or refs missing) leaves the install in charge', () => {
    for (const n of ['emptyhead', 'garbage', 'noheadfile', 'norefs', 'noobjects', 'badref', 'shorthex']) {
      expect(denied('git checkout other', dirs[n]), n).toBe(true)
      expect(denied(`cd ${dirs[n]} && git reset --hard`, root), n).toBe(true)
      // the same answer as git's own: it walks up past the fake and finds the install
      expect(execFileSync('git', ['-C', dirs[n], 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim(), n).toBe(root)
    }
  })
  it('a .git git accepts is its own toplevel: a symref or a full object id in HEAD, objects and refs present', () => {
    for (const n of ['symref', 'hex40', 'hex64', 'real']) {
      expect(denied('git checkout other', dirs[n]), n).toBe(false)
      expect(denied(`cd ${dirs[n]} && git reset --hard`, root), n).toBe(false)
    }
    expect(execFileSync('git', ['-C', dirs.real, 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim()).toBe(dirs.real)
  })
  it('a commondir that does not lead to a git directory (junk, empty, blank, missing target, hollow target, a chain) leaves the install in charge', () => {
    for (const n of ['commonjunk', 'commonempty', 'commonblank', 'commonnofile', 'commonhollow', 'commonchain']) {
      expect(denied('git checkout other', dirs[n]), n).toBe(true)
      expect(denied(`cd ${dirs[n]} && git reset --hard`, root), n).toBe(true)
      // git never takes the fake as its toplevel: it steps over it (the install is found) or, for an empty
      // commondir, dies on it and writes nothing, so the gate's DENY is the safe answer either way
      const r = spawnSync('git', ['-C', dirs[n], 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' })
      expect(r.status === 0 ? r.stdout.trim() : root, n).toBe(root)
    }
  })
  it('a commondir that names a real repository git directory (relative to the gitdir or absolute) is a git directory', () => {
    for (const n of ['commonrel', 'commonabs']) expect(denied('git checkout other', dirs[n]), n).toBe(false)
  })
  it('the commondir is read as git reads it: a leading blank or tab, a second line or a NUL names nothing; trailing whitespace is cut', () => {
    for (const n of ['commonlead', 'commontab', 'commonmulti', 'commonnbsp', 'commonvt', 'commonff', 'commonls']) {
      expect(denied('git checkout other', dirs[n]), n).toBe(true)
      expect(denied(`cd ${dirs[n]} && git reset --hard`, root), n).toBe(true)
      const r = spawnSync('git', ['-C', dirs[n], 'rev-parse', '--show-toplevel'], { encoding: 'utf-8' })
      expect(r.status === 0 ? r.stdout.trim() : root, n).toBe(root)
    }
    // a NUL ends the path for git (a C string), so git ACCEPTS it; the gate refuses it: the safe side of the difference
    expect(denied('git checkout other', dirs.commonnul), 'commonnul').toBe(true)
    expect(denied('git checkout other', dirs.commontrail), 'commontrail').toBe(false)
  })
  it('a linked worktree inside the install (gitdir with commondir, no objects/refs of its own) is still its own toplevel', () => {
    expect(denied('git checkout other', nested)).toBe(false)
    expect(denied('git checkout other', wt)).toBe(false)
  })
})

describe('R-IMPL: clone out of the install, and the message reads whole', () => {
  it('git clone of the install to somewhere else is a read; template, config and helper URLs are not', () => {
    for (const c of [`git clone . ${base}/copy`, `git clone --bare . ${base}/copy.git`, `git clone -q --depth 1 . ${base}/copy`]) expect(denied(c, root), c).toBe(false)
    for (const c of [`git clone --template=/tmp/t . ${base}/copy`, `git clone -c core.hooksPath=/tmp/h . ${base}/copy`, `git clone --upload-pack=/tmp/x . ${base}/copy`, `git clone ext::sh ${base}/copy`, 'git clone . scripts/hooks/copy'])
      expect(denied(c, root), c).toBe(true)
  })
  it('the sentences of the way-out message are separated', () => {
    const hook = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'self-pace-gate.mjs')
    const out = spawnSync('node', [hook], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git checkout other' }, cwd: dirname(dirname(hook)) }), encoding: 'utf-8' })
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason).toContain('git ...). Valtozo-bol')
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
