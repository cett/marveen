#!/usr/bin/env node
// PreToolUse hard-gate: blocks SELF-PACE for sub-agents.
//
// Governance control (2026-06-26, after the autonom-kor incident: a sub-agent
// scheduled its own wakeups via ScheduleWakeup, fed itself prompts, and acted
// on a SELF-GENERATED "A) zárjuk le" decision -- dispatching real development
// -- while the operator slept. Two independent adversarial audits confirmed the
// root cause is the agent's own self-pace loop, not an external vector).
//
// A sub-agent must be INPUT-DRIVEN: it acts on operator / peer messages, never
// on prompts it scheduled for itself. This gate blocks every self-pace path:
//   - the Claude Code runtime tools ScheduleWakeup / CronCreate / CronList /
//     CronDelete / RemoteTrigger (the autonomous-loop machinery), AND
//   - the Bash escape routes that achieve the same self-injection: writing the
//     Claude scheduled_tasks.json directly, tmux send-keys into a session, or
//     POSTing a new schedule to the dashboard.
//
// Why a hook and not only a permissions deny-list: permissive profiles launch
// with --dangerously-skip-permissions. A whole-tool-name deny DOES survive that
// (deny is checked before the bypass allow), so the scaffold also adds these
// names to permissions.deny -- but the Bash-command routes can ONLY be caught
// by a PreToolUse hook, which runs regardless of permission mode. Defense in
// depth: deny-list for the tool names, this hook for the Bash routes (+ the
// names again, redundantly fail-closed).
//
// Wired into every sub-agent's .claude/settings.json by
// writeAgentSettingsFromProfile() (agent-scaffold.ts), guarded by
// name !== MAIN_AGENT_ID, re-applied on every spawn (respawn-safe).
//
// KNOWN, NOT COVERED (listed on purpose, not fixed here): the protected-path rule below judges the WORDS of a command,
// so an operation that changes the install without naming a protected path is not seen: `patch -p1 < x.diff`,
// `tar xf` / `unzip` / `cpio -i` into a directory under the install, `rsync` / `cp -r a/. .` onto `.`,
// `git config core.hooksPath`, `git -c core.fsmonitor=...`, and a diff program or textconv filter that the repository
// configuration already names (diff.external, diff.<driver>.textconv) for a plain `git diff`, and a pager that the repository
// configuration names (core.pager, pager.<command>) for `git --paginate` / `git -p` (allowed, like diff.external). A git hidden from the parser
// (`sh -c 'git ...'`, `find -exec git`, `env -C <dir> git`, a nested command substitution) is not judged by
// the working-tree rule (gitRewritesInstallTree), and neither is a repository whose configuration sets core.worktree.

import { readFileSync, readdirSync, realpathSync, statSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Claude Code runtime self-pace / scheduling tools. A sub-agent has no
// legitimate need to schedule its own future turns -- it is input-driven.
const SELF_PACE_TOOLS = new Set([
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
])

// Bash command patterns that achieve self-pace by another route. These are
// tested per COMMAND SEGMENT (see splitSegments), so a token in one part of a
// compound command never trips a pattern that belongs to another part.
const SELF_PACE_BASH_PATTERNS = [
  // tmux pane injection -- every write-subcommand that can push keys/text/commands
  // into a pane (the actual incident vector), not just send-keys. [\s\S] (not
  // [^\n]) so an intra-segment newline cannot split the match.
  /\btmux\b[\s\S]*\b(send-keys|paste-buffer|run-shell|set-buffer)\b/i,
  // self-backgrounding that relaunches claude (nohup/setsid/disown + claude)
  /\b(nohup|setsid|disown)\b[\s\S]*\bclaude\b/i,
  // the loop slash-skill driven from a shell. `/loop` must be in SLASH-COMMAND
  // position -- a standalone token (segment-start / whitespace / quote before it,
  // whitespace / quote / end after it) -- never a PATH segment. The old
  // `\/loop\b` fired on any `loop`-prefixed path component whenever `.claude` was
  // in the same command (\bclaude\b matches the `.claude` in every memory/skill
  // path), so reading `.../memory/loop-stop-...md` or `~/.claude/skills/loop/...`
  // was denied. Every real form stays denied: `claude /loop 5m`, `claude -p "/loop x"`,
  // `claude '/loop'`, bare `claude /loop`.
  /\bclaude\b[\s\S]*(?:^|[\s'"])\/loop(?=[\s'"]|$)/i,
]

// OS-level schedulers + delayed exec (cron / launchd / systemd / at / batch): the
// shell route to the same self-pace the CronCreate tool-deny blocks at the runtime
// layer. Anchored to command position (segment start), but a leading wrapper is
// allowed before the binary -- sudo/env/command/nice, a VAR=val environment, and
// an absolute/relative path -- so `sudo crontab -r`, `/usr/bin/at now`,
// `PATH=/bin crontab -` are all caught. Trailing \b(?!-) so it never fires on
// "netstat" / "crontab-helper.sh"; (?!\s*=) so a bare NAME=value assignment
// (`at=$(...)`) is not mistaken for the `at` binary.
// The match is done by a procedural, linear matcher (makePrefixedMatcher below), NOT by one regex. The equivalent
// regex, `(^|[;&|(`]\s*)PREFIX TAIL` with PREFIX = `(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*(?:\S*/)?`,
// is quadratic: on a long run of `(` or backticks every boundary opens a `\S*` scan to the end of the word (60 KB: 2.3 s).
// The verdicts are the regex's, exactly: narrowing `\S*` would change them (a wrapper word the list does not name, such
// as nohup in `X=$(nohup <scheduler> ...)`, is caught only because the assignment value swallows `$(nohup`), so the
// matcher keeps the same language and only changes how it is searched. The old regexes live in the tests as the oracle
// of a differential fuzz; do not change the language here without changing them there.
// The input size cap (MAX_CMD_CHARS) stays as the outer bound.
// The command-boundary anchor includes `(` so a $(...) command substitution
// (`X=$(crontab -)`) is caught, AND a backtick so a legacy `...` substitution
// (`X=`crontab -r``) is caught too -- both run the enclosed command in a shell
// context, so a scheduler binary immediately inside either is a real self-pace.
const SCHED_BOUNDARY = '[;&|(`]'
// `at` and `batch` are ordinary English words; splitSegments splits on NEWLINES
// so a prose line ("at least 80%", "batch size 50") at a segment start looked
// like the at(1)/batch(1) binaries. For these two ONLY, also require something
// that looks like an actual invocation: end of segment, a flag, a redirect, or
// an at(1) TIMESPEC. crontab/systemd-run keep the plain match (not English words).
const AT_INVOCATION = String.raw`(?=\s*$|\s+-|\s*<|\s+(?:now|noon|midnight|teatime|today|tomorrow|next\b|\+\s*\d|\d{1,2}:\d{2}|\d{3,4}\b|\d{1,2}\s*(?:am|pm)\b|\d{1,2}[./]\d{1,2}|(?:mon|tue|wed|thu|fri|sat|sun)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)))`
// launchctl needs similar narrowing: fleet heartbeats include launchctl job labels
// (e.g. `launchctl com.marveen.channels PID 555`) at segment-starts in status prose.
// Require a subcommand-shaped next token (bare lowercase word, no dot/slash).
// Every real self-pace vector (load/bootstrap/submit/kickstart/start/enable/...)
// takes a subcommand word. A job label and a path both fail and pass as prose.
const LAUNCHCTL_SUBCOMMAND = String.raw`(?=\s*$|\s+-|\s+[a-z][a-z-]*(?:\s|$))`
const SCHEDULER_TAIL = String.raw`(?:(?:crontab|systemd-run)\b(?!-)(?!\s*=)|launchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|(?:batch|at)\b(?!-)(?!\s*=)${AT_INVOCATION})`
// ...but allow a pure READ-listing of one's own schedule (parity with the store /
// schedule-API read exemptions): crontab -l, launchctl list/print, atq.
const SCHEDULER_READ_TAIL = String.raw`(crontab\s+-l\b|launchctl\s+(?:list|print|dumpstate|blame|examine)\b|atq\b)`

// Linear equivalent of `(^|[;&|(`]\s*)PREFIX TAIL` (flag i), as a boolean test. PREFIX is any number of wrapper words,
// each followed by whitespace (a NAME=value word, or one of sudo/env/command/exec/nice/builtin/time), then an optional
// `\S*/` (a path ending in a slash, TAIL right after it). A start position is the string start (no whitespace skipped
// there) or the first non-space after a boundary char. Per position i (a non-space char):
//   final(i)   = TAIL matches at i, or a `/` in i's own word is followed by a TAIL match
//   wrapper(i) = i starts a whole word that is a wrapper and is followed by whitespace
//   R[i]       = final(i) || (wrapper(i) && R[start of the next word])
// R is filled right to left, so every position is evaluated once and a long chain of wrappers costs nothing extra.
export function makePrefixedMatcher(tailSource) {
  const tail = new RegExp(tailSource, 'iy')
  const wrapperKw = /(?:sudo|env|command|exec|nice|builtin|time)(?=\s)/iy
  const isSpace = (ch) => /\s/.test(ch)
  const isWordCh = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122)
  const isLetterOrUnderscore = (c) => (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122)
  return function test(seg) {
    const s = String(seg ?? '')
    const n = s.length
    if (n === 0) return false
    // sp[i]: whitespace; wordEnd[i]: end (exclusive) of the non-space run containing i; nextNonSpace[i]: first non-space >= i;
    // wEnd[i]: end of the \w run starting at i.
    const sp = new Uint8Array(n + 1)
    for (let i = 0; i < n; i++) sp[i] = isSpace(s[i]) ? 1 : 0
    sp[n] = 1
    const wordEnd = new Int32Array(n + 1)
    const nextNonSpace = new Int32Array(n + 2)
    const wEnd = new Int32Array(n + 2)
    wordEnd[n] = n
    nextNonSpace[n] = n
    nextNonSpace[n + 1] = n
    wEnd[n] = n
    wEnd[n + 1] = n
    for (let i = n - 1; i >= 0; i--) {
      wordEnd[i] = sp[i] ? i : wordEnd[i + 1]
      nextNonSpace[i] = sp[i] ? nextNonSpace[i + 1] : i
      wEnd[i] = isWordCh(s.charCodeAt(i)) ? wEnd[i + 1] : i
    }
    const memo = new Int8Array(n + 2).fill(-1)
    const tailAt = (t) => {
      if (t >= n) return false
      if (memo[t] < 0) {
        tail.lastIndex = t
        memo[t] = tail.test(s) ? 1 : 0
      }
      return memo[t] === 1
    }
    // slash[i]: a `/` at or after i inside i's own word, with TAIL right after it
    const slash = new Uint8Array(n + 2)
    const R = new Uint8Array(n + 2)
    for (let i = n - 1; i >= 0; i--) {
      if (sp[i]) continue
      slash[i] = (s.charCodeAt(i) === 47 && tailAt(i + 1)) || (i + 1 < n && !sp[i + 1] && slash[i + 1]) ? 1 : 0
      let r = tailAt(i) || slash[i] === 1
      // a wrapper must be followed by whitespace and then more: at the string end R[n] is 0, so a last-word wrapper never matches
      if (!r) {
        let wrapper = false
        if (isLetterOrUnderscore(s.charCodeAt(i))) {
          const w = wEnd[i + 1]
          wrapper = w < n && s.charCodeAt(w) === 61 // NAME=
        }
        if (!wrapper) {
          wrapperKw.lastIndex = i
          wrapper = wrapperKw.test(s)
        }
        if (wrapper) r = R[nextNonSpace[wordEnd[i]]] === 1
      }
      R[i] = r ? 1 : 0
    }
    if (!sp[0] && R[0]) return true
    for (let b = 0; b < n; b++) {
      const c = s.charCodeAt(b)
      if (c === 59 || c === 38 || c === 124 || c === 40 || c === 96) {
        const start = nextNonSpace[b + 1]
        if (start < n && R[start]) return true
      }
    }
    return false
  }
}
export const schedulerMatch = makePrefixedMatcher(SCHEDULER_TAIL)
export const schedulerReadMatch = makePrefixedMatcher(SCHEDULER_READ_TAIL)

// The Claude self-schedule store. Blocked for WRITE on any route (a Bash write,
// or the native Write/Edit/NotebookEdit tool); a read/grep is legit diagnostics.
const SCHEDULE_STORE_RX = /scheduled_tasks\.json/i
// Write-intent shell tokens (redirect / tee / in-place edit / dd / copy-move).
const WRITE_INTENT_RX = /(>>?|\btee\b|\bsed\b[\s\S]*\s-i|\bdd\b|\bcp\b|\bmv\b)/i
// Dashboard schedule API. A WRITE method (POST/PUT/PATCH/DELETE) creates/edits a
// self-paced cron; a GET (list / pending / agents) is legit diagnostics -> allowed.
const SCHEDULE_API_RX = /\/api\/schedules\b/i
const HTTP_WRITE_RX = /(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|(^|\s)(--data\b|--data-\w+\b|-d\b))/i

// THE GATES AND THEIR CONFIG ARE A GATE ON THE SUB-AGENT ITSELF (EGRESSSELFEDIT824, extended).
// Two families of files decide what a sub-agent may do, and both were plain writable files in its
// own tree. A sub-agent may not edit either (it may READ both and RUN the scripts):
//
//  1. STORE CONFIG that widens egress: store/egress-allowlist.json (WebFetch list; on 2026-08-24 a
//     nested sub-agent added a domain to reach it and removed it afterwards), store/egress-vendor-
//     hosts.json (the hosts the Bash egress parser lets through), the runtime cache
//     store/.egress-allowlist-cache.json (egress-gate.mjs trusts it for 30 s), and the history
//     directories of the first two.
//  2. The gate and hook EXECUTABLES of THIS install: scripts/self-pace-gate.mjs,
//     scripts/email-send-gate.mjs and everything under scripts/hooks/ and scripts/lib/. Overwriting
//     any of them (Edit/Write, or `cat /dev/null > scripts/self-pace-gate.mjs`) disables a gate
//     for every later call.
//
//  3. The Claude Code SETTINGS files that wire those gates: agents/<any name>/.claude/settings.json
//     and settings.local.json, the same two under agents/<name>/.claude-config/ (the CLAUDE_CONFIG_DIR
//     of an isolated agent), and <repo root>/.claude/settings.json and settings.local.json. A
//     settings.local.json with {"disableAllHooks": true} (or a permissions or hooks edit) turns every
//     gate off from the next session. The agents/*/ part is a PATTERN on real paths under THIS install's
//     agents/ directory (an agent that does not exist yet has no file to list), and the .claude /
//     .claude-config directories themselves cannot be moved, removed or re-linked. NOT protected, said
//     here on purpose: the user-global ~/.claude/settings.json (it is the owner's, shared by every
//     agent and the main one; protecting it needs an owner decision), and the server's own writes
//     (agent-scaffold, the dashboard), which are a different process and never pass this gate.
// Their legitimate writers are the MAIN agent (on the owner's go) and the owner by hand -- neither
// runs this gate (it is wired for sub-agents only), so neither is affected.
//
// WHAT IS PROTECTED is a set of REAL PATHS derived from this script's own location (scripts/ ->
// repo root -> store/), the way the allowlist path always was; MARVEEN_STORE_DIR adds the store
// of an isolated instance. It is NOT a name pattern: developers work in git worktrees such as
// <home>/worktrees/<x>/scripts/hooks/foo.mjs, and a worktree copy is a different real path, so
// editing it, staging it, running it stay allowed. (The one exception, kept from the first version:
// a file NAMED egress-allowlist.json is protected wherever it is.)
//
// Native file tools: denied on the resolved real path (relative path against the payload cwd,
// symlink, a file that does not exist yet inside a protected directory).
// Bash: FAIL-CLOSED. The command is split quote-aware into simple commands; a path word is resolved
// against the cwd of the payload and every directory a `cd` in the same command visits (after
// ~, $HOME, assigned variables, brace expansion and globs). A command that names a protected path
// may only be:
//   - a plain READ: cat/grep/head/tail/wc/ls/stat/shasum/diff/jq/..., each judged by readerOk() (a
//     listed name is not a promise: sort -o, uniq IN OUT, xxd IN OUT, a sed w/e/r command or -f,
//     file -C, rg --pre and find -fprint write or exec and are denied), or a safe git subcommand
//     (status/diff/log/show/add/commit ...) without --out*, -c, --config-env, grep -O;
//   - a plain RUN of the file: `node scripts/hooks/x.mjs`, `python3 scripts/hooks/x.py`, `bash x.sh`,
//     `./scripts/hooks/x.sh args` -- the protected file as the SCRIPT operand of an interpreter with
//     no inline-code flag (-c/-e/-p/-r/-m), or as the command word. Running a hook is how the fleet
//     tests it; whatever the script does is the script's own code. Any OTHER protected word in a
//     run (an argument, an option value) denies.
//   and in both cases no output redirect may point at a protected path (`>`, `>>`, `>|`, `&>`,
//   `>&file`, `N>&file`, `<>`, matched on the unquoted, unescaped word). cp/mv/tee/sed -i/ln/rm/
//   truncate/dd/chmod, an interpreter with inline code, xargs, or anything else that names a
//   protected path is denied, because whether it writes cannot be read off the command string.
//   Extra rules: a protected word next to a command substitution / process substitution is denied;
//   quotes or a backslash inside a protected name together with ANY redirect operator in the same
//   simple command is denied (the mention check is ambiguous there); an unterminated quote is denied
//   when the command names a protected path.
//
// What this gate CANNOT see -- written down, not hidden: a script that builds the path at runtime
// (`python3 x.py` that writes it, `P=$(echo ...)`, a glob that never spells a protected directory),
// a `cd` into a variable (then only the BASENAMES of the protected files are matched), a symlink
// chain created by another route, a heredoc fed to an interpreter that is not a plain reader (that
// IS denied when it names a protected path, but not when it spells it in pieces). The dashboard
// keeps a hash baseline of the two store config files and reports every change, whoever made it, by
// whatever route (src/web/egress-allowlist-baseline.ts). The script files have no baseline: they
// change legitimately on every deploy, and `git status` / `git diff` on the install shows an edit.
const ALLOWLIST_BASENAME = 'egress-allowlist.json'
// The allowlist STORE objects by name, not the concept: the file and its history directory, or a
// glob that starts on the name (egress-allow*, egress-allowlist.*). A plain /egress[-_]?allow/ also
// matched this gate's own source and test names (egress-allowlist-baseline.ts), so no sub-agent
// could run, stage or diff them -- review on upstream #1678.
const ALLOWLIST_MENTION_RX = /egress[-_]?allowlist(?:\.json|\.history)|egress[-_]?allow[\w.]*[*?[]/i
const READERS = new Set([
  'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'jq', 'wc', 'ls', 'stat',
  'file', 'shasum', 'sha256sum', 'md5', 'md5sum', 'diff', 'cmp', 'echo', 'printf',
  'nl', 'sort', 'uniq', 'cut', 'tr', 'tac', 'od', 'xxd', 'hexdump', 'strings',
  'realpath', 'readlink', 'dirname', 'basename', 'du', 'test', '[', 'cd', 'pushd', 'popd', 'true', 'false',
  'sed', 'find', // both are checked in readerOk below
])
// READERS is a list of NAMES, and a name is not a promise: sort -o, uniq IN OUT, xxd IN OUT, sed's w
// command and file -C write files, rg --pre execs a program, find -fprint writes. readerOk() states
// per command what a plain read is; anything it cannot show safe is not a read. A pager (less, more,
// bat) can log (-o) or run commands, so none is listed.
const SAFE_GIT = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'ls-files', 'add', 'grep', 'rev-parse', 'cat-file', 'check-ignore',
  'diff-tree', 'show-ref', 'ls-tree', 'shortlog', 'commit', 'diff-index', 'diff-files', 'rev-list', 'describe',
  // pure read-only names (no write form of their own; gitSafe still refuses -c, --output, --ext-diff, --textconv in front of or after them).
  // NOT here, on purpose: branch, tag, remote, stash, reflog, config (they have write forms), ls-remote (--upload-pack runs a program),
  // verify-commit / verify-tag (run the configured gpg program), fsck (--lost-found writes), merge-tree (writes objects)
  'merge-base', 'for-each-ref', 'name-rev', 'cherry', 'whatchanged', 'count-objects', 'show-branch', 'range-diff',
])
const WRAPPER_WORDS = new Set(['env', 'time', 'nohup', 'command', 'builtin', 'exec', 'nice', 'sudo', 'doas', 'stdbuf', 'setsid'])
const INTERPRETERS = /^(?:python(?:\d+(?:\.\d+)?)?|node(?:js)?|bash|sh|zsh|dash|ksh|perl|ruby|php|deno|bun|tsx|ts-node|source|\.)$/
const INLINE_FLAGS = new Set(['-c', '-e', '-E', '-p', '-r', '-m', '-', '--eval', '--print', '--require', '--import', '--loader', '-pe', '-ne', '-le'])
const DEFAULT_SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const SETTINGS_FILES = ['settings.json', 'settings.local.json']
// agents/<name>/.claude (project settings) and agents/<name>/.claude-config (the CLAUDE_CONFIG_DIR of
// an isolated agent, see agent-process-config.ts) both hold settings files Claude Code reads.
const AGENT_CONFIG_DIRS = ['.claude', '.claude-config']

function expandHome(p) {
  return p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}
// realpath that also works for a path that does not exist yet: the nearest existing ancestor is
// resolved (macOS: case and /tmp -> /private/tmp included) and the rest appended.
function realOrSelf(p) {
  try { return realpathSync.native(p) } catch { /* not there (yet) */ }
  const parent = dirname(p)
  return parent === p ? p : join(realOrSelf(parent), basename(p))
}

// Files of a gate's neighbourhood that sit outside scripts/hooks and scripts/lib (see protectedSet).
const GATE_ADJACENT_SCRIPTS = ['agent-api.sh', 'sync-hooks.sh', 'doctor.sh', 'gate-onfailure-check.py', 'secret-gate.ts']
const GATE_ADJACENT_SOURCES = [['src', 'web', 'hook-registration-guard.ts'], ['src', 'security', 'secret-gate.ts']]

// The protected set of an install. `entries` are real paths (dir: true = the directory and all below);
// `ancestors` are the directories that CONTAIN protected paths (a move/remove of one removes them).
export function protectedSet(opts = {}) {
  const scriptsDir = realOrSelf(opts.scriptsDir ?? DEFAULT_SCRIPTS_DIR)
  const storeDirs = opts.storeDir
    ? [realOrSelf(opts.storeDir)]
    : [...new Set([join(scriptsDir, '..', 'store'), ...(process.env.MARVEEN_STORE_DIR ? [process.env.MARVEEN_STORE_DIR] : [])].map(realOrSelf))]
  const entries = []
  // `lex` is the path as the fixed name spells it (installation root joined with the name), `real` its resolved
  // form: the integrity check must name files the way git does (by name), so a symlink put in place of a gate
  // file or directory is a change there and not a quiet jump to the target
  const add = (path, dir, kind) => entries.push({ real: realOrSelf(path), lex: path, dir, kind })
  for (const s of storeDirs) {
    add(join(s, ALLOWLIST_BASENAME), false, 'egress-allowlist')
    add(join(s, 'egress-allowlist.history'), true, 'egress-allowlist')
    add(join(s, 'egress-vendor-hosts.json'), false, 'egress-allowlist')
    add(join(s, 'egress-vendor-hosts.history'), true, 'egress-allowlist')
    add(join(s, '.egress-allowlist-cache.json'), false, 'egress-allowlist')
  }
  if (opts.allowlistPath) add(opts.allowlistPath, false, 'egress-allowlist')
  for (const f of ['self-pace-gate.mjs', 'email-send-gate.mjs']) add(join(scriptsDir, f), false, 'gate-scripts')
  for (const d of ['hooks', 'lib']) add(join(scriptsDir, d), true, 'gate-scripts')
  // Gate-adjacent files outside hooks/ and lib/: whoever can rewrite them can switch a gate off or act as another
  // agent. agent-api.sh carries every /api call and its token handling; sync-hooks.sh installs the hook registrations;
  // doctor.sh and gate-onfailure-check.py are the fail-closed checkers; secret-gate.ts is the commit-time secret gate.
  for (const f of GATE_ADJACENT_SCRIPTS) add(join(scriptsDir, f), false, 'gate-scripts')
  // hook-registration-guard.ts self-heals the hook registrations; src/security/secret-gate.ts is the secret gate's engine.
  const installRoot = dirname(scriptsDir)
  for (const f of GATE_ADJACENT_SOURCES) add(join(installRoot, ...f), false, 'gate-scripts')
  // Directories that CONTAIN protected paths. Moving, removing or re-linking one removes or replaces
  // them. `strict`: any command that is not a plain read is denied (scripts/ also holds the gates by
  // name). `loose`: only commands that move, remove, link, extract or rewrite (see DESTRUCTIVE), so
  // `cp file store/`, `ls`, `cd` and a script run in the repo root keep working.
  const ancestors = [{ real: scriptsDir, strict: true, kind: 'gate-scripts' }]
  for (const s of storeDirs) ancestors.push({ real: s, strict: false, kind: 'egress-allowlist' })
  const root = dirname(scriptsDir)
  ancestors.push({ real: root, strict: false, kind: 'gate-scripts' })
  // The directories above the protected sources (src, src/web, src/security): moving, removing or re-linking one
  // takes the protected file with it or swaps it for another. Loose, so a plain write to a neighbour keeps working.
  const sourceDirs = new Set()
  for (const f of GATE_ADJACENT_SOURCES) for (let i = 1; i < f.length; i++) sourceDirs.add(join(installRoot, ...f.slice(0, i)))
  for (const d of sourceDirs) ancestors.push({ real: realOrSelf(d), strict: false, kind: 'gate-scripts' })
  // The Claude Code settings files of the sub-agents (and of the install root): a settings.local.json
  // with {"disableAllHooks": true} switches every gate off. Per agent, by PATTERN under agents/ (see
  // agentSettingsKind), because an agent may not exist yet; the root ones are plain entries.
  for (const f of SETTINGS_FILES) add(join(root, '.claude', f), false, 'agent-settings')
  ancestors.push({ real: realOrSelf(join(root, '.claude')), strict: false, kind: 'agent-settings' })
  return { entries, ancestors, scriptsDir, agentsDir: realOrSelf(join(root, 'agents')) }
}
// kind of a REAL path: 'egress-allowlist' | 'gate-scripts' | null. `ancestor` paths only count for
// commands that move or remove things (any command that is not a plain read).
function kindOf(real, prot) {
  // Compared without regard to case, for every entry: a path that does not exist yet keeps the case it is
  // spelled with (the nearest existing ancestor is canonical, the rest is not), and a case-insensitive
  // filesystem opens `Settings.Local.json` or `Store/Egress-Allowlist.json` as the real file. The price
  // on a case-sensitive one is a false deny for a differently-cased sibling name, which is harmless.
  const lc = real.toLowerCase()
  for (const e of prot.entries) {
    const er = e.real.toLowerCase()
    if (e.dir ? (lc === er || lc.startsWith(er + sep)) : lc === er) return e.kind
  }
  return agentSettingsKind(real, prot)
}
const underAgents = (real, prot) => Boolean(prot.agentsDir) && real.toLowerCase().startsWith(prot.agentsDir.toLowerCase() + sep)
// agents/<any name>/{.claude,.claude-config}/settings.json | settings.local.json, as a REAL path under
// THIS install's agents/ directory. A pattern, not a list: an agent that does not exist yet has none.
function agentSettingsKind(real, prot) {
  if (!underAgents(real, prot)) return null
  const rel = real.slice(prot.agentsDir.length + 1).split(sep)
  return rel.length === 3 && AGENT_CONFIG_DIRS.includes(rel[1].toLowerCase()) && SETTINGS_FILES.includes(rel[2].toLowerCase()) ? 'agent-settings' : null
}
// agents/<name>/.claude and agents/<name>/.claude-config: moving, removing or re-linking one (then
// writing through the new link) would walk past the pattern above.
function agentConfigDirKind(real, prot) {
  if (!underAgents(real, prot)) return null
  const rel = real.slice(prot.agentsDir.length + 1).split(sep)
  return rel.length === 2 && AGENT_CONFIG_DIRS.includes(rel[1].toLowerCase()) ? 'agent-settings' : null
}
// agents/ and agents/<name>: a directory that CONTAINS the config dirs. Merging a tree into one (rsync,
// tar -x, cp -r of a source that carries a .claude) would create settings.local.json without naming it.
function agentDirKind(real, prot) {
  if (!prot.agentsDir) return null
  const lc = real.toLowerCase(); const ad = prot.agentsDir.toLowerCase()
  if (lc === ad) return 'agent-settings'
  return lc.startsWith(ad + sep) && lc.slice(ad.length + 1).split(sep).length === 1 ? 'agent-settings' : null
}
// The settings files / config dirs of the agents that exist now (for globs and unresolved prefixes).
function settingsCandidates(prot) {
  if (prot.settingsCache) return prot.settingsCache
  const dirs = []; const files = []
  let names = []
  try { names = readdirSync(prot.agentsDir) } catch { /* no agents/ yet */ }
  for (const n of names) {
    for (const d of AGENT_CONFIG_DIRS) {
      const dir = join(prot.agentsDir, n, d); dirs.push(dir)
      for (const f of SETTINGS_FILES) files.push(join(dir, f))
    }
  }
  return (prot.settingsCache = { dirs, files })
}
// 'anc-strict:<kind>' | 'anc-loose:<kind>' | null
const ancestorOf = (real, prot) => {
  const lc = real.toLowerCase()
  const a = prot.ancestors.find((x) => x.real.toLowerCase() === lc)
  if (a) return `anc-${a.strict ? 'strict' : 'loose'}:${a.kind}`
  const k = agentConfigDirKind(real, prot)
  if (k) return `anc-loose:${k}`
  // agents/ and agents/<name> hold the config dirs but are also where agents are created and arranged:
  // their own flavour, decided by what the operation can actually put into or take out of them
  const d = agentDirKind(real, prot)
  return d ? `anc-agentdir:${d}` : null
}
const isAnc = (k) => typeof k === 'string' && k.startsWith('anc-')

// Does a native file-tool call target a protected path? Returns the kind or null.
export function fileToolProtectedKind(toolInput, prot, cwd = process.cwd()) {
  const raw = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
  if (!raw) return null
  if (basename(raw).toLowerCase() === ALLOWLIST_BASENAME) return 'egress-allowlist'
  return kindOf(realOrSelf(resolve(cwd, expandHome(raw))), prot)
}
// Kept for callers and tests that ask only about the allowlist.
export function fileToolTargetsAllowlist(toolInput, allowlistPath = join(DEFAULT_SCRIPTS_DIR, '..', 'store', ALLOWLIST_BASENAME), cwd = process.cwd()) {
  return fileToolProtectedKind(toolInput, protectedSet({ allowlistPath }), cwd) === 'egress-allowlist'
}

// ---- shell reading ----------------------------------------------------------------------------
// Quote-aware split into simple commands. Separators: newline ; && || | & ( ) and a standalone
// { }. NOT split: inside quotes, inside $( ) <( ) >( ) and backticks (kept in the segment, which
// then denies if it names a protected path), >& &> >| <&. A heredoc body is not parsed for quotes:
// each body line becomes a segment of its own. `unterminated` = a quote or $( never closed.
// `grouped` = the STRUCTURE has a subshell, a group or a brace group: an unquoted, unescaped ( ) or standalone { } outside
// every substitution (a parenthesis in quotes or in a $( ) is text or a command of its own). A heredoc body line counts as
// a command line, as it is judged as one.
export function splitShell(command) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  const segs = []; const seps = []; let cur = ''; let i = 0; let depth = 0; let q = null; let unterminated = false; let grouped = false
  const pending = []
  const push = (s = '') => { if (cur.trim()) { segs.push(cur); seps.push(s) } cur = '' }
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (q) {
      cur += c
      if (c === '\\' && q === '"' && i + 1 < n) { cur += src[i + 1]; i += 2; continue }
      if (c === q) q = null
      i++; continue
    }
    if (c === '\\' && i + 1 < n) { cur += c + src[i + 1]; i += 2; continue }
    if (c === "'" || c === '"') { q = c; cur += c; i++; continue }
    if (c === '`') {
      const e = src.indexOf('`', i + 1)
      if (e === -1) { unterminated = true; cur += src.slice(i); i = n; continue }
      cur += src.slice(i, e + 1); i = e + 1; continue
    }
    if ((c === '$' || c === '<' || c === '>') && src[i + 1] === '(') { depth++; cur += c + '('; i += 2; continue }
    if (depth > 0) { if (c === '(') depth++; else if (c === ')') depth--; cur += c; i++; continue }
    const here = c === '<' && src[i + 1] === '<' && src[i + 2] !== '<' ? /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(src.slice(i)) : null
    if (here) { pending.push(here[1] ?? here[2] ?? here[3]); cur += here[0]; i += here[0].length; continue }
    if (c === '\n') {
      push(); i++
      while (pending.length) { // heredoc bodies: lines up to the terminator, each its own segment
        const tag = pending.shift()
        for (;;) {
          if (i >= n) break
          let e = src.indexOf('\n', i); if (e === -1) e = n
          const line = src.slice(i, e); i = Math.min(e + 1, n)
          if (line.trim() === tag) break
          if (line.trim()) { segs.push(line); seps.push('\n'); if (!grouped && splitShell(line).grouped) grouped = true }
        }
      }
      continue
    }
    if (c === ';') { push(';'); i++; continue }
    if (c === '&') {
      if (src[i + 1] === '&') { push('&&'); i += 2; continue }
      if (src[i - 1] === '>' || src[i - 1] === '<' || src[i + 1] === '>') { cur += c; i++; continue }
      push('&'); i++; continue
    }
    if (c === '|') {
      if (src[i - 1] === '>') { cur += c; i++; continue }
      const two = src[i + 1] === '|'
      push(two ? '||' : '|'); i += two || src[i + 1] === '&' ? 2 : 1; continue
    }
    if (c === '(' || c === ')') { grouped = true; push(); i++; continue }
    if ((c === '{' || c === '}') && (i === 0 || /\s/.test(src[i - 1])) && (i + 1 >= n || /\s/.test(src[i + 1]))) { grouped = true; push(); i++; continue }
    cur += c; i++
  }
  if (q || depth > 0) unterminated = true
  push()
  return { segs, seps, unterminated, grouped }
}
// The text of every OUTERMOST command or process substitution in a command: $( ), <( ), >( ) (balanced, quote-aware, a $( ) in
// double quotes counts) and `...`. A nested one sits inside the text of its outer one and is found when that text is judged.
// An unclosed one runs to the end of the command. Bounded: a nesting deeper than SUBST_NEST_MAX takes the rest as its text.
const SUBST_NEST_MAX = 64
function substitutionTexts(command) {
  const s = String(command ?? ''); const n = s.length; const out = []
  let close // forward: close <-> skipDouble
  // the index after a double-quoted string that starts at i (a $( ) or a backtick inside it is live)
  const skipDouble = (i, nest) => {
    i++
    while (i < n && s[i] !== '"') {
      if (s[i] === '\\') { i += 2; continue }
      if (s[i] === '$' && s[i + 1] === '(') { i = close(i + 1, nest + 1) + 1; continue }
      if (s[i] === '`') { const e = s.indexOf('`', i + 1); i = e === -1 ? n : e + 1; continue }
      i++
    }
    return i + 1
  }
  // the index of the ")" that closes the "(" at `open`; n when it never closes
  close = (open, nest) => {
    if (nest > SUBST_NEST_MAX) return n
    let depth = 1; let i = open + 1
    while (i < n) {
      const c = s[i]
      if (c === '\\') { i += 2; continue }
      if (c === "'") { const e = s.indexOf("'", i + 1); i = e === -1 ? n : e + 1; continue }
      if (c === '"') { i = skipDouble(i, nest); continue }
      if (c === '`') { const e = s.indexOf('`', i + 1); i = e === -1 ? n : e + 1; continue }
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) return i
      i++
    }
    return n
  }
  let inDouble = false
  for (let i = 0; i < n;) {
    const c = s[i]
    if (c === '\\') { i += 2; continue }
    if (c === "'" && !inDouble) { const e = s.indexOf("'", i + 1); i = e === -1 ? n : e + 1; continue }
    if (c === '"') { inDouble = !inDouble; i++; continue }
    if (c === '`') { const e = s.indexOf('`', i + 1); out.push(s.slice(i + 1, e === -1 ? n : e)); i = e === -1 ? n : e + 1; continue }
    if (s[i + 1] === '(' && (c === '$' || (!inDouble && (c === '<' || c === '>')))) {
      const e = close(i + 1, 0); out.push(s.slice(i + 2, e)); i = e + 1; continue
    }
    i++
  }
  return out
}
// Words and redirect targets of one simple command, unquoted and unescaped. `hasRedirect` = any
// redirect operator at all (including fd duplication and input).
// A word with a part the parser cannot read (a command substitution after a literal head, an ANSI-C string it cannot
// decode) carries this marker where the unreadable part starts: the text in front of it is the literal HEAD of the word,
// the text behind it is the raw unreadable part. wordKind judges such a word by its head (see dynamicHeadKind).
// A private-use code point: no shell word spells it, and PATH_JUNK in wordKind treats it as junk.
export const DYN = ''
// bounds of the balanced scan of a substitution: past either one the word is flagged and the rest is read as before
const MAX_DYN_LEN = 8192
const MAX_DYN_DEPTH = 64
// The end (exclusive) of the substitution that starts at seg[i] (`$(` or a backtick), or -1 when it is not closed or a bound
// is passed. One linear pass; quote-, escape- and nesting-aware.
function skipDynamic(seg, i) {
  const n = Math.min(seg.length, i + MAX_DYN_LEN)
  if (seg[i] === '`') {
    for (let j = i + 1; j < n; j++) { if (seg[j] === '\\') j++; else if (seg[j] === '`') return j + 1 }
    return -1
  }
  let depth = 1
  for (let j = i + 2; j < n; j++) {
    const c = seg[j]
    if (c === '\\') { j++; continue }
    if (c === "'") { const e = seg.indexOf("'", j + 1); if (e === -1 || e >= n) return -1; j = e; continue }
    if (c === '"') { let k = j + 1; while (k < n && seg[k] !== '"') { if (seg[k] === '\\') k++; k++ } if (k >= n) return -1; j = k; continue }
    if (c === '`') { const e = skipDynamic(seg, j); if (e === -1) return -1; j = e - 1; continue }
    if (c === '(') { if (++depth > MAX_DYN_DEPTH) return -1 }
    else if (c === ')' && --depth === 0) return j + 1
  }
  return -1
}
// The ANSI-C string $'...' whose body starts at seg[i]: { text, end, ok }. `end` is the index after the closing quote (the end of
// the segment when it is not closed). ok=false when the string cannot be decoded to the text bash would build: an unterminated
// string, a NUL (bash cuts the string there), an escape this does not know, a byte above 0x7f (not text), a code point out of range.
function readAnsiC(seg, i) {
  const n = seg.length
  let text = ''; let ok = true; let j = i
  const SIMPLE = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
  const take = (re, max, radix) => { let k = 0; let v = 0; while (k < max && j + k < n && re.test(seg[j + k])) { v = v * radix + parseInt(seg[j + k], radix); k++ } return { v, k } }
  while (j < n && seg[j] !== "'") {
    if (seg[j] !== '\\') { text += seg[j]; j++; continue }
    const e = seg[j + 1]
    if (e === undefined) { ok = false; j = n; break }
    if (e in SIMPLE) { text += SIMPLE[e]; j += 2; continue }
    j += 2
    let v = null
    if (/[0-7]/.test(e)) { j--; const r = take(/[0-7]/, 3, 8); j += r.k; v = r.v }
    else if (e === 'x') { const r = take(/[0-9a-fA-F]/, 2, 16); if (r.k) { j += r.k; v = r.v } }
    else if (e === 'u' || e === 'U') { const r = take(/[0-9a-fA-F]/, e === 'u' ? 4 : 8, 16); if (r.k) { j += r.k; v = r.v; if (v > 0x10ffff || (v >= 0xd800 && v < 0xe000)) v = null; else if (v > 0x7f) { text += String.fromCodePoint(v); continue } } }
    else if (e === 'c' && j < n) { v = seg.charCodeAt(j) & 0x1f; j++ }
    if (v === null || v === 0 || v > 0x7f) ok = false
    else text += String.fromCharCode(v)
  }
  if (j >= n) return { text, end: n, ok: false }
  return { text, end: j + 1, ok }
}
export function tokenizeShell(seg) {
  const words = []; const redirects = []; let hasRedirect = false; let i = 0
  const n = seg.length
  const readWord = () => {
    while (i < n && /\s/.test(seg[i])) i++
    let cur = ''; let any = false
    while (i < n) {
      const c = seg[i]
      if (/\s/.test(c) || c === '>' || c === '<' || c === '|' || c === ';' || c === '&' || c === '(' || c === ')') break
      if (c === "'") { const e = seg.indexOf("'", i + 1); const end = e === -1 ? n : e; cur += seg.slice(i + 1, end); i = end + 1; any = true; continue }
      // $'...' is an ANSI-C string: the word is what bash builds from it (escapes decoded); one it cannot decode is unreadable
      if (c === '$' && seg[i + 1] === "'") {
        const a = readAnsiC(seg, i + 2)
        cur += a.ok ? a.text : DYN + seg.slice(i, a.end); i = a.end; any = true; continue
      }
      if (c === '$' && seg[i + 1] === '"') { i++; continue } // $"..." is a double-quoted string (the locale lookup changes nothing here)
      // a command substitution behind a literal head (`<dir>/$(echo x)`, `a/`echo x``) is ONE unreadable word, read to its balanced end
      // (the marker comes AFTER the `$` of `$(`, and in front of a backtick: the piece in front of it reads `head$` / `head`, as it did
      // when the word was cut here, so a rule that looked at that piece looks at the same one)
      if (cur !== '' && ((c === '$' && seg[i + 1] === '(') || c === '`')) {
        const e = skipDynamic(seg, i)
        const sub = c === '$' ? '$' + DYN : DYN
        const from = c === '$' ? i + 1 : i
        if (e !== -1) { cur += sub + seg.slice(from, e); i = e; any = true; continue }
        // unbalanced or past a bound: flagged, the rest is read as before
        if (c === '$') { cur += sub; i++; any = true; continue }
        cur += DYN
      }
      if (c === '"') {
        let j = i + 1
        while (j < n && seg[j] !== '"') {
          if (seg[j] === '\\' && j + 1 < n) { cur += seg[j + 1]; j += 2; continue }
          if (cur !== '' && ((seg[j] === '$' && seg[j + 1] === '(') || seg[j] === '`')) {
            const e = skipDynamic(seg, j)
            const dollar = seg[j] === '$'
            if (e !== -1) { cur += (dollar ? '$' + DYN : DYN) + seg.slice(dollar ? j + 1 : j, e); j = e; continue }
            if (dollar) { cur += '$' + DYN; j++; continue }
            cur += DYN
          }
          cur += seg[j]; j++
        }
        i = j + 1; any = true; continue
      }
      if (c === '\\' && i + 1 < n) { cur += seg[i + 1]; i += 2; any = true; continue }
      cur += c; i++; any = true
    }
    return any ? cur : null
  }
  while (i < n) {
    if (/\s/.test(seg[i])) { i++; continue }
    const m = /^(\d*)(&>>|&>|>>|>\||>&|>|<>|<<<|<<-|<<|<&|<)/.exec(seg.slice(i))
    if (m) {
      hasRedirect = true; i += m[0].length
      const op = m[2]
      const target = readWord()
      if (target === null) continue
      if (op === '<' || op === '<&' || op === '<<' || op === '<<-' || op === '<<<') continue // input / heredoc: not a write
      if (op === '>&' && /^(\d+|-)$/.test(target)) continue // fd duplication
      redirects.push(target)
      continue
    }
    if (/[|;&()]/.test(seg[i])) { i++; continue }
    const w = readWord()
    if (w !== null) words.push(w)
    else i++
  }
  return { words, redirects, hasRedirect }
}
function expandBraces(tok, cap = 256) {
  const m = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/s.exec(tok)
  if (!m) return [tok]
  const out = []
  for (const alt of m[2].split(',')) {
    for (const rest of expandBraces(m[1] + alt + m[3], cap)) { out.push(rest); if (out.length >= cap) return out }
  }
  return out
}
function collectVars(command) {
  const vars = {}; let read = 0
  // (a value spelled $'..' or $".." is the text the shell builds from it, like the same word in a path: `D=$'doctor.sh'` is `D=doctor.sh`;
  // one that cannot be decoded stays unset)
  for (const m of String(command).matchAll(/(?:^|[\s;&|(])(?:export\s+|local\s+|declare\s+)?([A-Za-z_]\w*)=("([^"]*)"|'([^']*)'|\$'((?:[^'\\]|\\.)*)'|\$"([^"]*)"|[^\s;&|()]*)/g)) {
    // a value the parser cannot read is UNREADABLE (the DYN marker: a word that uses it is judged by its literal head, see wordKind), not
    // unset: bash cuts a $'..' value at a NUL and joins a quoted piece with the characters that follow it (`D=$'doc'tor.sh` is
    // `doctor.sh`), so neither a value this decoder refuses nor a quoted piece that the word goes on after is the text the regex took
    // (the value word is read by the tokenizer itself: pieces joined as the shell joins them, $'..' decoded, a piece it cannot decode
    // is an unreadable word that carries the marker; bounded in size and in number, past a bound the value is the marker alone)
    const next = String(command)[m.index + m[0].length]
    const goesOn = next !== undefined && !/[\s;&|()]/.test(next)
    const quoted = m[3] !== undefined || m[4] !== undefined || m[5] !== undefined || m[6] !== undefined
    if (quoted && (goesOn || m[5] !== undefined)) {
      const rest = String(command).slice(m.index + m[0].length - m[2].length, m.index + m[0].length - m[2].length + 2048)
      const word = ++read > 64 || rest.length >= 2048 ? undefined : tokenizeShell(rest).words[0]
      vars[m[1]] = word === undefined ? DYN : word
      continue
    }
    vars[m[1]] = m[3] ?? m[4] ?? m[6] ?? m[2]
  }
  return vars
}
function expandWord(w, vars, cwd) {
  let s = w
  if (s === '~' || s.startsWith('~/')) s = homedir() + s.slice(1)
  const table = { ...vars, HOME: homedir(), PWD: cwd }
  for (let k = 0; k < 3; k++) {
    s = s.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (all, a, b) => (table[a ?? b] ?? all))
  }
  return s
}
// The index of the ] that closes the glob class opened at abs[i]; -1 when it is not closed; -2 when the
// scan budget of this word ran out (see globToRegex). `tails` holds the last index of each POSIX class
// closer (":]", "=]", ".]"), so a "[:" with no closer after it costs nothing to rule out.
function globClassEnd(abs, i, tails, meter) {
  let j = i + 1
  if (abs[j] === '!' || abs[j] === '^') j++
  if (abs[j] === ']') j++ // a ] right after the [ (or its negation) is a member, not the end
  for (; j < abs.length; j++) {
    if (--meter.left < 0) return -2
    const c = abs[j]
    if (c === '\\') j++ // an escaped character is a member
    else if (c === '[' && abs[j + 1] !== undefined && ':=.'.includes(abs[j + 1]) && tails[abs[j + 1]] >= j + 2) {
      const close = abs.indexOf(abs[j + 1] + ']', j + 2) // [:alpha:] [=a=] [.-.] sit inside the class
      meter.left -= close - j
      j = close + 1
    } else if (c === ']') return j
  }
  return -1
}
// The regex source of a glob bracket class body (the text between [ and ]). The leading ! or ^ of the glob
// negates; a backslash makes the next character a plain member (as in bash); an unescaped dash between two
// members is a range. An out-of-order range (z-a) is read with its ends swapped: the gate over-matches what a
// shell would call an empty range, it never matches less. A class RegExp still refuses falls back to any one
// non-slash character, which also over-matches. Neither path throws.
function globClass(body) {
  // A POSIX class, an equivalence class or a collating symbol: not modelled, matches any one character.
  if (/\[[:=.]/.test(body)) return '[^/]'
  const neg = body[0] === '!' || body[0] === '^'
  const chars = []
  for (let i = neg ? 1 : 0; i < body.length; i++) {
    if (body[i] === '\\' && i + 1 < body.length) chars.push({ c: body[++i], lit: true })
    else chars.push({ c: body[i], lit: false })
  }
  const esc = (c) => c.replace(/[\\[\]^-]/g, '\\$&')
  let inner = ''
  for (let i = 0; i < chars.length; i++) {
    const isRange = i + 2 < chars.length && !chars[i + 1].lit && chars[i + 1].c === '-'
    if (isRange) {
      const lo = chars[i].c, hi = chars[i + 2].c
      // A reversed range is swapped in a plain class (it matches more) and dropped in a negated one: there it
      // is an empty exclusion, and swapping it would exclude more characters, i.e. match less than a shell.
      if (lo <= hi) inner += esc(lo) + '-' + esc(hi)
      else if (!neg) inner += esc(hi) + '-' + esc(lo)
      i += 2
    } else inner += esc(chars[i].c)
  }
  if (!inner) return neg ? '[^/]' : null // a negated class that excludes nothing matches any one character
  const src = '[' + (neg ? '^' : '') + inner + ']'
  try { new RegExp(src); return src } catch { return '[^/]' }
}
// At most this many separate unbounded wildcards of one word are expanded, the rest of the word matches
// anything: separated by literals they still backtrack polynomially (a*a*a*..b on a name of a's), so the
// degree is kept small. Protected names are short, a real glob rarely has more.
const MAX_GLOB_STARS = 4
// A word longer than this cannot be inspected (RegExp refuses a pattern far above it, "Regular expression too
// large"); no path is this long, but the gate does not rely on that: it matches everything, so a protected
// path behind it is denied, the same fail-closed answer the size caps of the sibling gates give.
const MAX_GLOB_WORD = 32768
function globToRegex(abs) {
  // Bash reads a run of stars as one (** is the same as *, here a star that may cross a slash), so the run is
  // folded BEFORE the length check: a word padded with stars to any length is still read exactly.
  abs = abs.replace(/\*{2,}/g, '**')
  if (abs.length > MAX_GLOB_WORD) return /^.*$/
  // Bounds, so that no word can make the gate slow or make RegExp throw (a block under onFailure:block):
  //  - one scan budget for the whole word: a class that never closes does not rescan the rest per bracket
  //    (lastClose rules most of them out in O(1)); when the budget runs out the rest of the word is
  //    over-matched, never skipped;
  //  - a run of stars is one star, and at most MAX_GLOB_STARS stars are expanded: the rest matches anything.
  //    Adjacent stars make a backtracking RegExp explode, thousands of them overflow its stack.
  const lastClose = abs.lastIndexOf(']')
  const tails = { ':': abs.lastIndexOf(':]'), '=': abs.lastIndexOf('=]'), '.': abs.lastIndexOf('.]') }
  const meter = { left: 4 * abs.length + 256 }
  let out = '^'
  let stars = 0
  let spent = false
  // A run of adjacent wildcards (*, ?, a widened class) is ONE quantified unit: [^/]{min,} (or .{min,} when a
  // ** is in it). Chained, they make a backtracking RegExp explode (eight [^/]* against a 50-character name
  // take ~9 s); as one unit they cost nothing.
  let run = null
  const flush = () => {
    if (!run) return
    const any = run.wide ? '.' : '[^/]'
    out += run.unbounded ? `${any}{${run.min},}` : `${any}{${run.min}}`
    run = null
  }
  for (let i = 0; i < abs.length; i++) {
    const c = abs[i]
    let star = null
    let piece = null
    if (c === '*') { if (abs[i + 1] === '*') { star = '.*'; i++ } else star = '[^/]*' }
    else if (c === '?') piece = '[^/]'
    else if (c === '[') {
      const e = i < lastClose ? globClassEnd(abs, i, tails, meter) : -1
      if (e === -2) { star = '.*'; spent = true }
      else {
        const cls = e === -1 ? null : globClass(abs.slice(i + 1, e))
        // An unclosed bracket is literal text, as in bash. A closed one always yields a class: the gate must
        // reach a decision, never throw out of a Bash call.
        if (cls) {
          // A stray ] straight after the class (before any further [) means the quoting that was removed before
          // this point may have hidden an escaped ] inside it: the structure is ambiguous, so everything up to
          // that ] matches any run of non-slash characters. It over-matches, it never matches less.
          const stray = /^[^[\]]*\]/.exec(abs.slice(e + 1))
          if (stray) { star = '[^/]*'; i = e + stray[0].length } else { piece = cls; i = e }
        } else piece = '\\['
      }
    }
    else piece = c.replace(/[.+^${}()|\\]/g, '\\$&')
    if (star === null && piece !== '[^/]') { flush(); out += piece; continue }
    run ??= { min: 0, unbounded: false, wide: false }
    if (star === null) { run.min++; continue } // a ? is one character of the run
    if (spent || (!run.unbounded && ++stars > MAX_GLOB_STARS)) { run.unbounded = true; run.wide = true; flush(); break }
    run.unbounded = true
    if (star === '.*') run.wide = true
  }
  flush()
  return new RegExp(out + '$')
}
function listDir(dir, ctx, depth = 0, out = []) {
  if (depth === 0 && ctx.cache.has(dir)) return ctx.cache.get(dir)
  if (depth > 3 || out.length > 2000) return out
  let names = []
  try { names = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const d of names) {
    const p = join(dir, d.name); out.push(p)
    if (d.isDirectory()) listDir(p, ctx, depth + 1, out)
  }
  if (depth === 0) ctx.cache.set(dir, out)
  return out
}

// The context of one Bash command: every cwd a word may be relative to, the assigned variables, and
// whether a `cd` went somewhere unknowable.
function makeContext(command, cwd, prot) {
  return { cwds: new Set([resolve(cwd)]), current: resolve(cwd), vars: collectVars(command), unknownCwd: false, prot, listing: null, cache: new Map() }
}
// A call of the fleet API wrapper (scripts/agent-api.sh, the protected file, run directly or as the script of a shell) carries its
// JSON body in a single-quoted argument: data for the script, not a command and not a path. The words of a quoted command line are
// read piece by piece (see wordKind), so a protected path, a pipe or a $( ) inside that body made the call look like a write.
// Returns the segment with the BODY word (the third positional after the wrapper, past its options) replaced by 'x' when it is only
// single-quoted spans. Narrow on purpose: nothing at all when the segment has a live substitution ($( ), backtick, <( ), >( ): the
// code in it runs, whatever words it holds), not for any other command, not for a word that follows a redirect operator (`> '...'` is a target, not data), not for a word that has anything
// attached to its quotes (`>""'...'`, `--out='...'`), never a double-quoted span (a live $( ) there stays), and an unclosed quote
// is left as it is.
// (a command that defines a function or an alias, or moves PATH / BASH_ENV / ENV, may have given `bash` or the wrapper another
// meaning: no masking; the same for a group or a shell keyword in the command, which is where a function body sits)
const SHADOW_RX = /\balias\b|expand_aliases|\benable\b|\bhash\b|\bBASH_ENV\b|\bBASH_FUNC|\b(?:PATH|ENV|IFS)\s*=|\bPS4\b|\bSHELLOPTS\b|\bBASHOPTS\b|\bBASH_XTRACEFD\b|\bPROMPT_COMMAND\b/
const SYSTEM_SHELL_RX = /^\/(?:usr\/(?:local\/)?|opt\/homebrew\/)?bin\/(?:bash|sh|zsh|dash)$/
function maskApiBody(seg, ctx, whole, compound) {
  if (compound || SHADOW_RX.test(whole)) return seg
  // (a newline inside the segment means a quote spans lines: after a comment (`# '`) the splitter's quote state is not the shell's,
  // so the text of a later command line could sit inside a span this would mask. Such a segment is left as it is.)
  if (!seg.includes("'") || /[\r\n]/.test(seg)) return seg
  const w = spliceEnvSplit(tokenizeShell(seg).words)
  const ci = commandWordIndex(w)
  // (anything in front of the command word - a NAME=value setting, env, nice - can change what the shell does with the call: PS4 with
  // -x runs code, SHELLOPTS turns xtrace on: no masking then)
  if (ci !== 0) return seg
  const cmd = w[ci].split('/').pop()
  let k = -1
  if (cmd === 'agent-api.sh') k = ci
  else if (/^(?:bash|sh|zsh|dash)$/.test(cmd) && (!w[ci].includes('/') || SYSTEM_SHELL_RX.test(w[ci]))) {
    // between the shell and the wrapper only flags that change nothing about WHAT the shell runs (-e -u -x -v, alone or bundled):
    // -c / -s / -i (inline code, a script from stdin, an interactive shell: the wrapper path is then only a positional parameter),
    // -o / -O / +O with a value, --rcfile, --init-file and any option this does not know leave the segment as it is
    for (let j = ci + 1; j < w.length; j++) {
      if (/^-[euv]+$/.test(w[j])) continue // (no x: with xtrace a PS4 runs code)
      if (w[j].startsWith('-') && w[j].length > 1) return seg
      k = j; break
    }
  }
  // (the wrapper is named by a path: a bare name is looked up in PATH, not in the directory the parser resolved it in)
  if (k === -1 || !w[k].includes('/') || w[k].split('/').pop() !== 'agent-api.sh' || wordKind(w[k], ctx) !== 'gate-scripts') return seg
  const apiWord = w[k]
  const n = seg.length
  let out = ''; let i = 0; let seen = false; let raw = ''; let word = ''; let last = ''
  let live = false // an unquoted (or double-quoted) $( ), backtick, <( ) or >( ): code that runs, whatever sits in its words
  let pos = 0; let optsDone = false; let skipNext = false
  // The wrapper's own arguments: [--agent X] [--token X] [--max-time X] [--with-status] [--] METHOD PATH [BODY]. Only the BODY, the
  // third positional word, is data; a quoted word anywhere else (the method, the path, a fourth word) stays as it is.
  // A WORD (a run up to unquoted whitespace) is masked only when it is made of single-quoted spans and escaped quotes and nothing
  // else (`'{...}'`, `'it'\''s'`): a word that has anything attached to the quotes (`>''"'p'"`, `>""'p'`, `--out='p'`, `$'p'`) is
  // kept whole, so a redirect target built from several quoted pieces cannot be cut in the middle. `last` is the last character
  // before the word: after a redirect operator (`> '...'`, `>& '...'`, `>| '...'`) the word is a target, not a body.
  const flush = () => {
    if (raw === '') return
    let mask = false
    if (!seen) { if (word === apiWord) seen = true } else {
      let positional = true
      if (skipNext) { skipNext = false; positional = false } else if (!optsDone) {
        if (/^--(?:agent|token|max-time)$/.test(word)) { skipNext = true; positional = false } else if (word === '--with-status') positional = false
        else if (word === '--') { optsDone = true; positional = false } else optsDone = true
      }
      if (positional && ++pos === 3 && raw.includes("'") && /^(?:'[^']*'|\\')+$/.test(raw) && !/[<>|&]/.test(last)) mask = true
    }
    out += mask ? "'x'" : raw
    last = raw[raw.length - 1]
    raw = ''; word = ''
  }
  while (i < n) {
    const c = seg[i]
    if (c === '\\' && i + 1 < n) { raw += c + seg[i + 1]; word += seg[i + 1]; i += 2; continue }
    if (c === '"') {
      let j = i + 1; let inner = ''
      while (j < n && seg[j] !== '"') { if (seg[j] === '\\' && j + 1 < n) { inner += seg[j + 1]; j += 2 } else { inner += seg[j]; j++ } }
      if (/\$\(|`/.test(inner)) live = true
      raw += seg.slice(i, j + 1); word += inner; i = j + 1; continue
    }
    if (c === "'") {
      const e = seg.indexOf("'", i + 1)
      if (e === -1) { raw += seg.slice(i); word += seg.slice(i + 1); i = n; continue }
      raw += seg.slice(i, e + 1); word += seg.slice(i + 1, e); i = e + 1; continue
    }
    if (c === '`' || (seg[i + 1] === '(' && (c === '$' || c === '<' || c === '>'))) live = true
    if (/\s/.test(c)) { flush(); out += c; i++; continue }
    raw += c; word += c; i++
  }
  flush()
  return live ? seg : out
}
function protectedBasenames(ctx) {
  if (ctx.listing) return ctx.listing
  const set = new Map()
  for (const e of ctx.prot.entries) {
    if (e.kind === 'agent-settings') continue // settings.json is too common a name to match after an unknown cd
    set.set(basename(e.real), e.kind)
    if (e.dir) for (const p of listDir(e.real, ctx)) set.set(basename(p), e.kind)
  }
  return (ctx.listing = set)
}
// The kind of a word with an unreadable part (see DYN): judged by its literal HEAD, because what the unreadable part builds is not known.
// A head that names a protected path, a directory that holds protected paths (the gate scripts directory, the store, the install root),
// or the directory a name started by the head would land in, counts as that protected kind: `<install>/scripts/$(echo x)` may be any
// file in the scripts directory. A head in the agent directories, a glob, a head with an unresolved variable, or a word with no head
// at all (the marker comes first) is not judged here: that is the reading the word had before the marker existed.
function dynamicHeadKind(part, ctx) {
  // (the `$` in front of the marker belongs to the substitution; an assignment `at=$(date)` has the value as its head)
  const head = part.slice(0, part.indexOf(DYN)).replace(/\$$/, '').replace(/^[A-Za-z_]\w*=/, '')
  if (!head || /[*?[]/.test(head)) return null
  let anc = null
  for (const cwd of ctx.cwds) {
    const w = expandWord(head, ctx.vars, cwd)
    if (!w || w.includes('$') || w.includes(DYN)) continue
    const abs = isAbsolute(w) ? w : join(cwd, w)
    const dir = w.endsWith('/') ? abs : dirname(abs)
    for (const p of [abs, dir]) {
      const real = realOrSelf(p)
      const k = kindOf(real, ctx.prot)
      if (k) return k
      const a = ancestorOf(real, ctx.prot)
      // a bare name (no slash) lands in the working directory: only the strict ancestor (the gate scripts directory itself) counts
      // for it, the loose ones (the install root, the store) are where every command runs and would refuse `x$(date)` there
      if (a && !a.startsWith('anc-agentdir') && (head.includes('/') || a.startsWith('anc-strict'))) anc ??= a.split(':')[1]
    }
  }
  return anc
}
// kind of ONE shell word ('egress-allowlist' | 'gate-scripts' | null); a directory that holds protected paths gives 'anc-strict:<kind>' or 'anc-loose:<kind>'.
function wordKind(word, ctx) {
  const results = []
  // A word that is not a plain path (inline code, a quoted command line) is also read piece by piece.
  const PATH_JUNK = /[^\w./~$@+\-*?[\]{},=:%#!^]+/
  const candidates = PATH_JUNK.test(word) || /^[^{]*,/.test(word)
    ? [word, ...word.split(PATH_JUNK).filter(Boolean), ...word.split(/[^\w./~$@+\-*?[\]{}=:%#!^]+/).filter(Boolean)]
    : [word]
  for (const alt of candidates.flatMap((c) => expandBraces(c))) {
    let stripped = alt
    if (stripped.startsWith('-') && !stripped.includes('=')) {
      // an option has no path in it, except one with its value attached: -oPATH
      if (!/^-[A-Za-z]./.test(stripped)) continue
      stripped = stripped.slice(2)
    }
    if (ALLOWLIST_MENTION_RX.test(stripped)) { results.push('egress-allowlist'); continue }
    const parts = [stripped]
    const eq = stripped.indexOf('=')
    if (eq > 0 && eq < stripped.length - 1) parts.push(stripped.slice(eq + 1)) // of=PATH, --out=PATH
    for (const part of parts) {
      if (part.includes(DYN)) { const dk = dynamicHeadKind(part, ctx); if (dk) results.push(dk); continue }
      for (const cwd of ctx.cwds) {
        let w = expandWord(part, ctx.vars, cwd)
        if (!w) continue
        // a variable whose value cannot be read (see collectVars) put the marker into the word: judged by its literal head, and when the
        // head names nothing it is an unresolved variable like any other (the tail is matched as a suffix of the protected paths below)
        if (w.includes(DYN)) {
          const dk = dynamicHeadKind(w, ctx)
          if (dk) { results.push(dk); continue }
          // (the unreadable piece is the raw text of what it was, up to the next slash: the tail from that slash on is what is matched)
          const cut = w.indexOf('/', w.lastIndexOf(DYN))
          w = cut === -1 ? '$__dyn' : `$__dyn${w.slice(cut)}`
        }
        if (/[*?[]/.test(w)) {
          const abs = isAbsolute(w) ? w : join(cwd, w)
          const firstGlob = abs.search(/[*?[]/)
          const dirPrefix = abs.slice(0, abs.lastIndexOf('/', firstGlob) + 1) || '/'
          const re = globToRegex(join(realOrSelf(dirPrefix), abs.slice(dirPrefix.length)))
          for (const e of ctx.prot.entries) {
            const hits = [e.real, ...(e.dir ? listDir(e.real, ctx) : [])]
            if (hits.some((p) => re.test(p))) { results.push(e.kind); break }
          }
          const ga = ctx.prot.ancestors.find((a) => re.test(a.real))
          if (ga) results.push(ancestorOf(ga.real, ctx.prot))
          const sc = settingsCandidates(ctx.prot)
          const rei = new RegExp(re.source, 'i')
          if (sc.files.some((f) => rei.test(f))) results.push('agent-settings')
          const sd = sc.dirs.find((d) => rei.test(d))
          if (sd) results.push(ancestorOf(sd, ctx.prot))
          continue
        }
        if (w.includes('$')) {
          // an unresolved variable in front of a literal tail (`$WT/scripts/hooks/x.mjs`): the tail
          // is matched as a SUFFIX of the protected paths, two path segments at least.
          const vm = [...w.matchAll(/\$\{?[A-Za-z_]\w*\}?/g)].pop()
          const tail = vm ? w.slice(vm.index + vm[0].length) : ''
          if ((tail.match(/\//g) ?? []).length >= 2) {
            if (settingsCandidates(ctx.prot).files.some((f) => f.toLowerCase().endsWith(tail.toLowerCase()))) results.push('agent-settings')
            for (const e of ctx.prot.entries) {
              if (e.real.endsWith(tail) || (e.dir && listDir(e.real, ctx).some((pth) => pth.endsWith(tail)))) { results.push(e.kind); break }
            }
          }
          continue
        }
        const real = realOrSelf(isAbsolute(w) ? w : join(cwd, w))
        const k = kindOf(real, ctx.prot)
        if (k) results.push(k)
        else { const an = ancestorOf(real, ctx.prot); if (an) results.push(an) }
      }
      if (ctx.unknownCwd && !part.includes('/') && protectedBasenames(ctx).has(part)) results.push(protectedBasenames(ctx).get(part))
    }
  }
  const first = results.find((k) => !isAnc(k))
  return first ?? results.find((k) => k.startsWith('anc-strict')) ?? results.find(isAnc) ?? null
}
// `env -S "cmd args"` / `env --split-string=...` hands ONE word to env, which splits it and runs it: the
// value is spliced into the word list as the words it becomes, so the rest of the gate reads the command
// that really runs (the same reading as skipWrapper in hooks/bash-egress-parser.mjs). Other options of env
// (-i, -u NAME, -C DIR ...) stay in front of the spliced words.
const ENV_VALUE_OPTS = new Set(['-u', '-C', '-P', '--unset', '--chdir', '--default-signal', '--ignore-signal', '--block-signal'])
export function spliceEnvSplit(words, depth = 0) {
  if (depth > 4) return words
  let k = 0
  for (;;) {
    const w = words[k]
    if (w === undefined) return words
    if (/^[A-Za-z_]\w*=/.test(w)) { k++; continue }
    const base = w.split('/').pop()
    if (!WRAPPER_WORDS.has(base)) return words
    k++
    if (base !== 'env') { while (k < words.length && words[k].startsWith('-')) k++; continue }
    while (k < words.length && words[k].startsWith('-') && words[k] !== '-') {
      const o = words[k]
      if (o === '--') { k++; break }
      let value = null; let used = 1
      if (o === '--split-string') { value = words[k + 1] ?? ''; used = 2 }
      else if (o.startsWith('--split-string=')) value = o.slice('--split-string='.length)
      else if (!o.startsWith('--') && /^-[A-Za-z]*S/.test(o)) {
        const attached = o.slice(o.indexOf('S') + 1)
        if (attached) value = attached; else { value = words[k + 1] ?? ''; used = 2 }
      } else if (ENV_VALUE_OPTS.has(o)) used = 2
      if (value !== null) {
        // (the value is text that is read again: the marker of a substitution behind a literal head is not part of it, see shellScriptTexts)
        const spliced = [...words.slice(0, k), ...tokenizeShell(value.replaceAll(DYN, '')).words, ...words.slice(k + used)]
        return spliceEnvSplit(spliced, depth + 1)
      }
      k += used
    }
  }
}

// ---- agents/ and agents/<name>: what an operation can put into them ------------------------------------
// The directories themselves are not protected, only the settings files below their config dirs. So
// mkdir -p agents/new, a copy of an ordinary template, an extraction of an archive with no settings
// file in it and a move of a directory in are fine; a source that carries (or may carry) a settings file
// is not, and neither is anything that removes, moves away or re-links the directory.
const isSettingsPair = (parent, name) => AGENT_CONFIG_DIRS.includes(parent.toLowerCase()) && SETTINGS_FILES.includes(name.toLowerCase())
// Does the tree at `src` (a path word) carry a settings file under a config dir, a symlink (which could
// point anywhere), or something that cannot be read? Not there at all: nothing to carry.
function sourceCarriesSettings(src, ctx) {
  let found = false; let seen = 0
  for (const cwd of ctx.cwds) {
    const w = expandWord(src, ctx.vars, cwd)
    if (!w || /[$`*?[]/.test(w)) return true // not a path the gate can read
    const abs = isAbsolute(w) ? w : join(cwd, w)
    let st
    try { st = lstatSync(abs) } catch { continue }
    if (st.isSymbolicLink()) return true
    if (!st.isDirectory()) { if (isSettingsPair(basename(dirname(abs)), basename(abs))) found = true; continue }
    const walk = (dir, depth) => {
      if (found) return
      if (depth > 8 || seen > 5000) { found = true; return }
      let ents = []
      try { ents = readdirSync(dir, { withFileTypes: true }) } catch { found = true; return }
      for (const d of ents) {
        seen++
        if (d.isSymbolicLink()) { found = true; return }
        if (d.isDirectory()) walk(join(dir, d.name), depth + 1)
        else if (isSettingsPair(basename(dir), d.name)) { found = true; return }
      }
    }
    if (isSettingsPair(basename(dirname(abs)), basename(abs))) found = true
    walk(abs, 0)
  }
  return found
}
// Does the archive carry a settings file under a config dir? An archive that is not there extracts nothing;
// one that cannot be listed counts as carrying one.
function archiveCarriesSettings(archive, ctx) {
  for (const cwd of ctx.cwds) {
    const w = expandWord(archive, ctx.vars, cwd)
    if (!w || /[$`*?[]/.test(w)) return true
    const abs = isAbsolute(w) ? w : join(cwd, w)
    try { statSync(abs) } catch { continue }
    const lower = abs.toLowerCase()
    const cmd = /\.zip$/.test(lower) ? ['unzip', ['-Z1', abs]] : ['tar', ['-tf', abs]]
    const r = spawnSync(cmd[0], cmd[1], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 })
    if (r.status !== 0 || typeof r.stdout !== 'string') return true
    for (const line of r.stdout.split('\n')) {
      const parts = line.replace(/\/+$/, '').split('/').filter(Boolean)
      if (parts.length >= 2 && isSettingsPair(parts[parts.length - 2], parts[parts.length - 1])) return true
      if (parts.includes('..') || line.startsWith('/')) return true // a path that leaves the extraction root
    }
  }
  return false
}
// May this command, with agents/ or agents/<name> among its words, touch a protected settings file?
// `agentWords` are the indexes into `words` of the agent-directory words.
function agentDirOpHarmless(cmd, words, ci, agentWords, ctx) {
  const args = words.slice(ci + 1)
  if (cmd === 'mkdir' || cmd === 'touch') return true // creates, never replaces
  const ops = operandsOf(args, new Set(['-t', '-C', '-d', '-f', '-T', '--target-directory', '--directory']))
  const optVal = (...names) => { for (let k = 0; k < args.length; k++) { const a = args[k]; for (const n of names) { if (a === n) return args[k + 1]; if (a.startsWith(n + '=')) return a.slice(n.length + 1) } } return undefined }
  const isAgent = (word) => agentWords.some((i) => words[i] === word)
  if (cmd === 'cp' || cmd === 'ditto' || cmd === 'rsync' || cmd === 'mv' || cmd === 'install') {
    const td = optVal('-t', '--target-directory')
    const dest = td ?? ops[ops.length - 1]
    const sources = td !== undefined ? ops : ops.slice(0, -1)
    if (!dest || !isAgent(dest)) {
      // the agent directory is a SOURCE: copying out of it reads; moving it away or removing the source takes the settings along
      if (cmd === 'mv' || cmd === 'install' || args.some((a) => /^--(remove-source|delete)/.test(a))) return false
      return true
    }
    if (sources.some((src) => isAgent(src))) return false // a copy or move of the agent directory onto itself
    return !sources.some((src) => sourceCarriesSettings(src, ctx))
  }
  if (cmd === 'tar' || cmd === 'bsdtar' || cmd === 'gtar') {
    const extract = args.some((a, k) => (k === 0 && /^[A-Za-z]*x/.test(a) && !a.startsWith('-')) || /^-[A-Za-z]*x/.test(a) || a === '--extract' || a === '--get')
    if (!extract) return true // create / list: the agent directory is read
    let archive = optVal('-f', '--file')
    if (archive === undefined) {
      // `tar xf FILE` (first word, no dash) and a cluster ending in f (-xzf FILE)
      if (args[0] && !args[0].startsWith('-') && /f/.test(args[0])) archive = args[1]
      else { const k = args.findIndex((a) => /^-[A-Za-z]*f$/.test(a)); if (k !== -1) archive = args[k + 1] }
    }
    if (archive === undefined) return false
    return !archiveCarriesSettings(archive, ctx)
  }
  if (cmd === 'unzip') {
    const archive = ops.find((o) => !isAgent(o))
    return archive !== undefined && !args.includes('-l') ? !archiveCarriesSettings(archive, ctx) : true
  }
  return false // rm, ln, rename, chmod ..., anything else that moves, removes, links or rewrites
}

function commandWordIndex(words) {
  let k = 0
  for (;;) {
    const w = words[k]
    if (w === undefined) return -1
    if (/^[A-Za-z_]\w*=/.test(w)) { k++; continue }
    if (WRAPPER_WORDS.has(w.split('/').pop())) {
      k++
      while (k < words.length && words[k].startsWith('-')) k++
      continue
    }
    return k
  }
}
const ADDR = String.raw`(?:\d+|\$|\/(?:[^\/\\]|\\.)*\/)`
const SED_PRINT = new RegExp(String.raw`^(?:${ADDR}(?:,${ADDR})?)?\s*!?\s*[pPdqnNlxgGhH=]$`)
const SED_SUBST = new RegExp(String.raw`^(?:${ADDR}(?:,${ADDR})?)?\s*!?\s*s([\/|#,@])((?:(?!\1)[^\\]|\\.)*)\1((?:(?!\1)[^\\]|\\.)*)\1[gpiI0-9]*$`)
// A sed script is "safe" only when every command in it is a print / delete / quit style command or an
// s/// whose flags carry no w and no e. The w, W, e, r, R commands, a {block}, a label and a -f script
// file all fail this shape and therefore deny: whether they write cannot be read off a short string.
export function sedScriptSafe(script) {
  if (/[\n{}]/.test(script)) return false
  return String(script).split(';').map((s) => s.trim()).filter(Boolean).every((s) => SED_PRINT.test(s) || SED_SUBST.test(s))
}
// Operands of a command: the words that are not options and not the value of a value-taking option.
function operandsOf(args, valueFlags = new Set()) {
  const out = []; let opts = true
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (opts && a === '--') { opts = false; continue }
    if (opts && a.startsWith('-') && a.length > 1) { if (valueFlags.has(a)) k++; continue }
    out.push(a)
  }
  return out
}
// Is this plain read of its (protected) operands really only a read?
function readerOk(cmd, args, ctx) {
  // an option that names an output file is never a read, on any listed command
  if (args.some((a) => /^--out/.test(a))) return false
  switch (cmd) {
    case 'sed': {
      const scripts = []; let haveE = false; let k = 0
      const operands = []
      for (; k < args.length; k++) {
        const a = args[k]
        if (a === '--') { operands.push(...args.slice(k + 1)); break }
        if (a.startsWith('--')) {
          if (/^--expression(=|$)/.test(a)) { haveE = true; scripts.push(a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++k] ?? ''); continue }
          if (/^--(quiet|silent|regexp-extended|null-data|separate|unbuffered|posix|debug|sandbox|binary|follow-symlinks|line-length=\d+)$/.test(a)) continue
          return false // --in-place, --file, anything unknown
        }
        if (a.startsWith('-') && a.length > 1) {
          for (let q = 1; q < a.length; q++) {
            const c = a[q]
            if (c === 'e') { haveE = true; scripts.push(q + 1 < a.length ? a.slice(q + 1) : args[++k] ?? ''); break }
            if (c === 'l') { if (q + 1 >= a.length) k++; break }
            if (!'nErzsu'.includes(c)) return false // -i, -f and anything unknown
          }
          continue
        }
        operands.push(a)
      }
      if (!haveE) { if (!operands.length) return false; scripts.push(operands.shift()) }
      for (const s of scripts) {
        if (!sedScriptSafe(s)) return false
        const wk = wordKind(s, ctx); if (wk && !isAnc(wk)) return false
      }
      return true
    }
    case 'find': return !args.some((a) => /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(a))
    case 'sort':
      // -o FILE / --output writes, --compress-program execs, -T DIR creates temp files
      return !args.some((a) => (/^-[^-]/.test(a) && /[oT]/.test(a)) || /^--[oct]/.test(a))
    case 'uniq': return operandsOf(args, new Set(['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'])).length <= 1 // the second operand is an OUTPUT file
    case 'xxd': return operandsOf(args, new Set(['-l', '-s', '-c', '-g', '-o', '-len', '-seek', '-cols', '-groupsize', '-offset'])).length <= 1 // the second operand is an OUTPUT file
    case 'file': return !args.some((a) => (/^-[^-]/.test(a) && /C/.test(a)) || /^--compile/.test(a)) // -C writes <magic>.mgc
    case 'rg': return !args.some((a) => /^--(pre|hostname-bin)(=|$)/.test(a)) // --pre execs a program
    default: return true
  }
}
const SAFE_ENV_RX = /^(?:GIT_|PAGER=|LESS|LD_|DYLD_|BASH_ENV=|ENV=|PATH=|SHELLOPTS=|IFS=|EDITOR=|VISUAL=)/
// Commands that move, remove, link, extract or rewrite a directory (loose ancestors, see protectedSet).
const DESTRUCTIVE = new Set(['mv', 'rm', 'rmdir', 'ln', 'rename', 'unlink', 'rsync', 'ditto', 'chmod', 'chown', 'chgrp', 'chflags', 'trash', 'shred', 'truncate', 'install', 'tar', 'unzip', 'zip', 'pax', 'cpio', 'patch', 'dd', 'mkdir', 'touch', 'tee', 'sponge'])
function destructiveCmd(cmd, args) {
  if (DESTRUCTIVE.has(cmd)) return true
  if (cmd === 'cp') return args.some((a) => /^-[A-Za-z]*[rRa]/.test(a) || /^--(recursive|archive)/.test(a))
  // a git that is not read-only can write through an operand or an option value (`checkout-index --prefix=DIR`, `format-patch -o DIR`,
  // `archive -o FILE`, `clone ... DIR`): it is judged by the SAME classification the working-tree rule uses (gitRewritesInstallTree),
  // never by a list of the writing subcommands (that list missed checkout-index)
  if (cmd === 'git') return !gitNeverWrites(args)

  if (cmd === 'find') return !readerOk('find', args)
  if (INTERPRETERS.test(cmd)) return args.some((a) => INLINE_FLAGS.has(a))
  return false
}
function gitSubcommand(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { k++; continue }
    if (a.startsWith('-')) continue
    return a
  }
  return null
}
// A safe git subcommand is safe only without an option that writes a file or runs a program:
// --output=FILE (and any abbreviation of it: git accepts --outp=), -c key=value / --config-env (core.pager,
// diff.external, alias.*), --exec-path, grep -O / --open-files-in-pager.
function gitSafe(args) {
  const sub = gitSubcommand(args)
  if (!SAFE_GIT.has(sub ?? '')) return false
  const subAt = args.indexOf(sub)
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (k < subAt) {
      if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { k++; continue }
      if (a === '-c' || /^-c./.test(a) || /^--(config-env|exec-path|super-prefix)/.test(a)) return false
      continue
    }
    if (a === '--') break
    if (/^--ou/.test(a)) return false
    // git grep -O[<pager>] / --open-files-in-pager[=<pager>] runs a program on the matching files. -O can sit inside a
    // short-option cluster (-nOless, -inO) and git takes any unambiguous abbreviation of the long form (--op and up;
    // --o alone is ambiguous with --only-matching and --or, and git refuses it). A cluster that merely contains an O
    // in a pattern (-eOther) is refused too: the cost of failing closed here is one false deny.
    if (sub === 'grep') {
      if (/^-[^-]*O/.test(a)) return false
      const gname = a.split('=')[0]
      if (gname.length >= 4 && '--open-files-in-pager'.startsWith(gname)) return false
    }
    // --ext-diff runs the configured external diff program, --textconv the configured textconv filter. git takes any
    // unambiguous abbreviation, so every prefix that can only be that option counts: --ext (>= 5 chars) and --textc
    // (>= 7 chars; --text itself is a different option, "treat as text"). --extended-regexp is not a prefix of
    // --ext-diff and stays a read.
    const name = a.split('=')[0]
    if ((name.length >= 5 && '--ext-diff'.startsWith(name)) || (name.length >= 7 && '--textconv'.startsWith(name))) return false
  }
  return true
}
// ONE definition of a plain read, used by every step of bashProtectedDecision that lets a read through (the strict
// ancestor step and the protected-file step): a reader that readerOk() shows safe, or a read-only git subcommand
// that gitSafe() shows safe, AND not fed into anything but another reader (it may be handing paths to xargs / sh),
// AND without an environment that makes it run a program or write a file. Two steps with their own copy of this
// condition is how a git read was refused at a strict ancestor while a git read piped into xargs passed at a file.
function isReadCommand(cmd, args, ctx) {
  return (READERS.has(cmd) && readerOk(cmd, args, ctx)) || (cmd === 'git' && gitSafe(args))
}
function isPlainRead(cmd, args, ctx, { si, feedsNonReader, envUnsafe }) {
  return isReadCommand(cmd, args, ctx) && !envUnsafe && !feedsNonReader(si)
}

// ---- git operations that rewrite a working tree -------------------------------------------------------------------
// `git checkout <branch>`, `switch`, `merge`, `pull`, `rebase`, `cherry-pick`, `reset --hard`, `restore --source`,
// `read-tree -u`, `stash pop`, `apply`, `am`, `clean` ... rewrite the files of the tree they run in without naming a
// single protected path, so the word-based rules above never see them. They are judged by WHERE they run: a git
// subcommand that is not read-only (not in SAFE_GIT, not in the short harmless list below) is refused when its working
// tree is the install or anything under it, and free when the tree is a real path outside it (a git worktree copy).
// An ALLOWLIST on purpose: naming the rewriting subcommands would miss the next one (restore --source, sparse-checkout,
// submodule update, bisect ...).
const GIT_HARMLESS_SUBS = new Set(['help', 'version', 'worktree']) // worktree: its own governance gate decides, not this one
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', 'time', '{'])
const GIT_LAUNCHERS = new Set([...WRAPPER_WORDS, 'timeout', 'xargs', 'busybox'])
const GIT_TREE_MAX_ARGS = 256
const GIT_TREE_MAX_CWDS = 32
const GIT_CANDIDATES_MAX = 8
// A shell that is handed its script as text (sh -c STRING, eval STRING, a script on stdin) runs a command the word rules
// cannot see inside. The text is judged as a command of its own, from the directory (and the cd history) the outer
// command had at that point, bounded in depth and in the number of texts per command (the cost stays linear).
// (a numeric suffix is tolerated: bash5, sh-3.2, zsh-5.9)
const SHELL_RX = /^(?:bash|sh|zsh|dash|ksh|ksh93|mksh|pdksh|oksh|ash|yash|posh|hush|rbash|fish|csh|tcsh)(?:[-.]?[0-9][0-9.]*)?$/
const INNER_DEPTH_MAX = 4
const INNER_BUDGET = 16
const SUBST_BUDGET = 64 // substitutions that name git, judged per command
// Does a text name git as a word? Also when quotes or backslashes split the name (g'i't, g"i"t, g''it): the shell that reads the
// text removes them, so the git is there. (A text that only looks like it, `g it`, has a space and is not matched.)
const GIT_WORD = /\bgit\b/
const GIT_WORD_STRICT = /(?:^|[^\w-])git(?:[^\w-]|$)/
const namesGit = (t, rx = GIT_WORD) => { const s = String(t ?? ''); return rx.test(s) || rx.test(s.replace(/['"\\]/g, '')) }
// The script texts one segment hands to a shell: { texts, unreadable }. `prevSeg`: the segment before a pipe (or null).
// `unreadable`: the script is handed over in a form this parser cannot read, so what it runs is not known:
//   'always'  the text is spelled so that the words are not the words that run ($'..' / $".." quoting, a \xHH, \uHHHH or octal
//             escape, a printf format directive): judged as the worst case, a tree-rewriting git
//   'if-git'  the script comes from a source that is not text in the command (a command substitution, a pipe from anything but
//             echo / printf / a heredoc, a redirect from a file, `source /dev/stdin`): the same, but only when the command
//             mentions git at all (a plain `cat run.sh | sh` of a command with no git in it is not this rule's business)
function shellScriptTexts(words, cmdIdx, seg, prevSeg) {
  const none = { texts: [], unreadable: null }
  if (cmdIdx === -1) return none
  // The words carry the DYN marker of a substitution behind a literal head (see tokenizeShell). The text a shell is handed is judged
  // as a command of its own, and the marker is not part of that text: with it `$(` reads `$<marker>(`, the BUILT test below does not see
  // the substitution and the inner parse takes the `(` for a group. The marker comes after the `$` and in front of a backtick, so
  // taking it out gives back the text the command had.
  words = words.map((w) => w.replaceAll(DYN, ''))
  const base = (w) => w.split('/').pop()
  const OBFUSCATED = /\$['"]|\\x[0-9A-Fa-f]|\\u[0-9A-Fa-f]|\\0[0-7]|\\[1-7][0-7]{2}/
  // (a plain $NAME in a text is expanded by the inner shell and judged there, like any word; only a substitution builds a command)
  const BUILT = /\$\(|`/ // a command substitution inside the text builds (part of) the command: `$(printf 'g%s' it) checkout x`
  const DYNAMIC = /\$\{/
  if (base(words[cmdIdx]) === 'eval') {
    const t = words.slice(cmdIdx + 1).join(' ')
    return { texts: [t], unreadable: OBFUSCATED.test(seg) || BUILT.test(t) ? 'always' : DYNAMIC.test(t) ? 'if-git' : null }
  }
  // `source /dev/stdin` and `. /dev/stdin` read their script from stdin exactly like a bare shell
  const stdinSource = /^(?:source|\.)$/.test(base(words[cmdIdx])) && (words.slice(cmdIdx + 1).some((a) => /^\/(?:dev\/stdin|dev\/fd\/[0-9]+|proc\/(?:self|[0-9]+)\/fd\/[0-9]+)$/.test(a)) || /<\(/.test(seg))
  let sh = SHELL_RX.test(base(words[cmdIdx])) || stdinSource ? cmdIdx : -1
  if (sh === -1) {
    // behind a launcher word (`xargs sh -c ...`, `nice -n 5 bash -c ...`, `timeout 5 sh ...`)
    // (a launcher with its own option value, `nice -n 1`, leaves the command word on the value: the launcher is looked
    // for from the start of the segment, but only counts when it is at or before the command word)
    const l = words.findIndex((w) => GIT_LAUNCHERS.has(base(w)))
    sh = l === -1 || l > cmdIdx ? -1 : words.findIndex((w, i) => i > l && SHELL_RX.test(base(w)))
  }
  if (sh === -1) return none
  const STDIN_DEV = /^\/(?:dev\/stdin|dev\/fd\/[0-9]+|proc\/(?:self|[0-9]+)\/fd\/[0-9]+)$/
  const devOperand = words.slice(sh + 1).some((a) => STDIN_DEV.test(a))
  const args = stdinSource ? [] : words.slice(sh + 1).filter((a) => !STDIN_DEV.test(a)) // `sh /dev/fd/3` is a bare shell reading a descriptor
  // a process substitution as the script (`bash <(cmd)`): the script is whatever cmd prints
  if (!args.some((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a)) && /<\(/.test(seg)) return { texts: [], unreadable: 'if-git' }
  const k = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a))
  if (k !== -1) {
    const s = args.slice(k + 1).find((a) => !a.startsWith('-'))
    if (s === undefined) return none
    return { texts: [s], unreadable: OBFUSCATED.test(seg) || BUILT.test(s) ? 'always' : DYNAMIC.test(s) ? 'if-git' : null }
  }
  if (args.some((a) => !a.startsWith('-'))) return none // a script FILE operand: not text
  // no -c and no file: the shell reads its script from stdin. A here-string and an echo / printf before the pipe are text;
  // a heredoc is text too (its lines are segments of their own, judged as commands).
  const texts = []
  let unreadable = null
  const hs = /<<<\s*(?:'([^']*)'|"([^"]*)"|([^\s;|&<>]+))/.exec(seg)
  if (hs) { texts.push(hs[1] ?? hs[2] ?? hs[3]); if (OBFUSCATED.test(seg) || BUILT.test(texts[0])) unreadable = 'always'; else if (DYNAMIC.test(texts[0])) unreadable = 'if-git' }
  else if (/<<-?\s*['"\\]?[A-Za-z_]/.test(seg) || (prevSeg !== null && /<<-?\s*['"\\]?[A-Za-z_]/.test(prevSeg))) { /* a heredoc: the body lines are segments */ }
  else if (prevSeg !== null) {
    const pw = tokenizeShell(prevSeg).words.map((w) => w.replaceAll(DYN, ''))
    const pi = commandWordIndex(pw)
    if (pi !== -1 && /^(?:echo|printf)$/.test(base(pw[pi]))) {
      const t = pw.slice(pi + 1).filter((a) => !/^-[neE]+$/.test(a)).join(' ')
      texts.push(t)
      // a printf format directive builds the text at run time (`printf 'g%s' it`), and so does an escape
      if (OBFUSCATED.test(prevSeg) || BUILT.test(t) || (base(pw[pi]) === 'printf' && /%/.test(t))) unreadable = 'always'
      else if (DYNAMIC.test(t)) unreadable = 'if-git'
    } else unreadable = 'if-git' // cat, curl, git show ... | sh: the script is whatever the feeder prints
  } else if (/(?:^|[\s;&|])\d*<(?![<(&])/.test(seg) || stdinSource) unreadable = 'if-git' // sh < run.sh, source /dev/stdin
  if (devOperand && unreadable === null && texts.length === 0) unreadable = 'if-git' // sh /dev/fd/3 with nothing readable behind it
  return { texts: texts.map((t) => t.replace(/\\n/g, '\n')), unreadable }
}
// Global git options in front of the subcommand, in order: -C <path> (repeatable, each relative to the one before),
// --work-tree, --git-dir; the others that take a value are skipped so the subcommand is found correctly.
function scanGitGlobals(args) {
  const ops = []; let bad = false; let k = 0
  for (; k < args.length; k++) {
    const a = args[k]
    if (!a.startsWith('-') || a === '--') break
    if (a === '-C') { ops.push(['C', args[++k]]); continue }
    if (/^-C./.test(a)) { bad = true; continue } // not a form git takes: do not guess
    if (a === '--work-tree' || a === '--git-dir') { ops.push([a === '--work-tree' ? 'wt' : 'gd', args[++k]]); continue }
    if (a.startsWith('--work-tree=')) { ops.push(['wt', a.slice('--work-tree='.length)]); continue }
    if (a.startsWith('--git-dir=')) { ops.push(['gd', a.slice('--git-dir='.length)]); continue }
    // a config override that moves the tree (core.worktree, core.*) or reads its value from the environment is not judged: refuse
    // (deny by default: only keys that cannot run a program or move a tree are let through; include.path, alias.*, filter.*, diff.*,
    // merge.*driver, core.* and the like are refused on a rewriting subcommand)
    const SAFE_C = /^(?:user|color|advice)\.[a-z0-9.-]+=/i
    if (a === '-c' && !SAFE_C.test(args[k + 1] ?? '')) bad = true
    if (/^-c.+/.test(a) && !SAFE_C.test(a.slice(2))) bad = true
    if (a === '--config-env' || a.startsWith('--config-env=')) bad = true
    if (a === '-c' || a === '--namespace' || a === '--config-env' || a === '--super-prefix') k++
  }
  return { ops, bad, sub: args[k] ?? null, subIdx: k }
}
const isOptionPrefix = (a, full, min) => { const n = a.split('=')[0]; return n.length >= min && full.startsWith(n) }
// `git fetch` only moves refs: the one rewriting-class subcommand with a daily need that is harmless in the install,
// unless an option or an operand makes it run a program (--upload-pack and its abbreviations, a remote helper such as
// ext::, a global -c / --config-env).
function gitFetchPlain(args, g) {
  if (args.slice(0, g.subIdx).some((a) => a === '-c' || /^-c./.test(a) || /^--(config-env|exec-path|super-prefix)/.test(a))) return false
  for (let k = g.subIdx + 1; k < args.length; k++) {
    const a = args[k]
    if (a === '--') break
    if (a.startsWith('--')) {
      if (isOptionPrefix(a, '--upload-pack', 5) || isOptionPrefix(a, '--receive-pack', 5) || isOptionPrefix(a, '--exec', 5) || isOptionPrefix(a, '--update-head-ok', 5)) return false
      continue
    }
    if (/^-[^-]*u/.test(a)) return false // -u is --update-head-ok
    if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(a)) return false // remote helper (ext::<command>)
  }
  return true
}
// ---- git config: a write is judged by its KEY and its VALUE, from any directory ----------------------------------------------------
// A worktree copy shares its repository configuration with the install, so a `git config` run in a copy reaches the install: core.hooksPath
// and diff.external make the next plain git in the install run a program, core.worktree re-points the install repository, alias.x=!cmd,
// core.fsmonitor, core.pager, filter.*, include.path and the like do the same. The key set is open-ended, so this is an ALLOWLIST (the shape
// the global `-c` rule already has, SAFE_C): a write form passes only for a key that cannot run a program or move a tree, AND only with a
// value that is one of that key's plain settings (pull.rebase=interactive opens an editor on the next pull). Compared lower-cased: git reads
// the section and the variable name case-insensitively. `branch.<name>.remote|merge|rebase` are NOT here: a remote can be a URL or a remote
// helper that the next pull runs, and `git branch --set-upstream-to` covers the daily need without a config write.
const GIT_CFG_TEXT = /^[^\r\n\0]*$/
const GIT_CFG_BOOL = /^(?:true|false)$/i // (git reads a boolean and these words case-insensitively)
const GIT_CFG_KEYS = [
  [/^(?:user|color)\.[a-z0-9.-]+$/, GIT_CFG_TEXT],
  [/^advice\.[a-z0-9.-]+$/, GIT_CFG_BOOL],
  [/^pull\.rebase$/, GIT_CFG_BOOL], [/^fetch\.prune$/, GIT_CFG_BOOL], [/^rerere\.enabled$/, GIT_CFG_BOOL], [/^push\.autosetupremote$/, GIT_CFG_BOOL],
  [/^core\.(?:filemode|ignorecase|quotepath)$/, GIT_CFG_BOOL],
  [/^pull\.ff$/, /^(?:true|false|only)$/i],
  [/^core\.autocrlf$/, /^(?:true|false|input)$/i],
  [/^core\.safecrlf$/, /^(?:true|false|warn)$/i],
  [/^push\.default$/, /^(?:simple|current|upstream|nothing|matching)$/i],
  [/^init\.defaultbranch$/, /^[A-Za-z0-9._/-]+$/],
]
// Options that change how a config is read or typed, none of which writes a file or runs a program. Matched EXACTLY (no abbreviation):
// anything else that starts with a dash is refused, so a spelling this table does not know can only cost a false deny.
const GIT_CFG_PLAIN = new Set(['--local', '--global', '--system', '--worktree', '--show-origin', '--show-scope', '--name-only', '--show-names', '--null', '-z',
  '--includes', '--no-includes', '--fixed-value', '--no-type', '--bool', '--int', '--bool-or-int', '--path', '--expiry-date', '--all', '--regexp'])
const GIT_CFG_READ = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list'])
const GIT_CFG_UNSET = new Set(['--unset', '--unset-all', '--remove-section']) // they only remove
const GIT_CFG_WRITE = new Set(['--add', '--replace-all', '--rename-section', '--append'])
const GIT_CFG_VALUED = /^--(?:type|default|value|url)=/ // the value is glued: text, never a path this rule reads
const GIT_CFG_VALUED_SEP = new Set(['--type', '--default', '-t']) // the next word is the value of the option
const GIT_CFG_SUBS = new Set(['get', 'list', 'unset', 'remove-section', 'set', 'edit', 'rename-section']) // git >= 2.46: `git config set k v`
// May this `git config` run? `rest` = the words after `config`. A word that cannot be read off the text ($VAR not set in the command, a
// substitution) is unreadable: for the key, and for the value of a key that has a value rule, it is a refusal.
function gitConfigAllowed(rest, ctx) {
  if (rest.length > GIT_TREE_MAX_ARGS) return false
  const readable = (w) => { const x = expandWord(w, ctx.vars, ctx.current); return /[$`]/.test(x) || x.includes(DYN) ? null : x }
  const pos = []; let act = null; let end = false
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k]
    if (end || !a.startsWith('-') || a === '-') { pos.push(a); continue }
    if (a === '--') { end = true; continue }
    if (GIT_CFG_PLAIN.has(a) || GIT_CFG_VALUED.test(a)) continue
    if (GIT_CFG_VALUED_SEP.has(a)) { k++; continue }
    if (GIT_CFG_READ.has(a)) { act ??= 'read'; continue }
    if (GIT_CFG_UNSET.has(a)) { act ??= 'unset'; continue }
    if (GIT_CFG_WRITE.has(a)) { act = a === '--rename-section' ? 'rename' : 'write'; continue }
    return false // -f / --file / --blob / -e / --edit (a file target is a path writer, an editor is a program), or a spelling not known
  }
  const first = pos[0] !== undefined && GIT_CFG_SUBS.has(pos[0]) ? pos.shift() : null
  if (first === 'edit') return false
  if (first === 'get' || first === 'list') act = 'read'
  else if (first === 'unset' || first === 'remove-section') act = 'unset'
  else if (first === 'set') act = 'write'
  else if (first === 'rename-section') act = 'rename'
  if (act === 'rename') {
    const SECTION = /^(?:user|color|advice)(?:\.[a-z0-9.-]+)?$/
    const [from, to] = [pos[0], pos[1]].map((p) => (p === undefined ? null : readable(p)?.toLowerCase() ?? null))
    return pos.length === 2 && from !== null && to !== null && SECTION.test(from) && SECTION.test(to)
  }
  if (act === 'read' || act === 'unset') return true
  if (act === null && pos.length <= 1) return true // one key and no value: a read
  if (pos.length === 0 || pos.length > 3) return false
  const key = readable(pos[0])?.toLowerCase()
  if (key === undefined || key === null) return false
  const rule = GIT_CFG_KEYS.find(([rx]) => rx.test(key))
  if (!rule) return false
  const value = pos[1] === undefined ? '' : readable(pos[1])
  // a free-text value (user.*, color.*) may be built by the shell: git stores it quoted, a newline in it cannot start a new key. A value
  // with a rule must be read off the text and match.
  if (rule[1] === GIT_CFG_TEXT) return value === null || GIT_CFG_TEXT.test(value)
  return value !== null && rule[1].test(value)
}
// Can this git never write through a path it was handed? Only a read-only subcommand (SAFE_GIT, and gitSafe agrees: no --output,
// no -c, no pager option), the harmless list without `worktree` (its add / move / remove take a target path), or a plain fetch.
// Everything else, and a git whose subcommand cannot be read, counts as writing: the same split gitRewritesInstallTree makes.
function gitNeverWrites(args) {
  const g = scanGitGlobals(args)
  if (g.sub === null || g.sub === 'worktree') return false
  if (SAFE_GIT.has(g.sub)) return gitSafe(args)
  return GIT_HARMLESS_SUBS.has(g.sub) || (g.sub === 'fetch' && gitFetchPlain(args, g))
}
// The words of a git command that are NOT operands of the writing subcommand, as indexes into `words` (`ci` = the git word):
// the value of -C / --git-dir / --work-tree / --namespace (they select the tree, and the tree rule judges that), and the value of
// -m / --message (text: `-m TEXT`, `-mTEXT`, `--message TEXT`, `--message=TEXT`). No other option is exempt. A word in this set is
// never a reason for the loose-ancestor tier on its own (a protected FILE or the strict ancestor in it still counts, see the caller).
function gitExemptWords(words, ci) {
  const args = words.slice(ci + 1); const off = ci + 1; const out = new Set()
  const g = scanGitGlobals(args)
  for (let k = 0; k < g.subIdx; k++) {
    const a = args[k]
    if (a === '-C' || a === '--work-tree' || a === '--git-dir' || a === '--namespace') { out.add(off + k + 1); k++; continue }
    if (/^--(?:work-tree|git-dir|namespace)=/.test(a)) { out.add(off + k); continue }
    if (a === '-c' || a === '--config-env' || a === '--super-prefix') k++ // (their values are not paths this rule exempts)
  }
  for (let k = g.subIdx + 1; k < args.length; k++) {
    const a = args[k]
    if (a === '--') break
    // (`-m` is a flag without a value in some subcommands, `read-tree -m --prefix=<dir>`: the word after it is text only when it does not
    // start with a dash; a message that starts with a dash is rare and `--message=TEXT` still covers it. `--message` always takes a value.)
    if (a === '--message') { out.add(off + k + 1); k++; continue }
    if (a === '-m') { if (args[k + 1] !== undefined && !args[k + 1].startsWith('-')) { out.add(off + k + 1); k++ } continue }
    if (a.startsWith('--message=') || /^-m[^-]/.test(a)) out.add(off + k)
  }
  return out
}
// The directories a relative word after `-C <dir>` is relative to, besides the directory the command runs in: each -C is relative
// to the one before it (git chdir's in order), from every directory the command may run in. A value that cannot be read is skipped.
function gitCTargets(words, ci, ctx) {
  const g = scanGitGlobals(words.slice(ci + 1))
  const cs = g.ops.filter(([kind]) => kind === 'C').map(([, v]) => v)
  const out = new Set()
  if (cs.length === 0 || cs.length > GIT_TREE_MAX_ARGS) return out
  for (const base of ctx.cwds) {
    let cur = base
    for (const v of cs) {
      if (v === undefined) { cur = null; break }
      const x = expandWord(v, ctx.vars, cur)
      if (x === '' || /[$`*?[\]{}]/.test(x) || x.includes(DYN)) { cur = null; break }
      cur = resolve(cur, x)
    }
    if (cur !== null) out.add(cur)
  }
  return out
}
// dev+ino of the install root and of every protected ancestor, compared instead of strings: APFS ignores case and
// there are symlinks, so two spellings of one directory have one identity.
function installIdentities(ctx) {
  let c = ctx.cache.get('install-ids')
  if (c) return c
  const reals = [dirname(ctx.prot.scriptsDir), ...ctx.prot.ancestors.map((a) => a.real)]
  c = { lower: reals.map((r) => r.toLowerCase()), ids: [] }
  for (const r of reals) { try { const st = statSync(r); c.ids.push(`${st.dev}:${st.ino}`) } catch { /* not there: the string form still counts */ } }
  ctx.cache.set('install-ids', c)
  return c
}
// Is this path the install or under it? Resolved to a real path first (a symlinked spelling), then walked upward with
// a stat of each level (bounded). A path deeper than the bound is treated as inside.
function insideInstall(p, inst) {
  let cur = realOrSelf(p)
  const lc = cur.toLowerCase()
  if (inst.lower.some((r) => lc === r || lc.startsWith(r + sep))) return true
  for (let n = 0; n < 128; n++) {
    try { const st = statSync(cur); if (inst.ids.includes(`${st.dev}:${st.ino}`)) return true } catch { /* not there (yet): look one level up */ }
    const up = dirname(cur)
    if (up === cur) return false
    cur = up
  }
  return true
}
// true = refuse. `mode.exact`: the cwd of this segment is exactly ctx.current (a plain `cd X && git ...` chain);
// otherwise the cwd may be ANY directory the command has been in (a pipe, `||`, a background job, a `cd` that only
// ran after `&&` followed by a `;`), so every one of them must be outside the install. `mode.compound`: the command
// has a subshell, a brace group or a shell keyword, where the cd tracking above cannot be trusted: refuse.
function gitRewritesInstallTree(words, ci, ctx, mode) {
  const args = words.slice(ci + 1)
  const g = scanGitGlobals(args)
  if (g.sub === null || SAFE_GIT.has(g.sub) || GIT_HARMLESS_SUBS.has(g.sub) || (g.sub === 'fetch' && gitFetchPlain(args, g))) return false
  if (args.length > GIT_TREE_MAX_ARGS || g.bad || ctx.unknownCwd || mode.compound || ctx.cwds.size > GIT_TREE_MAX_CWDS) return true
  // GIT_WORK_TREE / GIT_DIR / GIT_COMMON_DIR set anywhere else in the command (`export GIT_WORK_TREE=...; git checkout x`, an
  // assignment-only segment, `set -a`) move the tree without being a prefix of THIS git: more mentions than prefixes = refuse
  // (counted on the raw text AND on the words with their quotes removed: `G"IT"_WORK_TREE=x` has no GIT_WORK_TREE in the raw text.
  // GIT_CONFIG_COUNT / _KEY_n / _VALUE_n / _PARAMETERS / GIT_CONFIG_GLOBAL can set core.worktree: any mention is a refusal)
  const names = /GIT_(?:WORK_TREE|DIR|COMMON_DIR|CONFIG[A-Z0-9_]*)\b/g
  const count = (t) => (String(t ?? '').match(names) ?? []).length
  const mentions = Math.max(count(mode.raw), count(mode.joined))
  const prefixes = words.slice(0, ci).filter((x) => /^GIT_(?:WORK_TREE|DIR|COMMON_DIR)=/.test(x)).length
  if (mentions > prefixes) return true
  // a segment that loads an environment this parser cannot read (a sourced file, eval, set -a) may have set any of them
  if (mode.envUnknown) return true
  const inst = installIdentities(ctx)
  const env = (name) => { const w = words.slice(0, ci).filter((x) => x.startsWith(name + '=')).pop(); return w === undefined ? null : w.slice(name.length + 1) }
  const envWt = env('GIT_WORK_TREE'); const envGd = env('GIT_DIR') ?? env('GIT_COMMON_DIR')
  const value = (v, from) => { // a path the command spells, or null when it cannot be read off the text
    if (v === undefined) return null
    const x = expandWord(v, ctx.vars, from)
    return x === '' || /[$`*?[\]{}]/.test(x) ? null : resolve(from, x)
  }
  const envGdSeen = new Set()
  for (const base of mode.exact ? [ctx.current] : [...ctx.cwds]) {
    let cwd = base; let wt = null; let gd = null
    for (const [kind, v] of g.ops) {
      const r = value(v, cwd)
      if (r === null) return true
      if (kind === 'C') cwd = r; else if (kind === 'wt') wt = r; else gd = r
    }
    // the environment is read relative to the directory the command starts in AND to the one -C moved to: both count
    // (an option beats the environment; with neither, the tree is the directory the command runs in)
    const trees = new Set(wt !== null ? [wt] : envWt === null ? [cwd] : [])
    for (const [name, v] of [['wt', envWt], ['gd', envGd]]) {
      if (v === null) continue
      for (const from of new Set([base, cwd])) {
        const r = value(v, from)
        if (r === null) return true
        if (name === 'wt' && wt === null) trees.add(r)
        if (name === 'gd' && gd === null && !envGdSeen.has(r)) { envGdSeen.add(r); if (insideInstall(r, inst)) return true }
      }
    }
    // an explicit git directory inside the install is the install's own repository, whatever tree it is pointed at
    if (gd !== null && insideInstall(gd, inst)) return true
    for (const t of trees) if (insideInstall(t, inst)) return true
  }
  return false
}
// `cp SRC... DIR/` (or `cp -t DIR SRC...`) creates DIR/<basename of SRC>: a file named like a protected
// one lands there although no word of the command names it. Returns the kind of the protected path a
// copy would create inside a directory operand, or null. A source whose name cannot be read (a $VAR, a
// glob that could match) counts as the protected name when the directory holds one.
function copyIntoDirKind(args, ctx) {
  let targetDir = null; const operands = []; let opts = true
  const recursive = args.some((a) => /^-[A-Za-z]*[rRa]/.test(a) || /^--(recursive|archive)$/.test(a))
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (opts && a === '--') { opts = false; continue }
    if (opts && a.startsWith('--')) {
      if (a === '--target-directory') targetDir = args[++k] ?? null
      else if (a.startsWith('--target-directory=')) targetDir = a.slice('--target-directory='.length)
      continue
    }
    if (opts && a.startsWith('-') && a.length > 1) {
      for (let q = 1; q < a.length; q++) {
        if (a[q] === 't') { targetDir = q + 1 < a.length ? a.slice(q + 1) : args[++k] ?? null; break }
        if (a[q] === 'S') { if (q + 1 >= a.length) k++; break } // --suffix value
      }
      continue
    }
    operands.push(a)
  }
  const dest = targetDir ?? (operands.length > 1 ? operands[operands.length - 1] : null)
  const sources = targetDir !== null ? operands : operands.slice(0, -1)
  if (dest === null || !sources.length) return null
  const protectedChildren = (realD) => {
    const names = new Map()
    for (const e of ctx.prot.entries) if (dirname(e.real) === realD) names.set(basename(e.real), e.kind)
    if (agentConfigDirKind(realD, ctx.prot)) for (const f of SETTINGS_FILES) names.set(f, 'agent-settings')
    return names
  }
  for (const cwd of ctx.cwds) {
    const w = expandWord(dest, ctx.vars, cwd)
    if (!w || /[$`*?[]/.test(w)) continue
    const realD = realOrSelf(isAbsolute(w) ? w : join(cwd, w))
    let isDir = w.endsWith('/')
    if (!isDir) { try { isDir = statSync(realD).isDirectory() } catch { /* not there: a file target, wordKind reads it */ } }
    if (!isDir) continue
    const children = protectedChildren(realD)
    for (const src of sources) {
      const base = basename(String(src).replace(/\/+$/, ''))
      if (!base) continue
      if (/[$`]/.test(base)) { if (children.size) return [...children.values()][0]; continue }
      if (/[*?[]/.test(base)) {
        const re = new RegExp(globToRegex(base).source, 'i')
        for (const [name, kind] of children) if (re.test(name)) return kind
        continue
      }
      const target = join(realD, base)
      const k = kindOf(target, ctx.prot)
      if (k) return k
      for (const [name, kind] of children) if (name.toLowerCase() === base.toLowerCase()) return kind
      // a recursive copy of a directory creates (or merges into) DIR/<base> with everything below it, so
      // a target that IS or CONTAINS a protected path (the agents/ tree, an agent dir, its config dir, the
      // store, scripts/, the install root) takes the protected names along from the source
      if (recursive) {
        const lt = target.toLowerCase()
        const holds = (p) => { const lp = p.toLowerCase(); return lp === lt || lp.startsWith(lt + sep) }
        const e = ctx.prot.entries.find((x) => holds(x.real))
        if (e) return e.kind
        const a = ctx.prot.ancestors.find((x) => holds(x.real))
        if (a) return a.kind
        const ak = agentConfigDirKind(target, ctx.prot)
        if (ak) return ak
        // agents/ or agents/<name> as the target: only a source that carries a settings file matters
        const ad = agentDirKind(target, ctx.prot)
        if (ad && sourceCarriesSettings(src, ctx)) return ad
      }
    }
  }
  return null
}
// Fail-closed decision for a whole Bash command. Returns { deny: false } or { deny: true, reason }.
export function bashProtectedDecision(command, opts = {}) {
  const prot = opts.prot ?? protectedSet(opts)
  const cwd = opts.cwd || process.cwd()
  const ctx = makeContext(command, cwd, prot)
  // A script text judged as a command of its own (see shellScriptTexts) starts from the state of the outer command at the
  // point it runs: the directory, the cd history and the union / compound / raw-text context.
  const seed = opts.seed
  if (seed) { ctx.current = seed.current; ctx.cwds = new Set(seed.cwds); ctx.unknownCwd = seed.unknownCwd }
  const budget = opts.budget ?? { n: 0 }
  const { segs, seps, unterminated, grouped } = splitShell(command)
  // A command or process substitution is a command of its own: `echo $(git checkout x)`, `tee >(git pull)` run the git. Each
  // outermost one is judged with the same rules from the directory the outer command starts in (a nested one is found when
  // its outer text is judged, so the cost stays linear; the number judged per command is bounded, over it the rest is refused
  // unread). A substitution is not a group of the outer command: a subshell cannot move the outer cd (see `compound` below).
  for (const inner of substitutionTexts(command)) {
    if (namesGit(inner)) {
      budget.subs = (budget.subs ?? 0) + 1
      if (budget.subs > SUBST_BUDGET) return { deny: true, reason: 'gate-scripts' }
      const d = bashProtectedDecision(inner, { ...opts, prot, cwd, budget, seed: undefined }); if (d.deny) return d
      // with a cd in the command the substitution may run anywhere: judge it as if it ran in the install too
      // (the cd is looked for in the raw text AND in the words with their quotes removed: `"cd" /x`, `c\d /x` and `command cd /x` have no `cd` in the raw text)
      if (/\b(?:cd|pushd|popd)\b/.test(String(command)) || segs.some((x) => { const w = spliceEnvSplit(tokenizeShell(x).words); const i = commandWordIndex(w); return i !== -1 && /^(?:cd|pushd|popd)$/.test(w[i].split('/').pop()) })) { const d2 = bashProtectedDecision(inner, { ...opts, prot, cwd: dirname(prot.scriptsDir), budget, seed: undefined }); if (d2.deny) return d2 }
    }
  }
  const feedsNonReader = (idx) => {
    if (seps[idx] !== '|' || idx + 1 >= segs.length) return false
    const nw = spliceEnvSplit(tokenizeShell(segs[idx + 1]).words)
    const nc = commandWordIndex(nw)
    const name = nc === -1 ? '' : nw[nc].split('/').pop()
    return !(READERS.has(name) || name === 'tee')
  }
  // Where a segment runs: after a pipe, `||` or `&` it may run in any directory the command has been in; after a `cd`
  // that itself depended on `&&`, a following `;` or newline runs in either. A subshell, a brace group or a shell
  // keyword hides a cd from the tracking altogether. (Only a git subcommand that rewrites a tree reads this.)
  // (a script text starts with no pending cd of its own: the outer command's "a cd may have failed" state is already in `union`)
  let unionMode = seed?.union ?? false; let condCd = false
  // (a subshell or brace group is a structure of the command - `grouped` from splitShell - not a parenthesis in its text:
  // `git merge -m "x (y)"` and `echo $(date); git ...` have none)
  const compound = seed?.compound || grouped || segs.some((s) => /^\s*(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|select|function|!)\b/.test(s))
  // the whole command as words without quotes, and whether any segment loads an environment this parser cannot read
  // (a script text carries the outer command's: the environment was set outside it)
  // (the outer command's words already contain the text: an inner call does not count them twice)
  const joined = seed?.joined ?? segs.map((x) => tokenizeShell(x).words.join(' ')).join(' ')
  // (only a git in a LATER segment is affected: the text of the loading segment itself is judged as it stands)
  const envFrom = segs.findIndex((x) => {
    const w = spliceEnvSplit(tokenizeShell(x).words); const i = commandWordIndex(w)
    if (i === -1) return false
    const c = w[i].split('/').pop()
    return c === 'source' || c === '.' || c === 'eval' || (c === 'set' && w.slice(i + 1).some((a) => /^-[A-Za-z]*a|^allexport$/.test(a)))
  })
  const gmode = { compound, raw: seed?.raw ?? command, joined }
  const envUnknownAt = (i) => Boolean(seed?.envUnknown) || (envFrom !== -1 && i > envFrom)
  for (let si = 0; si < segs.length; si++) {
    const seg = maskApiBody(segs[si], ctx, String(seed?.raw ?? command), compound) // (the JSON body of a fleet API wrapper call is data, see maskApiBody)
    const prevSep = si > 0 ? seps[si - 1] : ''
    if (prevSep === '|' || prevSep === '||' || prevSep === '&') unionMode = true
    else if (condCd && (prevSep === ';' || prevSep === '')) unionMode = true
    const tokenized = tokenizeShell(seg)
    const { redirects, hasRedirect } = tokenized
    const words = spliceEnvSplit(tokenized.words)
    const kinds = words.map((w) => wordKind(w, ctx))
    const kindsC = words.map(() => null) // the same words read from the `git -C` directory (below), where they differ from `kinds`
    const rKinds = redirects.map((r) => wordKind(r, ctx))
    // `cd` moves the base of every later relative word (conservatively: the old base stays too).
    const ci = commandWordIndex(words)
    const cmd = ci === -1 ? '' : words[ci].split('/').pop()
    // a relative word after `git -C <dir>` is relative to <dir>: it is read against that directory too (the directory the command runs in
    // still counts), the way the tree rule reads the -C chain. The words of the global options themselves are read as they stand.
    if (cmd === 'git') {
      const cTargets = gitCTargets(words, ci, ctx)
      if (cTargets.size > 0) {
        const ctxC = { ...ctx, cwds: new Set([...ctx.cwds, ...cTargets]) }
        for (let i = ci + 2 + scanGitGlobals(words.slice(ci + 1)).subIdx; i < words.length; i++) kindsC[i] = wordKind(words[i], ctxC)
      }
    }
    if (cmd === 'cd' || cmd === 'pushd') {
      if (words.slice(ci + 1).includes('-')) ctx.unknownCwd = true // `cd -` goes back to a directory this parser never saw
      const arg = words.slice(ci + 1).find((a) => !a.startsWith('-'))
      const target = arg === undefined ? homedir() : expandWord(arg, ctx.vars, ctx.current)
      if (arg === '-' || target.includes('$') || /[*?[`]/.test(target)) ctx.unknownCwd = true
      else { ctx.current = resolve(ctx.current, target); ctx.cwds.add(ctx.current); ctx.cwds.add(realOrSelf(ctx.current)) }
    }
    if (cmd === 'popd') ctx.unknownCwd = true // the directory it returns to is not tracked
    // (any cd may fail: `cd /missing; git checkout x` runs the git where the command already was)
    if (cmd === 'cd' || cmd === 'pushd') condCd = true
    if (cmd === 'cp') {
      const ck = copyIntoDirKind(words.slice(ci + 1), ctx)
      if (ck) return { deny: true, reason: ck }
    }
    // a git subcommand that rewrites the tree it runs in, run in the install (see gitRewritesInstallTree)
    // (the command word may sit behind a shell keyword: `then git checkout x`, `do git pull`, `! git merge x`)
    let gci = ci
    while (gci !== -1 && SHELL_KEYWORDS.has(words[gci])) { const r = commandWordIndex(words.slice(gci + 1)); gci = r === -1 ? -1 : gci + 1 + r }
    const cmdIdx = gci
    // a launcher with its own option value (`nice -n 5 git ...`, `env -u X git ...`, `timeout 5 git ...`, `xargs git ...`) hides
    // the git from commandWordIndex. This parser does not know the option grammar of each launcher (which word is a value and
    // which is the command), so EVERY git word behind a launcher word is judged as the command: one of them is the real one,
    // and a git word that is only an option value (`env -u git git checkout x`, `xargs -I git ...`) cannot hide it.
    let gitIdxs = []
    const launcherAt = gci === -1 ? -1 : words.findIndex((w) => GIT_LAUNCHERS.has(w.split('/').pop()))
    if (gci !== -1 && (launcherAt === -1 || launcherAt >= gci) && words[gci].split('/').pop() === 'git') gitIdxs = [gci]
    else if (gci !== -1) {
      for (let i = launcherAt + 1; launcherAt !== -1 && i < words.length && gitIdxs.length <= GIT_CANDIDATES_MAX; i++) if (words[i].split('/').pop() === 'git') gitIdxs.push(i)
    }
    // (a bound on the candidates keeps the cost linear: more git words than this behind one launcher are refused unread)
    if (gitIdxs.length > GIT_CANDIDATES_MAX) return { deny: true, reason: 'gate-scripts' }
    for (let n = 0; n < gitIdxs.length; n++) {
      const g = gitIdxs[n]
      // a git word followed by another git word is an option value of the launcher (`-u git`, `-I git`): the next one is judged
      if (gitIdxs[n + 1] === g + 1) continue
      const gg = scanGitGlobals(words.slice(g + 1))
      const sub = gg.sub
      // behind xargs the gate does not see the arguments of the git (the input lines are appended to the command: `echo
      // --upload-pack=x | xargs git fetch`, `echo 'checkout x' | xargs git`), so only a read-only subcommand (SAFE_GIT) passes; the
      // fetch / worktree / help exceptions, which depend on the options, do not apply. Any other subcommand, or none, is judged as
      // `git checkout` with the same global options (-C, --work-tree, --git-dir) in front.
      const behindXargs = words.slice(0, g).some((w) => w.split('/').pop() === 'xargs')
      const viaXargs = behindXargs && (sub === null || !SAFE_GIT.has(sub))
      // a `git config` is judged by its key and value wherever it runs (a worktree copy shares the repository configuration with the
      // install). Behind xargs the words the gate sees are not all the words git gets, so there it is refused unread.
      if (sub === 'config' && (behindXargs || !gitConfigAllowed(words.slice(g + 1 + gg.subIdx + 1), ctx))) return { deny: true, reason: 'gate-scripts' }
      if (gitRewritesInstallTree(viaXargs ? [...words.slice(0, g + 1 + gg.subIdx), 'checkout'] : words, g, ctx, { exact: !unionMode, compound, ...gmode, envUnknown: envUnknownAt(si) })) return { deny: true, reason: 'gate-scripts' }
    }
    // a script handed to a shell as text (sh -c STRING, eval STRING, stdin): a git in it is judged as a command of its own
    // a command word built by an expansion (`G=git; $G checkout x`, `$(echo git) pull`): what runs is not known. Judged as the worst
    // case, a tree-rewriting git, when the command names git as a word anywhere
    if (gci !== -1 && /[$`]/.test(words[gci]) && namesGit(seed?.raw ?? command, GIT_WORD_STRICT)) {
      if (gitRewritesInstallTree(['git', 'checkout'], 0, ctx, { exact: !unionMode, compound, ...gmode, envUnknown: envUnknownAt(si) })) return { deny: true, reason: 'gate-scripts' }
    }
    const st = shellScriptTexts(words, cmdIdx, seg, si > 0 && prevSep === '|' ? segs[si - 1] : null)
    // a script whose text cannot be read off the command is judged as the worst case, a tree-rewriting git: refused where such a
    // git is refused (the install), free in a worktree copy. 'if-git': only when the command names git anywhere.
    if (st.unreadable === 'always' || (st.unreadable === 'if-git' && namesGit(seed?.raw ?? command))) {
      if (gitRewritesInstallTree(['git', 'checkout'], 0, ctx, { exact: !unionMode, compound, ...gmode, envUnknown: envUnknownAt(si) })) return { deny: true, reason: 'gate-scripts' }
    }
    for (const t of st.texts) {
      // (a text with a variable in it - `eval "$X"` after `X='git pull'` - may hold the git: it is judged too when the command names
      // git anywhere; its command word built by an expansion is then judged as the worst case by the rule above)
      if (!namesGit(t) && !(t.includes('$') && namesGit(seed?.raw ?? command))) continue
      if (++budget.n > INNER_BUDGET || (seed?.depth ?? 0) >= INNER_DEPTH_MAX) return { deny: true, reason: 'gate-scripts' }
      const inner = { current: ctx.current, cwds: [...ctx.cwds], unknownCwd: ctx.unknownCwd, union: unionMode, compound, raw: seed?.raw ?? command, joined, envUnknown: envUnknownAt(si), depth: (seed?.depth ?? 0) + 1 }
      const d = bashProtectedDecision(t, { ...opts, prot, cwd: ctx.current, budget, seed: inner }); if (d.deny) return d
    }
    const hit = kinds.find((k) => k && !isAnc(k)) ?? kindsC.find((k) => k && !isAnc(k)) ?? rKinds.find((k) => k && !isAnc(k)) ?? null
    const ancKinds = [...kinds, ...kindsC, ...rKinds].filter(isAnc)
    const ancestorHit = !hit && ancKinds.length > 0
    if (!hit && !ancestorHit) {
      // a redirect target with an unresolvable shape is only a problem next to a protected word (below)
      continue
    }
    const kind = hit ?? ancKinds[0].split(':')[1]
    const deny = () => ({ deny: true, reason: kind })
    // 1. a redirect that lands on a protected path, or whose target cannot be read
    if (rKinds.some((k) => k && !isAnc(k))) return deny()
    for (const r of redirects) {
      if (/^&?\d+$/.test(r) || r === '/dev/null') continue
      if (/[$`]/.test(r) && hit) return deny()
    }
    // 2. substitutions next to a protected word
    if (/\$\(|`|[<>]\(/.test(seg)) return deny()
    // 3. ambiguous mention: quotes / backslash inside a protected word AND a redirect operator
    if (hasRedirect && seg.split(/\s+/).some((raw) => /['"\\]/.test(raw) && tokenizeShell(raw).words.some((w) => { const k = wordKind(w, ctx); return k && !isAnc(k) }))) return deny()
    if (ci === -1) return deny()
    const args = words.slice(ci + 1)
    // an environment that makes a reader or git run a program or write a file (GIT_EXTERNAL_DIFF, PAGER, LD_PRELOAD ...)
    const envUnsafe = words.slice(0, ci).some((w) => SAFE_ENV_RX.test(w))
    // 4. a directory that CONTAINS protected paths: a plain read, a listing and a cd are fine. The
    //    strict one (scripts/) denies everything else; the loose ones (store/, the repo root) deny
    //    only what moves, removes, links, extracts or rewrites.
    if (ancestorHit) {
      // (the value of a git -C / --git-dir / --work-tree / --namespace and the text after -m / --message are not operands of the
      // command: a LOOSE ancestor in one of them is not read here; the strict one and a protected file still count)
      const exempt = cmd === 'git' ? gitExemptWords(words, ci) : new Set()
      const unlessExempt = (k, idx) => isAnc(k) && !(exempt.has(idx) && !k.startsWith('anc-strict'))
      const ancEff = [...kinds.filter(unlessExempt), ...kindsC.filter(unlessExempt), ...rKinds.filter(isAnc)]
      if (ancEff.length === 0) continue
      if (isPlainRead(cmd, args, ctx, { si, feedsNonReader, envUnsafe })) continue
      if (!ancEff.some((k) => k.startsWith('anc-strict')) && !destructiveCmd(cmd, args)) continue
      // agents/ and agents/<name> alone: only an operation that can put a settings file in (or take the
      // directory away) is refused
      if (ancEff.every((k) => k.startsWith('anc-agentdir'))) {
        const agentWords = kinds.map((k, idx) => (typeof k === 'string' && k.startsWith('anc-agentdir') ? idx : -1)).filter((idx) => idx !== -1)
        if (agentDirOpHarmless(cmd, words, ci, agentWords, ctx)) continue
      }
      return deny()
    }
    // 5. plain reads
    // (a reader whose output is piped into anything but another reader may be handing paths to xargs / sh)
    if (isPlainRead(cmd, args, ctx, { si, feedsNonReader, envUnsafe })) continue
    // a read (reader or git) that is fed into a non-reader is refused here, not handed on to the plain-run step
    if (isReadCommand(cmd, args, ctx) && !envUnsafe) return deny()
    // 6. plain runs: the protected file is the command word, or the SCRIPT operand of an interpreter
    const hitIdx = kinds.map((k, idx) => (k && !isAnc(k) ? idx : -1)).filter((idx) => idx !== -1)
    if (hitIdx.length === 1 && hitIdx[0] === ci && !INTERPRETERS.test(cmd)) continue
    if (INTERPRETERS.test(cmd)) {
      let operand = -1
      for (let k = ci + 1; k < words.length; k++) {
        const a = words[k]
        if (a.startsWith('-') && a.length > 1) { if (INLINE_FLAGS.has(a)) { operand = -2; break } continue }
        operand = k; break
      }
      if (operand >= 0 && hitIdx.length === 1 && hitIdx[0] === operand) continue
    }
    return deny()
  }
  if (unterminated) {
    // an unterminated quote hides the structure: deny only when some word names a protected path
    const all = String(command)
    const probe = tokenizeShell(all.replace(/['"`]/g, ' ')).words
    const k = probe.map((w) => wordKind(w, ctx)).find((x) => x && !isAnc(x))
    if (k) return { deny: true, reason: k }
  }
  return { deny: false }
}
// Segment-level check kept for callers and tests: a plain reader with no redirect at the file passes.
export function allowlistBashSegmentAllowed(seg) {
  return !bashProtectedDecision(String(seg ?? '')).deny
}

// Split a compound command into individual simple commands, so a token in one
// segment cannot trip a check anchored in another (e.g. `cat store && cp a b`).
// Line-continuations (backslash-newline) are collapsed FIRST so a single command
// continued across lines stays ONE segment (this is what keeps the
// tmux\<newline>send-keys vector closed); only real separators split.
//
// KNOWN LIMITATIONS (accepted, defense-in-depth -- the runtime tool-deny is the
// primary guard, this Bash hook is a second layer; a sub-agent is not adversarial
// to its own gate, it just must not casually self-pace):
//   - Not quote-aware: a separator INSIDE quotes (e.g. a commit message
//     `git commit -m "fix; crontab -r"`) splits and could false-deny. Rare
//     enough (the quoted ; must be immediately followed by a blocked binary at a
//     segment start) that a full shell-tokenizer is not warranted here.
//   - A $(...) or backtick substitution that assigns a scheduler result
//     (`X=$(crontab -)`, `X=`crontab -``) is caught by schedulerMatch's boundary
//     anchor, which now includes both `(` and the backtick.
export function splitSegments(command) {
  return String(command ?? '')
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||[;&|]|\r?\n/)
    // trim so a leading-separator segment (" at now") anchors at ^ correctly
    .map((s) => s.trim())
}

// FORK NOTE: only the primitive is ported (upstream #887 added it to the self-pace
// scheduler check as well). Here it is consumed by scripts/hooks/bash-egress-parser.mjs;
// gateDecision below is unchanged.
// Split like splitSegments, but ONLY on separators the shell would actually
// treat as separators -- never on one that sits inside a quoted string or a
// heredoc body. Returns null when the quoting cannot be resolved with
// confidence, and every caller must then fall back to the naive splitter.
//
// WHY THIS EXISTS (measured 2026-08-05, five denials in one morning -- three
// mine, two taric's): splitSegments is not quote-aware, so PROSE can manufacture
// a command position that never existed. All five denials had the same cause: a
// grep pattern quoted inside an inter-agent message,
//   Minta: stop.sh <bar> launchctl <bar> com.janna.dashboard
// The `<bar>` split it, the middle piece trimmed down to the bare word
// `launchctl`, and schedulerMatch's end-of-segment branch reads a bare `launchctl`
// as a real (interactive) invocation -- correctly, for a real command line.
// Nothing was scheduled; five messages simply never went out. From outside, a
// hard-gate denial is indistinguishable from an agent that stayed silent.
//
// The route decided it: the SAME text passes as `curl -d '<json>'` (the payload
// is blanked by stripDataPayloads) and is denied when sent from a python
// heredoc, which has no -d argument to blank. Choosing how to send a message
// had quietly become a security decision. stripDataPayloads' own comment names
// this false-positive class as its target -- it is implemented for exactly one
// route, so the gap is unfinished work, not an oversight.
//
// SCOPE, and this is the part that matters: the result feeds ONLY the anchored
// scheduler check. The unanchored patterns (tmux+send-keys, nohup+claude,
// claude+/loop) keep scanning naive segments, quoted regions included, because
// they do NOT depend on a command position that prose can fake -- and because
// measurement showed the naive scan is what catches a real
// `subprocess.run(['tmux','send-keys',...])` hidden in a heredoc body. Handing
// them quote-aware segments would have removed the detection of the very
// incident vector this gate was built for, under the banner of a structural fix.
//
// FAIL-CLOSED in three places, because "could not parse" must mean "scan more",
// never "scan less":
//   - unterminated quote or heredoc -> null (caller uses the naive split)
//   - a double-quoted region containing $(...) or a backtick -> null; the shell
//     runs what is inside, so a `;` in there IS a real separator
//   - a heredoc with an UNQUOTED tag whose body contains $(...) or a backtick
//     -> null, same reason (an unquoted tag expands the body)
// NOTE ON THE SHAPE OF THIS FIX. The first attempt made the SEGMENTER
// quote-aware and left the regexes alone. It failed one corpus case:
//   echo 'grep: foo <bar> crontab <bar> bar'
// stayed denied, because schedulerMatch carries its OWN boundary anchor
// (SCHED_BOUNDARY includes the bar), so it re-finds a command position INSIDE a
// segment. Keeping the quoted text in the segment at all was the mistake. The
// `launchctl` cases passed only by luck -- LAUNCHCTL_SUBCOMMAND's lookahead
// happened to reject the following bar. So the primitive is not "split more
// carefully", it is "the inert text must not be there": mask it out, then let
// the existing splitter and regexes run unchanged on what remains.
export function maskInertLiterals(command) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  let cur = ''
  let i = 0

  // Inert regions collapse to spaces: the text is gone, and with it every
  // separator inside it -- which is precisely what prose was faking.
  const blank = (s) => ' '.repeat(s.length)

  while (i < src.length) {
    const c = src[i]

    // backslash escape outside quotes: consumes the next character
    if (c === '\\' && i + 1 < src.length) { cur += src.slice(i, i + 2); i += 2; continue }

    // heredoc: <<TAG / <<-TAG / <<'TAG' / <<"TAG"
    const here = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(src.slice(i))
    if (here) {
      const tag = here[1] ?? here[2] ?? here[3]
      const quotedTag = here[1] != null || here[2] != null
      cur += here[0]
      i += here[0].length
      // the body starts after the rest of THIS line
      const nl = src.indexOf('\n', i)
      if (nl === -1) return null // heredoc announced but no body -> cannot resolve
      cur += src.slice(i, nl + 1)
      i = nl + 1
      // find the terminator line (leading tabs allowed for <<-)
      const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
      const rel = endRx.exec(src.slice(i))
      if (!rel) return null // unterminated heredoc
      const body = src.slice(i, i + rel.index)
      if (!quotedTag && /\$\(|`/.test(body)) return null // unquoted tag expands the body
      cur += blank(body) + rel[0]
      i += rel.index + rel[0].length
      continue
    }

    if (c === "'") { // literal until the next ' -- a backslash is NOT special here
      const end = src.indexOf("'", i + 1)
      if (end === -1) return null
      cur += blank(src.slice(i, end + 1)); i = end + 1; continue
    }

    if (c === '$' && src[i + 1] === "'") { // ANSI-C: \' does escape
      let j = i + 2
      while (j < src.length && src[j] !== "'") { j += src[j] === '\\' ? 2 : 1 }
      if (j >= src.length) return null
      cur += blank(src.slice(i, j + 1)); i = j + 1; continue
    }

    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') { j += src[j] === '\\' ? 2 : 1 }
      if (j >= src.length) return null
      const inner = src.slice(i + 1, j)
      if (/\$\(|`/.test(inner)) return null // may run a command -> not inert
      cur += blank(src.slice(i, j + 1)); i = j + 1; continue
    }

    cur += c; i++
  }
  return cur
}

// Blank out curl/HTTP DATA-PAYLOAD arguments before self-pace matching. A -d /
// --data body is data sent over the wire, NEVER a shell invocation, so a trigger
// token that only appears INSIDE the payload must not false-deny. The classic
// false-positive: an /api/messages inter-agent dispatch (a legit peer message in
// a green, operator-authorised review-loop) whose JSON body happens to mention
// "/api/schedules", "tmux send-keys", "scheduled_tasks.json" or "/loop" -- pure
// text, not an invocation. Only PROVABLY-LITERAL payloads are stripped:
// single-quoted '...', ANSI-C $'...', and double-quoted "..." WITHOUT
// $(...)/backtick. A payload that can run a command substitution (double-quoted
// with $(...) / backticks) is left intact so a real command-substitution payload
// is not blanked. Such a payload is then still denied by schedulerMatch, whose
// boundary anchor recognises both `$(` and the backtick as a command boundary,
// so a scheduler binary inside either substitution form is caught. The data FLAG
// itself is kept, so HTTP-write detection (-d /
// --data) is unchanged; the URL and method args live OUTSIDE the payload, so a
// real WRITE to /api/schedules is still denied.
//
// Quote classes match BASH parsing, not C. Inside a plain '...' a backslash is
// LITERAL and the FIRST following ' always closes the string, so the class is
// '[^']*'. A C-style '(?:[^'\\]|\\.)*' would treat \' as an escaped quote and
// scan PAST bash's real closing quote -- e.g. `curl -d 'x\' ; crontab -r` would
// blank the out-of-band `; crontab -r` and let a real self-pace command slip.
// ANSI-C $'...' DOES process \', so that branch keeps the \\. escape form; "..."
// keeps it too (backslash is special inside bash double quotes).
export function stripDataPayloads(seg) {
  return String(seg ?? '').replace(
    /((?:^|\s)(?:-d|--data(?:-(?:raw|binary|ascii|urlencode))?)(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full // may substitute -> keep
      return flag + (dq ? '""' : "''") // literal payload -> blank the content
    },
  )
}

// Blank out git commit/tag/stash -m/--message LITERAL text before self-pace
// matching. A commit message is prose, NEVER a shell invocation, so a trigger
// token that only appears INSIDE the message must not false-deny (2026-07-13,
// DrCode: a long `git commit -m "...batch...; at..."` blocked twice, the short
// one passed -- the message text was split as shell segments). Same principle
// and same literal-only quote handling as stripDataPayloads: single-quoted,
// ANSI-C $'...', and double-quoted WITHOUT $(...)/backtick are blanked; a
// double-quoted message that CAN command-substitute (`git commit -m "$(crontab
// -r)"`) is left intact so schedulerMatch still catches the real substitution.
// Scoped to git commit/tag/stash so a `-m` on an unrelated binary is untouched.
export function stripGitCommitMessages(command) {
  const cmd = String(command ?? '')
  if (!/\bgit\b[\s\S]*\b(commit|tag|stash)\b/i.test(cmd)) return cmd
  return cmd.replace(
    /((?:^|\s)(?:-m|--message)(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full // may substitute -> keep
      return flag + (dq ? '""' : "''") // literal message -> blank the content
    },
  )
}

// Normalise two shell-level obfuscations that bash resolves at EXEC time, so an
// invocation whose SHAPE is a real self-pace cannot dodge the slash-command match
// with quoting the shell undoes anyway. Measured end-to-end through the gate hook
// (upstream review, 2026-07-27): `claude \/loop` and `claude$IFS/loop` BOTH run
// `claude /loop` in bash but slipped the `(?:^|[\s'"])\/loop` match -- the char
// before `/loop` was `\` and `S` (end of `$IFS`), neither in the [\s'"] class.
// The fix is NOT to widen that class (that would let more prose through); it is to
// resolve what the shell resolves before matching: `$IFS`/`${IFS}` word-splits to
// a space, and a backslash escape `\X` collapses to `X`. Side effect: also closes
// `claude /lo\op`. Applied ONLY to the self-pace bash patterns below; the
// scheduler/store/API checks keep the raw segment (upstream measured them clean,
// and this PR is scoped to these two loop regressions). This cannot introduce a
// false positive: collapsing escapes / dropping `$IFS` never synthesises the
// literal `tmux`+send-keys, `nohup`+claude, or `claude`+`/loop` tokens out of
// prose -- it only removes an evasion.
export function normalizeShellEvasion(seg) {
  return String(seg ?? '')
    .replace(/\$\{IFS\}|\$IFS\b/g, ' ') // $IFS / ${IFS} -> the space it expands to
    .replace(/\\(.)/g, '$1') // \X -> X (bash unescape of a backslash-escaped char)
}

// 64 KiB: the longest real call seen is about 32 KB. The scheduler matcher is linear; the cap bounds the other scans (a few are n^1.5 on a hostile shape).
export const MAX_CMD_CHARS = 65536

// Pure decision: does this tool call set up self-pace / self-injection?
export function gateDecision(toolName, toolInput, opts = {}) {
  const name = String(toolName ?? '')
  if (SELF_PACE_TOOLS.has(name)) return { deny: true }
  // Native file tools writing the self-schedule store would bypass any Bash regex.
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const fp = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
    if (SCHEDULE_STORE_RX.test(fp)) return { deny: true }
    const kind = fileToolProtectedKind(toolInput, protectedSet(opts), opts.cwd || process.cwd())
    if (kind) return { deny: true, reason: kind }
  }
  if (name === 'Bash') {
    // A command this big is not read: the scans below are not all linear (a few are n^1.5 on a hostile
    // shape), and a hook still running at the host timeout is not a deny. Over the cap the call is refused,
    // fail-closed, like the other gates (the real maximum seen is ~32 KB).
    if (String(toolInput?.command ?? '').length > MAX_CMD_CHARS) return { deny: true, reason: 'too-large' }
    // Strip -d/--data payloads on the WHOLE command BEFORE splitting. A payload is
    // data, not an invocation; and since splitSegments is NOT quote-aware, a shell
    // separator (; && | &) INSIDE a dispatch body would otherwise orphan a fragment
    // that false-matches. Stripping first blanks the body (incl. any separators in
    // it), so the URL/method args still match but the body text never does. A
    // separator OUTSIDE the payload still splits, so `curl -d '' x ; crontab -r`
    // is still caught.
    const safeCommand = stripDataPayloads(stripGitCommitMessages(String(toolInput?.command ?? '')))
    // Per-segment so an unrelated token elsewhere in a compound command cannot
    // turn a legit read (store inspection, schedule-API GET) into a false deny.
    for (const seg of splitSegments(safeCommand)) {
      // Match the self-pace bash patterns against the shell-normalised segment so a
      // `\/loop` / `$IFS/loop` evasion (which bash resolves to `/loop` at exec) is
      // still caught; the scheduler/store/API checks below use the RAW seg (scoped).
      if (SELF_PACE_BASH_PATTERNS.some((re) => re.test(normalizeShellEvasion(seg)))) return { deny: true }
      // scheduler binaries: deny the exec/submit forms, allow pure read-listing
      if (schedulerMatch(seg) && !schedulerReadMatch(seg)) return { deny: true }
      // self-schedule store: block WRITE only (a read/grep is legit diagnostics)
      if (SCHEDULE_STORE_RX.test(seg) && WRITE_INTENT_RX.test(seg)) return { deny: true }
      // dashboard schedule API: block WRITE methods only (GET list/pending is legit)
      if (SCHEDULE_API_RX.test(seg) && HTTP_WRITE_RX.test(seg)) return { deny: true }
    }
    // the egress config and the gate / hook scripts of this install: reads and runs only
    // (EGRESSSELFEDIT824). Judged on the whole command: a `cd` in one segment moves the next.
    const protectedDecision = bashProtectedDecision(safeCommand, { ...opts, prot: protectedSet(opts) })
    if (protectedDecision.deny) return protectedDecision
  }
  return { deny: false }
}

const GATE_MSG =
  'Self-pace TILTOTT (governance hard-gate). Sub-agentkent NEM utemezhetsz sajat ' +
  'jovobeli turn-t: se ScheduleWakeup/Cron*/RemoteTrigger, se tmux send-keys, se ' +
  'scheduled_tasks.json iras, se /api/schedules POST, se /loop self-pace. Input-vezerelt ' +
  'vagy: csak az operator (channel) vagy egy peer (inter-agent) uzenete inditson. Ha varakozol, ' +
  'maradj idle a prompt-on -- a beerkezo uzenet majd ujrainditja a turn-t. SOHA ne valaszolj ' +
  'magadnak es SOHA ne dontsd el az operator helyett egy hozza intezett kerdest.'

const ALLOWLIST_GATE_MSG =
  'Egress-engedelylista TILTOTT (governance hard-gate). Sub-agentkent NEM irhatod a ' +
  'store/egress-allowlist.json-t, a store/egress-vendor-hosts.json-t es a ' +
  'store/.egress-allowlist-cache.json-t: ez a kapu RAD vonatkozik. Ha egy domain vagy vendor-host kell, kerd a fo ' +
  'agenst (inter-agent uzenet: domain + miert); o a gazda jovahagyasaval veszi fel. ' +
  'Olvasni szabad: cat / grep / jq a fajlra (ertelmezo -- python, node -- nem).'

const SCRIPTS_GATE_MSG =
  'Kapu- es hook-scriptek vedve (governance hard-gate). Sub-agentkent NEM irhatod ennek a telepitesnek a ' +
  'scripts/self-pace-gate.mjs, scripts/email-send-gate.mjs, scripts/hooks/ es scripts/lib/ fajljait, sem a ' +
  'scripts/agent-api.sh, sync-hooks.sh, doctor.sh, gate-onfailure-check.py, secret-gate.ts, src/web/hook-registration-guard.ts ' +
  'es src/security/secret-gate.ts fajlokat: ezek RAD vonatkozo kapuk vagy a kapuk ellenorzoi. Ha egy kapu hibas vagy modositani kell, kerd a fo agenst (inter-agent uzenet: fajl + miert). ' +
  'Olvasni (cat / grep / diff) es futtatni (node scripts/hooks/x.mjs, python3 scripts/hooks/x.py) szabad; ' +
  'a sajat worktree masolat szerkesztheto.'

const SETTINGS_GATE_MSG =
  'Agent-settings fajlok vedve (governance hard-gate). Sub-agentkent NEM irhatod a Claude Code settings.json / ' +
  'settings.local.json fajlokat (agents/*/.claude, agents/*/.claude-config, a telepites .claude mappaja): ' +
  'egy {"disableAllHooks": true} minden kaput kikapcsolna, ami RAD vonatkozik. Ha egy beallitas kell ' +
  '(plugin, hook, permission), kerd a fo agenst vagy a tulajdonost (inter-agent uzenet: fajl + miert). ' +
  'Olvasni (cat / jq / grep) szabad; a sajat worktree masolat szerkesztheto.'

const TOO_LARGE_MSG =
  'A parancs tul nagy (' + MAX_CMD_CHARS + ' karakter folott) ahhoz, hogy a kapu atvizsgalja (governance hard-gate), ' +
  'es egy vizsgalhatatlan parancs nem mehet at. Nagy szoveget fajlba irj a Write tool-lal, aztan futtasd ujra.'

function allow() { process.exit(0) }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function isInvokedDirectly() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch {
    return false
  }
}
if (isInvokedDirectly()) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never break the agent's tool calls
  }
  const { deny: shouldDeny, reason } = gateDecision(payload?.tool_name, payload?.tool_input, { cwd: payload?.cwd })
  if (shouldDeny) deny(reason === 'too-large' ? TOO_LARGE_MSG : reason === 'egress-allowlist' ? ALLOWLIST_GATE_MSG : reason === 'gate-scripts' ? SCRIPTS_GATE_MSG : reason === 'agent-settings' ? SETTINGS_GATE_MSG : GATE_MSG)
  allow()
}
