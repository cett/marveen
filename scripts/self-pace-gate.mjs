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
  'sed', 'find', 'shellcheck', // sed, find: checked in readerOk below; shellcheck only prints
])
// READERS is a list of NAMES, and a name is not a promise: sort -o, uniq IN OUT, xxd IN OUT, sed's w
// command and file -C write files, rg --pre execs a program, find -fprint writes. readerOk() states
// per command what a plain read is; anything it cannot show safe is not a read. A pager (less, more,
// bat) can log (-o) or run commands, so none is listed.
const SAFE_GIT = new Set([
  'status', 'diff', 'log', 'show', 'blame', 'ls-files', 'add', 'grep', 'rev-parse', 'cat-file', 'check-ignore',
  'diff-tree', 'show-ref', 'ls-tree', 'shortlog', 'commit', 'diff-index', 'diff-files', 'rev-list', 'describe',
])
// R-IMPL (positive list): a git command whose working tree IS this install may run only what is on this
// list, SAFE_GIT plus the read / prepare forms below. Everything else (checkout, switch, merge, pull, reset,
// apply, stash pop, cherry-pick, rebase, clean, am, read-tree, checkout-index, revert, restore ... and every
// git subcommand that does not exist yet) rewrites the tree and is refused. A list of the WRITERS would
// always be one command behind; this one names what is allowed. Each entry below is checked further in
// gitInstallOk (fetch / ls-remote: no program-running option or ext:: URL; worktree: add | list; stash: list
// | show; branch / tag: listing flags only; remote: -v | get-url).
const INSTALL_GIT_EXTRA = new Set(['fetch', 'ls-remote', 'merge-base', 'for-each-ref', 'name-rev', 'show-branch', 'version', 'worktree', 'stash', 'branch', 'tag', 'remote', 'clone'])
const FETCH_FLAGS = new Set(['--all', '--prune', '--prune-tags', '--tags', '--no-tags', '--force', '--verbose', '--quiet', '--dry-run', '--jobs', '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--unshallow', '--no-recurse-submodules', '--recurse-submodules', '--progress', '--no-progress', '--atomic', '--append', '--filter', '--set-upstream', '--porcelain', '--ipv4', '--ipv6', '--no-write-fetch-head', '--write-fetch-head', '--refetch', '--no-auto-gc', '--no-auto-maintenance', '--multiple', '--no-show-forced-updates', '--show-forced-updates', '--negotiation-tip'])
const CLONE_FLAGS = new Set(['--bare', '--mirror', '--depth', '--quiet', '--verbose', '--no-checkout', '--branch', '-b', '--single-branch', '--no-single-branch', '--local', '--no-local', '--no-hardlinks', '--shared', '--progress', '--no-tags'])
const LS_REMOTE_FLAGS =new Set(['--heads', '--branches', '--tags', '--refs', '--get-url', '--symref', '--quiet', '--exit-code', '--sort'])
const WORKTREE_ADD_FLAGS = new Set(['-b', '--detach', '--no-checkout', '--checkout', '-q', '--quiet', '--track', '--no-track', '--guess-remote', '--no-guess-remote', '--lock', '--reason', '--orphan', '--relative-paths', '--no-relative-paths'])
const BRANCH_LIST_FLAGS = new Set(['--list', '-l', '--show-current', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--merged', '--no-merged', '--contains', '--no-contains', '--sort', '--format', '--points-at', '--column', '--no-column', '--color', '--no-color', '--abbrev', '--no-abbrev', '-i', '--ignore-case', '-n'])
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
export function splitShell(command) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  const segs = []; const seps = []; let cur = ''; let i = 0; let depth = 0; let q = null; let unterminated = false
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
          if (line.trim()) { segs.push(line); seps.push('\n') }
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
    if (c === '(' || c === ')') { push(); i++; continue }
    if ((c === '{' || c === '}') && (i === 0 || /\s/.test(src[i - 1])) && (i + 1 >= n || /\s/.test(src[i + 1]))) { push(); i++; continue }
    cur += c; i++
  }
  if (q || depth > 0) unterminated = true
  push()
  return { segs, seps, unterminated }
}
// Words and redirect targets of one simple command, unquoted and unescaped. `hasRedirect` = any
// redirect operator at all (including fd duplication and input).
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
      if (c === '"') {
        let j = i + 1
        while (j < n && seg[j] !== '"') { if (seg[j] === '\\' && j + 1 < n) { cur += seg[j + 1]; j += 2 } else { cur += seg[j]; j++ } }
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
  const vars = {}
  for (const m of String(command).matchAll(/(?:^|[\s;&|(])(?:export\s+|local\s+|declare\s+)?([A-Za-z_]\w*)=("([^"]*)"|'([^']*)'|[^\s;&|()]*)/g)) {
    vars[m[1]] = m[3] ?? m[4] ?? m[2]
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
  return { cwds: new Set([resolve(cwd)]), current: resolve(cwd), vars: collectVars(command), unknownCwd: false, prot, listing: null, cache: new Map(), installRoot: prot?.scriptsDir ? realOrSelf(dirname(prot.scriptsDir)) : null, topCache: new Map() }
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
      for (const cwd of ctx.cwds) {
        const w = expandWord(part, ctx.vars, cwd)
        if (!w) continue
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
        const spliced = [...words.slice(0, k), ...tokenizeShell(value).words, ...words.slice(k + used)]
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
    case 'find':
      if (args.some((a) => /^-(?:exec|execdir)$/.test(a))) return findExecReadersOk(args)
      return !args.some((a) => /^-(?:delete|ok|okdir|fprint\w*|fls)$/.test(a))
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
  if (cmd === 'git') return ['rm', 'mv', 'clean', 'checkout', 'restore', 'reset', 'stash', 'apply', 'am', 'worktree'].includes(gitSubcommand(args) ?? '')
  if (cmd === 'find') return !readerOk('find', args)
  if (INTERPRETERS.test(cmd)) return args.some((a) => INLINE_FLAGS.has(a))
  return false
}
// Index of the git subcommand in args (options and their separate values skipped), -1 when there is none.
function gitSubIndex(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { k++; continue }
    if (a.startsWith('-')) continue
    return k
  }
  return -1
}
function gitSubcommand(args) {
  const k = gitSubIndex(args)
  return k === -1 ? null : args[k]
}
// A safe git subcommand is safe only without an option that writes a file or runs a program:
// --output=FILE (and any abbreviation of it: git accepts --outp=), -c key=value / --config-env (core.pager,
// diff.external, alias.*), --exec-path, grep -O / --open-files-in-pager.
function gitSafe(args) {
  const sub = gitSubcommand(args)
  if (!SAFE_GIT.has(sub ?? '')) return false
  return gitOptionsSafe(args, sub)
}
function gitOptionsSafe(args, sub) {
  const subAt = gitSubIndex(args)
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (k < subAt) {
      if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') { k++; continue }
      if (a === '-c' || /^-c./.test(a) || /^--(config-env|exec-path|super-prefix)/.test(a)) return false
      continue
    }
    if (a === '--') break
    if (/^--ou/.test(a)) return false
    if (sub === 'grep' && (/^-O/.test(a) || /^--open/.test(a))) return false
  }
  return true
}
// --- R-IMPL: the IMPLICIT target of a command (its working tree) ----------------------------------------
// The gate above reads which protected path a segment SAYS. `git checkout other` says none, yet in the
// install it replaces the gate files with the other branch's. So for git (and patch) the question is
// WHERE the command writes: the tree of the repository found from the cwd (or from -C, --work-tree,
// GIT_WORK_TREE, GIT_DIR). When that tree is this install, only the positive list may run.
const lcPath = (p) => String(p).toLowerCase()
const isUnder = (p, root) => lcPath(p) === lcPath(root) || lcPath(p).startsWith(lcPath(root) + sep)
// Is `p` a git directory git would accept? Git's own test (setup.c is_git_directory): HEAD is a symref
// ('ref: refs/...') or a full object id (40 / 64 hex), and objects/ AND refs/ are directories; a linked
// worktree's own gitdir has no objects/ or refs/ of its own but a `commondir` file naming the shared one.
// Anything else is stepped over by git, so the gate steps over it too (an `objects/` plus a garbage HEAD
// made by hand must not turn an install subdirectory into a toplevel of its own).
// The `commondir` file is read the way git reads it: its content, relative to the gitdir, names the shared
// directory, and THAT must itself be a git directory with objects/ and refs/ (one level: no commondir chain).
const isGitDir = (p, viaCommon = false) => {
  const kind = (n) => { try { const s = statSync(join(p, n)); return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null } catch { return null } }
  if (kind('HEAD') !== 'file') return false
  let head
  try { head = readFileSync(join(p, 'HEAD'), 'utf8').slice(0, 512) } catch { return false }
  if (!/^ref:\s*refs\//.test(head) && !/^([0-9a-f]{40}|[0-9a-f]{64})\s*$/.test(head)) return false
  if (kind('objects') === 'dir' && kind('refs') === 'dir') return true
  if (viaCommon || kind('commondir') !== 'file') return false
  let common
  // exactly as git: the WHOLE content, only TRAILING whitespace cut (strbuf_rtrim), nothing at the front and no line
  // split: a leading blank or a second line stays in the path, which then names nothing and git steps over it
  // (git's isspace is the four ASCII characters blank, tab, CR and LF: JS \s would also cut NBSP, \v, \f, U+2028 ...)
  try { common = readFileSync(join(p, 'commondir'), 'utf8').replace(/[ \t\r\n]+$/, '') } catch { return false }
  return common !== '' && isGitDir(realOrSelf(resolve(p, common)), true)
}
// 'install' | true | false for the `.git` entry at `p`: a directory with HEAD and objects, a gitfile whose
// gitdir: line names a git directory, a symlink to either (resolved). 'install' when it leads to the install's
// own .git (not to .git/worktrees/NAME, which is a linked worktree's own).
function validGitEntry(p, ctx) {
  let st
  try { st = lstatSync(p) } catch { return false }
  let real = p
  if (st.isSymbolicLink()) { real = realOrSelf(p); try { st = statSync(real) } catch { return false } }
  let gd = real
  if (st.isFile()) {
    try { const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(real, 'utf8')); if (!m) return false; gd = realOrSelf(resolve(dirname(real), m[1].trim())) } catch { return false }
  } else if (!st.isDirectory()) return false
  if (!isGitDir(gd)) return false
  const instGit = ctx.installRoot ? join(ctx.installRoot, '.git') : null
  return instGit && isUnder(gd, instGit) && !isUnder(gd, join(instGit, 'worktrees')) ? 'install' : true
}
// The nearest ancestor directory holding a `.git` ENTRY, file or directory: the main checkout's .git is a
// directory, a linked worktree's is a file, so a worktree is its own toplevel and is never the install.
function gitToplevel(dir, ctx) {
  const cache = (ctx.topCache ??= new Map())
  if (cache.has(dir)) return cache.get(dir)
  let found = null
  for (let d = dir; ;) {
    // only a VALID .git counts: git steps over an empty .git directory or a file that is not a gitfile, so the
    // gate must too, else `mkdir agents/x/.git` turns an install subdirectory into a toplevel of its own
    const g = validGitEntry(join(d, '.git'), ctx)
    if (g === 'install') { found = ctx.installRoot; break } // a symlink / gitfile that leads to the install's own git directory
    if (g) { found = d; break }
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  cache.set(dir, found)
  return found
}
// Is the tree a git command would write, starting at real directory `dir`, the install? `explicit`: the
// tree was NAMED (--work-tree, GIT_WORK_TREE) or follows the cwd (GIT_DIR alone): it is then not looked
// up, and anything inside the install (or above it) counts, because files land there directly.
function treeIsInstall(dir, explicit, ctx) {
  const root = ctx.installRoot
  if (!root) return false
  if (explicit) return isUnder(dir, root) || isUnder(root, dir)
  const top = gitToplevel(dir, ctx)
  // no repository found: a git command there fails, except that one above the install would not be seen;
  // inside the install that is not worth the risk
  if (top === null) return isUnder(dir, root)
  // the install's own checkout, or a repository ABOVE it whose tree contains it
  if (lcPath(top) === lcPath(root) || isUnder(root, top)) return true
  // agents/ or agents/<name> with a repository of its own: its tree holds the agents' settings files
  return agentDirKind(top, ctx.prot) !== null
}
const UNKNOWN = Symbol('unknown path')
// `git ... SUB ...` positive list, see INSTALL_GIT_EXTRA. True: the command cannot rewrite the tree.
function gitInstallOk(args) {
  const at = gitSubIndex(args)
  if (at === -1) return true // `git`, `git --version`
  const sub = args[at]
  if (SAFE_GIT.has(sub)) return gitOptionsSafe(args, sub)
  if (!INSTALL_GIT_EXTRA.has(sub) || !gitOptionsSafe(args, sub)) return false
  const rest = args.slice(at + 1)
  // fetch / ls-remote: an ALLOWLIST of options, matched exactly (git accepts any unambiguous prefix of a long
  // option, so a deny-pattern for --upload-pack would miss --upload-p=); a remote URL with a helper (ext::) runs a program
  if (sub === 'fetch' || sub === 'ls-remote') {
    const flags = sub === 'fetch' ? FETCH_FLAGS : LS_REMOTE_FLAGS
    return rest.every((a) => (a.startsWith('--') ? flags.has(a.split('=')[0]) : a.startsWith('-') && a.length > 1 ? (sub === 'fetch' ? /^-(?:[pPtfvqak46n]+|j\d*)$/ : /^-[htqb]+$/).test(a) : !a.includes('::')))
  }
  // clone writes only its destination (a path that names a protected one is refused by name); no template,
  // config, upload-pack or helper URL
  if (sub === 'clone') return rest.every((a) => (a.startsWith('-') ? CLONE_FLAGS.has(a.split('=')[0]) || /^-[qvsln]+$/.test(a) : !a.includes('::')))
  if (sub === 'worktree') {
    if (rest[0] === 'list') return true
    // add only, and not --force / -B (a branch checked out elsewhere could be reset)
    return rest[0] === 'add' && rest.slice(1).every((a) => !a.startsWith('-') || WORKTREE_ADD_FLAGS.has(a.split('=')[0]))
  }
  if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show'
  if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && rest[0] === '-v') || rest[0] === 'get-url'
  if (sub === 'branch' || sub === 'tag') {
    // listing only: every option is a listing / formatting one; a bare name (which would create a ref)
    // is only a pattern next to --list
    const listing = rest.some((a) => a === '--list' || a === '-l' || a === '--show-current')
    for (const a of rest) {
      if (a.startsWith('-')) { if (!BRANCH_LIST_FLAGS.has(a.split('=')[0])) return false } else if (!listing) return false
    }
    return true
  }
  return true
}
// Does `git` (or `patch`) with these args and env words, run from `base` (null = a cwd we could not resolve),
// write the tree of this install? UNKNOWN anywhere is yes: the target cannot be shown to be elsewhere.
function commandTargetsInstall(cmd, args, envWords, base, ctx) {
  let dir = base
  let tree = null; let gitDir = null
  const abs = (v) => {
    if (v === undefined) return UNKNOWN
    const w = expandWord(v, ctx.vars, dir ?? '/')
    if (/[$`*?[]/.test(w)) return UNKNOWN
    if (isAbsolute(w)) return w
    return dir === null ? UNKNOWN : join(dir, w)
  }
  // GIT_DIR / GIT_WORK_TREE set earlier in the same command (`export GIT_DIR=...; git ...`) apply as well
  for (const n of ['GIT_DIR', 'GIT_WORK_TREE']) if (ctx.vars?.[n]) { if (n === 'GIT_DIR') gitDir = abs(ctx.vars[n]); else tree = abs(ctx.vars[n]) }
  for (const w of envWords) {
    const m = /^GIT_(WORK_TREE|DIR)=(.*)$/.exec(w)
    if (m) { if (m[1] === 'DIR') gitDir = abs(m[2]); else tree = abs(m[2]) }
  }
  if (cmd !== 'git') {
    // patch -d, tar -C, unzip -d: the directory the command works in
    const w = workDirOf(cmd, args)
    if (w === UNKNOWN) dir = null
    else if (w !== undefined) { const v = abs(w); dir = v === UNKNOWN ? null : v }
  } else {
    const upto = gitSubIndex(args) === -1 ? args.length : gitSubIndex(args)
    for (let k = 0; k < upto; k++) {
      const a = args[k]
      if (a === '-C') { const v = abs(args[++k]); dir = v === UNKNOWN ? null : v; continue }
      if (a === '--work-tree') { tree = abs(args[++k]); continue }
      if (a.startsWith('--work-tree=')) { tree = abs(a.slice(12)); continue }
      if (a === '--git-dir') { gitDir = abs(args[++k]); continue }
      // -c core.worktree=DIR names the work tree like --work-tree does
      if (a === '-c' && /^core\.worktree=/i.test(args[k + 1] ?? '')) { tree = abs(args[++k].slice(14)); continue }
      if (a.startsWith('--git-dir=')) { gitDir = abs(a.slice(10)); continue }
    }
  }
  if (tree === UNKNOWN || gitDir === UNKNOWN) return true
  const real = (p) => realOrSelf(resolve(p))
  // a git directory inside the install's own .git moves its HEAD and index even from a worktree
  // (resolved through symlinks and through a `.git` FILE that points at the real git directory); the own git
  // directory of a linked worktree, .git/worktrees/NAME, is that worktree's and stays fine
  if (gitDir !== null && ctx.installRoot) {
    let gd = real(gitDir)
    try { if (statSync(gd).isFile()) { const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gd, 'utf8')); if (m) gd = real(resolve(dirname(gd), m[1].trim())) } } catch { /* not there: judged as spelled */ }
    const instGit = join(ctx.installRoot, '.git')
    if (isUnder(gd, instGit) && !isUnder(gd, join(instGit, 'worktrees'))) return true
  }
  // an explicit work tree inside (or above) the install is written directly
  if (tree !== null && treeIsInstall(real(tree), true, ctx)) return true
  if (dir === null) return true
  // the git directory is the one found from the cwd unless GIT_DIR / --git-dir names it; with the install's
  // own, the command moves its HEAD and index even when the files it writes are elsewhere
  if (gitDir === null) return treeIsInstall(real(dir), false, ctx)
  return tree === null && treeIsInstall(real(dir), true, ctx)
}
// The decision for one segment: a git command that is off the positive list, or a patch that is not a dry
// run, whose tree is the install. `bases`: the directories the segment may run in. null = no objection.
function implicitTreeDecision(cmd, words, ci, bases, ctx) {
  let args = words.slice(ci + 1)
  if (cmd === 'xargs') {
    // the file list comes from stdin and cannot be read: what xargs RUNS decides, and the tree is the cwd's.
    // A command with an implicit target is judged exactly as if it were typed (`xargs git checkout`, -C included).
    const inner = xargsInner(args)
    if (!inner) return null
    const name = inner[0].split('/').pop()
    if (IMPLICIT_CMDS.has(name) && name !== 'xargs') return implicitTreeDecision(name, inner, 0, bases, ctx)
    if (!destructiveCmd(name, inner.slice(1))) return null
    args = []
  } else if (cmd === 'tar') {
    // an unreadable tar line is treated as an extraction; one that NAMES its directory (-C) is judged by that
    // path like any other word (a member path is relative to it, so it cannot reach a protected path from elsewhere)
    const t = tarParse(args)
    if (t && (t.mode !== 'x' || t.dirVals.length)) return null
  } else if (cmd === 'unzip') {
    // a -d DIR that is its own word is judged by that path like any other word; one ATTACHED to the flags
    // (-qdDIR) is no word of its own (the word reader only strips one letter), so the directory it names is read here:
    // a protected path is denied, any other named directory is the command's own business
    if (!unzipExtracts(args)) return null
    const ud = unzipDir(args)
    if (ud && !ud.attached) return null
    if (ud && /[$`*?[]/.test(ud.dir)) { /* unreadable target: fall through to the tree of the base */ }
    else if (ud) { const k = wordKind(ud.dir, ctx); return k ? { deny: true, reason: isAnc(k) ? k.split(':')[1] : k } : null }
  } else if (cmd === 'git' ? gitInstallOk(args) : patchIsDry(args)) return null
  const env = words.slice(0, ci)
  for (const b of bases) if (commandTargetsInstall(cmd, args, env, b, ctx)) return { deny: true, reason: 'install-tree' }
  return null
}
const IMPLICIT_CMDS = new Set(['git', 'patch', 'xargs', 'tar', 'unzip'])
// Most inner evaluations (a text command judged in one directory) one command may cost; see the nested-text loop.
const INNER_EVAL_BUDGET = 100
// The command behind wrappers: `nice -n 5 git checkout x` has the command word 5 for commandWordIndex. Returns
// { gi, cmd, chdir } for the first IMPLICIT_CMDS word that follows a wrapper word, or null.
function effectiveCommand(words, ci) {
  const name = (i) => String(words[i] ?? '').split('/').pop()
  let w = -1
  for (let i = 0; i < words.length; i++) {
    if (/^[A-Za-z_]\w*=/.test(words[i])) continue
    if (WRAPPER_WORDS.has(name(i)) || name(i) === 'timeout') w = i
    break
  }
  if (w === -1) return null
  for (let gi = w + 1; gi < words.length; gi++) {
    if (!IMPLICIT_CMDS.has(name(gi))) continue
    if (gi === ci) return null // commandWordIndex already saw it
    const chdir = words.slice(w + 1, gi).some((x) => x === '-C' || x === '-D' || x === '--chdir' || x.startsWith('--chdir='))
    return { gi, cmd: name(gi), chdir }
  }
  return null
}
// The commands a segment hands over as text: sh -c STRING, eval STRING, find -exec CMD ARGS ;, $(CMD), `CMD`.
function innerCommandTexts(cmd, words, ci, seg) {
  const out = []
  const args = ci === -1 ? [] : words.slice(ci + 1)
  if (/^(?:bash|sh|zsh|dash|ksh)$/.test(cmd)) {
    const k = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a))
    const s = k === -1 ? undefined : args.slice(k + 1).find((a) => !a.startsWith('-'))
    if (s !== undefined) out.push(s)
  } else if (cmd === 'eval') out.push(args.join(' '))
  else if (cmd === 'find') {
    for (let k = 0; k < args.length; k++) {
      if (args[k] !== '-exec' && args[k] !== '-execdir') continue
      const inner = []
      for (k++; k < args.length && !isExecEnd(args, k); k++) inner.push(args[k])
      if (inner.length) out.push(inner.join(' '))
    }
  }
  for (const m of String(seg).matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) out.push(m[1] ?? m[2])
  return out
}
// unzip -d DIR, also bundled (-qd DIR, -od DIR, -jd DIR, -qdDIR); the value of -x / -P / -O / -I is skipped, so
// `unzip -P -d out/ok.zip` (password "-d") is an extraction into the cwd. { dir, attached } or null (no -d).
function unzipDir(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (!a.startsWith('-') || a.length < 2 || a.startsWith('--')) continue
    for (let q = 1; q < a.length; q++) {
      const c = a[q]
      if (c === 'd') return q + 1 < a.length ? { dir: a.slice(q + 1), attached: true } : { dir: args[k + 1] ?? UNKNOWN, attached: false }
      if ('xPOI'.includes(c)) { if (q + 1 >= a.length) k++; break }
    }
  }
  return null
}
// The directory a non-git command works in: patch -d DIR, tar -C DIR, unzip -d DIR. undefined: the cwd.
function workDirOf(cmd, args) {
  if (cmd === 'tar') {
    const t = tarParse(args)
    if (t) return t.dirVals.length ? t.dirVals[t.dirVals.length - 1] : undefined
    // A line the parser does not understand (--sort, --exclude-caches, -xPf ...) unpacks into the cwd unless it names
    // a directory: the cwd tree decides. A -C inside a bundle (`-xCf DIR`, `xCf DIR`) hides its value: that stays unknown.
    let dir
    for (let k = 0; k < args.length; k++) {
      const a = args[k]
      // --directory and every prefix of it (getopt), and bsdtar's --cd, with the value attached or in the next word
      const long = /^--(?:d(?:i(?:r(?:e(?:c(?:t(?:o(?:r(?:y)?)?)?)?)?)?)?)?|cd)(?:=|$)/.test(a)
      if (a === '-C' || (long && !a.includes('='))) dir = args[++k] ?? UNKNOWN
      else if (long) dir = a.slice(a.indexOf('=') + 1)
      else if (/^-C./.test(a)) dir = a.slice(2)
      else if (/^-[A-Za-z]*C/.test(a) || (k === 0 && /^[A-Za-z]*C[A-Za-z]*$/.test(a))) return UNKNOWN
    }
    return dir
  }
  if (cmd === 'unzip') return unzipDir(args)?.dir
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '-d' || (cmd === 'patch' && a === '--directory')) return args[k + 1] ?? UNKNOWN
    if (a.startsWith('--directory=')) return a.slice(12)
    if (/^-d./.test(a) && !a.startsWith('--') && cmd === 'patch') return a.slice(2)
  }
  return undefined
}
// unzip extracts unless it only lists, tests or pipes (-l -t -p -v -Z).
function unzipExtracts(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (!a.startsWith('-') || a.length < 2 || a.startsWith('--')) continue
    for (let q = 1; q < a.length; q++) {
      // a value letter (-d DIR, -x LIST ...) ends the flags of the bundle: what follows is its value, not l / t / p
      if ('dxPOI'.includes(a[q])) { if (q + 1 >= a.length) k++; break }
      if ('ltpvZ'.includes(a[q])) return false
    }
  }
  return true
}
// `xargs [options] CMD ARGS`: does CMD remove, move or rewrite what it is handed?
const XARGS_VALUE_OPTS = new Set(['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '-J', '--max-args', '--max-procs', '--delimiter', '--max-lines', '--max-chars', '--eof', '--arg-file', '--replace'])
// The words of the command xargs runs, starting at its command word (null: none).
function xargsInner(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a.startsWith('-') && a.length > 1) { if (XARGS_VALUE_OPTS.has(a)) k++; continue }
    const inner = spliceEnvSplit(args.slice(k))
    const ik = commandWordIndex(inner)
    return ik === -1 ? null : inner.slice(ik)
  }
  return null
}
// patch only reads under --dry-run or -C / --check, as an OPTION: the value of -o / -r / -i / -d ... may look like one.
const PATCH_VALUE_LONG = new Set(['--suffix', '--prefix', '--basename-prefix', '--version-control', '--reject-file', '--global-reject-file', '--read-only', '--debug', '--output', '--input', '--directory', '--ifdef', '--fuzz', '--strip', '--get', '--quoting-style'])
// getopt_long accepts an unambiguous ABBREVIATION (--ou is --output and takes the next word as its value), so a long
// option that is not spelled in full cannot be told from a value-taking one: it makes the command not-a-dry-run.
const PATCH_FLAG_LONG = new Set(['--dry-run', '--check', '--backup', '--backup-if-mismatch', '--no-backup-if-mismatch', '--batch', '--binary', '--context', '--ed', '--force', '--forward', '--ignore-whitespace', '--merge', '--normal', '--posix', '--quiet', '--silent', '--remove-empty-files', '--reverse', '--unified', '--verbose', '--version', '--help', '--set-time', '--set-utc', '--follow-symlinks'])
function patchIsDry(args) {
  let dry = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '--') break
    if (a.startsWith('--')) {
      const n = a.split('=')[0]
      if (!PATCH_FLAG_LONG.has(n) && !PATCH_VALUE_LONG.has(n)) return false
      if (n === '--dry-run' || n === '--check') dry = true
      else if (PATCH_VALUE_LONG.has(n) && !a.includes('=')) k++
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let q = 1; q < a.length; q++) {
        if (a[q] === 'C') dry = true
        if ('zBYVroidDFpg'.includes(a[q])) { if (q + 1 >= a.length) k++; break }
      }
    }
  }
  return dry
}
// --- R-SINK: the ROLE of an operand --------------------------------------------------------------------
// cp, install, rsync, tar, unzip and dd name two kinds of path: the ones they READ (sources, the archive
// they unpack) and the ones they WRITE (the destination, the archive they create, -C / -d). A protected
// path that is only read is not a write; copying the gate files out, archiving the tree, listing an
// archive are fine. The destination, an unreadable operand and everything not understood stay as before.
// mv and ln are deliberately NOT here: the source of a mv disappears, and a hard link or symlink to a
// protected file lets a later write through the other name reach it.
//
// Each function returns the Set of indices into `args` that are PURE sources, or null: no relief.
const CP_VALUE_SHORT = { cp: 'tS', install: 'tSmog' }
const CP_VALUE_LONG = new Set(['--suffix', '--mode', '--owner', '--group', '--context'])
const CP_FLAG_LONG = new Set(['--recursive', '--archive', '--force', '--verbose', '--preserve', '--no-preserve', '--no-clobber', '--update', '--dereference', '--no-dereference', '--no-target-directory', '--interactive', '--backup', '--attributes-only', '--reflink', '--sparse', '--one-file-system', '--strip-trailing-slashes', '--debug', '--copy-contents', '--preserve-timestamps', '--compare'])
function cpSources(cmd, args) {
  let targetDir = false; const operands = []; let opts = true
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (opts && a === '--') { opts = false; continue }
    if (opts && a.startsWith('--')) {
      // an ALLOWLIST of long options, matched exactly (getopt takes any unambiguous prefix, so a deny-pattern for
      // --link would miss --lin): links alias the source, anything else unknown is not understood
      const n = a.split('=')[0]; const attached = a.includes('=')
      if (n === '--target-directory') { targetDir = true; if (!attached) k++ } else if (CP_VALUE_LONG.has(n)) { if (!attached) k++ } else if (!CP_FLAG_LONG.has(n)) return null
      continue
    }
    if (opts && a.startsWith('-') && a.length > 1) {
      for (let q = 1; q < a.length; q++) {
        const c = a[q]
        if (c === 'l' || c === 's' || (cmd === 'install' && c === 'd')) return null // link / make-directory forms
        if (CP_VALUE_SHORT[cmd].includes(c)) { if (c === 't') targetDir = true; if (q + 1 >= a.length) k++; break }
      }
      continue
    }
    operands.push(k)
  }
  if (targetDir) return new Set(operands)
  return operands.length >= 2 ? new Set(operands.slice(0, -1)) : null
}
// rsync SRC... DEST: the last operand is written. Anything that removes or rewrites the SOURCE
// (--remove-source-files) is no relief. The options that take a separate value are listed so that a value
// (or a trailing `--exclude x`) is never mistaken for the destination.
const RSYNC_VALUE_LONG = new Set(['--exclude', '--include', '--exclude-from', '--include-from', '--files-from', '--filter', '--rsh', '--rsync-path', '--port', '--sockopts', '--max-size', '--min-size', '--timeout', '--contimeout', '--bwlimit', '--chmod', '--chown', '--usermap', '--groupmap', '--suffix', '--backup-dir', '--partial-dir', '--temp-dir', '--compare-dest', '--copy-dest', '--link-dest', '--log-file', '--log-file-format', '--out-format', '--skip-compress', '--checksum-seed', '--block-size', '--modify-window', '--max-delete', '--compress-level', '--protocol', '--address', '--password-file', '--write-batch', '--read-batch', '--only-write-batch', '--iconv', '--info', '--debug', '--stop-after', '--stop-at', '--outbuf', '--early-input', '--copy-as', '--remote-option', '--checksum-choice', '--compress-choice', '--bwlimit'])
const RSYNC_FLAG_LONG = new Set(['archive', 'recursive', 'verbose', 'quiet', 'dry-run', 'compress', 'times', 'perms', 'links', 'owner', 'group', 'devices', 'specials', 'human-readable', 'progress', 'stats', 'delete', 'delete-before', 'delete-during', 'delete-after', 'delete-delay', 'delete-excluded', 'update', 'checksum', 'copy-links', 'copy-dirlinks', 'keep-dirlinks', 'safe-links', 'ignore-existing', 'existing', 'whole-file', 'itemize-changes', 'relative', 'one-file-system', 'numeric-ids', 'partial', 'inplace', 'backup', 'list-only', 'prune-empty-dirs', 'hard-links', 'xattrs', 'acls', 'executability', 'dirs', 'mkpath', 'fuzzy', 'size-only', 'ignore-times', 'append', 'append-verify', 'sparse', 'cvs-exclude', 'from0', 'protect-args', 'super', 'force', 'ignore-errors', 'no-motd', 'omit-dir-times', 'atimes', 'ipv4', 'ipv6', 'info', 'debug', 'bwlimit'])
function rsyncSources(args) {
  const operands = []; let opts = true
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (opts && a === '--') { opts = false; continue }
    if (opts && a.startsWith('--')) {
      if (/^--remove-(source|sent)-files/.test(a)) return null
      if (a.includes('=')) continue // an attached value cannot be mistaken for an operand
      if (RSYNC_VALUE_LONG.has(a)) { k++; continue }
      // a flag, or a value-taking option this list does not know (its value would pass for an operand)
      if (!RSYNC_FLAG_LONG.has(a.slice(2).replace(/^no-/, ''))) return null
      continue
    }
    if (opts && a.startsWith('-') && a.length > 1) {
      for (let q = 1; q < a.length; q++) {
        const c = a[q]
        if ('efTBMFf'.includes(c)) { if (q + 1 >= a.length) k++; break } // -e CMD, -f RULE, -T DIR, -B N, -M OPT take a value
        if (!'avzrtplgoDHXASxnhPuicqLkKWmUNyEdbV'.includes(c)) return null
      }
      continue
    }
    operands.push(k)
  }
  return operands.length >= 2 ? new Set(operands.slice(0, operands.length - 1)) : null
}
// tar: c (create): the operands are read, the -f archive is written; t / d (list, compare): everything is
// read; x (extract): the archive is read, the tree it unpacks into (-C, or the cwd) is written. Anything
// that runs a program or removes sources (--remove-files, --to-command, -I ...), or is not understood, is no relief.
const TAR_MODES = { c: 'c', x: 'x', t: 't', d: 'd', create: 'c', extract: 'x', get: 'x', list: 't', diff: 'd', compare: 'd' }
// no P (--absolute-names: members keep their absolute path) and no M (multi-volume)
const TAR_PLAIN_SHORT = 'vzjJaZphkmOwUSslon'
const TAR_FLAG_LONG = new Set(['verbose', 'gzip', 'gunzip', 'ungzip', 'bzip2', 'xz', 'lzma', 'zstd', 'auto-compress', 'preserve-permissions', 'same-permissions', 'keep-newer-files', 'touch', 'one-file-system', 'dereference', 'hard-dereference', 'sparse', 'numeric-owner', 'no-same-owner', 'same-owner', 'totals', 'exclude-vcs', 'ignore-failed-read', 'no-recursion', 'recursion', 'null', 'no-anchored', 'anchored', 'wildcards', 'no-wildcards', 'ignore-case', 'no-ignore-case', 'show-transformed-names', 'warning', 'quiet', 'sort', 'format'])
const TAR_VALUE_SHORT = 'fCTXbLN'
const TAR_VALUE_LONG = new Set(['--file', '--directory', '--files-from', '--exclude-from', '--exclude', '--transform', '--xform', '--strip-components', '--owner', '--group', '--mode', '--blocking-factor', '--newer', '--newer-mtime', '--label', '--suffix', '--index-file', '--tape-length', '--ignore-command-error'])
function tarParse(args) {
  let mode = ''; let archive = -1; const operands = []; const dirIdx = new Set(); const valueIdx = new Set(); const dirVals = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    const oldStyle = k === 0 && /^[A-Za-z]+$/.test(a)
    if (a.startsWith('--') && a.length > 2) {
      const name = a.split('=')[0]
      if (TAR_MODES[name.slice(2)]) { mode ||= TAR_MODES[name.slice(2)]; continue }
      if (/^--(remove-files|to-command|use-compress-program|checkpoint-action|rmt-command|rsh-command|info-script|new-volume-script|append|update|catenate|concatenate|delete|overwrite-dir|one-top-level)/.test(name)) return null
      if (TAR_VALUE_LONG.has(name)) {
        const attached = a.includes('=')
        const vi = attached ? k : ++k
        if (name === '--file') archive = vi
        else if (name === '--directory') { dirIdx.add(vi); dirVals.push(attached ? a.slice(a.indexOf('=') + 1) : args[vi] ?? UNKNOWN) }
        else valueIdx.add(vi)
      } else if (!TAR_FLAG_LONG.has(name.slice(2))) return null // an unknown or abbreviated long option is not understood
      continue
    }
    if (oldStyle || (a.startsWith('-') && a.length > 1)) {
      const letters = oldStyle ? a : a.slice(1)
      const pending = []
      for (let q = 0; q < letters.length; q++) {
        const c = letters[q]
        if (TAR_MODES[c] && c.length === 1) { mode ||= TAR_MODES[c]; continue }
        if (TAR_VALUE_SHORT.includes(c)) {
          // `-CDIR` / `-fFILE`: the rest of a dashed bundle is the value; in the old style word the values follow as arguments
          if (!oldStyle && q + 1 < letters.length) {
            if (c === 'f') archive = k
            else if (c === 'C') { dirIdx.add(k); dirVals.push(letters.slice(q + 1)) } else valueIdx.add(k)
            break
          }
          pending.push(c); continue
        }
        if (TAR_PLAIN_SHORT.includes(c)) continue
        return null
      }
      for (const c of pending) {
        const vi = ++k
        if (c === 'f') archive = vi
        else if (c === 'C') { dirIdx.add(vi); dirVals.push(args[vi] ?? UNKNOWN) } else valueIdx.add(vi)
      }
      continue
    }
    operands.push(k)
  }
  return { mode, archive, operands, dirIdx, valueIdx, dirVals }
}
function tarSources(args) {
  const t = tarParse(args)
  if (!t || !t.mode) return null
  // the operands and the -C directory are read; the value of any other option (--index-file writes, -T / -X read a
  // list) is not counted as a source
  const reads = new Set([...t.operands, ...t.dirIdx])
  if (t.mode === 't' || t.mode === 'd') { if (t.archive !== -1) reads.add(t.archive); return reads }
  if (t.mode === 'x') return t.archive === -1 ? null : new Set([t.archive])
  // create: the archive file is the only thing written
  return t.archive === -1 && args.some((a) => /^-[A-Za-z]*f/.test(a)) ? null : reads
}
// unzip [-d DIR] ARCHIVE [MEMBERS] [-x LIST]: the archive is read; -d DIR is written; -l -t -p -v -Z only read.
function unzipSources(args) {
  const src = new Set(); let archiveSeen = false; let readOnly = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a.startsWith('-') && a.length > 1) {
      for (let q = 1; q < a.length; q++) {
        const c = a[q]
        if ('ltpvZ'.includes(c)) readOnly = true
        if ('dxPOI'.includes(c)) { if (q + 1 >= a.length) k++; break }
      }
      continue
    }
    if (!archiveSeen) { src.add(k); archiveSeen = true }
  }
  if (readOnly) return new Set(args.map((_, k) => k))
  return archiveSeen ? src : null
}
// dd if=SRC of=DEST: only the if= word is read.
function ddSources(args) {
  const src = new Set()
  args.forEach((a, k) => { if (a.startsWith('if=')) src.add(k) })
  return src
}
function roleSources(cmd, args) {
  switch (cmd) {
    case 'cp': case 'install': return cpSources(cmd, args)
    case 'rsync': return rsyncSources(args)
    case 'tar': return tarSources(args)
    case 'unzip': return unzipSources(args)
    case 'dd': return ddSources(args)
    default: return null
  }
}
// True when every protected word of the segment sits at a position the command only READS.
function onlyReadsProtected(cmd, words, ci, kinds, rKinds) {
  const src = roleSources(cmd, words.slice(ci + 1))
  if (!src || rKinds.some(Boolean)) return false
  // A word that is not a source (the destination, a -t / -f value, the last operand) and holds an unresolved
  // variable may expand to NOTHING: then the word before it becomes the destination (`cp out/f scripts/hooks/x $E`,
  // `cp -t $E scripts/hooks out/f`, `tar -cf $E scripts/hooks/x.tar src`) and the protected path is written, not read.
  for (let j = ci + 1; j < words.length; j++) if (!src.has(j - ci - 1) && /[$`]/.test(words[j])) return false
  for (let j = 0; j < words.length; j++) if (kinds[j] && (j <= ci || !src.has(j - ci - 1))) return false
  return true
}
// `find ... -exec CMD ARGS ;` runs CMD on each match: a find whose actions are all -exec / -execdir of a plain
// reader is a read; a writer (rm, sh -c ...) or any other action that writes keeps find out of the readers.
// `;` ends a find -exec; `+` only does so right after `{}` (anywhere else it is an argument of the command)
const isExecEnd = (args, k) => args[k] === ';' || args[k] === '\\;' || (args[k] === '+' && args[k - 1] === '{}')
function findExecReadersOk(args) {
  let sawExec = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (/^-(?:delete|ok|okdir|fprint\w*|fls)$/.test(a)) return false
    if (a !== '-exec' && a !== '-execdir') continue
    sawExec = true
    const inner = []
    for (k++; k < args.length && !isExecEnd(args, k); k++) inner.push(args[k])
    if (k >= args.length) return false // unterminated
    const name = (inner[0] ?? '').split('/').pop()
    if (!READERS.has(name) || name === 'find' || name === 'sed' || name === 'cd' || !readerOk(name, inner.slice(1))) return false
  }
  return sawExec
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
  const { segs, seps, unterminated } = splitShell(command)
  const feedsNonReader = (idx) => {
    if (seps[idx] !== '|' || idx + 1 >= segs.length) return false
    const nw = spliceEnvSplit(tokenizeShell(segs[idx + 1]).words)
    const nc = commandWordIndex(nw)
    const name = nc === -1 ? '' : nw[nc].split('/').pop()
    return !(READERS.has(name) || name === 'tee')
  }
  // After `cd X &&` the next command of the chain runs in X only (a failed cd stops the chain); after any
  // other separator the old directory may still be the current one (a failed `cd X;`, a subshell), so the
  // directories visited so far all count. `narrow` holds X while the chain of && lasts.
  let narrow = null
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si]
    if (si > 0 && seps[si - 1] !== '&&') narrow = null
    const tokenized = tokenizeShell(seg)
    const { redirects, hasRedirect } = tokenized
    const words = spliceEnvSplit(tokenized.words)
    const kinds = words.map((w) => wordKind(w, ctx))
    const rKinds = redirects.map((r) => wordKind(r, ctx))
    // `cd` moves the base of every later relative word (conservatively: the old base stays too).
    const ci = commandWordIndex(words)
    const cmd = ci === -1 ? '' : words[ci].split('/').pop()
    if (cmd === 'cd' || cmd === 'pushd') {
      // (a lone `-` is the previous directory, not an option)
      const arg = words.slice(ci + 1).find((a) => !(a.startsWith('-') && a.length > 1))
      const target = arg === undefined ? homedir() : expandWord(arg, ctx.vars, ctx.current)
      // `cd -`, `cd ~-` and `cd ~+` go to a directory this reading does not know
      if (arg === '-' || /^~[-+]/.test(arg ?? '') || target.includes('$') || /[*?[`]/.test(target)) { ctx.unknownCwd = true; narrow = null }
      else {
        ctx.current = resolve(ctx.current, target); ctx.cwds.add(ctx.current); ctx.cwds.add(realOrSelf(ctx.current))
        // the chain narrows to the new directory only when the target cannot be redirected: an absolute path or
        // ./ ../ (a plain relative name is looked up in CDPATH first)
        narrow = arg === undefined || isAbsolute(target) || /^\.\.?(\/|$)/.test(target) ? new Set([ctx.current, realOrSelf(ctx.current)]) : null
      }
    }
    // popd returns to a directory of the stack that is not tracked: the visited ones all count again
    if (cmd === 'popd') narrow = null
    if (cmd === 'cp') {
      const ck = copyIntoDirKind(words.slice(ci + 1), ctx)
      if (ck) return { deny: true, reason: ck }
    }
    const hit = kinds.find((k) => k && !isAnc(k)) ?? rKinds.find((k) => k && !isAnc(k)) ?? null
    const ancKinds = [...kinds, ...rKinds].filter(isAnc)
    const ancestorHit = !hit && ancKinds.length > 0
    // R-IMPL: a git / patch / xargs command is judged by the tree it writes, whether or not it names a path.
    // A segment that also names a protected path keeps the reason of that path (the more specific message).
    // A wrapper with a value option (nice -n 5, timeout 5, env -C DIR, sudo -u U) hides the real command word
    // from commandWordIndex, so the command is looked for behind the wrapper.
    const eff = effectiveCommand(words, ci)
    const icmd = eff ? eff.cmd : cmd; const ici = eff ? eff.gi : ci
    const bases = narrow ? [...narrow] : [...ctx.cwds, ...(ctx.unknownCwd ? [null] : [])]
    if (IMPLICIT_CMDS.has(icmd)) {
      const d = implicitTreeDecision(icmd, words, ici, eff?.chdir ? [...bases, null] : bases, ctx)
      if (d) return { deny: true, reason: hit ?? (ancestorHit ? ancKinds[0].split(':')[1] : d.reason) }
    }
    // Commands handed over as text (sh -c STR, eval STR, find -exec CMD, $(CMD), `CMD`) are judged as commands of
    // their own, in every directory the segment may run in.
    for (const text of innerCommandTexts(cmd, words, ci, seg)) {
      const depth = opts._depth ?? 0
      if (depth >= 3) { if (/\b(?:git|patch|tar|unzip)\b/.test(text)) return { deny: true, reason: 'install-tree' }; continue }
      // Every level multiplies the work by the number of directories the text visited, so the bases are de-duplicated
      // by real path and ONE counter bounds the inner evaluations of a command: past it the command is refused with
      // a plain reason (fail closed), well inside the hook's time limit.
      const budget = opts._budget ?? { n: 0 }
      const seenBase = new Set()
      for (const b of bases) {
        const key = b === null ? '\0' : lcPath(realOrSelf(b))
        if (seenBase.has(key)) continue
        seenBase.add(key)
        if (++budget.n > INNER_EVAL_BUDGET) return { deny: true, reason: 'eval-budget' }
        const d = bashProtectedDecision(text, { ...opts, prot, cwd: b ?? ctx.current, _depth: depth + 1, _budget: budget })
        if (d.deny) return d
      }
    }
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
    // R-SINK: a protected path that the command only READS (the source of a copy, the archive it lists or
    // unpacks, `if=` of dd) is not a write; the destination and everything not understood keep the rules below.
    if (!envUnsafe && onlyReadsProtected(cmd, words, ci, kinds, rKinds)) continue
    if (ancestorHit) {
      if (READERS.has(cmd) && readerOk(cmd, args, ctx) && !feedsNonReader(si) && !envUnsafe) continue
      // a safe git subcommand with a protected pathspec (`git log -- scripts`) reads
      if (cmd === 'git' && gitSafe(args) && !envUnsafe) continue
      if (!ancKinds.some((k) => k.startsWith('anc-strict')) && !destructiveCmd(cmd, args)) continue
      // agents/ and agents/<name> alone: only an operation that can put a settings file in (or take the
      // directory away) is refused
      if (ancKinds.every((k) => k.startsWith('anc-agentdir'))) {
        const agentWords = kinds.map((k, idx) => (typeof k === 'string' && k.startsWith('anc-agentdir') ? idx : -1)).filter((idx) => idx !== -1)
        if (agentDirOpHarmless(cmd, words, ci, agentWords, ctx)) continue
      }
      return deny()
    }
    // 5. plain reads
    // (a reader whose output is piped into anything but another reader may be handing paths to xargs / sh)
    if (READERS.has(cmd) && readerOk(cmd, args, ctx) && !envUnsafe) { if (feedsNonReader(si)) return deny(); continue }
    if (cmd === 'git' && gitSafe(args) && !envUnsafe) continue
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

const GIT_TREE_MSG =
  'Git-muvelet az install munkafajan (governance hard-gate). Ennek a telepitesnek a fajlait (kapuk, hookok, scriptek, ' +
  'beallitasok) egy git checkout / switch / merge / pull / reset / apply / stash pop / cherry-pick / rebase / clean / am / ' +
  'revert, vagy egy patch egy masik ag tartalmara cserelne, a parancs kimondott utja nelkul is. Az install gyokereben es az ' +
  'agens-konyvtarban csak olvaso git szabad (status, diff, log, show, blame, grep, ls-files, add, commit, fetch, worktree add / list ...). ' +
  'A fejleszteshez kulon worktree kell: git worktree add ~/worktrees/<tema> -b <ag> origin/develop, es abban dolgozz (cd ~/worktrees/<tema> && git ...). ' +
  'Valtozo-bol osszeallitott cd celnal a kapu a celt nem latja: irj literalis utat.'
const EVAL_BUDGET_MSG =
  'A parancs tul sok egymasba agyazott szoveg-parancsot (eval, sh -c, $(...)) es cd-t tartalmaz ahhoz, hogy a kapu ' +
  'idoben atvizsgalja (governance hard-gate), es egy atvizsgalhatatlan parancs nem mehet at. Bontsd szet kisebb ' +
  'lepesekre, vagy irj scriptet a Write tool-lal es futtasd azt.'
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
  if (shouldDeny) deny(reason === 'too-large' ? TOO_LARGE_MSG : reason === 'egress-allowlist' ? ALLOWLIST_GATE_MSG : reason === 'gate-scripts' ? SCRIPTS_GATE_MSG : reason === 'agent-settings' ? SETTINGS_GATE_MSG : reason === 'install-tree' ? GIT_TREE_MSG : reason === 'eval-budget' ? EVAL_BUDGET_MSG : GATE_MSG)
  allow()
}
