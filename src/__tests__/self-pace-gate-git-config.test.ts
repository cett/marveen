// A `git config` run in a worktree copy writes the repository configuration the install shares: core.hooksPath and diff.external make the
// next plain git in the install run a program, core.worktree re-points the install repository, alias.x=!cmd, core.fsmonitor, include.path
// and the like do the same. The self-pace gate judges a `git config` write by its KEY (an allowlist, the shape the global -c rule has)
// AND by its VALUE (pull.rebase=interactive opens an editor on the next pull), from any directory.
//   A. every key of the allowlist, with a value that is allowed and one that is refused, in both case spellings
//   B. keys that run a program, move a tree or reach a remote are refused in every write spelling
//   C. read forms and removals stay free
//   D. a file target or an editor is refused whatever the key
//   E. the value rules (unreadable values, free text, newline)
//   F. the two-step pair: step 1 refused, step 2 alone stays allowed and is the reason step 1 is refused
//   G. where the words come from: -C, env prefix, sh -c, xargs, variables, the git >= 2.46 subcommand spelling
//   H. bounds
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
let wt2: string // a second copy
const touch = (p: string, body = '// x\n') => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body) }

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'git-config-'))
  root = join(base, 'fixture-root')
  wt = join(base, 'worktrees', 'feat')
  wt2 = join(base, 'worktrees', 'feat2')
  agentCwd = join(root, 'agents', 'agent-a')
  for (const r of [root, wt, wt2]) {
    for (const rel of ['scripts/self-pace-gate.mjs', 'scripts/email-send-gate.mjs', 'scripts/hooks/egress-gate.mjs', 'scripts/lib/homoglyph.py', 'scripts/agent-api.sh',
      'scripts/sync-hooks.sh', 'scripts/doctor.sh', 'scripts/gate-onfailure-check.py', 'scripts/secret-gate.ts', 'src/web/hook-registration-guard.ts', 'src/security/secret-gate.ts']) touch(join(r, rel))
  }
  mkdirSync(join(agentCwd, '.claude'), { recursive: true })
  touch(join(root, 'store', 'egress-allowlist.json'), '{"domains":[]}')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

const opts = (cwd: string) => ({ scriptsDir: join(root, 'scripts'), storeDir: join(root, 'store'), allowlistPath: join(root, 'store', 'egress-allowlist.json'), cwd })
const sub = (s: string) => s.replaceAll('@R', root).replaceAll('@W2', wt2).replaceAll('@W', wt).replaceAll('@A', agentCwd).replaceAll('@B', base)
const denied = (command: string, cwd: string) => Boolean(gateDecision('Bash', { command: sub(command) }, opts(cwd)).deny)
// the verdict of one command from a copy, a second copy, and as `git -C <copy> ...` from the agent directory
const inCopies = (c: string) => [denied(c, wt), denied(c, wt2), c.startsWith('git ') ? denied(`git -C @W ${c.slice(4)}`, agentCwd) : denied(c, wt)]
const REFUSED = [true, true, true]
const ALLOWED = [false, false, false]

// [key, a value that is allowed, a value that is refused]
const KEYS: Array<[string, string, string]> = [
  ['user.name', 'Some Name', 'a\nb'], // the refused one: a newline in free text (written through the quoted form below)
  ['user.email', 'agent-a@example.invalid', 'a\nb'],
  ['user.signingkey', 'ABC123', 'a\nb'],
  ['color.ui', 'auto', 'a\nb'],
  ['color.diff.meta', 'bold', 'a\nb'],
  ['advice.detachedhead', 'false', 'yes please'],
  ['pull.rebase', 'true', 'interactive'],
  ['pull.rebase', 'false', 'merges'],
  ['pull.ff', 'only', 'interactive'],
  ['pull.ff', 'true', 'always'],
  ['fetch.prune', 'true', 'maybe'],
  ['rerere.enabled', 'false', 'yes'],
  ['push.autosetupremote', 'true', '!echo x'],
  ['push.default', 'simple', 'tracking'],
  ['push.default', 'matching', '!x'],
  ['core.filemode', 'false', '!x'],
  ['core.ignorecase', 'true', '1'],
  ['core.quotepath', 'false', 'x y'],
  ['core.autocrlf', 'input', 'always'],
  ['core.safecrlf', 'warn', 'input'],
  ['init.defaultbranch', 'main', 'a b'],
  ['init.defaultbranch', 'feature/x-1.2', '$(x)'],
]

describe('A. every key of the allowlist: an allowed value passes, a refused value is refused', () => {
  it.each(KEYS)('%s = %s is free in a copy', (key, ok) => {
    expect(inCopies(`git config ${key} '${ok}'`)).toEqual(ALLOWED)
    expect(inCopies(`git config --global ${key} '${ok}'`)).toEqual(ALLOWED)
    expect(inCopies(`git config --local --replace-all ${key} '${ok}'`)).toEqual(ALLOWED)
  })
  it.each(KEYS.filter(([k]) => !/^(?:user|color)\./.test(k)))('%s = %s (a value outside the rule) is refused in a copy', (key, _ok, bad) => {
    expect(inCopies(`git config ${key} '${bad}'`)).toEqual(REFUSED)
    expect(inCopies(`git config --global ${key} '${bad}'`)).toEqual(REFUSED)
    expect(inCopies(`git config --add ${key} '${bad}'`)).toEqual(REFUSED)
  })
  it.each(KEYS)('the key is compared lower-cased and upper-cased: %s', (key, ok) => {
    const odd = key.replace(/(^|\.)([a-z])/g, (_m, d, c) => d + c.toUpperCase())
    expect(inCopies(`git config ${odd} '${ok}'`)).toEqual(ALLOWED)
    expect(inCopies(`git config ${key.toUpperCase()} '${ok}'`)).toEqual(ALLOWED)
  })
  it('a value with a rule is also compared in either case', () => {
    expect(inCopies('git config pull.rebase TRUE')).toEqual(ALLOWED)
    expect(inCopies('git config pull.ff Only')).toEqual(ALLOWED)
    expect(inCopies('git config pull.rebase Interactive')).toEqual(REFUSED)
  })
  it('the exact boundary values: one character more or less is refused', () => {
    for (const bad of ['truee', 'tru', ' true', 'true ', 'true\n', 'True1']) expect(inCopies(`git config pull.rebase '${bad}'`)).toEqual(REFUSED)
    for (const bad of ['', 'main branch', 'main;x', 'ma$in']) expect(inCopies(`git config init.defaultBranch '${bad}'`)).toEqual(REFUSED)
  })
  it('a key one character longer or shorter than an allowed key is refused', () => {
    for (const k of ['pull.rebases', 'pull.rebas', 'xpull.rebase', 'pull.rebase.x', 'core.autocrlf2', 'core.filemodes', 'core.x', 'advice', 'user', 'users.name', 'pull', 'push.defaults']) {
      expect(inCopies(`git config ${k} true`)).toEqual(REFUSED)
    }
  })
})

describe('B. a key that runs a program, moves a tree or reaches a remote is refused in every write spelling', () => {
  const keys = ['core.worktree', 'core.bare', 'core.hookspath', 'core.hooksPath', 'diff.external', 'core.fsmonitor', 'core.pager', 'core.editor', 'core.sshCommand',
    'core.gitProxy', 'core.askpass', 'alias.co', 'alias.x', 'filter.f.clean', 'filter.f.smudge', 'diff.x.textconv', 'merge.x.driver', 'credential.helper', 'include.path',
    'includeIf.gitdir:/x.path', 'url.x.insteadof', 'remote.origin.url', 'remote.origin.pushurl', 'remote.origin.uploadpack', 'remote.origin.fetch', 'sequence.editor',
    'gpg.program', 'sendemail.smtpserver', 'receive.denycurrentbranch', 'extensions.worktreeconfig', 'safe.directory', 'protocol.ext.allow', 'uploadpack.packobjectshook',
    'init.templatedir', 'core.attributesfile', 'core.excludesfile', 'branch.main.remote', 'branch.main.merge', 'branch.main.rebase', 'branch.autosetuprebase', 'pull.rebase.x',
    'transfer.hiderefs', 'submodule.x.update', 'submodule.x.url', 'http.proxy', 'ssh.variant', 'maintenance.x.cmd', 'trailer.x.command', 'credential.x.helper']
  const forms = (k: string) => [`git config ${k} /x`, `git config --global ${k} /x`, `git config --system ${k} /x`, `git config --local ${k} /x`, `git config --add ${k} /x`,
    `git config --replace-all ${k} /x`, `git config --worktree ${k} /x`, `git config ${k} /x oldvalue`, `git config -- ${k} /x`, `git config --type=path ${k} /x`,
    `git config --bool ${k} true`, `git config set ${k} /x`, `git config set --append ${k} /x`, `git config --global set ${k} /x`]
  it.each(keys)('%s', (k) => {
    for (const c of forms(k)) expect([c, inCopies(c)]).toEqual([c, REFUSED])
  })
  it('the cells that were open: the tree and hook keys named by value', () => {
    for (const c of ['git config core.worktree @R', 'git config --local core.worktree ../../fixture-root', 'git config --add core.worktree @R', 'git config CORE.WORKTREE @R',
      'git config core.bare true', 'git config core.hooksPath @B/hooks', 'git config core.hooksPath hooks', 'git config diff.external /bin/sh']) {
      expect([c, inCopies(c)]).toEqual([c, REFUSED])
    }
  })
  it('the quoting and splitting of the key does not hide it', () => {
    for (const c of ['git config "core.hooksPath" x', "git config 'core.hooks'Path x", 'git config core.hooks"Path" x', 'git config core.hooks\\Path x']) {
      expect([c, inCopies(c)]).toEqual([c, REFUSED])
    }
  })
  it('a key that is allowed with an unknown ride-along (a second value, a pattern) is judged by the same key', () => {
    expect(inCopies('git config user.name x oldpattern')).toEqual(ALLOWED)
    expect(inCopies('git config user.name x oldpattern extra')).toEqual(REFUSED)
    expect(inCopies('git config pull.rebase true oldpattern')).toEqual(ALLOWED)
  })
})

describe('C. read forms and removals stay free', () => {
  const free = ['git config --get core.hooksPath', 'git config --get-all core.hooksPath', 'git config --get-regexp "alias.*"', 'git config -l', 'git config --list', 'git config --list --show-origin',
    'git config --list --show-scope', 'git config --list --name-only', 'git config --global --list', 'git config --system -l', 'git config --local --get remote.origin.url', 'git config remote.origin.url',
    'git config core.hooksPath', 'git config --type=bool --get pull.rebase', 'git config --bool --get pull.rebase', 'git config --get --default x core.x', 'git config --get --default=x core.x',
    'git config --null --get core.x', 'git config -z --get core.x', 'git config --get-urlmatch http.proxy https://example.invalid', 'git config --get-color color.diff.meta',
    'git config --get-colorbool color.ui', 'git config --includes --get core.x', 'git config --no-includes --list', 'git config --unset core.hooksPath', 'git config --unset-all core.hooksPath',
    'git config --global --unset alias.x', 'git config --unset core.hooksPath oldpattern', 'git config --remove-section alias', 'git config --global --remove-section includeif.x',
    'git config get core.hooksPath', 'git config list', 'git config list --show-origin', 'git config unset core.hooksPath', 'git config remove-section alias', 'git config get --all core.x',
    'git config get --regexp "alias.*"', 'git config get --show-names --regexp x',
    'git config core.hooksPath=x'] // (one word and no value: a read of a key that does not exist, git writes nothing)
  it.each(free)('free in a copy: %s', (c) => { expect(inCopies(c)).toEqual(ALLOWED) })
  it('a read form from the install keeps the tree rule (the install is not a place for a git that is not read-only)', () => {
    expect(denied('git config --get core.x', root)).toBe(true)
    expect(denied('git config user.name x', root)).toBe(true)
    expect(denied('git config --get core.x', agentCwd)).toBe(true)
  })
  it('a write mixed into a read flag is judged as a write', () => {
    for (const c of ['git config --get --add core.hooksPath /x', 'git config --list --add core.hooksPath /x', 'git config --unset --add core.hooksPath /x', 'git config --get --replace-all core.hooksPath /x']) {
      expect([c, inCopies(c)]).toEqual([c, REFUSED])
    }
  })
  it('an unset or a read with a stray extra option the gate does not know is refused, not guessed', () => {
    for (const c of ['git config --get --frobnicate core.x', 'git config --unset --global=x core.x', 'git config -h', 'git config --help', 'git config --get-r "x"']) {
      expect([c, inCopies(c)]).toEqual([c, REFUSED])
    }
  })
})

describe('D. a file target, a blob or an editor is refused whatever the key', () => {
  const cmds = ['git config -f @B/cfg user.name x', 'git config --file @B/cfg user.name x', 'git config --file=@B/cfg user.name x', 'git config -f@B/cfg user.name x', 'git config --fil=@B/cfg user.name x',
    'git config user.name x -f @B/cfg', 'git config user.name x --file=@B/cfg', 'git config --blob HEAD:x user.name', 'git config --blob=HEAD:x --get user.name', 'git config -e', 'git config --edit',
    'git config --global -e', 'git config --global --edit', 'git config edit', 'git config --global edit', 'git config -lf @B/cfg', 'git config -fl @B/cfg', 'git config --get -f @B/cfg user.name',
    'git config --list --file @B/cfg', 'git config --file @B/cfg --get core.x', 'git config -- -f x']
  it.each(cmds)('%s', (c) => { expect(inCopies(c)).toEqual(REFUSED) })
})

describe('E. the value rules', () => {
  it('free text (user.*, color.*) takes any text, quoted, spaced, or built by the shell', () => {
    for (const c of ['git config user.name "A B C"', 'git config user.name "$NAME"', 'git config user.name $(whoami)', 'git config user.name `whoami`', "git config user.name 'a;b|c&d'", 'git config user.name ""', 'git config user.name',
      'git config color.diff.new "bold green"']) {
      expect([c, inCopies(c)]).toEqual([c, ALLOWED])
    }
  })
  it('free text with a newline in it is refused (the brief: any text without a newline)', () => {
    expect(inCopies("git config user.name 'a\nb'")).toEqual(REFUSED)
    expect(inCopies("git config color.ui 'a\r\nb'")).toEqual(REFUSED)
    expect(inCopies("git config user.name 'a b'")).toEqual(ALLOWED)
  })
  it('a type option in front of the key or with a separate value does not change the key rule', () => {
    expect(inCopies('git config --type bool pull.rebase true')).toEqual(ALLOWED)
    expect(inCopies('git config -t bool pull.rebase true')).toEqual(ALLOWED)
    expect(inCopies('git config --type=bool pull.rebase true')).toEqual(ALLOWED)
    expect(inCopies('git config --type bool pull.rebase interactive')).toEqual(REFUSED)
    expect(inCopies('git config --type bool core.hooksPath true')).toEqual(REFUSED)
    expect(inCopies('git config -t path core.hooksPath x')).toEqual(REFUSED)
  })
  it('a value with a rule that the text does not show is refused (a variable that is not set here, a substitution)', () => {
    for (const c of ['git config pull.rebase $V', 'git config pull.rebase "$V"', 'git config pull.rebase $(echo true)', 'git config pull.rebase `echo true`', 'git config core.autocrlf $V', 'git config init.defaultBranch $B']) {
      expect([c, inCopies(c)]).toEqual([c, REFUSED])
    }
  })
  it('a variable the command sets itself is read as its value', () => {
    expect(inCopies('V=true; git config pull.rebase $V')).toEqual(ALLOWED)
    expect(inCopies('V=interactive; git config pull.rebase $V')).toEqual(REFUSED)
    expect(inCopies('K=user.name; git config $K x')).toEqual(ALLOWED)
    expect(inCopies('K=core.hooksPath; git config $K x')).toEqual(REFUSED)
    expect(inCopies('K=core.hooksPath; git config "$K" x')).toEqual(REFUSED)
    expect(inCopies('K=core; git config $K.hooksPath x')).toEqual(REFUSED)
  })
  it('a key that the text does not show is refused', () => {
    for (const c of ['git config $K x', 'git config "$K" x', 'git config $(echo user.name) x', 'git config `echo core.hooksPath` x', 'git config user.$X x', 'git config ${K}.name x', 'git config --global $K x']) {
      expect([c, inCopies(c)]).toEqual([c, REFUSED])
    }
  })
  it('one key and no value is a read, also when the key is not readable', () => {
    expect(inCopies('git config $K')).toEqual(ALLOWED)
    expect(inCopies('git config --global core.hooksPath')).toEqual(ALLOWED)
  })
})

describe('F. the two-step pair', () => {
  it('step 1 (re-point the tree) is refused, step 2 alone (a checkout of a path in the copy) stays allowed: that is why step 1 is refused', () => {
    expect(denied('git config core.worktree @R', wt)).toBe(true)
    expect(denied('git checkout HEAD -- scripts/doctor.sh', wt)).toBe(false) // the second step alone: a plain checkout inside the copy
    expect(denied('git config core.worktree @R && git checkout HEAD~1 -- scripts/doctor.sh', wt)).toBe(true)
    expect(denied('git config core.worktree @R; git checkout HEAD~1 -- scripts/doctor.sh', wt)).toBe(true)
  })
})

describe('G. where the words come from', () => {
  it('-C and the other global options in front of config do not change the verdict', () => {
    expect(denied('git -C @W config core.hooksPath x', agentCwd)).toBe(true)
    expect(denied('git -C @W config user.name x', agentCwd)).toBe(false)
    expect(denied('git --git-dir=@W/.git config core.hooksPath x', wt2)).toBe(true)
    expect(denied('git --no-pager config alias.x "!x"', wt)).toBe(true)
    expect(denied('git --no-pager config user.name x', wt)).toBe(false)
    expect(denied('git -c user.name=z config core.hooksPath x', wt)).toBe(true)
    expect(denied('git -c user.name=z config user.name x', wt)).toBe(false)
  })
  it('an environment prefix, a launcher and a shell keyword do not hide it', () => {
    for (const c of ['FOO=1 git config core.hooksPath x', 'env git config core.hooksPath x', 'nice -n 5 git config core.hooksPath x', 'timeout 5 git config core.hooksPath x', 'command git config core.hooksPath x',
      'if true; then git config core.hooksPath x; fi', 'true && git config core.hooksPath x', 'false || git config core.hooksPath x', '(git config core.hooksPath x)', '{ git config core.hooksPath x; }', 'git status | git config core.hooksPath x']) {
      expect([c, denied(c, wt)]).toEqual([c, true])
    }
    for (const c of ['FOO=1 git config user.name x', 'env git config user.name x', 'timeout 5 git config user.name x', 'true && git config user.name x']) {
      expect([c, denied(c, wt)]).toEqual([c, false])
    }
  })
  it('a shell that is handed the command as text is judged on the text', () => {
    for (const c of ['sh -c "git config core.hooksPath x"', "bash -c 'git config alias.x !x'", 'eval "git config core.hooksPath x"', 'echo "git config core.hooksPath x" | sh', 'sh <<< "git config core.hooksPath x"',
      "sh -c 'cd . && git config core.hooksPath x'"]) {
      expect([c, denied(c, wt)]).toEqual([c, true])
    }
    for (const c of ['sh -c "git config user.name x"', "bash -c 'git config pull.rebase true'", 'eval "git config user.name x"', 'echo "git config user.name x" | sh']) {
      expect([c, denied(c, wt)]).toEqual([c, false])
    }
  })
  it('behind xargs the words the gate sees are not all the words git gets: refused unread', () => {
    for (const c of ['echo "core.hooksPath x" | xargs git config', 'xargs git config user.name', 'printf "a b" | xargs -n2 git config', 'echo x | xargs git config --get']) {
      expect([c, denied(c, wt)]).toEqual([c, true])
    }
  })
  it('the git >= 2.46 subcommand spelling is judged like the option spelling', () => {
    expect(inCopies('git config set user.name x')).toEqual(ALLOWED)
    expect(inCopies('git config set pull.rebase false')).toEqual(ALLOWED)
    expect(inCopies('git config set --global core.autocrlf input')).toEqual(ALLOWED)
    expect(inCopies('git config set core.hooksPath x')).toEqual(REFUSED)
    expect(inCopies('git config set pull.rebase interactive')).toEqual(REFUSED)
    expect(inCopies('git config set --all core.hooksPath x')).toEqual(REFUSED)
    expect(inCopies('git config set --value=old core.hooksPath x')).toEqual(REFUSED)
    expect(inCopies('git config --global set --append alias.x !x')).toEqual(REFUSED)
  })
  it('--rename-section: both names must be in an allowed family', () => {
    expect(inCopies('git config --rename-section color.diff color.mydiff')).toEqual(ALLOWED)
    expect(inCopies('git config --rename-section user user.old')).toEqual(ALLOWED)
    expect(inCopies('git config --rename-section evil core')).toEqual(REFUSED)
    expect(inCopies('git config --rename-section core evil')).toEqual(REFUSED)
    expect(inCopies('git config --rename-section user core')).toEqual(REFUSED)
    expect(inCopies('git config --rename-section user')).toEqual(REFUSED)
    expect(inCopies('git config rename-section user user.old')).toEqual(ALLOWED)
    expect(inCopies('git config rename-section alias core')).toEqual(REFUSED)
  })
  it('a free twin: a git that is not config is not touched by this rule', () => {
    for (const c of ['git status', 'git commit -m "core.hooksPath x"', 'git log --oneline', 'git branch --set-upstream-to=origin/x', 'git tag -a v1 -m "git config core.hooksPath x"', 'git stash push -m "config core.worktree"']) {
      expect([c, denied(c, wt)]).toEqual([c, false])
    }
  })
  it('the word config as an operand of another git is not a config command', () => {
    expect(denied('git checkout config', wt)).toBe(false)
    expect(denied('git log -- config', wt)).toBe(false)
    expect(denied('git add config.json', wt)).toBe(false)
  })
})

describe('H. bounds', () => {
  it('a 256-word config stays fast and is judged', () => {
    const many = Array.from({ length: 250 }, (_, i) => `--get-all`).join(' ')
    const t0 = Date.now()
    const v = denied(`git config ${many} core.x`, wt)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(v).toBe(false) // a read, 251 words: under the bound
  })
  it('more words than the bound are refused unread', () => {
    const words = Array.from({ length: 300 }, () => '--get').join(' ')
    expect(denied(`git config ${words} core.x`, wt)).toBe(true)
  })
  it('a 10 000 character value stays fast: refused for a rule key, free for free text', () => {
    const long = 'a'.repeat(10000)
    const t0 = Date.now()
    expect(denied(`git config pull.rebase ${long}`, wt)).toBe(true)
    expect(denied(`git config user.name ${long}`, wt)).toBe(false)
    expect(denied(`git config core.hooksPath ${long}`, wt)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(4000)
  })
})
