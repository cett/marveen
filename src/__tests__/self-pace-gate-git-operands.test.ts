// A git that is not read-only can write through a path operand or an option value that names a directory holding protected files
// (`checkout-index --prefix=<install>/`, `format-patch -o <install>`, `clone <src> <install>`): the loose-ancestor tier of the self-pace
// gate used to judge only a fixed list of writing subcommands. It now judges a git by the classification the working-tree rule uses:
// a git that is not read-only counts as a writer for that tier.
//   A. the cells that used to pass from a worktree copy are refused (from the copy, a second copy, the agent directory with -C <copy>,
//      the install root, the agent directory), and every one has an allowed twin (another copy, a scratch directory, a new name)
//   B. prefix spellings: slash or not, quoted, separate value, abbreviation, dotdot, symlink alias, relative, case
//   C. what is NOT an operand keeps its verdict: the value of -C / --git-dir / --work-tree / --namespace, the text after -m / --message
//   D. the daily git commands keep their verdict in a worktree copy
//   E. a relative word after `-C <dir>` is relative to <dir> as well as to the directory the command runs in
//   F. the accepted new false denies (stated in the CHANGELOG), and the limits that stay (an unreadable operand, a new file in scripts/)
//   G. bounds: 256 loose-ancestor words and a 10 000 character value stay fast
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
let wt2: string // a second copy
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'git-operands-'))
  root = join(base, 'fixture-root')
  wt = join(base, 'worktrees', 'feat')
  wt2 = join(base, 'worktrees', 'feat2')
  agentCwd = join(root, 'agents', 'agent-a')
  for (const r of [root, wt, wt2]) {
    for (const rel of ['scripts/self-pace-gate.mjs', 'scripts/email-send-gate.mjs', 'scripts/hooks/egress-gate.mjs', 'scripts/lib/homoglyph.py', 'scripts/agent-api.sh',
      'scripts/sync-hooks.sh', 'scripts/doctor.sh', 'scripts/gate-onfailure-check.py', 'scripts/secret-gate.ts', 'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts']) touch(join(r, rel))
  }
  mkdirSync(join(agentCwd, '.claude'), { recursive: true })
  mkdirSync(join(wt, 'sub'), { recursive: true })
  touch(join(root, 'store', 'egress-allowlist.json'), '{"domains":[]}')
  symlinkSync(root, join(base, 'alias-root'))
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const opts = (cwd: string) => ({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const sub = (s: string) => s.replaceAll('@R', root).replaceAll('@W2', wt2).replaceAll('@W', wt).replaceAll('@A', agentCwd).replaceAll('@B', base)
const denied = (command: string, cwd: string) => Boolean(gateDecision('Bash', { command: sub(command) }, opts(cwd)).deny)
// the verdict of one command in the five places that matter. `copy`: a worktree copy, `copy2`: another copy, `viaC`: the same command
// as `git -C <copy> ...` from the agent directory, `root` / `agent`: the install root and the agent directory (the tree rule refuses a
// git that is not read-only there, whatever its operands)
const at = (c: string) => ({
  copy: denied(c, wt), copy2: denied(c, wt2),
  viaC: c.startsWith('git ') ? denied(`git -C @W ${c.slice(4)}`, agentCwd) : null,
  root: denied(c, root), agent: denied(c, agentCwd),
})
const REFUSED = { copy: true, copy2: true, viaC: true, root: true, agent: true }
const ALLOWED_IN_COPY = { copy: false, copy2: false, viaC: false, root: true, agent: true }

describe('A. a git that is not read-only, with an operand that is a directory holding protected files, is refused', () => {
  const refused = [
    'git checkout-index -f --prefix=@R/ scripts/doctor.sh', 'git checkout-index -f --prefix=@R/ -a', 'git checkout-index -f --prefix @R/ scripts/doctor.sh',
    'git checkout-index -f --pre=@R/ scripts/doctor.sh', 'git checkout-index -f --prefix=@R/scripts/ doctor.sh', 'git checkout-index -f --prefix=@R/scripts/hooks/ -a',
    'git checkout-index -f --prefix=@R/src/ -a', 'git checkout-index -f --prefix=@R/src/web/ -a', 'git checkout-index -f --prefix=@R/store/ -a',
    'git checkout-index -f --prefix=@R/agents/ -a', 'git checkout-index -f --prefix=@R/agents/agent-a/ -a', 'git checkout-index -f --prefix=@R/agents/agent-a/.claude/ -a',
    'git read-tree --prefix=@R/ HEAD', 'git credential-store --file=@R/ store', 'git format-patch -o @R/ HEAD~1', 'git format-patch --output-directory=@R HEAD~1',
    'git format-patch -o @R/scripts/ HEAD~1', 'git diff --output=@R/', 'git diff --output @R/scripts/doctor.sh', 'git log --output=@R/scripts/hooks/egress-gate.mjs',
    'git archive -o @R/scripts/doctor.sh HEAD', 'git archive -o@R/scripts/doctor.sh HEAD', 'git bundle create @R/scripts/hooks/b.bundle HEAD',
    'git worktree add @R/scripts/hooks/x HEAD', 'git worktree add @R/src/ HEAD', 'git apply --directory=@R/scripts p.patch',
  ]
  it.each(refused)('refused in every place: %s', (c) => { expect(at(c)).toEqual(REFUSED) })

  const twins = [
    'git checkout-index -f --prefix=@W2/ scripts/doctor.sh', 'git checkout-index -f --prefix=@B/out/ -a', 'git checkout-index -f --prefix=sub/ -a',
    'git read-tree --prefix=@B/out/ HEAD', 'git credential-store --file=@B/creds store', 'git format-patch -o @W2 HEAD~1', 'git format-patch -o @B/patches HEAD~1',
    'git diff --output=@W2/note.txt', 'git log --output=@B/log.txt', 'git archive -o @W2/x.tar HEAD', 'git bundle create @B/x.bundle HEAD', 'git worktree add @W2/x HEAD',
    'git apply --directory=@W2 p.patch', 'git apply --directory=sub p.patch',
  ]
  it.each(twins)('the twin that names another copy or a scratch directory is free in a copy: %s', (c) => {
    const v = at(c)
    expect(v.copy).toBe(false); expect(v.copy2).toBe(false); expect(v.viaC).toBe(false)
    // (the tree rule: a git that is not read-only does not run in the install; a read (diff / log with --output) and `worktree add` do)
    const runsInInstall = /^git (?:diff|log|worktree)\b/.test(c)
    expect(v.root).toBe(!runsInInstall); expect(v.agent).toBe(!runsInInstall)
  })

  it('a NEW name in the install root, or in a directory that holds no protected file, overwrites nothing a gate relies on and stays free from a copy', () => {
    for (const c of ['git clone @W @R/newdir', 'git archive -o @R/x.tar HEAD', 'git worktree add @R/newdir HEAD', 'git worktree add @R/node_modules/x HEAD', 'git bundle create @R/x.bundle HEAD']) {
      const v = at(c)
      expect([c, v.copy, v.copy2, v.viaC]).toEqual([c, false, false, false])
    }
  })

  it('the second step of the core.worktree pair stays allowed on its own (it is not visible: the first step is the one that is refused)', () => {
    expect(at('git checkout -f HEAD -- scripts/doctor.sh')).toEqual(ALLOWED_IN_COPY)
  })
})

describe('B. prefix spellings of the install root and of the directories under it', () => {
  const spellings = [
    '@R/', '@R', '"@R/"', "'@R/'", '@R/../fixture-root/', '../../fixture-root/', '../../fixture-root', '@B/alias-root/', '@B/alias-root', '@R/./', '@R//', '@R/src/../',
    '@R/src', '@R/store', '@R/agents', '@R/agents/agent-a',
  ]
  it.each(spellings)('--prefix=%s is the install (or a directory in it) whatever the spelling', (p) => {
    for (const form of [`git checkout-index -f --prefix=${p} -a`, `git checkout-index -f --prefix ${p} -a`, `git checkout-index -f --pre=${p} -a`]) {
      const v = at(form)
      expect([form, v.copy, v.copy2, v.viaC]).toEqual([form, true, true, true])
    }
  })
  it('an attached -o<path> is read like the separate and the glued form', () => {
    for (const c of ['git archive -o@R/scripts/hooks/x.tar HEAD', 'git archive --output=@R/scripts/hooks/x.tar HEAD', 'git archive -o @R/scripts/hooks/x.tar HEAD']) expect(denied(c, wt)).toBe(true)
    for (const c of ['git archive -o@W2/x.tar HEAD', 'git archive --output=@W2/x.tar HEAD', 'git archive -o @W2/x.tar HEAD']) expect(denied(c, wt)).toBe(false)
  })
  it('a case spelling of the install path is refused on every volume, because the gate folds case for the install path text (APFS ignores case); a case-sensitive volume pays a harmless false deny', () => {
    // insideInstall() matches the install path as case-insensitive text on purpose (fail-closed): on APFS the
    // upper-case spelling IS the install, on a case-sensitive volume it is another path and is denied anyway.
    const upper = root.replace('fixture-root', 'FIXTURE-ROOT')
    expect(denied(`git checkout-index -f --prefix=${upper}/ -a`, wt)).toBe(true)
  })
})

describe('C. a word that is not an operand of the writing subcommand keeps its verdict', () => {
  const free = [
    'git -C @R fetch', 'git -C @R fetch origin develop', 'git -C @R status', 'git -C @R worktree add @W2/x develop', 'git -C @R worktree list',
    'git --git-dir=@R/.git log', 'git --git-dir=@R/.git worktree add @W2/y develop', 'git --git-dir @R/.git worktree add @W2/y develop', 'git --work-tree=@R status',
    'git --namespace=@R fetch', 'git --namespace @R fetch', 'git --work-tree=@R worktree list', 'git --namespace=@R worktree list', 'git --git-dir=@R/src worktree list',
    'git tag -a v1 -m "deployed to @R"', 'git tag -a v1 -m "deployed to @R/src"', 'git tag -a v1 -m@R', 'git tag -a v1 --message="deployed to @R"', 'git tag -a v1 --message "deployed to @R"',
    'git stash push -m "wip in @R"', 'git merge -m "see @R" feat', 'git merge -m"see @R/store" feat', 'git notes add -m "@R"',
  ]
  it.each(free)('free in a copy (the same verdict as before): %s', (c) => { expect(denied(c, wt)).toBe(false) })
  it('free in a copy and in the agent directory when the git runs in the copy through -C', () => {
    expect(denied('git -C @W tag -a v1 -m "deployed to @R"', agentCwd)).toBe(false)
    expect(denied('git -C @W stash push -m "wip in @R"', agentCwd)).toBe(false)
  })
  it('the exemption is for these option values only: the same directory as an operand or as another option value is refused', () => {
    for (const c of ['git format-patch -o @R HEAD~1', 'git checkout-index --prefix=@R/ -a', 'git clone @W @R', 'git archive -o @R HEAD', 'git remote add x @R']) expect(denied(c, wt)).toBe(true)
  })
  it('the exemption never hides a protected FILE or the strict directory: those are judged as they were', () => {
    for (const c of ['git tag -a v1 -m @R/scripts/doctor.sh', 'git tag -a v1 -m @R/scripts', 'git -C @R/scripts fetch', 'git -C @R/scripts/hooks fetch', 'git --git-dir=@R/scripts/hooks/x worktree list']) {
      expect([c, denied(c, wt)]).toEqual([c, true])
    }
  })
  it('-m with no value (read-tree -m, a flag) exempts nothing: the word after it that starts with a dash is an operand again', () => {
    for (const c of ['git read-tree -m --prefix=@R/ HEAD', 'git read-tree -m --prefix=@R/scripts/ HEAD', 'git read-tree -m -u --prefix=@R/ HEAD', 'git read-tree -m --prefix @R/ HEAD', 'git read-tree -m--prefix=@R/ HEAD']) {
      expect([c, denied(c, wt)]).toEqual([c, true])
    }
    // the twins: the same flag with a prefix that names another copy, and the same without -m, behave as before
    expect(denied('git read-tree -m --prefix=@W2/ HEAD', wt)).toBe(false)
    expect(denied('git read-tree --prefix=@R/ HEAD', wt)).toBe(true)
    // a message after -m (a word without a leading dash) stays text, also next to such a flag
    expect(denied('git merge -m "see @R" feat', wt)).toBe(false)
    // a message that starts with a dash is text with a space in it, not a path: free. (Only a dash word that IS a loose ancestor after
    // -m is refused now, which no message is; --message TEXT and --message=TEXT stay exempt.)
    expect(denied('git tag -a v1 -m "-wip @R"', wt)).toBe(false)
    expect(denied('git tag -a v1 --message "-wip @R"', wt)).toBe(false)
    expect(denied('git tag -a v1 --message=-wip@R', wt)).toBe(false)
  })
  it('a substitution next to an exempt word is still refused', () => {
    expect(denied('git tag -a v1 -m "@R $(date)"', wt)).toBe(true)
    expect(denied('git -C @R fetch $(echo x)', wt)).toBe(true)
  })
  it('what is read-only or harmless is not a writer: help, version and a read with a plain option take any word; a git with no readable subcommand is a writer', () => {
    for (const c of ['git help @R', 'git version @R', 'git log -- @R/src', 'git status @R/store', 'git diff --stat -- @R/agents']) expect([c, denied(c, wt)]).toEqual([c, false])
    for (const c of ['git -c @R/ ', 'git -c core.pager=x log @R/src', 'git diff --ext-diff @R/src']) expect([c, denied(c, wt)]).toEqual([c, true])
  })
  it('an exempt word does not exempt an operand next to it', () => {
    expect(denied('git -C @R checkout-index --prefix=@R/ -a', wt)).toBe(true)
    expect(denied('git tag -a v1 -m "x" @R', wt)).toBe(true)
  })
})

describe('D. the daily git commands keep their verdict in a worktree copy', () => {
  const daily = [
    'git push origin feat', 'git pull --rebase origin develop', 'git rebase develop', 'git branch -D old', 'git checkout -b feat', 'git cherry-pick abc123',
    'git reset --hard origin/develop', 'git clean -fd', 'git gc', 'git bisect start HEAD HEAD~3', 'git commit -m "x"', 'git add .', 'git switch -c feat', 'git merge feat',
    'git restore sub', 'git stash', 'git stash pop', 'git config user.name x', 'git log --oneline', 'git status',
  ]
  it.each(daily)('%s is free in a copy', (c) => { expect(denied(c, wt)).toBe(false) })
  it.each(daily.filter((c) => !/^git (?:log|status|commit|add)\b/.test(c)))('%s is still refused in the install (the tree rule)', (c) => { expect(denied(c, root)).toBe(true) })
})

describe('E. a relative word after -C <dir> is relative to <dir> as well as to the directory the command runs in', () => {
  it('a relative prefix that is the install ONLY from the -C directory is refused', () => {
    expect(denied('git -C @W checkout-index -f --prefix=../../fixture-root/ -a', agentCwd)).toBe(true)
    expect(denied('git -C @W checkout-index -f --prefix=../../fixture-root/ -a', wt2)).toBe(true)
  })
  it('a relative prefix that is the install ONLY from the directory the command runs in is still refused (both count)', () => {
    // from the agent directory, `../` is the agents directory of the install; from the copy it is not
    expect(denied('git -C @W checkout-index -f --prefix=../ -a', agentCwd)).toBe(true)
    expect(denied('git -C @W checkout-index -f --prefix=../agents/ -a', agentCwd)).toBe(true)
  })
  it('a relative prefix that stays in the copy or goes to another copy is free', () => {
    expect(denied('git -C @W checkout-index -f --prefix ../../../out/ -a', agentCwd)).toBe(false) // (the separate form: a glued `--prefix=..` is also read as a path piece, which only ever adds a refusal)
    expect(denied('git -C @W checkout-index -f --prefix=sub/ -a', wt2)).toBe(false)
    expect(denied('git -C @W checkout-index -f --prefix ../../../worktrees/feat2/ -a', agentCwd)).toBe(false)
  })
  it('each -C is relative to the one before it', () => {
    expect(denied('git -C @B -C worktrees/feat checkout-index -f --prefix=../../fixture-root/ -a', wt)).toBe(true)
    // (from the agent directory the cwd reading cannot be what refuses it: only the chain reads `worktrees/feat` against @B)
    expect(denied('git -C @B -C worktrees/feat checkout-index -f --prefix ../../fixture-root/ -a', agentCwd)).toBe(true)
    expect(denied('git -C @B -C worktrees/feat checkout-index -f --prefix ../../../out/ -a', agentCwd)).toBe(false)
    expect(denied('git -C @B -C worktrees/feat checkout-index -f --prefix=../out/ -a', wt)).toBe(false) // (../out is a name beside the copy)
  })
  it('a relative word that names a protected FILE only from the -C directory is refused too (a name is a name); the twin that names a file of the copy is free', () => {
    expect(denied('git -C @W2/sub checkout-index -f ../../../fixture-root/scripts/doctor.sh', wt)).toBe(true)
    expect(denied('git -C @W2/sub checkout-index -f ../../feat/scripts/doctor.sh', wt)).toBe(false)
  })
  it('a -C value that cannot be read is refused by the tree rule (fail closed), with or without a path operand', () => {
    expect(denied('git -C $D checkout-index -f --prefix=out/ -a', wt)).toBe(true)
    expect(denied('git -C $(pwd) checkout-index -f --prefix=@R/ -a', wt)).toBe(true)
  })
})

describe('F. accepted new false denies and limits that stay', () => {
  it('a git that is not read-only with the install (or another loose ancestor) as TEXT is refused: clone, remote add / set-url, submodule add, push, branch -f', () => {
    for (const c of ['git clone @R @B/clone', 'git remote add inst @R', 'git remote set-url origin @R', 'git submodule add @R sub', 'git push @R HEAD:refs/heads/x', 'git branch -f feat @R']) {
      expect([c, denied(c, wt)]).toEqual([c, true])
    }
    // the way around, for a human or the main agent: the same command with a path that is not the install (a copy), or run through the main agent
    for (const c of ['git clone @W2 @B/clone', 'git remote add inst @W2', 'git submodule add @W2 sub']) expect([c, denied(c, wt)]).toEqual([c, false])
  })
  it('a plain fetch only moves refs: `git fetch <install path>` stays free (it is not a writer)', () => {
    expect(denied('git fetch @R develop', wt)).toBe(false)
    expect(denied('git fetch --upload-pack=x @R develop', wt)).toBe(true) // (an option that runs a program makes it a writer again)
  })
  it('KNOWN LIMIT: an operand the parser cannot read (an unset variable, a substitution, arguments through xargs) keeps the verdict it had: free in a copy', () => {
    for (const c of ['git checkout-index -f --prefix=$INST/ -a', 'git checkout-index -f --prefix=$(pwd)/../../fixture-root/ -a', 'echo @R/ | xargs git checkout-index -f -a --prefix']) {
      expect([c, denied(c, wt)]).toEqual([c, false])
    }
    // the twin: the same variable, set in the same command to the install, is read
    expect(denied('INST=@R; git checkout-index -f --prefix=$INST/ -a', wt)).toBe(true)
  })
})

describe('G. bounds', () => {
  it('256 loose-ancestor words and a 10 000 character value are judged fast and fail closed', () => {
    const many = `git checkout-index -f ${Array.from({ length: 256 }, () => '--prefix=@R/').join(' ')}`
    const t0 = Date.now()
    expect(denied(many, wt)).toBe(true)
    expect(denied(`git checkout-index -f --prefix=${'a'.repeat(10_000)}/ -a`, wt)).toBe(false)
    expect(denied(`git checkout-index -f --prefix=@R/${'a'.repeat(10_000)} -a`, wt)).toBe(false)
    expect(denied(`git tag -a v1 -m "${'@R '.repeat(500)}"`, wt)).toBe(false)
    expect(denied(`git -C @W ${Array.from({ length: 200 }, () => 'checkout-index').join(' ')}`, agentCwd)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(5000)
  })
})
