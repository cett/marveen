// Pure transport helpers of the OTLP push exporter (src/web/otel-push-exporter.ts): header parsing,
// the endpoint policy, what an HTTP status means, partialSuccess, backoff. No I/O, so each rule is
// testable without a collector.

// ── Headers (OTEL_EXPORTER_OTLP_HEADERS) ─────────────────────────────────────

// RFC 7230 token: what a header name may be made of.
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
// Set by the exporter itself, or by fetch: a configured value must not override them.
const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'host', 'transfer-encoding'])

export interface ParsedHeaders {
  headers: Record<string, string>
  // Header NAMES that were skipped, or a fixed placeholder. Never a value, and never a pair without a
  // `=` (that may be a bare credential): both go to the log.
  rejected: string[]
}

// The OTel env format: `name1=value1,name2=value2`, each value percent-encoded (so a value can carry
// a comma). `Authorization=Bearer%20abc` becomes `Authorization: Bearer abc`.
export function parseOtlpHeaders(raw: string): ParsedHeaders {
  const headers: Record<string, string> = {}
  const rejected: string[] = []
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim()
    if (eq === -1) {
      // no `=`: this could be a bare token pasted without its name, so it is never echoed
      rejected.push('(missing =)')
      continue
    }
    if (!HEADER_NAME_RE.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) {
      rejected.push(HEADER_NAME_RE.test(name) ? name : '(unreadable)')
      continue
    }
    let value: string
    try {
      value = decodeURIComponent(trimmed.slice(eq + 1).trim())
    } catch {
      rejected.push(name)
      continue
    }
    if (/[\r\n\0]/.test(value)) {
      rejected.push(name)
      continue
    }
    headers[name] = value
  }
  return { headers, rejected }
}

// ── Endpoint policy ──────────────────────────────────────────────────────────

export type EndpointCheck = { ok: true; base: string } | { ok: false; reason: string }

// A host that only resolves inside a private network: loopback, RFC 1918, link-local, ULA, `.local`,
// and a single-label name (a compose or cluster service name).
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host.startsWith('fe80:')) return true
  if (host.includes(':') && (host.startsWith('fc') || host.startsWith('fd'))) return true // unique local fc00::/7
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  return !host.includes('.') && !host.includes(':')
}

// The endpoint must be an http(s) URL without embedded credentials. Headers (usually a bearer token)
// are only sent over https, or over plain http inside a private network: a token must not cross the
// open internet in clear text.
export function checkEndpoint(endpoint: string, hasHeaders: boolean): EndpointCheck {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return { ok: false, reason: 'OTEL_EXPORTER_OTLP_ENDPOINT is not a valid URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `OTEL_EXPORTER_OTLP_ENDPOINT must be http(s), got ${url.protocol}` }
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'OTEL_EXPORTER_OTLP_ENDPOINT must not carry credentials: use OTEL_EXPORTER_OTLP_HEADERS' }
  }
  if (hasHeaders && url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    return { ok: false, reason: 'OTEL_EXPORTER_OTLP_HEADERS would go over plain http to a non-private host: use https' }
  }
  return { ok: true, base: endpoint.replace(/\/+$/, '') }
}

// ── What a response means ────────────────────────────────────────────────────

// OTLP/HTTP: 400 (and the other "this payload is wrong" statuses) is permanent, resending the same
// batch can never succeed and would block every batch behind it. Everything else that is not a 2xx
// (401/403 from a wrong header, 404 from a wrong path, 429, 5xx) is worth retrying later.
const PERMANENT_STATUSES = new Set([400, 413, 415, 422])

export function isPermanentStatus(status: number): boolean {
  return PERMANENT_STATUSES.has(status)
}

export interface PartialSuccess {
  rejected: number
  message: string
}

// A 2xx may still say "I kept some of it": {"partialSuccess":{"rejectedSpans":"3","errorMessage":"..."}}
// (traces) rejectedDataPoints (metrics) or rejectedLogRecords (logs). The spec says not to retry those.
export function parsePartialSuccess(body: string): PartialSuccess | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as { partialSuccess?: Record<string, unknown> }
    const ps = parsed?.partialSuccess
    if (!ps || typeof ps !== 'object') return null
    const rejected = Number(ps['rejectedSpans'] ?? ps['rejectedDataPoints'] ?? ps['rejectedLogRecords'] ?? 0)
    if (!Number.isFinite(rejected) || rejected <= 0) return null
    const message = typeof ps['errorMessage'] === 'string' ? ps['errorMessage'].slice(0, 200) : ''
    return { rejected: Math.round(rejected), message }
  } catch {
    return null
  }
}

// ── Backoff ──────────────────────────────────────────────────────────────────

export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_MAX_MS = 10 * 60_000
const RETRY_AFTER_MAX_MS = 60 * 60_000

// Wait before the next attempt after `consecutiveFailures` failures in a row: 30 s, 60 s, 120 s ...
// capped at 10 minutes, +-20 % jitter so a fleet of installs does not retry in lockstep.
export function backoffDelayMs(consecutiveFailures: number, random: () => number = Math.random): number {
  const exp = Math.min(Math.max(consecutiveFailures, 1) - 1, 10)
  const base = Math.min(BACKOFF_BASE_MS * 2 ** exp, BACKOFF_MAX_MS)
  return Math.round(base * (0.8 + random() * 0.4))
}

// Retry-After as seconds or an HTTP date; unusable values are ignored.
export function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - nowMs
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  return Math.min(ms, RETRY_AFTER_MAX_MS)
}
