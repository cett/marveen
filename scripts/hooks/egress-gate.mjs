#!/usr/bin/env node
// PreToolUse hook: WebFetch egress allowlist enforcement.
//
// Any WebFetch call from the main agent must target a known, legitimate API
// endpoint. Arbitrary web content (RSS feeds, docs, news pages, public APIs
// not in the allowlist) MUST go through the quarantine-reader sub-agent
// instead, so the fetched content is quarantined, wrapped, and never executed
// as instructions in the main agent's context.
//
// Two-tier allowlist:
//   1. Built-in (ALLOWED_PREFIXES): hard-coded, always enforced.
//   2. Runtime (egress_allowlist DB table, migration 0056/#985): operator-managed.
//      This hook runs OUTSIDE the backend Node process (a fresh subprocess per
//      PreToolUse call), so it cannot query the DB directly -- it calls
//      GET /api/v1/egress-allowlist and disk-caches the result for
//      RUNTIME_CACHE_TTL_MS (resolveRuntimeAllowlist()). If the dashboard is
//      unreachable (down, still starting, or the call errors/times out), it
//      falls back to store/egress-allowlist.json via loadRuntimeAllowlist() --
//      the file this hook used to read exclusively before the DB migration.
//      That file is left in place (store/ is gitignored) purely as this
//      fail-safe; it is no longer the primary source. Shape (both the API
//      response's reshaped fields and the fallback file):
//      { "domains": ["example.com"], "prefixes": ["https://host/path/"] }.
//      Missing file/cache, malformed JSON, or a failed API call -> treated as
//      empty lists (FAIL-OPEN on the source, FAIL-SAFE on the decision: the
//      built-in list still guards; no extra URLs are allowed merely because
//      the runtime source is unavailable).
//
// When a URL is not on either allowlist:
//   - The tool call is HARD-BLOCKED (decision: deny).
//   - The blocked call is appended to EGRESS_BLOCK_LOG for operator review.
//   - The operator can approve the URL/domain via the Settings dashboard (or
//     POST /api/v1/egress-allowlist), then re-run the WebFetch. No restart
//     required; the next call picks it up once the cache TTL elapses.
//
// The log is separate from the main Marveen log so operators can grep it
// independently: `tail -f store/egress-blocked.log`
//
// Scope: this guard covers the Claude Code WebFetch tool only. It does NOT
// intercept WebSearch, curl/Bash network calls, or MCP-server outbound
// requests. Those channels are out of scope for this hook mechanism and require
// separate controls if needed.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Derive repo root from this script's location (scripts/hooks/egress-gate.mjs).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EGRESS_BLOCK_LOG = join(REPO_ROOT, 'store', 'egress-blocked.log')
const RUNTIME_ALLOWLIST_PATH = join(REPO_ROOT, 'store', 'egress-allowlist.json')

// Dashboard port: env WEB_PORT, else the install .env, else the 3420 default.
// A fixed 3420 in the allowlist below blocked the agent's own dashboard as soon
// as the install moved to another port.
// SECURITY: the value is interpolated into an allowlist PREFIX (`http://localhost:${PORT}/`), so it
// must be digits ONLY. An unvalidated value containing `@` turns the whole `localhost:<value>` part
// into a URL userinfo section -- `http://localhost:3420@evil.com/` resolves to host evil.com, which
// would put an attacker-chosen host on the built-in allowlist and defeat the egress gate entirely.
// Anything that is not 1-5 digits is rejected and falls back to the default port.
const isValidPort = (v) => /^\d{1,5}$/.test(v)
const DASHBOARD_PORT = (() => {
  const fromEnv = process.env['WEB_PORT']
  if (fromEnv && isValidPort(fromEnv)) return fromEnv
  try {
    const m = readFileSync(join(REPO_ROOT, '.env'), 'utf-8').match(/^WEB_PORT=(.*)$/m)
    const v = m?.[1]?.trim().replace(/^["']|["']$/g, '')
    if (v && isValidPort(v)) return v
  } catch { /* no .env: fall through to the default */ }
  return '3420'
})()

// Built-in allowlist: URL prefixes the main agent may call directly via WebFetch.
// Anything not on this list (or the runtime allowlist) must go through the
// quarantine-reader sub-agent. Keep sorted and documented so additions are
// intentional, not accidental.
const ALLOWED_PREFIXES = [
  // GitHub REST API
  'https://api.github.com/',
  // Google OAuth token endpoint
  'https://oauth2.googleapis.com/',
  // Google APIs (Calendar, Gmail, Drive, etc.)
  'https://www.googleapis.com/',
  'https://gmail.googleapis.com/',
  'https://calendar.googleapis.com/',
  // Telegram Bot API
  'https://api.telegram.org/',
  // Slack Web API
  'https://slack.com/api/',
  // Discord REST API
  'https://discord.com/api/',
  // Ollama (local LLM server) -- localhost and loopback
  'http://localhost:11434/',
  'http://127.0.0.1:11434/',
  // Marveen dashboard API (local). The port follows WEB_PORT: a fixed 3420 here
  // blocked the agent's own dashboard once the install moved to another port.
  `http://localhost:${DASHBOARD_PORT}/`,
  `http://127.0.0.1:${DASHBOARD_PORT}/`,
]

// The quarantine tier.
//
// The block message tells the caller to fetch through the quarantine-reader
// sub-agent -- and until now this same hook blocked that sub-agent too, so the
// escape hatch the gate prescribed was one the gate closed (kanban #224).
//
// A sub-agent's PreToolUse payload carries two fields a main agent's does not:
// `agent_id` and `agent_type` (measured 2026-08-03, both key sets recorded in
// store/egress-blocked.log). `agent_type` is what separates the tiers.
//
// FAIL-CLOSED: only an exact `agent_type` match opens this tier. A missing,
// empty, unknown or misspelled value is treated as a main agent, i.e. blocked.
// A mistake here can only deny a fetch, never grant one.
//
// The domain list mirrors the one in the sub-agent's own definition
// (templates/sub-agents/quarantine-reader.md). That copy is a promise the
// sub-agent makes to itself in its prompt; this one is enforcement. Keep them
// in step -- and when they disagree, this file is the one that decides.
const QUARANTINE_AGENT_TYPE = 'quarantine-reader'

// `path` (optional) narrows a domain to the URLs the sub-agent's definition
// actually promises. Reddit is the reason it exists: the definition allows RSS
// feeds only, and hostname matching alone would hand over the entire site.
const QUARANTINE_DOMAINS = [
  { domain: 'status.anthropic.com' },
  { domain: 'status.claude.com' },
  { domain: 'feeds.feedburner.com' },
  { domain: 'rss.arxiv.org' },
  { domain: 'export.arxiv.org' },
  { domain: 'hnrss.org' },
  { domain: 'feeds.arstechnica.com' },
  { domain: 'techcrunch.com' },
  { domain: 'feeds.reuters.com' },
  { domain: 'feeds.bbci.co.uk' },
  { domain: 'www.reddit.com', path: (p) => p.endsWith('.rss') },
]

function matchesQuarantineDomain(url, extraDomains = []) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const hostMatches = (d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d)
  for (const entry of QUARANTINE_DOMAINS) {
    if (!hostMatches(entry.domain)) continue
    if (entry.path && !entry.path(parsed.pathname)) return false
    return true
  }
  // Operator additions carry no path rule: an entry someone typed into the
  // store file is a deliberate act, and second-guessing its shape here would
  // only make the file's behaviour harder to predict.
  return extraDomains.some(hostMatches)
}

// Load the runtime allowlist from store/egress-allowlist.json.
// FAIL-OPEN on the file: missing or malformed -> empty lists, NOT an error.
// The caller must still apply the built-in ALLOWED_PREFIXES.
export function loadRuntimeAllowlist() {
  try {
    const raw = readFileSync(RUNTIME_ALLOWLIST_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      domains: Array.isArray(parsed.domains) ? parsed.domains.filter((d) => typeof d === 'string') : [],
      prefixes: Array.isArray(parsed.prefixes) ? parsed.prefixes.filter((p) => typeof p === 'string') : [],
      // Operator-managed extension of the QUARANTINE tier. Reachable ONLY by
      // the quarantine-reader sub-agent -- putting a domain here does not open
      // it to the main agent, which is the whole point of the split.
      quarantineDomains: Array.isArray(parsed.quarantine_domains)
        ? parsed.quarantine_domains.filter((d) => typeof d === 'string')
        : [],
    }
  } catch {
    // Missing file or JSON parse error: treat as empty, never propagate.
    return { domains: [], prefixes: [], quarantineDomains: [] }
  }
}

// --- DB-backed runtime allowlist (migration 0056/#985, decision D1=A) ------
//
// This hook is a fresh Node subprocess per PreToolUse call -- there is no
// long-lived process to hold an in-memory cache across invocations, so the
// "process-level Map, 30s TTL" the plan describes is implemented as a small
// disk-backed cache file instead: functionally the same throttle (at most one
// dashboard round-trip per RUNTIME_CACHE_TTL_MS across however many WebFetch
// calls land in that window), just surviving the fact that "the process" here
// means "one exec, then exit".
const RUNTIME_CACHE_PATH = join(REPO_ROOT, 'store', '.egress-allowlist-cache.json')
const RUNTIME_CACHE_TTL_MS = 30_000
// Kept short: a hung dashboard must not make WebFetch itself feel hung, and
// the fallback (loadRuntimeAllowlist, below) is one readFileSync away.
const API_FETCH_TIMEOUT_MS = 2_000

function readRuntimeCache() {
  try {
    const raw = JSON.parse(readFileSync(RUNTIME_CACHE_PATH, 'utf-8'))
    if (typeof raw?.fetchedAt !== 'number') return null
    // A fetchedAt in the FUTURE is never fresh: a hand-written cache with fetchedAt = 9e15 would
    // otherwise stay "fresh" for good. The cache is written only by this hook, with Date.now().
    if (raw.fetchedAt > Date.now()) return null
    if (Date.now() - raw.fetchedAt >= RUNTIME_CACHE_TTL_MS) return null
    return {
      domains: Array.isArray(raw.domains) ? raw.domains : [],
      prefixes: Array.isArray(raw.prefixes) ? raw.prefixes : [],
      quarantineDomains: Array.isArray(raw.quarantineDomains) ? raw.quarantineDomains : [],
    }
  } catch {
    return null // missing/malformed/stale cache: caller re-fetches
  }
}

function writeRuntimeCache(list) {
  try {
    mkdirSync(join(REPO_ROOT, 'store'), { recursive: true })
    writeFileSync(RUNTIME_CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), ...list }), 'utf-8')
  } catch {
    // A cache write failure only costs the throttle benefit, not correctness
    // (the next call just fetches again) -- never let it block the decision.
  }
}

// The calling agent's own dashboard token (agents/<id>/.agent-token), else the shared one
// (store/.dashboard-token) while T3 has no enforcement: scripts/lib/agent-api.mjs holds the
// resolution. The token only decides which identity the allowlist is FETCHED under; the verdict
// never depends on it (no token, a token the dashboard refuses, or an unloadable resolver all
// end in the same file fallback below). A dynamic import keeps a missing resolver from taking
// the whole gate down at load time.
async function readDashboardAuth() {
  try {
    const { resolveToken } = await import('../lib/agent-api.mjs')
    const auth = resolveToken({ cwd: process.cwd() })
    return auth.token ? auth : null
  } catch {
    return null
  }
}

// One HTTP round-trip to the backend's own view of egress_allowlist. Returns
// null on ANY failure (no token file, connection refused, timeout, non-200,
// malformed body) -- the caller falls back to the file, never throws.
async function fetchRuntimeAllowlistFromApi() {
  const auth = await readDashboardAuth()
  if (!auth) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), API_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`http://localhost:${DASHBOARD_PORT}/api/v1/egress-allowlist`, {
      headers: auth.headers(),
      signal: controller.signal,
    })
    if (!res.ok) return null
    const body = await res.json()
    return {
      domains: Array.isArray(body.domains) ? body.domains.filter((d) => typeof d === 'string') : [],
      prefixes: Array.isArray(body.prefixes) ? body.prefixes.filter((p) => typeof p === 'string') : [],
      quarantineDomains: Array.isArray(body.quarantine_domains)
        ? body.quarantine_domains.filter((d) => typeof d === 'string')
        : [],
    }
  } catch {
    return null // network error, timeout (AbortError), or malformed JSON
  } finally {
    clearTimeout(timer)
  }
}

// The entry point's actual allowlist source: fresh disk cache first, else a
// live API call (cached for next time on success), else the file --
// loadRuntimeAllowlist()'s own FAIL-OPEN behavior is the final backstop, so
// this function itself never throws.
export async function resolveRuntimeAllowlist() {
  const cached = readRuntimeCache()
  if (cached) return cached
  const fromApi = await fetchRuntimeAllowlistFromApi()
  if (fromApi) {
    writeRuntimeCache(fromApi)
    return fromApi
  }
  return loadRuntimeAllowlist()
}

// Pure decision, with the tier that decided it.
//
// `runtimeList` is the decoded store/egress-allowlist.json (or any equivalent
// object) and `agentType` is the payload's `agent_type` -- empty for a main
// agent. Keeping file I/O out of this function makes it fully unit-testable
// without touching the filesystem.
//
// The tier is returned because the quarantine tier is the security-relevant
// exception and its grants are audited: a fetch nobody can see is a hole
// nobody can find.
//
// Domain matching uses URL-parsed hostname ONLY, not string-contains, to prevent
// bypasses like `https://evil.com/?x=docs.anthropic.com` matching the domain
// "docs.anthropic.com" via a simple includes() check.
export function egressDecision(
  toolName,
  toolInput,
  runtimeList = { domains: [], prefixes: [], quarantineDomains: [] },
  agentType = '',
) {
  if (toolName !== 'WebFetch') return { blocked: false, tier: 'not-webfetch' }
  const url = String(toolInput?.url ?? '')
  if (!url) return { blocked: false, tier: 'no-url' }

  // 1. Built-in prefix check (startsWith is correct here: the prefix already
  //    includes the trailing slash so a prefix-extension attack is impossible,
  //    e.g. 'https://api.github.com.evil.com/' does not start with
  //    'https://api.github.com/').
  if (ALLOWED_PREFIXES.some((prefix) => url.startsWith(prefix))) return { blocked: false, tier: 'builtin' }

  // 2. Runtime prefix check.
  const rtPrefixes = runtimeList.prefixes ?? []
  if (rtPrefixes.some((p) => url.startsWith(p))) return { blocked: false, tier: 'runtime-prefix' }

  // 3. Runtime domain check: parse the URL to extract a verified hostname.
  //    URL parsing fails on non-URLs -> block (fail-safe).
  const rtDomains = runtimeList.domains ?? []
  if (rtDomains.length > 0) {
    let hostname
    try {
      hostname = new URL(url).hostname
    } catch {
      // Unparseable URL: block, don't throw.
      return { blocked: true, tier: 'unparseable' }
    }
    // Match exact hostname OR any subdomain (host.endsWith('.' + domain)).
    if (rtDomains.some((d) => hostname === d || hostname.endsWith('.' + d))) return { blocked: false, tier: 'runtime-domain' }
  }

  // 4. Quarantine tier -- the ONLY tier a main agent cannot reach. Exact
  //    agent_type match required (fail-closed: anything else falls through to
  //    the block below).
  if (String(agentType ?? '') === QUARANTINE_AGENT_TYPE) {
    if (matchesQuarantineDomain(url, runtimeList.quarantineDomains ?? [])) {
      return { blocked: false, tier: 'quarantine' }
    }
  }

  return { blocked: true, tier: 'none' }
}

// Back-compatible boolean form.
export function isEgressBlocked(toolName, toolInput, runtimeList, agentType) {
  return egressDecision(toolName, toolInput, runtimeList, agentType).blocked
}

// The payload's top-level FIELD NAMES, sorted -- never a value.
//
// This exists to answer one open question with data instead of a guess: does
// the PreToolUse payload carry anything that identifies the CALLER? The gate
// decides on the URL alone, so a main agent and a quarantine-reader sub-agent
// are indistinguishable to it, and the sub-agent is the escape hatch the block
// message itself prescribes -- which is why the RSS path is currently dead
// (kanban #224). A caller-aware tier can only be built on a field that is
// verified to exist; building it on an assumed one would produce a guard that
// looks like it protects and does not.
//
// Keys only, by construction: a value could carry a url, a prompt, or a
// secret, and this log is read casually. Nested objects contribute nothing but
// their own key.
export function payloadKeySignature(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  return Object.keys(payload).sort().join(',')
}

// `agentType` IS logged by value, unlike everything else in the payload. It is
// an agent-type name from a fixed set -- not content, not a url, not a secret
// -- and without it a denied sub-agent call cannot be told apart from a denied
// main-agent one, which is exactly the distinction this log now exists to make.
function logLine(kind, url, detail, keys = '', agentType = '') {
  try {
    mkdirSync(join(REPO_ROOT, 'store'), { recursive: true })
    const ts = new Date().toISOString()
    const keyPart = keys ? ` payload_keys="${keys}"` : ''
    const agentPart = agentType ? ` agent_type="${agentType}"` : ''
    appendFileSync(EGRESS_BLOCK_LOG, `${ts} ${kind} url="${url}" ${detail}${agentPart}${keyPart}\n`, 'utf-8')
  } catch {
    // Never let log failure cascade into blocking the agent process itself.
  }
}

const BLOCK_MESSAGE =
  'Egress TILTOTT (egress-gate hook). Ez az URL nem szerepel a fő ágens WebFetch ' +
  'engedélylistáján. Külső web-tartalom (RSS, dokumentáció, cikkek, ismeretlen API-k) ' +
  'KIZÁRÓLAG a quarantine-reader sub-ágensen keresztül kérhető le: ' +
  'Agent({ subagent_type: "quarantine-reader", prompt: `FETCH {"url":"...","nonce":"..."}` }). ' +
  'A letiltott hívás rögzítve lett a store/egress-blocked.log fájlban. ' +
  'Ha ez a hívás jogos, az operátor jóváhagyhatja: POST /api/v1/egress-allowlist ' +
  '{ "value": "example.com", "type": "domain" } (vagy "type": "prefix" és egy ' +
  '"https://example.com/api/"-szerű érték a value-ban), admin dashboard-token ' +
  'szükséges -- majd futtassa újra a WebFetch hívást.'

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
    allow() // malformed/empty input must never block the agent
  }
  const url = String(payload?.tool_input?.url ?? '')
  const agentType = String(payload?.agent_type ?? '')
  const runtimeList = await resolveRuntimeAllowlist()
  const decision = egressDecision(payload?.tool_name, payload?.tool_input, runtimeList, agentType)
  if (decision.blocked) {
    logLine('BLOCKED', url, 'reason="not on egress allowlist"', payloadKeySignature(payload), agentType)
    deny(BLOCK_MESSAGE)
  }
  // Audited, not silent: the quarantine tier is the one grant a main agent
  // cannot obtain, so every use of it leaves a line next to the denials. The
  // other tiers are the ordinary allowlist and stay quiet.
  if (decision.tier === 'quarantine') {
    logLine('ALLOWED_QUARANTINE', url, 'reason="quarantine-reader tier"', '', agentType)
  }
  allow()
}
