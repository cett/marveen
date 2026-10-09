// Pure helpers for finding old "curl + dashboard token" recipes in text and proposing the
// equivalent call through scripts/agent-api.sh. No I/O here: callers pass text in and get a plan out,
// nothing is ever written. The dry-run CLI (scripts/recipe-wrapper-dry-run.ts) walks the files.
//
// Scope: only a curl against the dashboard (localhost / 127.0.0.1 on the dashboard port, an /api/
// path) that presents a dashboard token is converted. A curl to any other host is left alone, and a
// dashboard call it cannot convert faithfully is reported as skipped, never half-rewritten.
import { resolveRequiredPermission, hasPermission } from '../../src/web/rbac.js'
import { normalizePath } from '../../src/web/routes/versioning.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface CurlSpan { start: number; end: number; text: string }

export interface ConvertOpts {
  /** The wrapper invocation placed in front of the call, e.g. `bash /opt/marveen/scripts/agent-api.sh`. */
  wrapper: string
  /** Dashboard port; a curl to another local port is a different instance and is not converted. */
  defaultPort?: number
  /** Shell variables known to hold a token read from a token file (name -> which file kind). */
  tokenVars?: ReadonlyMap<string, TokenKind>
  /** Shell variables known to hold the dashboard base URL (name -> `http://127.0.0.1:3420`). */
  hostVars?: ReadonlyMap<string, string>
}

export interface PlanOpts extends ConvertOpts {
  /**
   * The text is markdown: a credential use outside a fenced code block is prose (listed as a
   * mention), inside a fence it is code. Default false: every line is code.
   */
  markdown?: boolean
}

export type TokenKind = 'dashboard' | 'agent' | 'operator'

export interface AdminVerdict {
  adminOnly: boolean
  /** Why: the table row, or the route-level rule, that makes a fleet agent token insufficient. */
  reason: string
}

export type ConvertResult =
  | {
      ok: true
      replacement: string
      method: string
      path: string
      agent?: string
      adminOnly: boolean
      adminReason: string
      /** Characters of the command text that the call really covers (prose after it is left out). */
      consumed: number
    }
  | { ok: false; reason: string; /** true when the command is not a dashboard call at all */ ignored: boolean }

export interface PlanEdit {
  /** 1-based line where the command starts. */
  line: number
  endLine: number
  start: number
  end: number
  old: string
  replacement: string
  method: string
  path: string
  agent?: string
  adminOnly: boolean
  adminReason: string
}

export interface PlanSkip { line: number; reason: string; snippet: string }

export type ManualKind = 'token-file-read' | 'bearer-in-code' | 'subprocess-curl' | 'mention'

export interface PlanManual { line: number; kind: ManualKind; reason: string; snippet: string }

export interface InlineAssignment { line: number; text: string }

export interface RewritePlan {
  edits: PlanEdit[]
  skipped: PlanSkip[]
  manual: PlanManual[]
  /** Lines that are only `VAR=$(cat <token file>)` and whose variable is used by converted calls alone. */
  assignmentsToDrop: number[]
  /** The same assignment sitting inside a longer line (`VAR=$(cat ...); curl ...`): remove by hand. */
  inlineAssignments: InlineAssignment[]
}

const TOKEN_FILE_RE = /dashboard-token|\.agent-token|\.operator-token/
const DEFAULT_PORT = 3420

// ── Shell scanning ──────────────────────────────────────────────────────────

/** Index of the `)` closing the `$(` at s[i], quote aware; -1 when unbalanced. */
function skipParen(s: string, i: number): number {
  let depth = 0
  let j = i + 1
  while (j < s.length) {
    const c = s[j]
    if (c === '\\') { j += 2; continue }
    if (c === "'") {
      const k = s.indexOf("'", j + 1)
      if (k < 0) return -1
      j = k + 1
      continue
    }
    if (c === '"') {
      j++
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\') { j += 2; continue }
        if (s[j] === '$' && s[j + 1] === '(') {
          const e = skipParen(s, j)
          if (e < 0) return -1
          j = e + 1
          continue
        }
        j++
      }
      if (j >= s.length) return -1
      j++
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return j
    }
    j++
  }
  return -1
}

const isWs = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r'

/**
 * End (exclusive) of the shell command starting at s[start], or -1 when a quote or substitution is
 * never closed. A command ends at a newline, `|`, a backtick, `;`, `&`, `)`, a ` #` comment or a
 * redirection; a `>` inside a `<name>` placeholder is not a redirection.
 */
function scanEnd(s: string, start: number): number {
  const n = s.length
  let i = start
  let q: string | null = null
  while (i < n) {
    const c = s[i]
    if (q === "'") { if (c === "'") q = null; i++; continue }
    if (q === '"') {
      if (c === '\\') { i += 2; continue }
      if (c === '"') { q = null; i++; continue }
      if (c === '$' && s[i + 1] === '(') {
        const e = skipParen(s, i)
        if (e < 0) return -1
        i = e + 1
        continue
      }
      i++
      continue
    }
    if (c === "'" || c === '"') { q = c; i++; continue }
    if (c === '\\') { i += 2; continue }
    if (c === '$' && s[i + 1] === '(') {
      const e = skipParen(s, i)
      if (e < 0) return -1
      i = e + 1
      continue
    }
    if (c === '\n' || c === '|' || c === '`' || c === ';' || c === '&' || c === ')') return i
    if (c === '>') {
      const prev = s[i - 1]
      if (isWs(prev)) return i
      if ((prev === '1' || prev === '2') && (i - 2 < start || isWs(s[i - 2]))) return i - 1
    }
    if (c === '<' && isWs(s[i - 1]) && (s[i + 1] === '<' || s[i + 1] === ' ' || s[i + 1] === '(')) return i
    if ((c === ' ' || c === '\t') && s[i + 1] === '#') return i
    i++
  }
  return q ? -1 : n
}

/** Every `curl ...` shell command in the text, in order, non-overlapping. */
export function findCurlCommands(text: string): CurlSpan[] {
  const out: CurlSpan[] = []
  const re = /(?<![A-Za-z0-9_./$-])curl(?=[ \t]|\\\r?\n)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    let end = scanEnd(text, start)
    if (end < 0) {
      const nl = text.indexOf('\n', start)
      end = nl < 0 ? text.length : nl
    }
    out.push({ start, end, text: text.slice(start, end) })
    re.lastIndex = Math.max(end, start + 4)
  }
  return out
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

/**
 * One shell word. `lit` is the value with quotes removed (live substitutions kept verbatim), `dq` the
 * same value escaped so that wrapping it in double quotes reproduces the original semantics, `live`
 * whether the word contains an expansion ($VAR, $(...), backticks) that must stay live.
 */
interface Word { raw: string; lit: string; dq: string; live: boolean; start: number; end: number }

const escDqChar = (c: string): string => ('"\\$`'.includes(c) ? '\\' + c : c)
// A backslash needs doubling in double quotes only before a character that would consume it.
const escDq = (s: string): string => s.replace(/\\(?=["\\$`]|$)|["$`]/g, '\\$&')

/** The `$...` expansion at s[i]: its source text, or null when the `$` is a literal dollar. */
function readDollar(s: string, i: number): string | null {
  const nx = s[i + 1]
  if (nx === '(') {
    const e = skipParen(s, i)
    return e < 0 ? null : s.slice(i, e + 1)
  }
  if (nx === '{') {
    const e = s.indexOf('}', i + 2)
    return e < 0 ? null : s.slice(i, e + 1)
  }
  const m = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i, i + 80))
  return m ? m[0] : null
}

function tokenize(s: string): Word[] | null {
  const words: Word[] = []
  const n = s.length
  let i = 0
  while (i < n) {
    while (i < n && isWs(s[i])) i++
    if (s[i] === '\\' && (s[i + 1] === '\n' || (s[i + 1] === '\r' && s[i + 2] === '\n'))) {
      i += s[i + 1] === '\n' ? 2 : 3
      continue
    }
    if (i >= n) break
    const begin = i
    let lit = ''
    let dq = ''
    let live = false
    const expansion = (): boolean => {
      const d = readDollar(s, i)
      if (d === null) return false
      lit += d; dq += d; live = true; i += d.length
      return true
    }
    while (i < n && !isWs(s[i])) {
      const c = s[i]
      if (c === '\\') {
        const nx = s[i + 1]
        if (nx === undefined) { lit += '\\'; dq += '\\\\'; i++; continue }
        if (nx === '\n') { i += 2; continue }
        if (nx === '\r' && s[i + 2] === '\n') { i += 3; continue }
        lit += nx; dq += escDqChar(nx); i += 2
        continue
      }
      if (c === "'") {
        const j = s.indexOf("'", i + 1)
        if (j < 0) return null
        const body = s.slice(i + 1, j)
        lit += body; dq += escDq(body); i = j + 1
        continue
      }
      if (c === '"') {
        i++
        for (;;) {
          if (i >= n) return null
          const d = s[i]
          if (d === '"') { i++; break }
          if (d === '\\') {
            const nx = s[i + 1]
            if (nx === undefined) return null
            if (nx === '\n') { i += 2; continue }
            if ('"\\$`'.includes(nx)) { lit += nx; dq += '\\' + nx; i += 2; continue }
            lit += '\\' + nx; dq += '\\' + nx; i += 2
            continue
          }
          if (d === '$') {
            if (expansion()) continue
            lit += '$'; dq += '\\$'; i++
            continue
          }
          if (d === '`') {
            const e = s.indexOf('`', i + 1)
            if (e < 0) return null
            const region = s.slice(i, e + 1)
            lit += region; dq += region; live = true; i = e + 1
            continue
          }
          lit += d; dq += d; i++
        }
        continue
      }
      if (c === '$') {
        if (expansion()) continue
        lit += '$'; dq += '\\$'; i++
        continue
      }
      if (c === '`') {
        const e = s.indexOf('`', i + 1)
        if (e < 0) return null
        const region = s.slice(i, e + 1)
        lit += region; dq += region; live = true; i = e + 1
        continue
      }
      lit += c; dq += escDqChar(c); i++
    }
    words.push({ raw: s.slice(begin, i), lit, dq, live, start: begin, end: i })
  }
  return words
}

const SAFE_BARE = /^[A-Za-z0-9_@%+=:,./-]+$/

/** A word ready to paste into a command line: bare, single-quoted, or (live expansions) double-quoted. */
function renderWord(w: { lit: string; dq: string; live: boolean }): string {
  if (w.live) return '"' + w.dq + '"'
  if (SAFE_BARE.test(w.lit)) return w.lit
  return "'" + w.lit.replace(/'/g, "'\\''") + "'"
}

/** The word minus its first `n` characters; only used on prefixes that carry no escapes. */
function dropPrefix(w: Word, n: number): Word {
  const dq = w.dq.slice(n)
  return { ...w, lit: w.lit.slice(n), dq, live: w.live && /(?<!\\)(?:\\\\)*[$`]/.test(dq) }
}

// ── Admin oracle ────────────────────────────────────────────────────────────

/**
 * Whether a fleet agent's own token is refused on this call, so the converted call needs
 * `--token admin`. The RBAC table decides (an unmapped endpoint falls back to admin:all), plus the
 * rules the routes add on top of a permission a fleet agent does hold:
 *   - skills: a fleet agent writes only its own `agent/<name>/...` skills (routes/skills.ts)
 *   - approvals: a fleet agent may request and read, never resolve (routes/approvals.ts)
 * The query string is dropped and /api/v1 is normalised, as the server does before it resolves.
 */
export function adminRequirement(method: string, rawPath: string): AdminVerdict {
  const m = method.toUpperCase()
  const plain = rawPath.split(/[?#]/)[0]
  const norm = normalizePath(plain).path

  if (/^\/api\/(\$|<)/.test(norm)) return { adminOnly: true, reason: 'resource segment is a variable: assumed admin' }

  const skill = /^\/api\/skills\/sql(?:\/([^/]*))?/.exec(norm)
  if (skill && m !== 'GET') {
    if (skill[1] === undefined) return { adminOnly: true, reason: 'route: a fleet agent cannot create tenant skills' }
    let id = skill[1]
    try { id = decodeURIComponent(id) } catch { /* keep the raw segment */ }
    if (!id.startsWith('agent/')) return { adminOnly: true, reason: 'route: a fleet agent writes only its own agent/<name>/ skills' }
  }

  if (/^\/api\/approvals\/[^/]+$/.test(norm) && (m === 'PATCH' || m === 'PUT')) {
    return { adminOnly: true, reason: 'route: a fleet agent cannot resolve approvals' }
  }

  const perm = resolveRequiredPermission(m, norm)
  if (perm === null) return { adminOnly: true, reason: 'no permission-table entry (falls back to admin:all)' }
  if (!hasPermission('fleet_agent', perm)) return { adminOnly: true, reason: `${perm} is not held by a fleet agent` }
  return { adminOnly: false, reason: `${perm} is held by a fleet agent` }
}

// ── Conversion ──────────────────────────────────────────────────────────────

const LOCAL_URL_RE = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::([^/]*))?(\/.*)?$/
const IGNORABLE_FLAGS = new Set(['--silent', '--show-error', '--fail', '--location', '--compressed'])
// Options the wrapper cannot express that take a value: the value must not be mistaken for the URL.
const VALUE_OPTIONS = new Set([
  '-o', '--output', '-u', '--user', '-A', '--user-agent', '-b', '--cookie', '-c', '--cookie-jar', '-e', '--referer',
  '--connect-timeout', '--retry', '--resolve', '-F', '--form', '-T', '--upload-file', '--data-urlencode', '-K', '--config',
])
const DATA_FLAGS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii'])

function tokenRefIn(text: string, tokenVars?: ReadonlyMap<string, TokenKind>): boolean {
  if (TOKEN_FILE_RE.test(text)) return true
  if (!tokenVars) return false
  for (const name of tokenVars.keys()) {
    if (new RegExp('\\$\\{?' + name + '\\b').test(text)) return true
  }
  return false
}

/**
 * Convert one `curl ...` command (as found by findCurlCommands) into a wrapper call. `ignored`
 * results are not dashboard calls (another host, a non-API path) and are not worth reporting; the
 * rest of the failures are reported by the caller as skipped.
 */
export function convertCurl(cmd: string, opts: ConvertOpts): ConvertResult {
  const defaultPort = opts.defaultPort ?? DEFAULT_PORT
  const ignore = (reason: string): ConvertResult => ({ ok: false, reason, ignored: true })
  const skip = (reason: string): ConvertResult => ({ ok: false, reason, ignored: false })

  const words = tokenize(cmd)
  if (!words) {
    const mentions = tokenRefIn(cmd, opts.tokenVars) || new RegExp(`(localhost|127\\.0\\.0\\.1):${defaultPort}`).test(cmd)
    return mentions ? skip('unparsable: unbalanced quote or substitution') : ignore('unparsable, not a dashboard call')
  }
  if (words.length === 0 || words[0].lit !== 'curl') return ignore('not a curl command')

  let method: string | null = null
  let urlWord: Word | null = null
  let agent: Word | null = null
  let maxTime: string | null = null
  let withStatus = false
  let body: Word | null = null
  let bodyFlag = ''
  let authKind: TokenKind | 'unknown' | null = null
  let problem: string | null = null
  let proseIdx = -1
  const fail = (reason: string): void => { if (problem === null) problem = reason }

  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    const t = w.lit
    const value = (): Word | null => {
      const v = words[i + 1]
      if (!v) { fail(`option ${t} has no value`); return null }
      i++
      return v
    }
    if (/^-[sSfL]+$/.test(t) || IGNORABLE_FLAGS.has(t)) continue
    if (t === '-X' || t === '--request' || /^-X[A-Za-z]+$/.test(t)) {
      const v = t.length > 2 && !t.startsWith('--') ? { lit: t.slice(2) } : value()
      if (v) method = v.lit.toUpperCase()
      continue
    }
    if (t === '-H' || t === '--header') {
      const v = value()
      if (!v) continue
      const colon = v.lit.indexOf(':')
      const name = colon < 0 ? '' : v.lit.slice(0, colon).trim().toLowerCase()
      const hv = colon < 0 ? '' : v.lit.slice(colon + 1).trim()
      if (name === 'authorization') {
        const bearer = /^Bearer\s+(.+)$/i.exec(hv)
        if (!bearer) { fail('unsupported Authorization scheme'); continue }
        const cred = bearer[1]
        if (/\.operator-token/.test(cred)) authKind = 'operator'
        else if (/\.agent-token/.test(cred)) authKind = 'agent'
        else if (TOKEN_FILE_RE.test(cred)) authKind = 'dashboard'
        else {
          const variable = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(cred)
          if (variable) authKind = opts.tokenVars?.get(variable[1]) ?? 'unknown'
          else fail('Authorization carries a credential the tool cannot identify')
        }
      } else if (name === 'x-agent-id') {
        const dqColon = v.dq.indexOf(':')
        agent = { ...v, lit: hv, dq: v.dq.slice(dqColon + 1).trimStart() }
      } else if (name === 'content-type') {
        if (!/^application\/json\b/i.test(hv)) fail(`Content-Type ${hv} (the wrapper sends application/json)`)
      } else if (name === 'accept') {
        if (!/^(application\/json|\*\/\*)\b/i.test(hv)) fail(`Accept ${hv} (unsupported)`)
      } else {
        fail(`unsupported header ${name || v.lit}`)
      }
      continue
    }
    if (DATA_FLAGS.has(t)) {
      const v = value()
      if (!v) continue
      if (body) { fail('more than one data option'); continue }
      body = v
      bodyFlag = t
      continue
    }
    if (t === '-m' || t === '--max-time') {
      const v = value()
      if (!v) continue
      if (/^\d+$/.test(v.lit)) maxTime = v.lit
      else fail(`--max-time ${v.lit} is not a whole number of seconds`)
      continue
    }
    if (t === '-w' || t === '--write-out') {
      const v = value()
      if (!v) continue
      if (v.lit === '\\n%{http_code}' || v.lit === '$\\n%{http_code}') withStatus = true
      else fail(`unsupported -w format ${v.lit}`)
      continue
    }
    if (t.startsWith('-')) {
      fail(`unsupported option ${t}`)
      if (VALUE_OPTIONS.has(t) && words[i + 1]) i++
      continue
    }
    // A second bare word after the URL is prose that follows the command in a text: stop there.
    if (urlWord) { proseIdx = i; break }
    urlWord = w
  }

  if (!urlWord) return ignore('no URL')

  // Where does the call go? Only the dashboard (localhost / 127.0.0.1 on its port, /api/ path).
  // A token we can tie to a token file (a file reference, or a variable assigned from one) makes a
  // call to any other place worth reporting; an unidentified $VAR credential on another host
  // (github, google, ...) is none of our business.
  const known = authKind !== null && authKind !== 'unknown'
  const local = LOCAL_URL_RE.exec(urlWord.lit)
  const varHost = /^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)(\/api(?:\/.*)?)$/.exec(urlWord.lit)
  let portText: string | undefined
  let pathLit: string
  if (local) {
    portText = local[1]
    pathLit = local[2] ?? ''
  } else if (varHost) {
    const base = opts.hostVars?.get(varHost[1].replace(/[${}]/g, ''))
    const baseMatch = base ? LOCAL_URL_RE.exec(base) : null
    if (!baseMatch) return known ? skip('host comes from a variable: cannot confirm it is the dashboard') : ignore('variable host')
    portText = baseMatch[1]
    pathLit = varHost[2]
  } else {
    return known || TOKEN_FILE_RE.test(cmd)
      ? skip(`dashboard token sent to a non-dashboard host (${urlWord.lit.slice(0, 60)}): left alone`)
      : ignore('other host')
  }
  if (!(pathLit === '/api' || pathLit.startsWith('/api/') || pathLit.startsWith('/api?'))) return ignore('not an /api/ path')
  if (portText === undefined || !/^\d+$/.test(portText)) {
    return known ? skip(`port ${portText === undefined ? '(none)' : portText} is not a fixed dashboard port`) : ignore('other port')
  }
  if (Number(portText) !== defaultPort) {
    return known ? skip(`another instance (port ${portText}): the wrapper targets port ${defaultPort}`) : ignore('other port')
  }
  if (authKind === null) return skip('dashboard URL without a token header: left alone')
  const firstProblem = problem as string | null
  if (firstProblem !== null) return skip(firstProblem)

  const prefixLen = urlWord.lit.length - pathLit.length
  const pathWord = dropPrefix(urlWord, prefixLen)
  if (pathWord.lit.startsWith('/api?')) return skip('path without a resource')
  const verb = method ?? (body ? 'POST' : 'GET')
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(verb)) return skip(`method ${verb} is not supported by the wrapper`)

  const admin = adminRequirement(verb, pathWord.lit)

  const parts: string[] = [opts.wrapper]
  if (agent && agent.lit) parts.push('--agent', renderWord(agent))
  if (authKind === 'operator') parts.push('--token', 'operator')
  else if (admin.adminOnly) parts.push('--token', 'admin')
  if (maxTime) parts.push('--max-time', maxTime)
  if (withStatus) parts.push('--with-status')
  parts.push(verb, renderWord(pathWord))
  if (body) {
    const b: Word = body
    if (b.lit === '@-') parts.push('-')
    else if (b.lit.startsWith('@') && bodyFlag === '--data-raw') return skip('--data-raw with a leading @ is literal text, the wrapper would read a file')
    else parts.push(renderWord(b))
  }
  // Sentence punctuation glued to the last quoted word ("...".) belongs to the text around the
  // command, not to the command: leave it out of the span so it stays where it is.
  const last = words[(proseIdx < 0 ? words.length : proseIdx) - 1]
  const tail = /["']([.,:;!?]+)$/.exec(last.raw)?.[1] ?? ''
  return {
    ok: true,
    replacement: parts.join(' '),
    method: verb,
    path: pathWord.lit,
    ...(agent && agent.lit ? { agent: agent.lit } : {}),
    adminOnly: admin.adminOnly && authKind !== 'operator',
    adminReason: admin.reason,
    consumed: last.end - tail.length,
  }
}

// ── Plan for a whole text ───────────────────────────────────────────────────

function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  return starts
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

const snippetOf = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 140)

/** `VAR=$(cat <token file>)` (kind 'token') or `VAR=http://localhost:<port>` (kind 'host'). */
interface Assignment {
  name: string
  kind: 'token' | 'host'
  tokenKind?: TokenKind
  hostUrl?: string
  line: number
  wholeLine: boolean
  text: string
}

function findAssignments(text: string, starts: number[]): Assignment[] {
  const out: Assignment[] = []
  const lineText = (line: number): string => text.slice(starts[line - 1], line < starts.length ? starts[line] - 1 : text.length)
  const tokenRe = /(?<![\w$])((?:export\s+)?([A-Za-z_]\w*)=(["']?)\$\(\s*cat\s+[^)]*?(dashboard-token|\.agent-token|\.operator-token)[^)]*\)\3)/g
  const hostRe = /(?<![\w$])((?:export\s+)?([A-Za-z_]\w*)=(["']?)(https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)\/?\3)(?=\s|;|$)/g
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(text)) !== null) {
    const line = lineOf(starts, m.index)
    out.push({
      name: m[2], kind: 'token', line, text: m[0],
      tokenKind: m[4] === '.operator-token' ? 'operator' : m[4] === '.agent-token' ? 'agent' : 'dashboard',
      wholeLine: lineText(line).trim().replace(/;$/, '') === m[1],
    })
  }
  while ((m = hostRe.exec(text)) !== null) {
    const line = lineOf(starts, m.index)
    out.push({
      name: m[2], kind: 'host', line, text: m[0], hostUrl: m[4],
      wholeLine: lineText(line).trim().replace(/;$/, '') === m[1],
    })
  }
  return out
}

export function planRewrite(text: string, opts: PlanOpts): RewritePlan {
  const starts = lineStartsOf(text)
  const assigns = findAssignments(text, starts)
  const tokenVars = new Map<string, TokenKind>(opts.tokenVars ?? [])
  const hostVars = new Map<string, string>(opts.hostVars ?? [])
  for (const a of assigns) {
    if (a.kind === 'token' && !tokenVars.has(a.name)) tokenVars.set(a.name, a.tokenKind as TokenKind)
    if (a.kind === 'host' && !hostVars.has(a.name)) hostVars.set(a.name, a.hostUrl as string)
  }
  const copts: ConvertOpts = { ...opts, tokenVars, hostVars }

  const edits: PlanEdit[] = []
  const skipped: PlanSkip[] = []
  const covered = new Set<number>()
  const cover = (a: number, b: number): void => { for (let l = a; l <= b; l++) covered.add(l) }

  for (const span of findCurlCommands(text)) {
    const trimmed = span.text.replace(/(?:[ \t]|\\\r?\n)+$/, '')
    const res = convertCurl(trimmed, copts)
    // Prose that follows the command on the same line is not part of it.
    const used = res.ok ? trimmed.slice(0, res.consumed) : trimmed
    const end = span.start + used.length
    const line = lineOf(starts, span.start)
    const endLine = lineOf(starts, Math.max(span.start, end - 1))
    if (res.ok) {
      edits.push({
        line, endLine, start: span.start, end, old: used, replacement: res.replacement,
        method: res.method, path: res.path, ...(res.agent ? { agent: res.agent } : {}),
        adminOnly: res.adminOnly, adminReason: res.adminReason,
      })
      cover(line, endLine)
    } else if (!res.ignored) {
      skipped.push({ line, reason: res.reason, snippet: snippetOf(trimmed) })
      cover(line, endLine)
    }
  }

  // A token (or base URL) variable is dropped only when every use of it is inside a converted call.
  const assignmentsToDrop: number[] = []
  const inlineAssignments: InlineAssignment[] = []
  const keptAssignLines = new Set<number>()
  const names = new Set(assigns.map(a => a.name))
  for (const name of names) {
    const ref = new RegExp('\\$\\{?' + name + '\\b', 'g')
    const total = (text.match(ref) ?? []).length
    const inEdits = edits.reduce((n, e) => n + (e.old.match(ref) ?? []).length, 0)
    const drop = total > 0 && total === inEdits
    for (const a of assigns.filter(x => x.name === name)) {
      if (!drop) { if (a.kind === 'token') keptAssignLines.add(a.line); continue }
      if (a.wholeLine) { assignmentsToDrop.push(a.line); covered.add(a.line) }
      else { inlineAssignments.push({ line: a.line, text: a.text }); covered.add(a.line) }
    }
  }
  assignmentsToDrop.sort((x, y) => x - y)

  return { edits, skipped, manual: findManual(text, covered, keptAssignLines, !!opts.markdown), assignmentsToDrop, inlineAssignments }
}

// ── Credential uses the tool cannot convert ─────────────────────────────────

const TOKEN_CONTEXT_RE = /3420|dashboard-token|\.agent-token|\.operator-token|WEB_PORT|\/api\//

function findManual(text: string, covered: ReadonlySet<number>, keptAssignLines: ReadonlySet<number>, markdown: boolean): PlanManual[] {
  const lines = text.split('\n')
  const out: PlanManual[] = []
  // In markdown, only a fenced block is code; everything else is prose that merely names a token file.
  const fenced: boolean[] = []
  let inFence = false
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) { fenced.push(false); inFence = !inFence } else fenced.push(inFence)
  }
  const near = (idx: number): boolean => {
    for (let k = Math.max(0, idx - 8); k <= Math.min(lines.length - 1, idx + 8); k++) if (TOKEN_CONTEXT_RE.test(lines[k])) return true
    return false
  }
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1
    const l = lines[idx]
    if (covered.has(lineNo) && !keptAssignLines.has(lineNo)) continue
    const push = (kind: ManualKind, reason: string): void => { out.push({ line: lineNo, kind, reason, snippet: snippetOf(l) }) }
    if (markdown && !fenced[idx] && !keptAssignLines.has(lineNo)) {
      if (TOKEN_FILE_RE.test(l)) push('mention', 'names a token file in prose; review by hand')
      continue
    }
    if (/["']curl["']\s*,/.test(l) && lines.slice(idx, idx + 6).some(x => /(localhost|127\.0\.0\.1):\d+\/api/.test(x))) {
      push('subprocess-curl', 'curl built as an argv list in code: convert by hand (call the wrapper or scripts/lib helpers)')
      continue
    }
    const hasToken = TOKEN_FILE_RE.test(l)
    if (hasToken && /\b(open|read_text|read_bytes|readFileSync|readFile|Path)\s*\(|\bcat\s+\S*(dashboard-token|\.agent-token|\.operator-token)/.test(l)) {
      const kept = keptAssignLines.has(lineNo)
      push('token-file-read', kept
        ? 'token file read into a variable that is still used by calls that were not converted'
        : 'token file read outside a convertible curl (shell cat, python or node code)')
      continue
    }
    if (/\bBearer\b/.test(l) && /urllib|urlopen|requests\.|http\.client|httpx|axios|fetch\(|Request\(|headers\s*[=:[]/i.test(l) && near(idx)) {
      push('bearer-in-code', 'Authorization: Bearer header built in code: use the token resolver the language binding provides')
      continue
    }
    if (hasToken) push('mention', 'names a token file in prose or config; review by hand')
  }
  return out
}

// ── Applying (used by tests and by anyone who wants the converted text; the CLI never writes) ─────

/**
 * The text with the edits applied and the given whole lines removed (both addressed in the ORIGINAL
 * text). Pure: the dry-run CLI never writes, this exists for tests and for a future apply step.
 */
export function applyEdits(text: string, edits: readonly PlanEdit[], dropLines: readonly number[] = []): string {
  const starts = lineStartsOf(text)
  const ops: { start: number; end: number; replacement: string }[] = edits.map(e => ({ start: e.start, end: e.end, replacement: e.replacement }))
  for (const l of dropLines) {
    const start = starts[l - 1]
    if (start === undefined) continue
    ops.push({ start, end: l < starts.length ? starts[l] : text.length, replacement: '' })
  }
  let out = text
  for (const o of ops.sort((a, b) => b.start - a.start)) out = out.slice(0, o.start) + o.replacement + out.slice(o.end)
  return out
}
