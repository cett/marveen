// Accepted (passing) behaviours of the self-pace gate that the tree rule does not judge, pinned BY NAME.
// They were measured against the real gate and they are NOT regressions of the tree-rewriting git rule: the same commands
// pass on the base too. Each test states the accepted behaviour and has a refused twin, so that a later fix flips a named
// test on purpose (and the CHANGELOG limit it belongs to is then removed in the same change), not by accident.
//   L1. `git checkout-index --prefix=<install>/` run from a worktree copy writes into the install
//   L2. `git config core.worktree <install>` then `git checkout HEAD -- <path>`: two steps, each passes in a worktree copy
//   L3. a glued or separate `--output=<install path>` on a read-only git (diff, log)
//   L4. git subcommands that take an output path (archive -o, bundle create, clone, init, config --file) from a worktree copy
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
  it('L1. KNOWN LIMIT: git checkout-index --prefix=<install>/ from a worktree copy is not judged by where it WRITES (all three spellings)', () => {
    const c = [`git checkout-index -a -f --prefix=${root}/`, `git checkout-index -a -f --prefix ${root}/`, `git checkout-index -a -f --prefix="${root}/"`]
    for (const x of c) expect(where(x)).toEqual(COPY_ONLY(x))
    // the twin: a prefix that names a protected directory is refused wherever it runs
    const t = `git checkout-index -a -f --prefix=${root}/scripts/`
    expect(where(t)).toEqual(REFUSED_EVERYWHERE(t))
  })

  it('L2. KNOWN LIMIT: core.worktree set in one step and used in the next passes in a worktree copy, each step on its own', () => {
    const set = `git config core.worktree ${root}`
    const use = 'git checkout HEAD -- scripts/doctor.sh'
    expect(where(set)).toEqual(COPY_ONLY(set))
    expect(where(use)).toEqual(COPY_ONLY(use))
    // the twin: naming the install as the tree in the same command is refused in the copy as well
    const t = `git -C ${root} checkout other`
    expect(where(t)).toEqual(REFUSED_EVERYWHERE(t))
  })

  it('L3. KNOWN LIMIT: --output=<path> and --output <path> on a read-only git are not read as a write to that path', () => {
    for (const x of [`git diff --output=${root}/scripts/x`, `git log --output=${root}/scripts/x`, `git diff --output ${root}/scripts/x`]) expect(where(x)).toEqual(PASSES(x))
    // the twin: the same option aimed at a protected file by name is refused
    const t = `git diff --output=${root}/scripts/doctor.sh`
    expect(where(t)).toEqual(REFUSED_EVERYWHERE(t))
  })

  it('L4. KNOWN LIMIT: archive -o, bundle create, clone, init and config --file take an output path under the install that is not read; a worktree copy passes', () => {
    for (const x of [
      `git archive -o ${root}/scripts/x.tar HEAD`, `git bundle create ${root}/scripts/x.bundle HEAD`, `git clone . ${root}/scripts/cloned`,
      `git init ${root}/scripts/inited`, `git config --file ${root}/scripts/x.cfg a.b c`,
    ]) expect(where(x)).toEqual(COPY_ONLY(x))
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
