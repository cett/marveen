// The `compound` rule of the tree-rewriting git check: a subshell, a brace group or a shell keyword hides a `cd` from the
// directory tracking, so a rewriting git next to one is refused wherever it runs. That must be a GROUP in the command's
// STRUCTURE, not a parenthesis anywhere in its text:
//   - a parenthesis or a brace inside quotes is text (`git merge -m "x (y)"`)
//   - a command substitution `$( )` is a command of its own, judged on its own text (a subshell cannot move the outer cd)
//   - a process substitution `<( )` / `>( )` is the same, and its text is judged too (it was not before)
// Every refusal has an allowed twin (the same command in the worktree copy) and every allow a refused twin.
// Neutral fixture only: a tmp world with a made-up install, no real names, paths or ids.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, splitShell } from '../../scripts/self-pace-gate.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

let base: string
let root: string // the install
let agentCwd: string // a sub-agent's own directory, UNDER the install
let wt: string // a git worktree copy: a real path outside the install
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'groups-'))
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
const EVERYWHERE = (c: string) => ({ c, agent: true, root: true, copy: true }) // a real group: refused in the copy as well
const FREE = (c: string) => ({ c, agent: false, root: false, copy: false })

describe('a parenthesis or a brace inside quotes or escaped is text, not a group', () => {
  it.each([
    'git merge -m "x (y)" other', "git merge -m 'x (y)' other", 'git merge -m "x { y" other', 'git merge -m "x ) y" other', 'git merge -m a\\(b other',
    'git merge -m "a" other; echo "("', 'echo "{ "; git checkout other', 'echo "( "; git pull', "git rebase -x 'echo (a)' other",
  ])('refused in the install, free in the copy: %s', (c) => {
    expect(guarded(c)).toEqual(REFUSED(c))
  })
  it('splitShell reports a group only for an unquoted, unescaped parenthesis or standalone brace', () => {
    for (const c of ['(a)', 'a; (b)', '{ a; }', 'f() { a; }', 'a | (b)', 'case x in x) a;; esac', '(( x = 1 ))']) expect(splitShell(c).grouped).toBe(true)
    for (const c of ['a "(b)"', "a '(b)'", 'a \\(b', 'a "{ b"', 'echo $(date)', 'echo $((1 + 2))', 'diff <(a) <(b)', 'a >(b)', 'echo `date`', 'a {b}', 'a b{c,d}']) expect(splitShell(c).grouped).toBe(false)
  })
})

describe('a command substitution is not a group; the git inside it is judged on its own', () => {
  it.each([
    'echo $(date); git checkout other', 'echo $(date) && git merge other', 'git push origin "$(git branch --show-current)"', 'git push origin $(git branch --show-current)',
    'git checkout $(git rev-parse HEAD~1)', 'git checkout other & echo $(date)', 'echo "$(date) (now)"; git checkout other', 'echo $((1 + 2)); git pull', 'echo `date`; git checkout other',
    'x=$(date +%s); git merge other',
  ])('refused in the install, free in the copy: %s', (c) => {
    expect(guarded(c)).toEqual(REFUSED(c))
  })
  it.each(['echo $(git checkout other)', 'echo "$(git checkout other)"', 'x=$(git checkout other)', 'echo $(echo $(git checkout other))', 'echo `git checkout other`'])(
    'a rewriting git INSIDE the substitution is refused in the install and free in the copy: %s', (c) => {
      expect(guarded(c)).toEqual(REFUSED(c))
    })
  it.each(['echo $(git status)', 'echo "$(git log -1)"', 'echo $(date); git status', 'echo $(date)'])('read-only or no git: free everywhere: %s', (c) => {
    expect(guarded(c)).toEqual(FREE(c))
  })
  it.each(["echo '$(git checkout other)'", 'echo "\\$(git checkout other)"', 'echo "<(git checkout other)"', "echo '<(git checkout other)'"])(
    'a substitution that is quoted or escaped is text, not a command: free everywhere: %s', (c) => {
      expect(guarded(c)).toEqual(FREE(c))
    })
  it.each(['echo $(echo "$(echo ")" ; git checkout other)")', 'echo "x $(echo "a" ; git checkout other) y"', "echo $(echo ')' ; git checkout other)", 'echo $(echo "(" ; git checkout other)'])(
    'a quoted parenthesis inside a substitution does not end it early: refused in the install, free in the copy: %s', (c) => {
      expect(guarded(c)).toEqual(REFUSED(c))
    })
  it('a substitution that moves the directory first is still refused in the copy (the outer cd may put it in the install)', () => {
    expect(denied('cd /somewhere && echo $(git checkout other)', wt)).toBe(true)
  })
})

describe('a process substitution runs its text: judged on its own, as a $( ) is', () => {
  it.each(['echo hi | tee >(git checkout other)', 'echo <(git checkout other)', 'cat <(git pull) >/dev/null', 'echo x > >(git merge other)'])(
    'a rewriting git inside <( ) / >( ): refused in the install, free in the copy: %s', (c) => {
      expect(guarded(c)).toEqual(REFUSED(c))
    })
  it.each(['diff <(git log) <(git log -1)', 'echo hi | tee >(cat)', 'diff <(git show HEAD:a) <(git show HEAD~1:a)'])('read-only: free everywhere: %s', (c) => {
    expect(guarded(c)).toEqual(FREE(c))
  })
})

describe('a substitution with a group inside is a group', () => {
  it.each(['echo $( (git checkout other) )', 'echo $(cd /x; (git checkout other))', 'echo <( (git checkout other) )'])('refused everywhere: %s', (c) => {
    expect(guarded(c)).toEqual(EVERYWHERE(c))
  })
})

describe('a real group, keyword or function is still refused wherever it runs (the cd tracking cannot be trusted there)', () => {
  it.each([
    '(git checkout other)', '(cd /x; git checkout other)', '{ git checkout other; }', 'if true; then git checkout other; fi', 'f() { git checkout other; }; f',
    'echo "$(date)"; (git checkout other)', 'git checkout other; (echo hi)', 'echo $(date) | (git checkout other)', 'case x in x) git checkout other;; esac',
    '(( x = 1 )); git checkout other', 'for i in 1; do git checkout other; done', 'while false; do git checkout other; done',
    'cat <<EOF\n(echo)\nEOF\ngit checkout other', // a heredoc body is judged as commands, so a group in it counts
  ])('refused in the install and in the copy: %s', (c) => {
    expect(guarded(c)).toEqual(EVERYWHERE(c))
  })
  it('a group with no rewriting git is not this rule\'s business', () => {
    for (const c of ['(cd /x; git status)', '{ git log; }', 'if true; then git diff; fi']) expect(guarded(c)).toEqual(FREE(c))
  })
})

describe('the substitution scan is bounded', () => {
  it('deeply nested substitutions are refused unread, quickly and without a crash', () => {
    const deep = '$('.repeat(500) + 'git status' + ')'.repeat(500)
    const t = Date.now()
    expect(denied(deep, wt)).toBe(true)
    const deepQuoted = '"$('.repeat(10000) + 'git status' + ')"'.repeat(10000)
    expect(() => denied(deepQuoted, wt)).not.toThrow()
    expect(Date.now() - t).toBeLessThan(5000)
  })
  it('a handful of substitutions that name git is judged, not refused for their number', () => {
    const many = (n: number) => Array.from({ length: n }, () => '$(git rev-parse HEAD)').join(' ')
    expect(denied(`echo ${many(8)}`, wt)).toBe(false)
    expect(denied(`echo ${many(64)}`, wt)).toBe(false) // the bound is 64 per command
    expect(denied(`echo ${many(65)}`, wt)).toBe(true)
    // only the substitutions that name git count against the bound
    expect(denied(`echo ${Array.from({ length: 200 }, () => '$(date)').join(' ')}`, wt)).toBe(false)
  })
  it('an unclosed substitution is refused where a rewriting git is refused and does not hide the rest', () => {
    expect(denied('echo $(git checkout other', agentCwd)).toBe(true)
    expect(denied('echo <(git checkout other', agentCwd)).toBe(true)
  })
})
