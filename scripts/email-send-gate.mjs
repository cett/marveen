#!/usr/bin/env node
// PreToolUse hard-gate: blocks outbound email-send for sub-agents.
//
// Governance control (Szabi 2026-06-25, after the Boni incident: a sub-agent
// autonomously emailed a fabricated address asking for money in Szabi's name).
// Sub-agents may NOT send outbound email; any email must be routed through the
// main agent (Marveen) for approval -- only Marveen retains email-send.
//
// STATED LIMIT (msg 14298): this gate catches the ACCIDENTAL send, not a
// determined evader. Static analysis of arbitrary interpreter code is
// undecidable, so a sub-agent CAN send through interpreter code the patterns
// do not model -- the premise "a sub-agent cannot send outbound" does NOT
// hold against intent, only against accident. The exec-heuristic below covers
// the naive shapes (process-spawn plus a known mailer name in one code
// string) and claims no more. Our sub-agents are not adversaries; if that
// assumption ever changes, this gate is the wrong tool.
//
// Why a hook and not a permissions deny-list: permissive security profiles
// launch Claude Code with --dangerously-skip-permissions, which BYPASSES the
// settings.json allow/deny list. A PreToolUse hook runs regardless of
// permission mode, so it is the only reliable mode-independent gate.
//
// This file is wired into every sub-agent's .claude/settings.json by
// writeAgentSettingsFromProfile() (agent-scaffold.ts), guarded by
// name !== MAIN_AGENT_ID, and re-applied on every spawn (respawn-safe).

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Bash command patterns that send mail. SUBGATEPOZ822 (2026-08-22): these are
// no longer the primary trigger -- they matched CONTENT anywhere in the
// command string, and the header's old premise ("a sub-agent has no
// legitimate need to invoke these") broke measurably: the developer of the
// mail tooling IS a sub-agent, and the gate blocked the delivery of the
// mail-gate fix three times in one afternoon (commit message, PR body,
// card-comment sqlite write), plus five more content hits across the fleet
// the same day. The primary trigger is now isSendInvocation() below
// (command-position analysis); this list remains ONLY as the conservative
// fallback when a command cannot be tokenized (unbalanced quote) -- on
// unparseable input the gate behaves exactly as before, never weaker.
// "<anchor> ... <keyword>" on ONE line, in linear time. The regex /anchor[^\n]*keyword/ is quadratic on a
// long line that repeats the anchor and never has the keyword after it (every anchor scans to the end of the
// line and backtracks: 17000 repeats of `resend ` took 1.1 s on an idle machine, over 3 s on a loaded CI
// runner). The first anchor on a line leaves the widest remainder, so looking for the keyword after the
// first anchor only finds exactly what the regex found: same verdicts, one pass. Both patterns must be
// non-global (no lastIndex state).
function sameLineAfter(anchor, keyword) {
  return {
    test(text) {
      for (const line of String(text).split('\n')) {
        const m = anchor.exec(line)
        if (m && keyword.test(line.slice(m.index + m[0].length))) return true
      }
      return false
    },
  }
}

const SEND_PATTERNS = [
  /support-mail\/send\.py/i,
  /\bsend\.py\b/i,
  /api\.resend\.com/i,
  sameLineAfter(/\bresend\b/i, /\b(email|send|message)\b/i),
  /\bsendmail\b/i,
  /\bmsmtp\b/i,
  /\bswaks\b/i,
  /\bsmtplib\b|SMTP\s*\(/i,
  /\bmail\.send\b|\bsendEmail\b/i,
  // graph-mail.ts (PR #668, M365/Exchange Online client-credentials mailbox):
  // its CLI is `tsx scripts/graph-mail.ts send ...`, which none of the above
  // patterns catch (no "sendmail"/"mail.send" substring). Also gate any direct
  // call to the exported sendMail() (e.g. a one-off `node -e`/`tsx -e` that
  // imports the module without going through the CLI).
  sameLineAfter(/\bgraph-mail\b/i, /\bsend\b/i),
  /\bsendMail\s*\(/i,
]

// --- command-position analysis (SUBGATEPOZ822) ------------------------------
// Ported from scripts/hooks/outgoing-copy-gate.py (KAPUHATOKOR822, PR #1042,
// two adversarial rounds): quote-aware tokenization, then the INVOKED program
// of each pipeline/sequence segment decides. A quoted token keeps its
// POSITION, so a quoted provider URL in curl argument position still fires
// (the normal way curl is written), while the same domain inside a quoted -d
// payload stays content (the target pattern is anchored to the token start).
// Wrapper-shell -c strings recurse; interpreter code-string arguments
// (python -c / node -e) are scanned for code-level send calls -- code handed
// to an interpreter IS operation, not content.
// Order-independent heredoc stripping (round 3, msg 14286): the rest of
// the intro line (e.g. a redirect after the marker) is command text and
// is KEPT -- only the body is cut. Without this, marker-first spellings
// leaked the body into command position (FP), and dropping the intro
// would have lost a heredoc-fed real sender (FN).
//
// The heredoc is found by scanHeredocs() below, ONE LINEAR PASS, not by a regex. The old
// single regex (an intro `<<-?\s*'?(\w+)'?[^\n]*`, a newline, then a lazy body up to
// `\n<TAG>`) was superlinear on hostile input: a `<<` followed by a long run of word
// characters and no newline backtracked quadratically through the intro, and every
// never-closed opener re-scanned the rest of the string for its closer. A hook that is
// still running at its timeout is NOT a deny (the host treats it as non-blocking), so a
// slow classifier is a fail-OPEN. Same decision as before, with a bound on the work.
// Mirrored in hooks/outgoing-copy-gate.py (_scan_heredocs); keep the two identical.
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z_0-9]*=/
// KWSPLIT924: shell reserved words that put the NEXT word in command position.
// Stripped only at the head of a segment, never used as separators -- see the
// full rationale at _CMD_POSITION_KEYWORDS in outgoing-copy-gate.py (the python
// twin); the shared send-invocation-cases.json binds the two copies.
const CMD_POSITION_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '{', '!'])
const SENDER_PROG = /^(sendmail|msmtp|swaks)$/i
const SENDPY = /^send\.py$/i
// SUBAGENTMAILGATE1016: a version-suffixed interpreter (python3.12, python3.13, and
// the free-threaded python3.13t) is the same python; the old /^python3?$/ let it
// through as "not an interpreter".
const PYTHON = /^python(3(\.\d+t?)?)?$/i
const NODEISH = /^(node|tsx|ts-node|deno|bun|npx)$/i
const GRAPHMAIL = /^graph-mail(\.ts|\.js)?$/i
const WRAPPER_SHELL = /^(sh|bash|zsh|dash)$/i
const CURLISH = /^(curl|wget|http)$/i
const RESEND_TARGET = /^(https?:\/\/)?([^/@\s]*\.)?api\.resend\.com(\/|$)/i
// curl takes its URL as `--url https://...` (two tokens, the URL is its own token) or as
// `--url=https://...` (ONE token): the target pattern is anchored to the token start, so the
// glued form is read after its `--url=` prefix. Mirrored in outgoing-copy-gate.py (_url_arg).
const urlArg = (t) => (t.startsWith('--url=') ? t.slice('--url='.length) : t)
// RESENDGETTWIN1010: port of the python twin's method verdict (RESENDGATE826,
// outgoing-copy-gate.py :: _curl_resend_verdict). Until now this copy was
// method-blind and denied a read-only GET /domains the python copy passed.
// Strict direction kept: the method must be RECOGNIZED (explicit -X/--request/
// --method, or an implicit POST from a body flag); an undecidable method
// (variable, truncated flag, config file) stays a send. httpie (`http`) takes
// its method positionally and its body as `key=value` items, none of which this
// flag scan reads, so it is undecidable too and stays a send in both twins.
const HTTPIE = /^http$/i
const CURL_BODY_OPTS = new Set([
  '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode',
  '--data-ascii', '-F', '--form', '--form-string', '--json',
  '-T', '--upload-file',
  // wget body flags
  '--post-data', '--post-file', '--body-data', '--body-file',
])
const SAFE_METHODS = new Set(['GET', 'HEAD'])
const ALPHA = /^\p{L}+$/u // python str.isalpha()

// 'read' | 'send' | 'unknown' -- the caller treats unknown as a send.
function curlResendVerdict(prog, rest) {
  if (HTTPIE.test(prog)) return 'unknown'
  let method = null
  let hasBody = false
  let getForced = false
  const n = rest.length
  for (let i = 0; i < n; i++) {
    const t = rest[i]
    if (t === '-X' || t === '--request' || t === '--method') {
      if (i + 1 >= n || !ALPHA.test(rest[i + 1])) return 'unknown'
      method = rest[i + 1].toUpperCase()
      i++
      continue
    }
    if (t.startsWith('--request=') || t.startsWith('--method=')) {
      const m = t.split('=').slice(1).join('=')
      if (!ALPHA.test(m)) return 'unknown'
      method = m.toUpperCase()
      continue
    }
    if (t === '-G' || t === '--get') { getForced = true; continue }
    if (t === '-K' || t === '--config') return 'unknown' // a config file can carry a hidden method or body
    if (CURL_BODY_OPTS.has(t) ||
        [...CURL_BODY_OPTS].some((o) => o.startsWith('--') && t.startsWith(o + '='))) {
      hasBody = true
      continue
    }
    if (t.startsWith('-') && !t.startsWith('--') && t.length > 1) {
      // single-dash cluster (-sS, -sX POST, -sd '{}'): the letters are bundled
      const letters = t.slice(1)
      if (letters.includes('X')) {
        const after = letters.slice(letters.indexOf('X') + 1)
        if (after) {
          if (!ALPHA.test(after)) return 'unknown'
          method = after.toUpperCase()
        } else {
          if (i + 1 >= n || !ALPHA.test(rest[i + 1])) return 'unknown'
          method = rest[i + 1].toUpperCase()
          i++
        }
      } else if (letters.includes('d') || letters.includes('F') || letters.includes('T')) {
        hasBody = true
      } else if (letters.includes('G')) {
        getForced = true
      } else if (letters.includes('K')) {
        return 'unknown'
      }
    }
  }
  if (method !== null && !SAFE_METHODS.has(method)) return 'send'
  // implicit POST (the default of curl -d/-F/--json/-T), or a suspicious
  // "GET with a body" -- both are treated as a send
  if (hasBody && !getForced) return 'send'
  return 'read'
}
const CODE_SEND = /\bsmtplib\b|SMTP\s*\(|\bsendMail\s*\(|\bsendEmail\b|\bmail\.send\b/i
// Naive-shape exec heuristic (msg 14298): process-spawn AND a known mailer
// name together in one interpreter code string. Covers the accidental shapes;
// see the STATED LIMIT in the header for what it deliberately does not claim.
const CODE_EXECISH = /\bsubprocess\b|os\.system|\bpopen\b|child_process|\bexec[A-Za-z]*\s*\(|\bspawn[A-Za-z]*\s*\(/i
const CODE_SENDER_LIT = /sendmail|msmtp|swaks|send\.py/i
// Issue #1853 (stylnet): the support-mail sender LOADED AS A MODULE (`import send`,
// `from send import main`, runpy, __import__/import_module, a spec built from send.py).
// Case-sensitive on purpose; `send` must be the whole module name. Mirrors
// _CODE_SEND_MODULE in hooks/outgoing-copy-gate.py; send-invocation-cases.json binds them.
const CODE_SEND_MODULE = new RegExp(
  String.raw`\bimport\s+(?:[\w.]+\s*,\s*)*send\b(?![\w.])` +
  String.raw`|\bfrom\s+send\s+import\b` +
  String.raw`|\brunpy\b[^\n]*\bsend\b` +
  String.raw`|\b(?:__import__|import_module)\s*\(\s*['"]send['"]` +
  String.raw`|\bspec_from_file_location\b[^\n]*\bsend\.py\b` +
  // The same class on the Graph sender (export sendMail): renamed on import, or a string key.
  String.raw`|\bsendMail\s+as\b|\[\s*['"]sendMail['"]\s*\]`,
)
const codeStringSends = (code) =>
  CODE_SEND.test(code) || CODE_SEND_MODULE.test(code) || (CODE_EXECISH.test(code) && CODE_SENDER_LIT.test(code))

// Unquoted newline / backtick / `$(` become segment separators; quoted text is
// untouched (it is content). Tracks quote state by hand -- no shell involved.
export function maskSubshellMarkers(cmd) {
  let out = ''
  let q = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < cmd.length) { out += cmd[i] + cmd[i + 1]; i++; continue }
      if (ch === q) q = null
      out += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue }
    if (ch === '\\' && i + 1 < cmd.length) { out += cmd[i] + cmd[i + 1]; i++; continue }
    if (ch === '\n' || ch === '`') { out += ';'; continue }
    if (ch === '$' && cmd[i + 1] === '(') { out += ';'; i++; continue }
    out += ch
  }
  return out
}

// --- bounded heredoc scan -------------------------------------
// Hard limits, measured on 365k real Bash calls of the fleet (max command 32 KB, max
// 7 heredoc openers, longest opener line 1.7 KB): each limit is 4x or more above
// anything seen. Over a limit the gate does NOT guess: it DENIES, "too large to
// inspect" (fail-closed), because an inspection that cannot finish inside the hook
// timeout would otherwise let the call through.
export const MAX_CMD_CHARS = 131072
export const MAX_HEREDOC_OPENERS = 32
export const MAX_OPENER_LINE_CHARS = 4096

export class InspectionLimitError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'InspectionLimitError'
    this.reason = reason
  }
}

const HEREDOC_INTRO = /<<-?\s*'?(\w+)/y
const LINE_RUN = /\w+/y
const WS_CHAR = /\s/

// Closing-line candidates of the whole command, built in ONE pass: every line that
// starts with a word-character run followed by whitespace or the end of the string
// (the old regex's `\n<TAG>(?=\s|$)`). A closer for delimiter `TAG` is exactly such a
// line whose run equals a PREFIX of the opener's word (the old regex backtracked
// `\w+` to shorter delimiters), so a query is a few Map lookups, not a rescan.
function buildCloserIndex(cmd) {
  const byRun = new Map()
  const lengths = new Set()
  for (let nl = cmd.indexOf('\n'); nl !== -1; nl = cmd.indexOf('\n', nl + 1)) {
    const s = nl + 1
    LINE_RUN.lastIndex = s
    const r = LINE_RUN.exec(cmd)
    if (!r) continue
    const e = s + r[0].length
    if (e !== cmd.length && !WS_CHAR.test(cmd[e])) continue
    const list = byRun.get(r[0])
    if (list) list.push(s)
    else byRun.set(r[0], [s])
    lengths.add(r[0].length)
  }
  return { byRun, lengthsDesc: [...lengths].sort((a, b) => b - a) }
}

// First closer line start >= minStart for the longest usable prefix of `word`, or -1.
function findCloser(index, word, minStart) {
  for (const k of index.lengthsDesc) {
    if (k > word.length) continue
    const list = index.byRun.get(word.slice(0, k))
    if (!list || list[list.length - 1] < minStart) continue
    let lo = 0
    let hi = list.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid] >= minStart) hi = mid
      else lo = mid + 1
    }
    return { start: list[lo], delimLen: k }
  }
  return null
}

// Same matches the old regex found, left to right and non-overlapping:
//   { start, introEnd, bodyStart, bodyEnd, end }
// m[1] = cmd.slice(start, introEnd), the body = cmd.slice(bodyStart, bodyEnd) (keeps its
// final newline), end = just past the closing tag. Throws InspectionLimitError over a limit.
let lastScan = { cmd: null, found: null }
export function scanHeredocs(cmd) {
  if (lastScan.cmd === cmd) return lastScan.found
  if (cmd.length > MAX_CMD_CHARS) {
    throw new InspectionLimitError(`command is ${cmd.length} characters, the limit is ${MAX_CMD_CHARS}`)
  }
  const found = []
  let index = null
  let openers = 0
  let i = cmd.indexOf('<<')
  while (i !== -1) {
    HEREDOC_INTRO.lastIndex = i
    const m = HEREDOC_INTRO.exec(cmd)
    if (!m) { i = cmd.indexOf('<<', i + 1); continue }
    if (++openers > MAX_HEREDOC_OPENERS) {
      throw new InspectionLimitError(`more than ${MAX_HEREDOC_OPENERS} heredoc openers`)
    }
    const q = cmd.indexOf('\n', i + m[0].length)
    if (q !== -1) {
      index ??= buildCloserIndex(cmd)
      const closer = findCloser(index, m[1], q + 2)
      if (closer) {
        const lineStart = cmd.lastIndexOf('\n', i - 1) + 1
        if (q - lineStart > MAX_OPENER_LINE_CHARS) {
          throw new InspectionLimitError(`a heredoc opener line is longer than ${MAX_OPENER_LINE_CHARS} characters`)
        }
        const end = closer.start + closer.delimLen
        found.push({ start: i, introEnd: q, bodyStart: q + 1, bodyEnd: closer.start, end })
        i = cmd.indexOf('<<', end)
        continue
      }
    }
    i = cmd.indexOf('<<', i + 1)
  }
  lastScan = { cmd, found }
  return found
}

// cmd with every heredoc BODY cut and its opening line kept (the old `replace(RE, '$1')`).
function stripHeredocBodies(cmd) {
  let out = ''
  let pos = 0
  for (const h of scanHeredocs(cmd)) {
    out += cmd.slice(pos, h.introEnd)
    pos = h.end
  }
  return pos === 0 ? cmd : out + cmd.slice(pos)
}

// Quote-aware tokenizer -> [[token, ...], ...] per segment. Throws on an
// unbalanced quote (the caller falls back to the legacy content patterns).
export function segmentsTokens(cmd) {
  const s = maskSubshellMarkers(stripHeredocBodies(cmd))
  const segments = []
  let cur = []
  let tok = ''
  let hasTok = false
  let q = null
  const pushTok = () => { if (hasTok) { cur.push(tok); tok = ''; hasTok = false } }
  const pushSeg = () => { pushTok(); if (cur.length) { segments.push(cur); cur = [] } }
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < s.length) { tok += s[++i]; continue }
      if (ch === q) { q = null; continue }
      tok += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; hasTok = true; continue }
    if (ch === '\\' && i + 1 < s.length) { tok += s[++i]; hasTok = true; continue }
    if (ch === ' ' || ch === '\t') { pushTok(); continue }
    if ('|&;()'.includes(ch)) { pushSeg(); continue }
    tok += ch
    hasTok = true
  }
  if (q) throw new Error('unbalanced quote')
  pushSeg()
  return segments
}

const basename = (t) => t.split('/').pop()

// SENDWRAP924: a wrapper in front of the sender is stepped over WITH its own
// flags -- see the full rationale at _WRAPPERS in outgoing-copy-gate.py (the
// python twin). An unknown long flag without `=` is read both ways, so it errs
// toward auditing. send-invocation-cases.json binds the two copies.
const WRAPPERS = new Map([
  ['time', ['fo', ['format', 'output'], 0]],
  ['sudo', ['ughpCUrtDRT', ['user', 'group', 'host', 'prompt', 'close-from', 'other-user',
    'role', 'type', 'chdir', 'chroot', 'command-timeout'], 0]],
  ['env', ['uCS', ['unset', 'chdir', 'split-string'], 0]],
  ['nohup', ['', [], 0]],
  ['nice', ['n', ['adjustment'], 0]],
  ['exec', ['a', [], 0]],
  ['command', ['', [], 0]],
  ['xargs', ['ILnPsdEa', ['arg-file', 'delimiter', 'eof', 'replace', 'max-lines', 'max-args',
    'max-procs', 'max-chars', 'process-slot-var'], 0]],
  ['timeout', ['sk', ['signal', 'kill-after'], 1]],
  ['setsid', ['', [], 0]],
])
const HEAD_DEPTH = 8
// A wrapper with more unknown long flags than this (`sudo --a --a --a ...`) is refused as too
// large to inspect: every flag opens one more reading of the rest, so the heads were O(n^2)
// (40k flags: an out-of-memory crash in this copy, 49 s in the python twin -- both fail-open).
// Real wrappers carry at most a few unknown flags.
export const MAX_WRAPPER_FLAG_STARTS = 32

function commandHeads(toksIn, d = 0) {
  let skip = 0
  while (skip < toksIn.length && (ENV_ASSIGN.test(toksIn[skip]) || CMD_POSITION_KEYWORDS.has(toksIn[skip]))) skip++
  const toks = skip ? toksIn.slice(skip) : toksIn
  if (!toks.length) return [toks]
  const w = basename(toks[0])
  // Still a wrapper at the depth bound: counts as a send (null), see the python twin.
  if (d >= HEAD_DEPTH) return (WRAPPERS.has(w) || w === 'function' || w === 'coproc') ? [null] : [toks]
  if (w === 'function') return commandHeads(toks.slice(2), d + 1)
  if (w === 'coproc') return [...commandHeads(toks.slice(1), d + 1), ...commandHeads(toks.slice(2), d + 1)]
  const spec = WRAPPERS.get(w)
  if (!spec) return [toks]
  const [shortVal, longVal, positionals] = spec
  let i = 1
  const starts = []
  while (i < toks.length) {
    const t = toks[i]
    if (t === '--') { i++; break }
    if (t.startsWith('--')) {
      if (!t.includes('=') && longVal.includes(t.slice(2))) { i += 2; continue }
      if (!t.includes('=')) starts.push(i + 2)
      i++
      continue
    }
    if (t.startsWith('-') && t.length > 1) {
      if (w === 'command' && (t.includes('v') || t.includes('V'))) return []
      let k = -1
      for (let j = 1; j < t.length; j++) if (shortVal.includes(t[j])) { k = j; break }
      i += k === t.length - 1 ? 2 : 1
      continue
    }
    break
  }
  if (starts.length > MAX_WRAPPER_FLAG_STARTS) {
    throw new InspectionLimitError(`a wrapper carries more than ${MAX_WRAPPER_FLAG_STARTS} unknown long flags`)
  }
  starts.unshift(i)
  return starts.flatMap((s) => commandHeads(toks.slice(s + positionals), d + 1))
}

// SUBAGENTMAILGATE1016 (measured on the sub-agent gate, 2026-10-16): the
// support-mail sender was recognised only as `python3 <path>/send.py --to ...`,
// that is, with the script as the FIRST argument and the exact `--to` flag. Six
// spellings ran the same sender past this gate: an interpreter option first
// (`python3 -u`, `python3 -X utf8`), a version-suffixed interpreter, a glob or a
// variable as the script path (`s?nd.py`, `$P`), and the program read from
// stdin (`python3 - --to ... < send.py`). argparse also takes `--t` for `--to`.
// The boundary, fail-closed where the command cannot be read statically:
//   - the script operand is found past the interpreter's own options (a
//     separate argument for -X / -W / --check-hash-based-pycs);
//   - a recipient flag is `--to` or any argparse abbreviation of it (`--t`),
//     with or without `=value` (the sender's --to is required, so every
//     delivering call carries one of these);
//   - send.py by basename + a recipient flag: a send (as before, now from any
//     operand position, interpreter spelling and flag spelling);
//   - a script operand that cannot be resolved statically (glob or brace
//     characters, or a `$` expansion) + a recipient flag: a send, because what
//     runs is undecidable here (until MAILGATEVARARGS1020 also "or another `$`
//     token", see below);
//   - a program read from stdin (`-`, or no script operand and a `<` redirect)
//     + a recipient flag: a send (a heredoc-fed program is judged by its body,
//     heredocProgramSends, as before).
// Anything else stays allowed: `python3 -u other.py`, `python3 -c "print(1)"`,
// `for f in *.py; do python3 $f; done`, `python3 x.py --to-date ...`,
// `python3 "$DIR/gen.py" "$OUT"`.
// Mirrors _python_head_sends in hooks/outgoing-copy-gate.py; the shared
// send-invocation-cases.json binds the two.
//
// MAILGATEVARARGS1020 (measured on a production install, 2026-10-19): the
// "or another `$` token" half denied ordinary scripted work. In one day 26
// sub-agent Bash calls, across four agents, were denied as mail sends; none
// of them was one (no recipient flag, no sender, no mail program). Each was a
// script run from a variable path with a variable argument:
// `python3 "$SP/gen.py" "$SP/out.json"`, `python3 "$L" /dev/null "$SP/o.txt"`,
// `python3 $A/check.py $S/x.json && python3 $A/stamp.py --note-file "$A/n.json"`.
// The agents lost turns on rewrites and workarounds. The extra `$` rule also
// guarded nothing the rest of the gate guards: a literal sender path with a
// variable argument (`python3 scripts/support-mail/send.py $ARGS`) has always
// passed, because a recipient flag inside a variable is not visible statically
// on ANY branch. So this branch now asks what the send.py and the stdin
// branches ask: is there a recipient flag. A variable path WITH one
// (`python3 $P --to ...`) is still a send; `python3 $SENDER $ARGS` passes,
// pinned as a documented limit in send-invocation-cases.json.
const PY_OPT_WITH_ARG = new Set(['-X', '-W', '--check-hash-based-pycs'])
const RECIPIENT_FLAG = /^--to?(=|$)/
const UNDECIDABLE_PATH = /[*?[{$]/
// CPython reads a cluster of short options left to right (`-uX utf8`, `-um send`, `-msend`,
// `-uc "code"`): the first of c, m, X or W takes the rest of the token as its value, or the next
// token when nothing is left. null when the token is not a cluster; opt is null when the cluster
// holds none of the four (`-u`, `-OB`).
const PY_CLUSTER = /^-[A-Za-z]+$/
function pythonCluster(t) {
  if (!PY_CLUSTER.test(t)) return null
  for (let j = 1; j < t.length; j++) {
    if ('cmXW'.includes(t[j])) return { opt: t[j], value: t.slice(j + 1) }
  }
  return { opt: null, value: '' }
}
function pythonScriptOperand(rest) {
  let stdinRedirect = false
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    if (t === '--') return { script: rest[i + 1] ?? null, stdin: false, stdinRedirect }
    if (t === '-') return { script: null, stdin: true, stdinRedirect }
    if (/^-[cm]/.test(t)) return { script: null, stdin: false, stdinRedirect } // code string / module: judged elsewhere
    const cl = pythonCluster(t)
    if (cl && (cl.opt === 'c' || cl.opt === 'm')) return { script: null, stdin: false, stdinRedirect }
    if (cl && cl.opt && !cl.value) { i++; continue } // -X / -W at the end of a cluster: the next token is its value
    if (PY_OPT_WITH_ARG.has(t)) { i++; continue }
    if (t.startsWith('<')) { stdinRedirect = true; if (t === '<') i++; continue }
    if (/^\d*>/.test(t)) { if (/^\d*>>?$/.test(t)) i++; continue }
    if (t.startsWith('-') && t.length > 1) continue
    return { script: t, stdin: false, stdinRedirect }
  }
  return { script: null, stdin: false, stdinRedirect }
}
// A command or process substitution as a word of the command (`$(...)`, a
// backtick pair, `<(...)`, `>(...)`), with the substitution replaced by one
// placeholder word that carries a `$`. maskSubshellMarkers splits these into
// their own segments, which is right for judging the INNER command, but it
// leaves the outer one without the word: `python3 $(echo .../send.py) --to x`
// became `python3` and `--to x`. Judged on this form as well, the word is an
// undecidable script path (or interpreter) like a variable. Quoted text is left
// alone: a quoted `"$(...)"` already reaches the tokenizer as a `$` word.
export function flattenSubstitutions(cmd) {
  let out = ''
  let q = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (q) {
      if (ch === '\\' && q === '"' && i + 1 < cmd.length) { out += ch + cmd[++i]; continue }
      if (ch === q) q = null
      out += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; out += ch; continue }
    if (ch === '\\' && i + 1 < cmd.length) { out += ch + cmd[++i]; continue }
    const opens = (ch === '$' || ch === '<' || ch === '>') && cmd[i + 1] === '('
    if (opens || ch === '`') {
      let depth = 1
      let j = i + (opens ? 2 : 1)
      let iq = null
      for (; j < cmd.length && depth > 0; j++) {
        const c = cmd[j]
        if (iq) { if (c === iq) iq = null; continue }
        if (c === "'" || c === '"') { iq = c; continue }
        if (ch === '`') { if (c === '`') depth = 0; continue }
        if (c === '(') depth++
        else if (c === ')') depth--
      }
      out += ' $__SUBST__ '
      i = j - 1
      continue
    }
    out += ch
  }
  return out
}

function pythonHeadSends(rest) {
  const recipient = rest.some((t) => RECIPIENT_FLAG.test(t))
  const { script, stdin, stdinRedirect } = pythonScriptOperand(rest)
  if (script !== null && SENDPY.test(basename(script))) return recipient
  if (script !== null && UNDECIDABLE_PATH.test(script)) return recipient // MAILGATEVARARGS1020
  if (stdin || (script === null && stdinRedirect)) return recipient
  return false
}

function segmentIsSend(toksIn, depth) {
  return commandHeads(toksIn).some((h) => headIsSend(h, depth))
}

function headIsSend(toks, depth) {
  if (toks === null) return true // the depth bound was hit on a wrapper: audit it
  if (!toks.length) return false
  const prog = basename(toks[0])
  const rest = toks.slice(1)
  if (SENDER_PROG.test(prog)) return true
  if (WRAPPER_SHELL.test(prog) && depth < 3) {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '-c' && rest[i + 1] && isSendInvocation(rest[i + 1], depth + 1)) return true
    }
  }
  if (PYTHON.test(prog) || NODEISH.test(prog)) {
    for (let i = 0; i < rest.length; i++) {
      if ((rest[i] === '-c' || rest[i] === '-e' || rest[i] === '--eval') &&
          rest[i + 1] && codeStringSends(rest[i + 1])) return true
    }
  }
  if (PYTHON.test(prog)) {
    // `-uc "code"`, `-c"code"`: the code string behind a cluster of short options.
    for (let i = 0; i < rest.length; i++) {
      const cl = pythonCluster(rest[i])
      if (cl && cl.opt === 'c') {
        const code = cl.value || rest[i + 1]
        if (code && codeStringSends(code)) return true
      }
    }
  }
  const candidates = [prog]
  if ((PYTHON.test(prog) || NODEISH.test(prog)) && rest.length) candidates.push(basename(rest[0]))
  // Issue #1853: `python3 -m send` (or -m pkg.send) is the same sender by module name.
  if (PYTHON.test(prog)) {
    for (let i = 0; i < rest.length - 1; i++) {
      if (rest[i] === '-m' && rest[i + 1].split('.').pop() === 'send') candidates.push('send.py')
    }
    // `-msend`, `-um send`: the module behind a cluster of short options.
    for (let i = 0; i < rest.length; i++) {
      const cl = pythonCluster(rest[i])
      if (cl && cl.opt === 'm') {
        const mod = cl.value || rest[i + 1]
        if (mod && mod.split('.').pop() === 'send') candidates.push('send.py')
      }
    }
  }
  if (candidates.some((c) => SENDPY.test(c)) && rest.some((t) => RECIPIENT_FLAG.test(t))) return true
  if (PYTHON.test(prog) && pythonHeadSends(rest)) return true
  // An interpreter or program that cannot be resolved statically ($PY, a glob,
  // a substitution) with a recipient flag: what runs is undecidable here.
  if (UNDECIDABLE_PATH.test(toks[0]) && rest.some((t) => RECIPIENT_FLAG.test(t))) return true
  if (toks.some((t) => GRAPHMAIL.test(basename(t))) && rest.includes('send')) return true
  // RESENDGETTWIN1010: only an actual send (POST/PUT/..., or a body) fires; a
  // read-only GET/HEAD passes; an undecidable method stays fail-closed.
  if (CURLISH.test(prog) && rest.some((t) => RESEND_TARGET.test(urlArg(t)))) {
    return curlResendVerdict(prog, rest) !== 'read'
  }
  return false
}

// True when some segment is still a wrapper at the depth bound (HEADDEPTH924),
// so the deny says WHY -- see wrapper_depth_hit in outgoing-copy-gate.py.
export function wrapperDepthHit(cmd) {
  let segments
  try {
    segments = segmentsTokens(cmd)
  } catch (e) {
    if (e instanceof InspectionLimitError) throw e
    return false
  }
  // Only when the bound is the WHOLE reason: a visible send in another segment wins.
  const heads = segments.flatMap((toks) => commandHeads(toks))
  return heads.some((h) => h === null) && !heads.some((h) => h !== null && headIsSend(h, 0))
}

export function buildWrapperDepthMsg() {
  return (
    'TILTVA (governance hard-gate): a parancs valodi fejet nem latom. ' +
    `A parancs a burkolo-korlatnal (${HEAD_DEPTH} egymasba agyazott burkolo: sudo, time, env, nohup, nice, timeout...) ` +
    'is meg burkolo, tehat nem tudom eldonteni, hogy levelkuldes-e, es a kapu ilyenkor fail-closed. ' +
    `Ha ez NEM levelkuldes: csokkentsd a burkolok szamat ${HEAD_DEPTH} vagy kevesebb ala. ` +
    'Ha levelkuldes: sub-agentkent Bash-bol amugy sem kuldhetsz, a kimeno emailt a fo-agens kuldi.'
  )
}

// Issue #1853, the heredoc form: the segmenter drops heredoc BODIES, but when the
// command that opens one is an interpreter (`python3 - <<'PY'`, `node <<EOF`) the body
// IS the program. Mirrors _heredoc_program_sends in hooks/outgoing-copy-gate.py.
// NARROWED (Geri's #1855 review): inside a heredoc body the exec + sender-literal half takes
// the literal only as a lowercase, QUOTED command word (an argv item or an os.system command),
// so a card id like SENDMAIL... in a report's prose no longer matches. Mirrors
// _HEREDOC_SENDER_ARGV / _heredoc_body_sends in hooks/outgoing-copy-gate.py.
// NOT COVERED, named: a program the classifier never reads -- `python3 /tmp/x.py`,
// `python3 < /tmp/x.py`, `cat /tmp/x.py | python3 -`, `python3 -c "exec(open('/tmp/x.py').read())"`;
// also a here-string fed to an interpreter (`python3 <<<'import send'`) and a CommonJS
// destructuring rename of the Graph sender (`const { sendMail: s } = require(...)`).
// A heredoc fed to a SHELL (`bash <<EOF`) is a shell program: its body is judged with
// isSendInvocation itself, one level deeper (Geri/Samu, #1855).
// WRITTEN, THEN RUN IN THE SAME COMMAND (#1855): `cat > P <<TAG` / `cat <<TAG > P`, then an
// interpreter or a shell on the same path token P: the body is judged as if fed directly.
// Exact token match; a file run by ANOTHER Bash call stays out of reach.
// PIPED (#1855): `cat <<'EOF' | bash` or `| python3 -` hands the body over the pipe on the
// heredoc's opening line; it is judged the same way.
const HEREDOC_SENDER_ARGV = /['"](?:[^'"\s]*\/)?(?:sendmail|msmtp|swaks|send\.py)(?=['"\s])/
const heredocBodySends = (body) =>
  CODE_SEND.test(body) || CODE_SEND_MODULE.test(body) || (CODE_EXECISH.test(body) && HEREDOC_SENDER_ARGV.test(body))
const HEREDOC_SHELL = /(?:^|[\s;&|(])(?:\S*\/)?(?:bash|sh|zsh|dash)\b[^\n<]*$/i
const HEREDOC_INTERP = /(?:^|[\s;&|(])(?:\S*\/)?(python3?(?:\.\d+)?|node|tsx|ts-node|deno|bun)\b[^\n<]*$/i
const HEREDOC_PIPE = /\|\s*(?:\S*\/)?(python3?(?:\.\d+)?|node|tsx|ts-node|deno|bun|bash|sh|zsh|dash)\b/i
const HEREDOC_REDIRECT = /(?:^|[\s;&|(])(?:cat|tee)\b[^\n]*?(?:>>?|\btee(?:\s+-a)?)\s*(['"]?)([^\s'"<>;&|]+)\1/
function writtenThenRun(cmd, written, depth) {
  if (!written.size) return false
  let segments
  try { segments = segmentsTokens(cmd) } catch (e) { if (e instanceof InspectionLimitError) throw e; return false }
  for (const toks of segments) {
    for (const head of commandHeads(toks)) {
      if (!head || !head.length) continue
      const prog = basename(head[0])
      let args = head.slice(1).filter((t) => !t.startsWith('-'))
      if (prog.toLowerCase() === 'npx' && args.length) args = args.slice(1) // npx <runner> <file>
      if (!args.length || !written.has(args[0])) continue
      const body = written.get(args[0])
      if ((PYTHON.test(prog) || NODEISH.test(prog)) && heredocBodySends(body)) return true
      if (WRAPPER_SHELL.test(prog) && depth < 3 && isSendInvocation(body, depth + 1)) return true
    }
  }
  return false
}
function heredocProgramSends(cmd, depth = 0) {
  const written = new Map()
  for (const h of scanHeredocs(cmd)) {
    const lineStart = cmd.lastIndexOf('\n', h.start - 1) + 1
    const intro = cmd.slice(h.start, h.introEnd)
    const body = cmd.slice(h.bodyStart, h.bodyEnd)
    const w = HEREDOC_REDIRECT.exec(cmd.slice(lineStart, h.start) + intro)
    if (w) written.set(w[2], body)
    const piped = HEREDOC_PIPE.exec(intro)
    if (piped) {
      if (WRAPPER_SHELL.test(piped[1])) {
        if (depth < 3 && isSendInvocation(body, depth + 1)) return true
      } else if (heredocBodySends(body)) return true
    }
    const head = cmd.slice(lineStart, h.start)
    if (HEREDOC_INTERP.test(head)) {
      if (heredocBodySends(body)) return true
    } else if (HEREDOC_SHELL.test(head) && depth < 3) {
      if (isSendInvocation(body, depth + 1)) return true
    }
  }
  return writtenThenRun(cmd, written, depth)
}

export function isSendInvocation(cmd, depth = 0) {
  if (heredocProgramSends(cmd, depth)) return true
  let segments
  try {
    segments = segmentsTokens(cmd)
  } catch (e) {
    if (e instanceof InspectionLimitError) throw e
    // Unparseable command: fall back to the LEGACY content patterns, so on
    // this path the gate is exactly as strict as before -- never weaker.
    return SEND_PATTERNS.some((re) => re.test(cmd))
  }
  if (segments.some((toks) => segmentIsSend(toks, depth))) return true
  // The same command with every substitution as one undecidable word (see
  // flattenSubstitutions): the outer command keeps the word it would run.
  const flat = flattenSubstitutions(cmd)
  if (flat === cmd) return false
  try {
    return segmentsTokens(flat).some((toks) => segmentIsSend(toks, depth))
  } catch {
    return SEND_PATTERNS.some((re) => re.test(cmd))
  }
}

// Outbound-shaped operations of the multiplexed manage_email tool. Each of
// these sends for real unless the call explicitly asks for a draft.
const MANAGE_EMAIL_SEND_OPS = new Set(['send', 'reply', 'replyall', 'forward'])

// Pure decision: does this tool call send (or attempt to send) email?
export function gateDecision(toolName, toolInput) {
  const name = String(toolName ?? '')
  // Any MCP send_email tool, name-agnostic (gmail or a differently-named
  // server in a customer install -> the matcher + this both key on send_email).
  if (/send_email/i.test(name)) return { deny: true }
  if (name === 'Bash') {
    const cmd = String(toolInput?.command ?? '')
    try {
      if (isSendInvocation(cmd)) {
        // Same verdict, a truthful reason: when the wrapper-depth bound is the ONLY thing
        // that makes this a send (no visible send, none in a heredoc), say so.
        return wrapperDepthHit(cmd) && !heredocProgramSends(cmd)
          ? { deny: true, wrapperDepth: true }
          : { deny: true }
      }
    } catch (e) {
      // Fail-closed: a command too large to inspect inside the hook timeout is refused,
      // not waved through (a timed-out hook is non-blocking in the host).
      if (e instanceof InspectionLimitError) return { deny: true, tooLarge: e.reason }
      throw e
    }
  }
  return { deny: false }
}

export function buildTooLargeMsg(reason) {
  return (
    'TILTVA (governance hard-gate): a parancs tul nagy ahhoz, hogy a kapu atvizsgalja ' +
    `(${reason}), es egy vizsgalhatatlan parancs nem mehet at. ` +
    'Bontsd kisebb parancsokra (nagy szoveget fajlba irj a Write tool-lal), aztan futtasd ujra.'
  )
}

// Pure builder for the deny message, so the brand/owner substitution is
// provable without spawning the hook. With the stock defaults (botName
// 'Marveen', ownerName 'Szabolcs') the wording is byte-identical to before.
export function buildGateMsg(botName, ownerName) {
  return (
    'Email-kuldes sub-agentkent tiltott (governance hard-gate). ' +
    `Kuldd a tervezett emailt (CIMZETT + TARGY + TELJES SZOVEG) ${botName}nek inter-agent uzenetben ` +
    `jovahagyasra; a kimeno emailt ${botName} kuldi. Csak VERIFIKALT cimre (soha nem nevbol talalt cim). ` +
    `Soha ne irj ala ${ownerName} nevevel, es soha ne kerj penzt senki neveben.`
  )
}

// Resolve the brand + owner display names for the deny message. The hook runs
// standalone (no config.ts), so read the install's .env directly, keyed off
// this file's own location (<root>/scripts/email-send-gate.mjs -> <root>/.env).
// Any failure falls back to the stock defaults, so the gate never breaks and a
// bare install keeps the original wording.
export function readBrandEnv(readFile = (p) => readFileSync(p, 'utf-8')) {
  const fallback = { botName: 'Marveen', ownerName: 'Szabolcs' }
  try {
    const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
    const raw = readFile(envPath)
    const pick = (key) => {
      const m = raw.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'))
      if (!m) return ''
      return m[1].trim().replace(/^["']|["']$/g, '').trim()
    }
    return {
      botName: pick('BOT_NAME') || fallback.botName,
      ownerName: pick('OWNER_NAME') || fallback.ownerName,
    }
  } catch {
    return fallback
  }
}

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

// Run as the hook entrypoint only when invoked directly (not when imported by a
// test). Reads the PreToolUse payload from stdin and emits a deny decision for
// email-send tool calls. realpath both sides so a symlinked install path (the
// hook command is an absolute path that may traverse a symlink, e.g. /tmp ->
// /private/tmp on macOS, or a symlinked /home on Linux) still matches -- a raw
// url-vs-argv compare would silently no-op the gate (a security bypass).
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
  let decision
  try {
    decision = gateDecision(payload?.tool_name, payload?.tool_input)
  } catch (e) {
    // An uncaught throw would exit 1, which the host treats as NON-blocking: fail-open.
    deny(`TILTVA (governance hard-gate): a kapu belso hibaja (${e?.message ?? e}), a parancs nem vizsgalhato.`)
  }
  if (decision.deny) {
    if (decision.tooLarge) deny(buildTooLargeMsg(decision.tooLarge))
    if (decision.wrapperDepth) deny(buildWrapperDepthMsg())
    const { botName, ownerName } = readBrandEnv()
    deny(buildGateMsg(botName, ownerName))
  }
  allow()
}
