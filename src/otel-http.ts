// Dashboard HTTP server telemetry (OTel H6a): the request duration histogram and a span for the requests worth a
// span, with a ROUTE TEMPLATE instead of the raw path.
//
// Privacy: a path carries ids, names and search terms (/api/kanban/<card>, /api/skills/<name>/..., ?q=...). The
// metric and the span get http.route only, built here: the resource word is kept when it is a known one, a
// deeper segment is kept only if it is one of the fixed words the dashboard's own routes use (STATIC_SEGMENTS),
// everything else becomes {id}; the query string is never looked at. A cap on distinct templates is the last
// guard against a label explosion (a new route nobody listed lands in the template of its parent, a flood of
// distinct ones in /other).

import { randomBytes } from 'node:crypto'
import type http from 'node:http'
import { upsertOtelSpan, closeOtelSpan } from './db.js'
import { recordHttpServerRequest } from './otel-signals.js'

import { runAs } from './db/context.js'
// First path segment after /api: the resources of the dashboard.
const RESOURCES: ReadonlySet<string> = new Set([
  'activity', 'admin', 'agent-availability', 'agents', 'agent-inflight-turn', 'agent-state', 'agent-taskstate', 'approvals', 'artifacts', 'audit',
  'auth', 'autonomy', 'backups', 'blackboard', 'bridge-enroll', 'browser-enroll-codes', 'budgets', 'channel-bindings',
  'claude-auth', 'claude-plans', 'config', 'conversation-ledger', 'daily-log', 'dashboard-users', 'decisions', 'device-keys',
  'docs', 'egress-allowlist', 'federation', 'fleet', 'github-repos', 'hook-audit', 'identity', 'import', 'kanban', 'labels',
  'memories', 'messages', 'migrate', 'models', 'network-info', 'otel-export', 'overview', 'partner-senders', 'schedules',
  'sessions', 'settings', 'skill-usage', 'skills', 'spans', 'stt', 'team', 'tenants', 'tokens', 'tool-log', 'tool-stats',
  'traces', 'tts', 'users', 'vault', 'watchlist', 'workspace', 'workspace-docs',
])

// Deeper segments that are fixed words in the routes (collected from the route sources), as opposed to ids and names.
const STATIC_SEGMENTS: ReadonlySet<string> = new Set([
  'activity', 'admin', 'agent-availability', 'agents', 'analyze', 'apply', 'approvals', 'archived', 'assignees', 'available',
  'avatar', 'backfill', 'backlog', 'bindings', 'blackboard', 'bridge-enroll', 'browser-enroll-codes', 'budgets', 'categories',
  'channel-bindings', 'check', 'claim', 'claude-auth', 'collect', 'configure', 'dates', 'decisions', 'device-keys', 'detail',
  'diagnose', 'directive', 'directory', 'docs', 'dump', 'enabled', 'enroll-browser', 'expand-prompt', 'expand-questions',
  'export', 'export-all', 'external-paths', 'facts', 'federation', 'focus', 'github-repos', 'graph', 'heartbeat-summary',
  'history', 'identity', 'import', 'inbox', 'init', 'install', 'kanban', 'labels', 'launch', 'links', 'local', 'log', 'login',
  'logout', 'logout-all', 'maintain', 'manifest', 'manual', 'me', 'memories', 'messages', 'modality', 'model-dist',
  'model-suggest', 'models', 'overview', 'partner-senders', 'password', 'peers', 'pending', 'prune', 'read-event', 'recall',
  'refresh', 'remove', 'resort', 'restart', 'rotate', 'routing-mode', 'run', 'scan', 'search', 'sessions', 'set',
  'shadow-log', 'skills', 'sources', 'sql', 'ssh-keys', 'ssh-servers', 'stale', 'state', 'stats', 'status', 'stt', 'summary',
  'sync', 'team', 'tenant-gate-status', 'tenants', 'threads', 'tick-status', 'timeline', 'tokens', 'tool-stats', 'tts',
  'users', 'versions', 'watchlist', 'workspace', 'comments', 'toggle', 'activate', 'transfer', 'cancel', 'retry', 'verify',
])

const KNOWN_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const MAX_SEGMENTS = 6
export const MAX_DISTINCT_ROUTES = 300
const OTHER_ROUTE = '/other'

const seenRoutes = new Set<string>()

// Path (already without the /api/v1 alias, the query string is not part of it) -> low-cardinality route template.
// `coarse` gives the resource only (/api/kanban): used for the answers that say no (4xx), which also covers every
// request nobody authenticated. Those never add to the set of known templates, so a stranger sending made-up
// paths can neither fill the cap (and push the real routes into /other) nor learn which paths exist.
export function httpRouteTemplate(path: string, coarse = false): string {
  if (path === '/api' || !path.startsWith('/api/')) return 'static'
  const segments = path.split('/').filter(Boolean).slice(1, coarse ? 2 : MAX_SEGMENTS + 1) // after "api"
  const out: string[] = ['api']
  segments.forEach((seg, i) => {
    const word = seg.toLowerCase()
    out.push((i === 0 ? RESOURCES : STATIC_SEGMENTS).has(word) ? word : '{id}')
  })
  const template = '/' + out.join('/')
  if (coarse) return template // at most the number of resources: bounded by itself
  if (seenRoutes.has(template)) return template
  if (seenRoutes.size >= MAX_DISTINCT_ROUTES) return OTHER_ROUTE
  seenRoutes.add(template)
  return template
}

export function resetSeenRoutes(): void {
  seenRoutes.clear()
}

export function httpMethod(method: string): string {
  const m = (method || '').toUpperCase()
  return KNOWN_METHODS.has(m) ? m : '_OTHER'
}

// ── W3C trace context (https://www.w3.org/TR/trace-context/) ────────────────────────────────────────────────
// traceparent: version-traceid-parentid-flags, all lowercase hex. Only the trace id is taken over: it is stored as
// `w3c-<32 hex>`, which the OTLP mapping sends as it is (any other id is hashed), so a span of this request lands
// in the trace of the caller. A malformed or all-zero header is ignored.
const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/

export function traceIdFromTraceparent(header: unknown): string | null {
  if (typeof header !== 'string') return null
  const m = TRACEPARENT_RE.exec(header.trim().toLowerCase())
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null
  return `w3c-${m[1]}`
}

// ── Recording ───────────────────────────────────────────────────────────────────────────────────────────────
// A span is written only for a request that failed on the server (5xx) or was slow: a span per request would be
// a database write per dashboard poll. The histogram covers every request.
export const SLOW_REQUEST_SECONDS = 1

export interface HttpRequestFacts {
  method: string
  path: string
  status: number
  seconds: number
  agentId?: string | null
  traceparent?: unknown
  // Only a traceparent that came with credentials is believed; anyone else's is ignored (and cannot steer a span
  // into a trace of their choosing).
  authenticated?: boolean
  nowMs?: number
}

export async function recordHttpRequest(f: HttpRequestFacts): Promise<void> {
  try {
    const refused = f.status >= 400 && f.status < 500
    const route = httpRouteTemplate(f.path, refused)
    const method = httpMethod(f.method)
    const status = Number.isInteger(f.status) && f.status >= 100 && f.status <= 599 ? f.status : 0
    recordHttpServerRequest(method, route, status, f.seconds)
    if (status >= 500 || f.seconds >= SLOW_REQUEST_SECONDS) {
      const endMs = f.nowMs ?? Date.now()
      const startMs = Math.max(0, endMs - Math.round(f.seconds * 1000))
      const traceId = (f.authenticated ? traceIdFromTraceparent(f.traceparent) : null) ?? randomBytes(16).toString('hex')
      const spanId = randomBytes(8).toString('hex')
      await upsertOtelSpan({
        trace_id: traceId, span_id: spanId, parent_span_id: null, agent_id: f.agentId || 'dashboard',
        operation: 'http.server', start_ms: startMs, attributes: JSON.stringify({ http_method: method, http_route: route, http_status: status }),
      })
      await closeOtelSpan(traceId, spanId, endMs, status >= 500 ? 'error' : 'ok')
    }
  } catch {
    /* instrumentation: never affects the request */
  }
}

// An event stream (SSE): the browser's EventSource asks for text/event-stream, and the response says so. The
// response header is read from the serialized head too, because writeHead({...}) does not show in getHeader().
function isEventStream(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (String(req.headers['accept'] || '').includes('text/event-stream')) return true
  if (String(res.getHeader('content-type') || '').includes('text/event-stream')) return true
  return String((res as unknown as { _header?: string })._header || '').toLowerCase().includes('text/event-stream')
}

// Called once per request at the top of the server's handler: records the request when its response is done.
// An answer cut short by the client is no measurement, and neither is an event stream (its "duration" is the
// length of the connection).
// `trust` is read when the response is done, so the handler can set `authenticated` once it has resolved the caller.
export interface HttpTrust { authenticated: boolean }
export function instrumentHttpRequest(req: http.IncomingMessage, res: http.ServerResponse, method: string, path: string, trust: HttpTrust = { authenticated: false }): void {
  const t0 = process.hrtime.bigint()
  res.once('close', () => {
    if (!res.writableFinished) return
    if (isEventStream(req, res)) return
    // recordHttpRequest catches its own failures; a close handler cannot wait for it.
    // A close handler runs outside the request's db context, so the write opens its own.
    void runAs.system('http-metrics', () => recordHttpRequest({
      method, path, status: res.statusCode, seconds: Number(process.hrtime.bigint() - t0) / 1e9,
      traceparent: req.headers['traceparent'],
      authenticated: trust.authenticated,
    }))
  })
}
