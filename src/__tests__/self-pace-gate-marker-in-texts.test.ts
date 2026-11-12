// The DYN marker of a substitution behind a literal head (see tokenizeShell) must not reach a text that a shell is handed (sh -c STRING,
// eval STRING, echo STRING | sh) or a variable value, and a variable value spelled $'..' must be decoded like the same word in a path.
//   A. a text with a substitution behind a literal head is judged as it was before the marker existed: a command word BUILT by the
//      substitution is the worst case (refused in the install, free in a worktree copy); a git with a substitution among its arguments
//      is judged by where it runs, never as a group (no false deny in a copy)
//   B. the same shapes with the substitution FIRST in the string (no marker) have the same verdict
//   C. a variable assigned from $'..' or $".." has the value the shell builds (`D=$'doctor.sh'` is `D=doctor.sh`); an undecodable value stays unset
//   D. KNOWN LIMITS (named, pinned): a variable assigned from a substitution or a read, and a loop variable, used behind a literal head
// Neutral fixture only: a tmp world with a made-up install, no real names, paths or ids.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, spliceEnvSplit, tokenizeShell, DYN } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string // the install
let agentCwd: string // a sub-agent's own directory, UNDER the install
let wt: string // a git worktree copy: a real path outside the install
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'marker-texts-'))
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
const sub = (s: string) => s.replaceAll('@R', root)
const denied = (command: string, cwd: string) => Boolean(gateDecision('Bash', { command: sub(command) }, opts(cwd)).deny)
const where = (c: string) => ({ agent: denied(c, agentCwd), root: denied(c, root), copy: denied(c, wt) })
const COPY_ONLY = { agent: true, root: true, copy: false } // a tree-rewriting git: refused in the install, free in a worktree copy
const REFUSED = { agent: true, root: true, copy: true }
const PASSES = { agent: false, root: false, copy: false }

describe('A. a text with a substitution behind a literal head keeps the verdict it had without the marker', () => {
  // the command word is BUILT by the substitution: judged as the worst case, a tree-rewriting git
  const built = [
    'sh -c "gi$(echo t) checkout x"', 'sh -c "echo; $(printf \'g%s\' it) checkout x"', 'eval "echo; $(printf \'g%s\' it) checkout x"', 'eval "echo; gi$(echo t) checkout x"',
    'echo "x; gi$(echo t) checkout x" | sh', 'echo "echo; gi$(echo t) checkout x" | bash', 'echo "echo; `echo git` checkout x" | sh', 'sh -c "x=1; g$(echo i)t pull"',
  ]
  it.each(built)('built command word: refused in the install, free in a copy: %s', (c) => { expect(where(c)).toEqual(COPY_ONLY) })

  // a real git with a substitution among its arguments or around it: judged by where it runs (no group, no false deny in a copy)
  const plainGit = [
    'sh -c "git checkout x $(echo y)"', 'sh -c "echo $(git checkout x)"', 'sh -c "x=$(date); git checkout main"', 'sh -c "cd /tmp && git checkout x $(echo y)"',
    'eval "git pull $(echo x)"', 'echo "git pull $(echo x)" | sh', 'bash <<< "git pull $(echo x)"', 'sh -c "git checkout -b x $(git rev-parse HEAD)"',
  ]
  it.each(plainGit)('a git with a substitution next to it: refused in the install, free in a copy: %s', (c) => { expect(where(c)).toEqual(COPY_ONLY) })

  it('env -S hands one word to env, which splits it: the marker is not part of that text', () => {
    for (const c of ['env -S "git checkout x $(echo y)"']) expect(where(c)).toEqual(COPY_ONLY)
    // (the words env -S splits are the words of the text, with no marker in them)
    const words = tokenizeShell('env -S "git checkout x $(echo y)"').words
    expect(words.some((w: string) => w.includes(DYN))).toBe(true) // the tokenizer DID mark the word ...
    expect(spliceEnvSplit(words).some((w: string) => w.includes(DYN))).toBe(false) // ... and the spliced words do not carry it
    expect(spliceEnvSplit(words).slice(0, 4)).toEqual(['env', 'git', 'checkout', 'x'])
  })

  it('B. the same shapes with the substitution FIRST (no marker) have the same verdict as with it behind a head', () => {
    for (const c of ['sh -c "$(printf \'g%s\' it) checkout x"', 'eval "$(echo git) pull"', 'echo "$(echo git) pull" | sh']) expect(where(c)).toEqual(COPY_ONLY)
    for (const c of ['sh -c "echo hi"', 'eval "echo hi"', 'echo "x; echo hi" | sh']) expect(where(c)).toEqual(PASSES)
  })
})

describe('C. a variable value spelled $\'..\' or $".." is the text the shell builds', () => {
  const spelled = [
    "D=$'doctor.sh'; cp /tmp/x @R/scripts/$D", 'D=$"doctor.sh"; cp /tmp/x @R/scripts/$D', "D=$'doc\\x74or.sh'; cp /tmp/x @R/scripts/$D", "D=$'doc\\164or.sh'; cp /tmp/x @R/scripts/$D",
    "export D=$'doctor.sh'; cp /tmp/x @R/scripts/$D", "D=$'doctor.sh'; cp /tmp/x @R/scripts/${D}",
  ]
  it.each(spelled)('refused like the single-quoted spelling: %s', (c) => { expect(where(c)).toEqual(REFUSED) })
  it('the single-quoted spelling is the twin (refused), an unrelated name is free', () => {
    expect(where("D='doctor.sh'; cp /tmp/x @R/scripts/$D")).toEqual(REFUSED)
    expect(where("D=$'notes.txt'; cp /tmp/x @R/scripts/$D")).toEqual(PASSES)
    expect(where("D='doc'; cp /tmp/x @R/scripts/$D")).toEqual(PASSES)
  })
  it('a value the parser cannot read is UNREADABLE, not unset: bash cuts $\'..\' at a NUL and joins a quoted piece with what follows it', () => {
    for (const c of [
      "D=$'doctor.sh\\x00'; cp /tmp/x @R/scripts/$D", "D=$'doctor.sh\\x00junk'; cp /tmp/x @R/scripts/$D", "D=$'doctor.sh\\q'; cp /tmp/x @R/scripts/$D",
      "D=$'doc'tor.sh; cp /tmp/x @R/scripts/$D", "D='doc'tor.sh; cp /tmp/x @R/scripts/$D", 'D="doc"tor.sh; cp /tmp/x @R/scripts/$D', 'D=$"doc"tor.sh; cp /tmp/x @R/scripts/$D',
    ]) expect([c, where(c)]).toEqual([c, REFUSED])
    // the variable holds (or may hold) a directory and the tail names a protected path: the tail is matched, as for an unresolved variable
    // (a value the tokenizer joins is read whole: `D='<dir>'""` is `<dir>`, so even a one-segment tail is judged against it)
    for (const c of [
      "D=$'\\x00'; cp /tmp/x $D/scripts/hooks/egress-gate.mjs", "D=$'\\q'; cp /tmp/x $D/scripts/self-pace-gate.mjs", "D='@R'\"\"; cp /tmp/x $D/scripts/self-pace-gate.mjs",
      "D='@R/scripts'\"\"; cp /tmp/x $D/doctor.sh", "D=\"@R\"/scripts; cp /tmp/x $D/doctor.sh",
    ]) expect([c, where(c)]).toEqual([c, REFUSED])
    // the twins: the same shapes naming an unrelated file are judged by the head only (the directory holds protected files: refused);
    // a variable with no head at all keeps the reading it had (the head-less limit), and a plain assignment followed by a separator is read
    expect(where("D=$'doc'tor.sh; echo x > $D")).toEqual(PASSES)
    expect(where("D='doc' ; cp /tmp/x @R/scripts/$D")).toEqual(PASSES)
    expect(where("D=$'doc'; cp /tmp/x @R/scripts/$D")).toEqual(PASSES)
  })
})

describe('D. KNOWN LIMITS: a variable that gets its value from a substitution, a read or a loop is not tracked behind a literal head', () => {
  it('KNOWN LIMIT: D=$(echo doctor.sh), read D <<< ..., for D in $(...) used as <install>/scripts/$D pass', () => {
    for (const c of ['D=$(echo doctor.sh); cp /tmp/x @R/scripts/$D', "read D <<< $'doctor.sh'; cp /tmp/x @R/scripts/$D", 'for D in $(echo doctor.sh); do cp /tmp/x @R/scripts/$D; done', 'cp /tmp/x @R/scripts/${D}', 'cp /tmp/x @R/scripts/$D']) {
      expect([c, where(c)]).toEqual([c, PASSES])
    }
    // the twin: the name spelled in the command is read
    expect(where("D=doctor.sh; cp /tmp/x @R/scripts/$D")).toEqual(REFUSED)
  })
})
