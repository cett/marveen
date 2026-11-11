// Pure read-only git names (merge-base, for-each-ref, name-rev, cherry, whatchanged, count-objects, show-branch, range-diff) are in SAFE_GIT:
// a sub-agent working from its directory inside the install can run them, alone or in a chain, while the guards of gitSafe (-c, --output,
// --ext-diff, --textconv) still refuse their option twins, and the names that have a write form or run a program stay refused.
// Neutral fixture only: a tmp world with a made-up install, no real names, paths or ids.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string
let agentCwd: string
let wt: string
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'safe-git-'))
  root = join(base, 'fixture-root'); wt = join(base, 'worktrees', 'feat'); agentCwd = join(root, 'agents', 'agent-a')
  for (const r of [root, wt]) for (const rel of ['scripts/self-pace-gate.mjs', 'scripts/email-send-gate.mjs', 'scripts/hooks/egress-gate.mjs', 'scripts/lib/homoglyph.py', 'scripts/agent-api.sh',
    'scripts/sync-hooks.sh', 'scripts/doctor.sh', 'scripts/gate-onfailure-check.py', 'scripts/secret-gate.ts', 'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts']) touch(join(r, rel))
  mkdirSync(agentCwd, { recursive: true })
  touch(join(root, 'store', 'egress-allowlist.json'), '{"domains":[]}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })
const opts = (cwd: string) => ({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const denied = (c: string, cwd: string) => Boolean(gateDecision('Bash', { command: c.replaceAll('@W', wt).replaceAll('@R', root) }, opts(cwd)).deny)
const everywhere = (c: string) => [denied(c, agentCwd), denied(c, root), denied(c, wt)]

const NAMES = ['merge-base origin/develop HEAD', 'merge-base --is-ancestor origin/develop HEAD', 'for-each-ref refs/heads', 'name-rev HEAD', 'cherry -v origin/develop', 'whatchanged -1',
  'count-objects -v', 'show-branch main feat', 'range-diff main...feat']

describe('the pure read-only names are free everywhere, alone and in a chain', () => {
  it.each(NAMES)('git %s', (n) => {
    const c = `git ${n}`
    expect(everywhere(c)).toEqual([false, false, false])
    expect(denied(`cd @W && ${c} && echo y || echo n`, agentCwd)).toBe(false)
    expect(denied(`cd @W && git log --oneline -1; ${c}`, agentCwd)).toBe(false) // the `;` after a cd chain that made a daily command refused
  })
  it('the reported chain (a merge-base check after a log), exactly, from the agent directory', () => {
    const c = 'cd @W && git log --oneline -1 origin/develop; git merge-base --is-ancestor origin/develop HEAD && echo "already contains develop" || echo "needs rebase"'
    expect(denied(c, agentCwd)).toBe(false)
  })
})

describe('the option guards of gitSafe still apply to every added name', () => {
  // (the guard matters where a path rule looks at the command: next to a directory that holds protected files a plain read passes,
  // the same read with an option that writes or runs a program is a writer and is refused)
  it.each(NAMES)('git %s: a read next to a protected directory passes, with -c, --output, --ext-diff, --textconv it is refused', (n) => {
    const [name, ...rest] = n.split(' ')
    expect(denied(`git ${n} -- @R/src/`, wt)).toBe(false)
    for (const extra of ['-c core.pager=x', '--output=@W/x', '--ext-diff', '--textconv']) {
      const c = extra.startsWith('-c') ? `git ${extra} ${n} -- @R/src/` : `git ${name} ${extra} ${rest.join(' ')} -- @R/src/`
      expect([c, denied(c, wt)]).toEqual([c, true])
    }
  })
})

describe('names with a write form or a program stay refused', () => {
  it.each(['branch -D old', 'branch --show-current', 'tag v1', 'remote add x y', 'stash drop', 'reflog expire --all', 'config user.name x', 'ls-remote --upload-pack=evil origin', 'ls-remote origin',
    'verify-commit HEAD', 'fsck --lost-found', 'merge-tree a b c'])('git %s from the agent directory is refused', (n) => {
    expect(denied(`git ${n}`, agentCwd)).toBe(true)
  })
  it('the install rule for a git that rewrites a tree is unchanged', () => {
    expect(denied('git checkout other', agentCwd)).toBe(true); expect(denied('git checkout other', wt)).toBe(false)
  })
})
