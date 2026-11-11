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

describe('F2. a script text that is a variable, in a command that names git', () => {
  it.each([
    `X='git checkout other'; eval "$X"`, `X='git pull'; sh -c "$X"`, `X='git pull'; bash -c "$X"`, `X='git pull'; echo "$X" | sh`, `X='git pull'; bash <<< "$X"`,
    `X='git checkout other'; eval $X`, `CMD=git; eval "$CMD checkout other"`, `X='git checkout other'; sh -c "echo hi; $X"`, `X='git pull'; sh -c "\${X}"`,
    `X='git pull'; nice sh -c "$X"`, `X='git checkout other'; xargs sh -c "$X"`, `X=g'i't; eval "$X checkout other"`,
  ])('the variable may hold the git: refused in the install, free in the copy: %s', (c) => {
    expect(guarded(c)).toEqual(REFUSED(c))
  })
  it.each([`X='echo hi'; eval "$X"`, 'eval "$X"', `sh -c "echo $HOME"`, `X=ls; sh -c "$X"`, `echo "$X" | sh`])('with no git in the command it is not this rule\'s business: %s', (c) => {
    expect(guarded(c)).toEqual(FREE(c))
  })
  it.each([`git status; sh -c 'echo $HOME'`, `git log -1; sh -c "ls $DIR"`, `git diff; eval "echo $X"`])('a text with a variable that is not the command word is judged by its words: %s', (c) => {
    expect(guarded(c)).toEqual(FREE(c))
  })
  it('texts with a variable are judged only when the command names git (they do not use up the bound of 16 texts otherwise)', () => {
    const many = Array.from({ length: 20 }, () => `sh -c 'echo $HOME'`).join('; ')
    expect(guarded(many)).toEqual(FREE(many))
  })
  it('KNOWN LIMIT (worst case): a text that IS a variable next to any git word is judged as a tree-rewriting git', () => {
    for (const c of ['git status; eval "$X"', 'git log; sh -c "$CMD"']) expect(guarded(c)).toEqual(REFUSED(c))
  })
})

describe('named costs and limits of the git rule (pinned, so that a later change flips a named test and is decided on purpose)', () => {
  const EVERYWHERE = (c: string) => ({ c, agent: true, root: true, copy: true })
  it('F4. a script text built by a command substitution is judged as the worst case even with no git word in the command: refused in the install', () => {
    for (const c of ['eval "$(ssh-agent -s)"', 'sh -c "$(cat run.sh)"', 'bash -c "`echo hi`"']) expect(guarded(c)).toEqual(REFUSED(c))
  })
  it('W1. a git -c override is refused unless the key is user.*, color.* or advice.*, also in the copy', () => {
    for (const c of ['git -c core.editor=true rebase --continue', 'git -c core.hooksPath=x pull']) expect(guarded(c)).toEqual(EVERYWHERE(c))
    for (const c of ['git -c user.name=x merge other', 'git -c color.ui=never pull']) expect(guarded(c)).toEqual(REFUSED(c))
  })
  it('W2. a rewriting git after source, ., eval or set -a is refused in the copy as well (the environment it loads is not read)', () => {
    for (const c of ['source env.sh; git pull', '. env.sh && git pull', 'set -a; git pull', 'eval "x=1"; git pull']) expect(guarded(c)).toEqual(EVERYWHERE(c))
  })
  it('W3. a command word built by a substitution with no git word anywhere in the command is not seen (a git name that is never spelled)', () => {
    for (const c of ["$(printf 'g%s' it) checkout other", '$(echo g)it checkout other']) expect(guarded(c)).toEqual(FREE(c))
    expect(guarded("$(printf 'g%s' it) checkout other; echo git")).toEqual(REFUSED("$(printf 'g%s' it) checkout other; echo git"))
  })
  it('W6. a parenthesis in a trailing comment counts as a group: a rewriting git with `# (text)` is refused in the copy as well; the same comment without parentheses is not a group', () => {
    const withParen = 'git reset --hard other # (careful)'
    const plain = 'git reset --hard other # careful'
    expect(guarded(withParen)).toEqual(EVERYWHERE(withParen))
    expect(guarded(plain)).toEqual(REFUSED(plain)) // the twin: no parenthesis, the copy is free
    // a read-only git with the same comment is not touched (the group rule applies to a rewriting git only)
    expect(guarded('git status # (careful)')).toEqual(FREE('git status # (careful)'))
  })
  it('W7. (the former limit is closed) a protected path spelled as an ANSI-C word, a $".." word or with a partial $(..) in the word has the verdict of the plain spelling', () => {
    const pairs: Array<[string, string]> = [
      ["rm $'scripts/doctor.sh'", 'rm scripts/doctor.sh'], ['rm $"scripts/doctor.sh"', 'rm scripts/doctor.sh'], ['rm scripts/$(echo doctor.sh)', 'rm scripts/doctor.sh'],
      ["cp a $'scripts/doctor.sh'", 'cp a scripts/doctor.sh'], ['cp a scripts/$(echo doctor.sh)', 'cp a scripts/doctor.sh'],
      ["echo x > $'scripts/doctor.sh'", 'echo x > scripts/doctor.sh'], ['echo x > scripts/$(echo doctor.sh)', 'echo x > scripts/doctor.sh'],
      ["mv a $'scripts/doctor.sh'", 'mv a scripts/doctor.sh'], ['tee $"scripts/doctor.sh"', 'tee scripts/doctor.sh'],
    ]
    for (const [spelled, plain] of pairs) expect(guarded(spelled)).toEqual({ ...guarded(plain), c: spelled })
    // the plain spelling is refused in the install, free in the copy: so are the spelled ones
    for (const [spelled] of pairs) expect({ c: spelled, root: denied(spelled, root), copy: denied(spelled, wt) }).toEqual({ c: spelled, root: true, copy: false })
  })
})
