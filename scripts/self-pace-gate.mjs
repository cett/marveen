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

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const SCHED_PREFIX = String.raw`(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*(?:\S*/)?`
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
const SCHEDULER_RX = new RegExp(
  String.raw`(^|${SCHED_BOUNDARY}\s*)${SCHED_PREFIX}(?:(?:crontab|systemd-run)\b(?!-)(?!\s*=)|launchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|(?:batch|at)\b(?!-)(?!\s*=)${AT_INVOCATION})`,
  'i',
)
// ...but allow a pure READ-listing of one's own schedule (parity with the store /
// schedule-API read exemptions): crontab -l, launchctl list/print, atq.
const SCHEDULER_READ_RX = new RegExp(String.raw`(^|${SCHED_BOUNDARY}\s*)${SCHED_PREFIX}(crontab\s+-l\b|launchctl\s+(?:list|print|dumpstate|blame|examine)\b|atq\b)`, 'i')

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

// The protected set of an install. `entries` are real paths (dir: true = the directory and all below);
// `ancestors` are the directories that CONTAIN protected paths (a move/remove of one removes them).
export function protectedSet(opts = {}) {
  const scriptsDir = realOrSelf(opts.scriptsDir ?? DEFAULT_SCRIPTS_DIR)
  const storeDirs = opts.storeDir
    ? [realOrSelf(opts.storeDir)]
    : [...new Set([join(scriptsDir, '..', 'store'), ...(process.env.MARVEEN_STORE_DIR ? [process.env.MARVEEN_STORE_DIR] : [])].map(realOrSelf))]
  const entries = []
  const add = (path, dir, kind) => entries.push({ real: realOrSelf(path), dir, kind })
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
  // Directories that CONTAIN protected paths. Moving, removing or re-linking one removes or replaces
  // them. `strict`: any command that is not a plain read is denied (scripts/ also holds the gates by
  // name). `loose`: only commands that move, remove, link, extract or rewrite (see DESTRUCTIVE), so
  // `cp file store/`, `ls`, `cd` and a script run in the repo root keep working.
  const ancestors = [{ real: scriptsDir, strict: true, kind: 'gate-scripts' }]
  for (const s of storeDirs) ancestors.push({ real: s, strict: false, kind: 'egress-allowlist' })
  const root = dirname(scriptsDir)
  ancestors.push({ real: root, strict: false, kind: 'gate-scripts' })
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
  for (const e of prot.entries) {
    if (e.dir ? (real === e.real || real.startsWith(e.real + sep)) : real === e.real) return e.kind
    // the settings entries match without regard to case: a file that does not exist yet keeps the case
    // it is spelled with, and a case-insensitive filesystem opens `Settings.Local.json` as the real one
    if (e.kind === 'agent-settings' && !e.dir && real.toLowerCase() === e.real.toLowerCase()) return e.kind
  }
  return agentSettingsKind(real, prot)
}
// agents/<any name>/{.claude,.claude-config}/settings.json | settings.local.json, as a REAL path under
// THIS install's agents/ directory. A pattern, not a list: an agent that does not exist yet has none.
function agentSettingsKind(real, prot) {
  if (!prot.agentsDir || !real.startsWith(prot.agentsDir + sep)) return null
  const rel = real.slice(prot.agentsDir.length + 1).split(sep)
  return rel.length === 3 && AGENT_CONFIG_DIRS.includes(rel[1].toLowerCase()) && SETTINGS_FILES.includes(rel[2].toLowerCase()) ? 'agent-settings' : null
}
// agents/<name>/.claude and agents/<name>/.claude-config: moving, removing or re-linking one (then
// writing through the new link) would walk past the pattern above.
function agentConfigDirKind(real, prot) {
  if (!prot.agentsDir || !real.startsWith(prot.agentsDir + sep)) return null
  const rel = real.slice(prot.agentsDir.length + 1).split(sep)
  return rel.length === 2 && AGENT_CONFIG_DIRS.includes(rel[1].toLowerCase()) ? 'agent-settings' : null
}
// The settings files / config dirs of the agents that exist now (for globs and unresolved prefixes).
function settingsCandidates(prot) {
  if (prot.settingsCache) return prot.settingsCache
  const dirs = []; const files = []
  let names = []
  try { names = readdirSync(prot.agentsDir) } catch { /* no agents/ yet */ }
  for (const n of names) for (const d of AGENT_CONFIG_DIRS) {
    const dir = join(prot.agentsDir, n, d); dirs.push(dir)
    for (const f of SETTINGS_FILES) files.push(join(dir, f))
  }
  return (prot.settingsCache = { dirs, files })
}
// 'anc-strict:<kind>' | 'anc-loose:<kind>' | null
const ancestorOf = (real, prot) => {
  const a = prot.ancestors.find((x) => x.real === real || (x.kind === 'agent-settings' && x.real.toLowerCase() === real.toLowerCase()))
  if (a) return `anc-${a.strict ? 'strict' : 'loose'}:${a.kind}`
  const k = agentConfigDirKind(real, prot)
  return k ? `anc-loose:${k}` : null
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
function globToRegex(abs) {
  let out = '^'
  for (let i = 0; i < abs.length; i++) {
    const c = abs[i]
    if (c === '*') { if (abs[i + 1] === '*') { out += '.*'; i++ } else out += '[^/]*' }
    else if (c === '?') out += '[^/]'
    else if (c === '[') { const e = abs.indexOf(']', i + 2); if (e === -1) out += '\\['; else { out += abs.slice(i, e + 1); i = e } }
    else out += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
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
  if (cmd === 'git') return ['rm', 'mv', 'clean', 'checkout', 'restore', 'reset', 'stash', 'apply', 'am', 'worktree'].includes(gitSubcommand(args) ?? '')
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
    if (sub === 'grep' && (/^-O/.test(a) || /^--open/.test(a))) return false
  }
  return true
}
// `cp SRC... DIR/` (or `cp -t DIR SRC...`) creates DIR/<basename of SRC>: a file named like a protected
// one lands there although no word of the command names it. Returns the kind of the protected path a
// copy would create inside a directory operand, or null. A source whose name cannot be read (a $VAR, a
// glob that could match) counts as the protected name when the directory holds one.
function copyIntoDirKind(args, ctx) {
  let targetDir = null; const operands = []; let opts = true
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
      const k = kindOf(join(realD, base), ctx.prot)
      if (k) return k
      for (const [name, kind] of children) if (name.toLowerCase() === base.toLowerCase()) return kind
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
    const nw = tokenizeShell(segs[idx + 1]).words
    const nc = commandWordIndex(nw)
    const name = nc === -1 ? '' : nw[nc].split('/').pop()
    return !(READERS.has(name) || name === 'tee')
  }
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si]
    const { words, redirects, hasRedirect } = tokenizeShell(seg)
    const kinds = words.map((w) => wordKind(w, ctx))
    const rKinds = redirects.map((r) => wordKind(r, ctx))
    // `cd` moves the base of every later relative word (conservatively: the old base stays too).
    const ci = commandWordIndex(words)
    const cmd = ci === -1 ? '' : words[ci].split('/').pop()
    if (cmd === 'cd' || cmd === 'pushd') {
      const arg = words.slice(ci + 1).find((a) => !a.startsWith('-'))
      const target = arg === undefined ? homedir() : expandWord(arg, ctx.vars, ctx.current)
      if (arg === '-' || target.includes('$') || /[*?[`]/.test(target)) ctx.unknownCwd = true
      else { ctx.current = resolve(ctx.current, target); ctx.cwds.add(ctx.current); ctx.cwds.add(realOrSelf(ctx.current)) }
    }
    if (cmd === 'cp') {
      const ck = copyIntoDirKind(words.slice(ci + 1), ctx)
      if (ck) return { deny: true, reason: ck }
    }
    const hit = kinds.find((k) => k && !isAnc(k)) ?? rKinds.find((k) => k && !isAnc(k)) ?? null
    const ancKinds = [...kinds, ...rKinds].filter(isAnc)
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
      if (READERS.has(cmd) && readerOk(cmd, args, ctx) && !feedsNonReader(si) && !envUnsafe) continue
      if (!ancKinds.some((k) => k.startsWith('anc-strict')) && !destructiveCmd(cmd, args)) continue
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
//     (`X=$(crontab -)`, `X=`crontab -``) is caught by SCHEDULER_RX's boundary
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
// `launchctl`, and SCHEDULER_RX's end-of-segment branch reads a bare `launchctl`
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
// stayed denied, because SCHEDULER_RX carries its OWN boundary anchor
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
// is not blanked. Such a payload is then still denied by SCHEDULER_RX, whose
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
// -r)"`) is left intact so SCHEDULER_RX still catches the real substitution.
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
      if (SCHEDULER_RX.test(seg) && !SCHEDULER_READ_RX.test(seg)) return { deny: true }
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
  'scripts/self-pace-gate.mjs, scripts/email-send-gate.mjs, scripts/hooks/ es scripts/lib/ fajljait: ezek RAD ' +
  'vonatkozo kapuk. Ha egy kapu hibas vagy modositani kell, kerd a fo agenst (inter-agent uzenet: fajl + miert). ' +
  'Olvasni (cat / grep / diff) es futtatni (node scripts/hooks/x.mjs, python3 scripts/hooks/x.py) szabad; ' +
  'a sajat worktree masolat szerkesztheto.'

const SETTINGS_GATE_MSG =
  'Agent-settings fajlok vedve (governance hard-gate). Sub-agentkent NEM irhatod a Claude Code settings.json / ' +
  'settings.local.json fajlokat (agents/*/.claude, agents/*/.claude-config, a telepites .claude mappaja): ' +
  'egy {"disableAllHooks": true} minden kaput kikapcsolna, ami RAD vonatkozik. Ha egy beallitas kell ' +
  '(plugin, hook, permission), kerd a fo agenst vagy a tulajdonost (inter-agent uzenet: fajl + miert). ' +
  'Olvasni (cat / jq / grep) szabad; a sajat worktree masolat szerkesztheto.'

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
  if (shouldDeny) deny(reason === 'egress-allowlist' ? ALLOWLIST_GATE_MSG : reason === 'gate-scripts' ? SCRIPTS_GATE_MSG : reason === 'agent-settings' ? SETTINGS_GATE_MSG : GATE_MSG)
  allow()
}
