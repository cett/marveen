// A shell that is handed its script as text (sh -c STRING, eval STRING, a script on stdin) runs a command the word rules cannot
// see inside: `sh -c 'git checkout other'` names no protected path and its command word is `sh`. The text is judged as a command
// of its own, from the directory (and the cd history) the outer command had at that point. The xargs and stdin-fed git forms
// (`echo x | xargs git checkout`, `git apply < p.diff`) were already refused by the tree rule; they are pinned here too so a later
// change to the text rule cannot loosen them.
//
// Every refusal has an allowed twin (the same text in the worktree copy) and every allow a refused twin.
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
  base = mkdtempSync(join(tmpdir(), 'text-cmd-'))
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
const bash = (command: string, cwd: string) => gateDecision('Bash', { command }, opts(cwd))
const denied = (command: string, cwd: string) => Boolean(bash(command, cwd).deny)

// the git commands a text hands over: tree-rewriting ones (refused in the install, free in the copy)
const REWRITES = ['git checkout other', 'git reset --hard', 'git apply change.diff', 'git stash pop', 'git pull --ff-only', 'git merge feature']
// the shapes that hand a text to a shell; `%` is replaced by the git command
const TEXT_FORMS: Array<[string, (g: string) => string]> = [
  ['sh -c, single quoted', (g) => `sh -c '${g}'`],
  ['bash -c, double quoted', (g) => `bash -c "${g}"`],
  ['bash -lc (clustered flag)', (g) => `bash -lc '${g}'`],
  ['zsh -c', (g) => `zsh -c '${g}'`],
  ['dash -ec (clustered flag)', (g) => `dash -ec '${g}'`],
  ['absolute shell path', (g) => `/bin/sh -c '${g}'`],
  ['eval, quoted', (g) => `eval '${g}'`],
  ['eval, unquoted', (g) => `eval ${g}`],
  ['echo into sh', (g) => `echo '${g}' | sh`],
  ['printf into bash', (g) => `printf '${g}\\n' | bash`],
  ['here-string into bash', (g) => `bash <<< '${g}'`],
  ['here-string into bash -s', (g) => `bash -s <<< "${g}"`],
  ['xargs sh -c', (g) => `echo x | xargs sh -c '${g}'`],
  ['timeout sh -c', (g) => `timeout 5 sh -c '${g}'`],
  ['nice bash -c', (g) => `nice -n 1 bash -c '${g}'`],
  ['env VAR sh -c', (g) => `env FOO=1 sh -c '${g}'`],
  ['VAR=val prefix', (g) => `FOO=1 sh -c '${g}'`],
  ['after && (second segment)', (g) => `true && sh -c '${g}'`],
  ['after a shell keyword', (g) => `if true; then sh -c '${g}'; fi`],
  ['nested sh -c in sh -c', (g) => `sh -c "sh -c '${g}'"`],
]

describe('a git rewriting the tree, handed to a shell as text: refused in the install, free in the copy', () => {
  for (const [name, form] of TEXT_FORMS) {
    describe(name, () => {
      it.each(REWRITES)('refused from the agent directory: %s', (g) => {
        const c = form(g)
        // `if ... then` is a compound command: the tree rule refuses a rewriting git there in the copy as well (existing rule), so
        // the allowed twin below skips that one form
        expect({ c, deny: denied(c, agentCwd) }).toEqual({ c, deny: true })
      })
      it.each(REWRITES)('refused from the install root: %s', (g) => {
        const c = form(g)
        expect({ c, deny: denied(c, root) }).toEqual({ c, deny: true })
      })
      if (name !== 'after a shell keyword') {
        it.each(REWRITES)('allowed in the worktree copy (the twin): %s', (g) => {
          const c = form(g)
          expect({ c, deny: denied(c, wt) }).toEqual({ c, deny: false })
        })
      }
    })
  }
})

describe('the destination decides, as with a bare git: cd, -C, GIT_WORK_TREE inside the text and around it', () => {
  it('a cd inside the text moves where the git runs', () => {
    expect(denied(`sh -c 'cd ${root} && git checkout other'`, wt)).toBe(true)
    expect(denied(`sh -c 'cd ${agentCwd} && git checkout other'`, wt)).toBe(true)
    expect(denied(`sh -c 'cd ${wt} && git checkout other'`, root)).toBe(false)
    expect(denied(`sh -c 'cd ${wt} && git checkout other'`, agentCwd)).toBe(false)
  })
  it('a cd before the shell moves it too, and a cd that may not have happened keeps both places', () => {
    expect(denied(`cd ${root} && sh -c 'git checkout other'`, wt)).toBe(true)
    expect(denied(`cd ${wt} && sh -c 'git checkout other'`, root)).toBe(false)
    expect(denied(`cd ${wt}; sh -c 'git checkout other'`, root)).toBe(true) // after `;` the cd may have failed: same as a bare `cd X; git checkout`
    expect(denied(`cd ${wt}; git checkout other`, root)).toBe(true)
    expect(denied(`cd ${wt} || sh -c 'git checkout other'`, root)).toBe(true) // runs where the command already was
    expect(denied(`cd ${wt} && true | sh -c 'git checkout other'`, root)).toBe(true) // a pipe: any directory it has been in
    expect(denied(`cd ${root} || sh -c 'git checkout other'`, wt)).toBe(true)
  })
  it('an unknown cd target before the shell is refused, as before a bare git', () => {
    expect(denied(`cd "$X" && sh -c 'git checkout other'`, wt)).toBe(true)
    expect(denied(`sh -c 'cd "$X" && git checkout other'`, wt)).toBe(true)
  })
  it('-C and --work-tree inside the text', () => {
    expect(denied(`sh -c 'git -C ${root} checkout other'`, wt)).toBe(true)
    expect(denied(`sh -c 'git -C ${wt} checkout other'`, root)).toBe(false)
    expect(denied(`sh -c 'git --work-tree=${root} checkout other'`, wt)).toBe(true)
    expect(denied(`sh -c 'git --work-tree=${wt} checkout other'`, agentCwd)).toBe(false)
  })
  it('GIT_WORK_TREE / GIT_DIR set around or inside the text', () => {
    expect(denied(`GIT_WORK_TREE=${root} sh -c 'git checkout other'`, wt)).toBe(true)
    expect(denied(`export GIT_WORK_TREE=${root}; sh -c 'git checkout other'`, wt)).toBe(true)
    expect(denied(`sh -c 'GIT_WORK_TREE=${root} git checkout other'`, wt)).toBe(true)
    expect(denied(`sh -c 'GIT_DIR=${join(root, '.git')} git checkout other'`, wt)).toBe(true)
    expect(denied(`sh -c 'GIT_WORK_TREE=${wt} git checkout other'`, root)).toBe(false)
  })
  it('a subshell or brace group around the shell hides the cd tracking: refused, as for a bare git', () => {
    expect(denied(`(cd ${wt} && sh -c 'git checkout other')`, root)).toBe(true)
    expect(denied(`{ cd ${wt}; sh -c 'git checkout other'; }`, root)).toBe(true)
  })
})

describe('reads and texts without a git stay free everywhere', () => {
  it.each(['git status', 'git log --oneline -3', 'git diff', 'git show HEAD', 'git ls-files', 'git add x', 'git commit -m wip', 'git rev-parse HEAD', 'git fetch origin'])(
    'a read-only git as text is free in the install: %s', (g) => {
      for (const [name, form] of TEXT_FORMS) {
        const c = form(g)
        expect({ name, c, deny: denied(c, agentCwd) }).toEqual({ name, c, deny: false })
      }
    })
  it.each(["sh -c 'ls -la'", "bash -c 'echo hi'", "eval 'echo hi'", "echo hi | sh", "bash <<< 'echo hi'", 'sh script.sh', 'bash ./run.sh --flag', "sh -c 'echo git is a word'"])(
    'a text with no tree-rewriting git, or a script FILE operand, is not this rule\'s business: %s', (c) => {
      expect({ c, deny: denied(c, agentCwd) }).toEqual({ c, deny: false })
    })
  it('boundaries of the stdin form: a pipe is needed, a script FILE operand ignores the text, a launcher word that follows another command is an argument', () => {
    expect(denied("echo 'git checkout other'; sh", agentCwd)).toBe(false) // not piped: the shell reads a terminal, not the echo
    expect(denied("echo 'git checkout other' | sh script.sh", agentCwd)).toBe(false) // KNOWN LIMIT: script.sh may read its stdin; its content is not text here
    expect(denied("echo nice sh -c 'git checkout other'", agentCwd)).toBe(false) // nice and sh are arguments of echo
    expect(denied("echo 'git checkout other' | sh", agentCwd)).toBe(true) // the twin: piped, no file
  })
  it('a multi-line stdin script is judged line by line', () => {
    expect(denied("printf 'git status\\ngit checkout other\\n' | sh", agentCwd)).toBe(true)
    expect(denied("printf 'git status\\ngit log\\n' | sh", agentCwd)).toBe(false)
  })
  it('the words git checkout as the ARGUMENTS of another command in the text do not run a git', () => {
    expect(denied("sh -c 'echo git checkout other'", agentCwd)).toBe(false)
    expect(denied("sh -c 'echo git checkout other'", wt)).toBe(false)
  })
})

describe('the xargs and stdin forms the tree rule already refuses stay refused (pins)', () => {
  it.each([
    'echo other | xargs git checkout', 'git branch --list | xargs git checkout', 'echo x | xargs -n1 git cherry-pick', 'echo x | xargs git reset --hard',
    'xargs git apply < list.txt', 'printf "a\\n" | xargs -I{} git checkout {} -- .', 'echo x | xargs env git checkout', 'echo x | xargs nice git merge',
    'git apply < x.diff', 'cat x.diff | git apply', 'git am < p.mbox', 'cat p.mbox | git am', 'git stash pop < /dev/null',
  ])('refused in the install, free in the copy: %s', (c) => {
    expect({ c, deny: denied(c, agentCwd) }).toEqual({ c, deny: true })
    expect({ c, deny: denied(c, wt) }).toEqual({ c, deny: false })
  })
  it.each(['echo x | xargs git log', 'git ls-files | xargs git log -1', 'git ls-files | xargs -n1 git blame'])('a read through xargs is free: %s', (c) => {
    expect({ c, deny: denied(c, agentCwd) }).toEqual({ c, deny: false })
  })
})

describe('the cost is bounded: depth and number of texts, refused (fail closed) when exceeded', () => {
  const nest = (depth: number, inner: string) => {
    let c = inner
    for (let i = 0; i < depth; i++) c = `sh -c ${JSON.stringify(c)}`
    return c
  }
  it('up to four levels of text are followed; a fifth is refused whatever the git is', () => {
    expect(denied(nest(4, 'git checkout other'), agentCwd)).toBe(true) // followed, and refused on its content
    expect(denied(nest(4, 'git checkout other'), wt)).toBe(false) // followed, allowed in the copy
    expect(denied(nest(5, 'git status'), wt)).toBe(true) // not followed: refused on the bound, even for a read in the copy
  })
  it('more than 16 texts that mention git in one command are refused; 16 are judged one by one', () => {
    const many = (n: number) => Array.from({ length: n }, () => "sh -c 'git status'").join('; ')
    expect(denied(many(16), wt)).toBe(false)
    expect(denied(many(17), wt)).toBe(true)
    // the texts without a git do not use the budget
    const noGit = Array.from({ length: 40 }, () => "sh -c 'ls'").join('; ')
    expect(denied(noGit, wt)).toBe(false)
  })
  it('a shell text inside a command substitution draws on the same budget', () => {
    const inSubst = (n: number) => Array.from({ length: n }, () => "echo $(sh -c 'git status')").join('; ')
    expect(denied(inSubst(16), wt)).toBe(false)
    expect(denied(inSubst(17), wt)).toBe(true)
  })
})
