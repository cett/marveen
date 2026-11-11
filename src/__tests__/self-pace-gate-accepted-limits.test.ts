// Accepted (passing) behaviours of the self-pace gate that the tree rule does not judge, pinned BY NAME.
// They were measured against the real gate and they are NOT regressions of the tree-rewriting git rule: the same commands
// pass on the base too. Each test states the accepted behaviour and has a refused twin, so that a later fix flips a named
// test on purpose (and the CHANGELOG limit it belongs to is then removed in the same change), not by accident.
//   L1. CLOSED by the git operand rule (a git that is not read-only counts as a writer for the loose-ancestor tier): the tests are in
//       self-pace-gate-git-operands.test.ts. The line stays so that the numbers below keep meaning what the CHANGELOG says.
//   L2. `git checkout HEAD -- <path>` alone (step two of the core.worktree pair) passes in a worktree copy: it is not visible, which is why
//       the first step is the one that is refused
//   L3. a glued or separate `--output=<path>` on a read-only git (diff, log) whose path is a NEW file directly in the scripts directory
//   L4. git subcommands that take an output path (archive -o, bundle create, clone, init) naming a NEW file or directory directly in the scripts directory, from a worktree copy
//   L8. an operand or option value the parser cannot read (an unset variable, a command substitution, arguments that arrive through xargs)
//   L5. `cd -P <symlink>/..` : the gate counts lexically, the shell goes physically
//   L6. CDPATH, inline or exported, changes where `cd <name>` goes
//   L7. an inline interpreter (python3 -c, node -e, perl -e, awk) that starts git: the text is not a shell script
// Neutral fixture only: a tmp world with a made-up install, no real names, paths or ids.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string // the install
let agentCwd: string // a sub-agent's own directory, UNDER the install
let wt: string // a git worktree copy: a real path outside the install
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'accepted-limits-'))
  root = join(base, 'fixture-root')
  wt = join(base, 'worktrees', 'feat')
  agentCwd = join(root, 'agents', 'agent-a')
  for (const r of [root, wt]) {
    for (const rel of ['scripts/self-pace-gate.mjs', 'scripts/email-send-gate.mjs', 'scripts/hooks/egress-gate.mjs', 'scripts/lib/homoglyph.py', 'scripts/agent-api.sh',
      'scripts/sync-hooks.sh', 'scripts/doctor.sh', 'scripts/gate-onfailure-check.py', 'scripts/secret-gate.ts', 'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts']) touch(join(r, rel))
  }
  mkdirSync(agentCwd, { recursive: true })
  touch(join(root, 'store', 'egress-allowlist.json'), '{"domains":[]}')
  symlinkSync(agentCwd, join(wt, 'lnk')) // a link in the copy that points INTO the install
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const opts = (cwd: string) => ({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const denied = (command: string, cwd: string) => Boolean(gateDecision('Bash', { command }, opts(cwd)).deny)
const where = (c: string) => ({ c, agent: denied(c, agentCwd), root: denied(c, root), copy: denied(c, wt) })
// passes in the worktree copy, refused in the install (a git that rewrites a tree, judged by where it runs)
const COPY_ONLY = (c: string) => ({ c, agent: true, root: true, copy: false })
// passes everywhere, the install included
const PASSES = (c: string) => ({ c, agent: false, root: false, copy: false })
const REFUSED_EVERYWHERE = (c: string) => ({ c, agent: true, root: true, copy: true })

describe('accepted behaviours of the tree rule, pinned by name (a later fix flips the named test on purpose)', () => {
  it('L2. KNOWN LIMIT: step two of the core.worktree pair (`git checkout HEAD -- <path>`) passes in a worktree copy on its own: only step one is refused', () => {
    const use = 'git checkout HEAD -- scripts/doctor.sh'
    expect(where(use)).toEqual(COPY_ONLY(use))
    // the twin: step one, with the install as the tree, is refused wherever it runs
    const set = `git config core.worktree ${root}`
    expect(where(set)).toEqual(REFUSED_EVERYWHERE(set))
    // and naming the install as the tree in the same command is refused in the copy as well
    const t = `git -C ${root} checkout other`
    expect(where(t)).toEqual(REFUSED_EVERYWHERE(t))
  })

  it('L3. KNOWN LIMIT: --output=<path> and --output <path> on a read-only git are not read as a write when the path is a NEW file directly in scripts/', () => {
    for (const x of [`git diff --output=${root}/scripts/x`, `git log --output=${root}/scripts/x`, `git diff --output ${root}/scripts/x`]) expect(where(x)).toEqual(PASSES(x))
    // the twins: the same option aimed at a protected file by name, a protected subdirectory or a directory that holds protected files is refused
    for (const t of [`git diff --output=${root}/scripts/doctor.sh`, `git diff --output=${root}/scripts/hooks/new.mjs`, `git diff --output=${root}/`]) expect(where(t)).toEqual(REFUSED_EVERYWHERE(t))
  })

  it('L4. KNOWN LIMIT: archive -o, bundle create, clone and init naming a NEW file or directory directly in scripts/ are not read as a write there; a worktree copy passes', () => {
    for (const x of [
      `git archive -o ${root}/scripts/x.tar HEAD`, `git bundle create ${root}/scripts/x.bundle HEAD`, `git clone . ${root}/scripts/cloned`,
      `git init ${root}/scripts/inited`,
    ]) expect(where(x)).toEqual(COPY_ONLY(x))
    // the twins: a protected name, a protected subdirectory, or a directory that holds protected files is refused wherever it runs
    for (const t of [`git archive -o ${root}/scripts/doctor.sh HEAD`, `git bundle create ${root}/scripts/hooks/x.bundle HEAD`, `git clone . ${root}/src/`]) expect(where(t)).toEqual(REFUSED_EVERYWHERE(t))
  })

  it('L8. KNOWN LIMIT: an operand the parser cannot read (an unset variable, a command substitution, arguments through xargs) keeps the verdict it had: free in a copy', () => {
    for (const x of [`git checkout-index -f --prefix=$INST/ -a`, `git checkout-index -f --prefix=$(pwd)/../../fixture-root/ -a`, `echo ${root}/ | xargs git checkout-index -f -a --prefix`]) {
      expect(where(x)).toEqual(COPY_ONLY(x))
    }
    // the twin: the same variable assigned in the same command is read
    const t = `INST=${root}; git checkout-index -f --prefix=$INST/ -a`
    expect(where(t)).toEqual(REFUSED_EVERYWHERE(t))
  })

  it('L9. KNOWN LIMIT: a git word built by an expansion, and the other commands that write the shared configuration (remote, submodule), are not judged by key: free in a copy', () => {
    for (const x of ['G=git; $G config core.hooksPath /x', '$(echo git) config core.hooksPath /x', 'git remote add evil x', 'git remote set-url origin x', 'git branch --set-upstream-to=origin/x']) {
      expect(where(x)).toEqual(COPY_ONLY(x))
    }
    // the twin: the same key spelled as a plain git word is refused in the copy too (the key rule)
    const t = 'git config core.hooksPath /x'
    expect(where(t)).toEqual(REFUSED_EVERYWHERE(t))
  })

  it('L5. KNOWN LIMIT: cd -P through a symlink is counted lexically, the shell goes physically', () => {
    const c = 'cd -P lnk/.. && git checkout other' // lexically the copy, physically the install's agents directory
    expect(where(c)).toEqual(COPY_ONLY(c))
    // the twin: the same git with no cd is judged from where it really runs
    expect(where('git checkout other')).toEqual(COPY_ONLY('git checkout other'))
  })

  it('L6. KNOWN LIMIT: CDPATH (inline or exported) changes where cd <name> goes and is not read', () => {
    for (const x of [`CDPATH=${root} cd agents && git checkout other`, `export CDPATH=${root}; cd agents && git checkout other`]) expect(where(x)).toEqual(COPY_ONLY(x))
  })

  it('L7. KNOWN LIMIT: git started from an inline interpreter (python3 -c, node -e, perl -e, awk) is not followed, in the install as well', () => {
    for (const x of [
      `python3 -c "import os; os.system('git checkout other')"`, `python3 -c "import subprocess; subprocess.run(['git', 'checkout', 'other'])"`,
      `node -e "require('child_process').execSync('git checkout other')"`, `perl -e 'system("git checkout other")'`,
      `awk 'BEGIN{system("git checkout other")}'`, `awk 'BEGIN{system("cd ${root} && git checkout other")}'`,
    ]) expect(where(x)).toEqual(PASSES(x))
    // the twin: the shell forms of the same text ARE followed (refused in the install, free in the copy)
    for (const x of [`sh -c 'git checkout other'`, `eval 'git checkout other'`]) expect(where(x)).toEqual(COPY_ONLY(x))
    // and an interpreter that names the install path is stopped by the path rules, not by the git rule
    for (const x of [`python3 -c "import os; os.chdir('${root}'); os.system('git checkout other')"`, `node -e "process.chdir('${root}'); require('child_process').execSync('git checkout other')"`]) {
      expect(where(x)).toEqual(REFUSED_EVERYWHERE(x))
    }
  })
})
