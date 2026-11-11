// Third automatic review round of the tree-rewriting git rule: three ways to make the rule judge the wrong git, the wrong tree
// or the wrong directory.
//   1. a launcher (`env -u X`, `xargs -I X`, `nice -n N`, `timeout N`) with an option VALUE spelled `git` hides the real git
//   2. a GIT_WORK_TREE / GIT_DIR / GIT_COMMON_DIR name hidden by quoting, or set by a segment that is not the git
//   3. a command substitution after a quoted or escaped cd
// Every refusal has an allowed twin (the same command in the worktree copy) and every allow a refused twin.
// Neutral fixture only: a tmp world with a made-up install, no real names, paths or ids.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string // the install
let agentCwd: string // a sub-agent's own directory, UNDER the install
let wt: string // a git worktree copy: a real path outside the install
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'review-r3-'))
  root = join(base, 'fixture-root')
  wt = join(base, 'worktrees', 'feat')
  agentCwd = join(root, 'agents', 'agent-a')
  for (const r of [root, wt]) {
    for (const rel of ['scripts/self-pace-gate.mjs', 'scripts/email-send-gate.mjs', 'scripts/hooks/egress-gate.mjs', 'scripts/lib/homoglyph.py', 'scripts/agent-api.sh',
      'scripts/sync-hooks.sh', 'scripts/doctor.sh', 'scripts/gate-onfailure-check.py', 'scripts/secret-gate.ts', 'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts']) touch(join(r, rel))
  }
  mkdirSync(agentCwd, { recursive: true })
  touch(join(root, 'store', 'egress-allowlist.json'), '{"domains":[]}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const opts = (cwd: string) => ({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const denied = (command: string, cwd: string) => Boolean(gateDecision('Bash', { command }, opts(cwd)).deny)
// refused in the install (agent dir and root), free in the worktree copy
const guarded = (c: string) => ({ c, agent: denied(c, agentCwd), root: denied(c, root), copy: denied(c, wt) })
const REFUSED = (c: string) => ({ c, agent: true, root: true, copy: false })

describe('1. a launcher option value spelled git does not hide the real git', () => {
  it.each([
    'env -u git git checkout other', 'env -C git git checkout other', 'xargs -I git git checkout other', 'xargs -E git git checkout other', 'xargs -a git git checkout other',
    'timeout -s git git checkout other', 'nice -n 5 git checkout other', 'timeout 5 git checkout other', 'xargs -I{} git checkout {}', 'sudo -u git git checkout other',
    'env -u git status git checkout other', // the first git word is followed by a safe subcommand: only the second is the write
    'xargs -I git log git reset --hard', 'nohup env -u git git pull',
  ])('refused in the install, free in the copy: %s', (c) => {
    expect(guarded(c)).toEqual(REFUSED(c))
  })
  it.each(['env -u git git status', 'xargs -I git git log -1', 'timeout 5 git log', 'nice -n 5 git diff', 'xargs -a git git ls-files', 'sudo -u git git status'])(
    'a launcher in front of a read-only git is free in the install: %s', (c) => {
      expect(guarded(c)).toEqual({ c, agent: false, root: false, copy: false })
    })
  it('the candidates are bounded: 8 git words behind a launcher are judged, 9 are refused unread (cost stays linear)', () => {
    const gits = (n: number) => `nice ${Array.from({ length: n }, () => 'git').join(' ')} status`
    expect(denied(gits(8), wt)).toBe(false)
    expect(denied(gits(9), wt)).toBe(true)
  })
})
