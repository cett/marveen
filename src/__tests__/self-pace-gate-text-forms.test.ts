// Spellings of a script text that the git rule must still read: the name of git split by quotes, and a text that is a variable.
//   F3. `sh -c "g'i't checkout other"`: the quotes inside the text are removed by the inner shell, so the git is there; the
//       "does the text name git" test ran on the raw text and skipped it
//   F2. `X='git checkout other'; eval "$X"`: the text is a variable, the command names git elsewhere
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
  base = mkdtempSync(join(tmpdir(), 'text-forms-'))
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
const guarded = (c: string) => ({ c, agent: denied(c, agentCwd), root: denied(c, root), copy: denied(c, wt) })
const REFUSED = (c: string) => ({ c, agent: true, root: true, copy: false }) // refused in the install, free in the copy
const FREE = (c: string) => ({ c, agent: false, root: false, copy: false })

describe('F3. the name of git split by quotes inside a script text is still git', () => {
  it.each([
    `sh -c "g'i't checkout other"`, `sh -c 'g"i"t checkout other'`, `bash -c "g''it pull"`, `bash -lc "gi\\"\\"t reset --hard"`, `sh -c "g\\it checkout other"`,
    `eval "g'i't checkout other"`, `eval g"i"t merge other`, `echo "g'i't checkout other" | sh`, `bash <<< "g'i't checkout other"`, `nice -n 5 sh -c "g'i't pull"`,
    `sh -c "echo hi; g'i't checkout other"`, `xargs sh -c "g'i't checkout other"`,
    `sh -c 'g\\it checkout other'`, `eval 'g\\it pull'`, // a backslash kept by single quotes is removed by the inner shell
  ])('refused in the install, free in the copy: %s', (c) => {
    expect(guarded(c)).toEqual(REFUSED(c))
  })
  it.each([`sh -c "g'i't status"`, `sh -c "g'i't log -1"`, `echo "g'i't status" | sh`, `eval "g'i't diff"`])('a read-only git spelled that way is free everywhere: %s', (c) => {
    expect(guarded(c)).toEqual(FREE(c))
  })
  it.each([`sh -c "echo g'i't"`, `sh -c "echo 'g' 'it' checkout"`, `sh -c "echo it's a g'it"`, `sh -c "echo gi t checkout"`])('quotes that do not make the word git are no git: %s', (c) => {
    expect(guarded(c)).toEqual(FREE(c))
  })
  // the other places that ask "does the command name git": a script from a source that cannot be read, a command word built by an
  // expansion, and a command substitution
  it.each([`sh < run.sh; g'i't status`, `cat run.sh | sh; g"i"t log`, `G=g'i't; $G checkout other`, `G="g""it"; $G pull`, `echo $(g'i't checkout other)`, `x=$(g"i"t pull)`])(
    'a quoted spelling of git elsewhere in the command still counts: refused in the install, free in the copy: %s', (c) => {
      expect(guarded(c)).toEqual(REFUSED(c))
    })
  it.each(['sh < run.sh', 'cat run.sh | sh; echo "g it"', "G=x; $G checkout"])('with no git in the command these are not this rule\'s business: %s', (c) => {
    expect(guarded(c)).toEqual(FREE(c))
  })
  it('KNOWN LIMIT (strict on purpose): quotes are removed from the text before the name is looked for, so a quoted g\'it that only prints the letters counts as git', () => {
    expect(guarded('cat run.sh | sh; echo "g\'it"')).toEqual(REFUSED('cat run.sh | sh; echo "g\'it"'))
  })
})
