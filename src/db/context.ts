// The db context carrier: WHO runs a db call, carried through `await`s with an
// AsyncLocalStorage, so the PostgreSQL phase can set the row-level-security role per call without every
// db function growing a parameter.
//
//   runAs.system('heartbeat', () => ...)          a job of the dashboard itself
//   runAs.tenant('acme', () => ...)               a request of a tenant
//   runAs.agent('agent-a', 'acme', () => ...)        a request of an agent token
//   runAs.admin('http-admin', () => ...)          a global admin session (no tenant)
//   runAs.viewer('http-global-viewer', () => ...) any other authenticated session without a tenant
//   runAs.public('http-public', () => ...)        a route served without a credential
//
// For now the carrier only RECORDS and COUNTS: a call without a context is not refused and nothing is
// filtered by it (that comes with the PostgreSQL step). Every facade call reads the context; a call without one bumps a counter
// and, at most once per interval, logs a warning with the call site, so the places that still need a
// `runAs` show up before enforcement exists.
//
// ALS traps (each one has a test):
//   - the context follows `await` and a `setTimeout` created INSIDE `runAs`,
//   - it does NOT reach a `setInterval` / `setTimeout` callback created BEFORE `runAs`: that callback keeps the
//     context of where it was created. A tick that touches the db has to open its own `runAs` (waves 3 and 4),
//   - a nested `runAs` replaces the IDENTITY and keeps the trace (traceId/spanId, set by `withTrace`) of the outer
//     context, because it is still the same request; the outer context is back when it returns,
//   - EXCEPT a background job (db/background-jobs.ts: systemJob, runAsAgentJob): it opens its context with
//     `{ inheritTrace: false }`. A timer created inside a request keeps that request's context, trace included, so a tick
//     that opened a plain nested `runAs` would write its rows under the trace of a request that is long over,
//   - this store is independent of the transaction scope in tx-lock.ts and of the tenant request context.

import { AsyncLocalStorage } from 'node:async_hooks'
import { logger } from '../logger.js'
import { captureOrigin } from './tx-lock.js'

/**
 * The vocabulary of `app.role` (the row-level-security policies read it): `system` is a job of the dashboard itself,
 * `tenant` and `agent` carry a tenant, `admin` is a global admin session, `viewer` any other authenticated session
 * without a tenant, `public` a caller without a credential. The last three carry a name like `system` does.
 */
export type DbRole = 'system' | 'tenant' | 'agent' | 'admin' | 'viewer' | 'public'

/** Every role, for the code that has to account for each of them (the counters). */
export const DB_ROLES: readonly DbRole[] = ['system', 'tenant', 'agent', 'admin', 'viewer', 'public']

export interface DbContext {
  role: DbRole
  /** system, admin, viewer, public: the name of the job or of the request kind (`http-admin`). */
  name?: string
  tenantId?: string
  agentId?: string
  /**
   * The id of the dashboard user of a session-authenticated request (`app.user_id`): what lets a tenant-less viewer reach
   * its OWN user and session rows. Absent for a token, a job and a request without a session.
   */
  userId?: string
  /** The trace of the unit of work (a request, an inter-agent message), set by `withTrace`; see its comment. */
  traceId?: string
  spanId?: string
}

/** The trace a unit of work runs in: the id the `otel_spans` rows of it carry, and the span of that unit itself. */
export interface DbTrace {
  traceId: string
  spanId: string
}

const store = new AsyncLocalStorage<DbContext>()

// Escalations: a `runAs.system|admin` opened while the running context is a `tenant` or an `agent` one. Under row-level
// security a transaction has ONE role, and a tenant context that climbs to system or admin is the pattern the policies exist
// to forbid. For now it is only COUNTED, never refused (enforcement comes with the policies). Declared next to the store so
// it exists before any opener can run.
let escalations = 0

/** The one sanctioned system context of a request path: the skill regen. `src/web/skill-regen.ts` imports the name; nothing else spells it. */
export const SKILL_REGEN_JOB = 'skill-regen'

/** The write-back qualification of `src/skill-sync.ts`: does this agent serve the owner tenant or a grantee tenant of a skill. It answers ONE boolean; the grantee list never leaves the context. */
export const SKILL_GRANTS_JOB = 'skill-grants'

/**
 * The narrow system contexts that a request or an agent job opens to reach a D2 table (global, privileged only: the policy
 * gives a tenant, an agent or a viewer context ZERO rows and refuses every write). One name per db function, opened INSIDE the
 * function, and the function takes the scope the caller decided as a parameter and filters on it in SQL: the system context
 * only lifts the table policy for that one statement, it never widens what the caller may see. Each is sanctioned for the same
 * reason as the two above, a table that no tenant context can read by design, so the escalation count would only be noise.
 * A new name here needs its own reason and its own cell (src/__tests__/pg/rls-d2-request-callers.pg.test.ts).
 */
export const D2_JOBS = {
  insertPendingTaskRetry: 'insert-pending-task-retry',
  listPendingTaskRetriesForTenant: 'list-pending-task-retries-for-tenant',
  deletePendingTaskRetryForTenant: 'delete-pending-task-retry-for-tenant',
  listActivePlansForAgents: 'list-active-plans-for-agents',
  getActivePlanForAgent: 'get-active-plan-for-agent',
  activatePlanForAgent: 'activate-plan-for-agent',
  deactivatePlanForAgent: 'deactivate-plan-for-agent',
  listPendingChannelRequests: 'list-pending-channel-requests',
  recordTokenShadow: 'record-token-shadow',
  // system_config: the durable mirror of one in-flight scheduled task, written from a run-now in the tenant context of its caller
  persistScheduleInflight: 'persist-schedule-inflight',
  // system_config: the stored desired run-state of the sub-agents (key agents_desired), changed by a start/stop request of a tenant or an agent token
  changeDesiredAgents: 'change-desired-agents',
  // skills + skill_files + skill_revisions of ONE GLOBAL skill (is_global = 1): only a privileged context may write or delete a global
  // row, and its revision row is refused to any tenant context. The route's authz (a global admin, the id, the row it read) is decided
  // BEFORE; the db function takes the tenant that row had for the route and filters on it and on is_global in SQL (`deleteGlobalSkill`).
  deleteGlobalSkill: 'delete-global-skill',
} as const

/**
 * The one sanctioned system context of the conversation ledger write (`logLedgerTurn`). conversation_log is a tenant table (its
 * WITH CHECK is `tenant_id = app.tenant()`), but the row's tenant is NOT the caller's: it is the tenant of the chat's channel
 * binding, resolved server-side, and NULL for a chat with no binding. A fleet agent token runs in its own tenant context, so a chat
 * bound to another tenant, or bound to none, was refused (42501) and the turn was lost. The tenant value is derived inside the
 * writer, never taken from the caller, and the policy itself is untouched: only the lookup and the one INSERT run in this context.
 */
export const LEDGER_WRITE_JOB = 'ledger-write'

/**
 * The read twin: `recentLedgerTurns` and `openLedgerQuestion`. The same policy hides the NULL-tenant rows (an unbound chat) from an
 * agent context, so a NON-shared agent would replay nothing after the write is fixed; and whether an agent is shared (it serves two
 * or more tenants) is only visible across tenants. Opened by the db function after the route's authz (registered agent, own token);
 * the statements keep their `agent_id` filter, and a shared agent keeps its tenant filter (or gets nothing).
 */
export const LEDGER_READ_JOB = 'ledger-read'

/**
 * System contexts that are SUPPOSED to be opened from a tenant or an agent request, by name: the work reads across tenants by
 * nature, so the count would only be noise. `skill-regen`: every grantee of a skill, the tenants an agent serves. Each entry
 * is a decision of its own; a new name here needs a reason next to it. The sanction is for `runAs.system` ONLY: an ADMIN
 * context that carries the same name is still counted, or a label alone would defeat the detector.
 */
const SANCTIONED_ESCALATIONS: ReadonlySet<string> = new Set([SKILL_REGEN_JOB, SKILL_GRANTS_JOB, LEDGER_WRITE_JOB, LEDGER_READ_JOB, ...Object.values(D2_JOBS)])
// `skill-grants` is sanctioned for the same reason as `skill-regen`: the write-back qualification reads every grantee of a
// skill and the tenants an agent serves, and answers one boolean (`agentQualifies` in src/skill-sync.ts).

/** Counts an escalation when the running context is a tenant or an agent one; every other outer context (none, system, admin, viewer, public) is not one. */
function noteEscalation(kind: 'system' | 'admin', name: string): void {
  if (kind === 'system' && SANCTIONED_ESCALATIONS.has(name)) return
  const outer = store.getStore()?.role
  if (outer === 'tenant' || outer === 'agent') escalations += 1
}

function requireId(kind: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`runAs.${kind}: a non-empty id is required`)
  return value
}

/** Internal option of a `runAs`. The default is to inherit; only the background-job openers (db/background-jobs.ts) turn it off. */
export interface RunAsOptions {
  /**
   * false: the context carries NO trace, whatever context it is opened in. For a job, which by definition is not part of
   * the request that happens to have created its timer.
   */
  inheritTrace?: boolean
}

/**
 * The context a `runAs` opens: the NEW identity, plus the trace of the context it is opened in (if there is one). A nested
 * `runAs` inside a request is still that request, so the identity is replaced and the trace is kept: dropping it
 * silently is exactly the gap the trace in the context closes. A `runAs` opened outside any context (a timer, a close
 * handler) has no trace to keep. `inheritTrace: false` opens a context with no trace at all (a background job).
 */
function withInheritedTrace(ctx: DbContext, opts?: RunAsOptions): DbContext {
  if (opts?.inheritTrace === false) return ctx
  const outer = store.getStore()
  return outer?.traceId && outer.spanId ? { ...ctx, traceId: outer.traceId, spanId: outer.spanId } : ctx
}

export const runAs = {
  system<T>(name: string, fn: () => T, opts?: RunAsOptions): T {
    const ctx = withInheritedTrace({ role: 'system', name: requireId('system', name) }, opts)
    noteEscalation('system', name)
    return store.run(ctx, fn)
  },
  admin<T>(name: string, fn: () => T, opts?: RunAsOptions): T {
    const ctx = withInheritedTrace({ role: 'admin', name: requireId('admin', name) }, opts)
    noteEscalation('admin', name)
    return store.run(ctx, fn)
  },
  viewer<T>(name: string, fn: () => T, opts?: RunAsOptions): T {
    return store.run(withInheritedTrace({ role: 'viewer', name: requireId('viewer', name) }, opts), fn)
  },
  public<T>(name: string, fn: () => T, opts?: RunAsOptions): T {
    return store.run(withInheritedTrace({ role: 'public', name: requireId('public', name) }, opts), fn)
  },
  tenant<T>(tenantId: string, fn: () => T, opts?: RunAsOptions): T {
    return store.run(withInheritedTrace({ role: 'tenant', tenantId: requireId('tenant', tenantId) }, opts), fn)
  },
  agent<T>(agentId: string, tenantId: string, fn: () => T, opts?: RunAsOptions): T {
    return store.run(withInheritedTrace({ role: 'agent', agentId: requireId('agent', agentId), tenantId: requireId('agent', tenantId) }, opts), fn)
  },
}

/**
 * Runs `fn` in a context taken earlier with `currentDbContext()`, or in none. For an event callback (a request 'end', a
 * response 'close') that was registered inside a `runAs` and must act in it: the callback itself does not carry the context.
 */
export function withDbContext<T>(ctx: DbContext | undefined, fn: () => T): T {
  return ctx === undefined ? fn() : store.run(ctx, fn)
}

/**
 * Runs `fn` in the running context plus a trace, so a writer deep in the call (the audit log, a log record) can say which
 * request or message it belongs to without a parameter. Without a running context there is nothing to attach the trace
 * to: `fn` runs as it is (a trace alone would make a call look scoped when it is not).
 *
 * A nested `runAs` replaces the identity but keeps this trace (see `withInheritedTrace`); a callback created before the run does not get it.
 */
export function withTrace<T>(trace: DbTrace, fn: () => T): T {
  const traceId = requireId('trace', trace.traceId)
  const spanId = requireId('trace', trace.spanId)
  const current = store.getStore()
  return current === undefined ? fn() : store.run({ ...current, traceId, spanId }, fn)
}

/**
 * Runs `fn` in the running context plus the id of the session user (`app.user_id`). Called by `runAsRequest` right after it
 * opens the context of a session-authenticated request; a nested `runAs` replaces the identity and does NOT carry the user
 * along (it is another identity). Without a running context there is nothing to attach it to: `fn` runs as it is.
 */
export function withUserId<T>(userId: string, fn: () => T): T {
  const id = requireId('userId', userId)
  const current = store.getStore()
  return current === undefined ? fn() : store.run({ ...current, userId: id }, fn)
}

/** The trace of the running call, or undefined when it carries none (no context, or a context without a trace). */
export function currentTrace(): DbTrace | undefined {
  const ctx = store.getStore()
  return ctx?.traceId && ctx.spanId ? { traceId: ctx.traceId, spanId: ctx.spanId } : undefined
}

/**
 * The `[trace_id, span_id]` an audit writer stores for the running call: the trace of the context, or `[null, null]`
 * (no context, or a context without a trace). The columns are nullable, and rows written before they existed stay NULL.
 * A `w3c-` value in the column is ALWAYS the server's own: it comes from here, never from a request body. The one other
 * source is a hook script naming its raw session id (insertHookAuditLog, through callerTraceId), which can be neither
 * a `w3c-` value nor the shape of a server-made id.
 */
export function currentTraceColumns(): [string | null, string | null] {
  const t = currentTrace()
  return t ? [t.traceId, t.spanId] : [null, null]
}

/** The longest trace id a caller-supplied value may have: a session id or a UUID is 36 characters, a hex id 32. */
const MAX_CALLER_TRACE_ID_LENGTH = 128
/** The characters of a session id, a UUID or a hex id. Anything else (a space, a quote, a control character) is not an id. */
const CALLER_TRACE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/
/** The shape of an id the server makes for a request (32 hex characters). */
const SERVER_TRACE_ID_SHAPE = /^[0-9a-f]{32}$/i

/**
 * A trace id that came from OUTSIDE the server (a request body, a hook script) in the form an audit row may store, or
 * null when it must not be stored as given.
 *
 * The rule (D2 of the audit/OTel plan): a `w3c-` value in an audit column means "the trace of a traceparent that came
 * with credentials", and only the server's own context (currentTraceColumns) may say that. A caller that writes
 * `w3c-<hex>` itself would place its row into a trace it has no claim to, so the value is dropped, never hashed or
 * rewritten; the writer then falls back to the server's own trace. A non-string, an empty or oversized string and
 * anything outside the id alphabet are dropped the same way. The match on the prefix is case-insensitive.
 *
 * The same goes for 32 hex characters (any case): that is the shape of a server-made request trace id, and the span
 * export maps a stored id by hashing it, so a caller that wrote such a string would land its row in that request's
 * trace. A session id is a UUID, so nothing legitimate is lost. Open limit: a UUID is not checked against the sessions
 * of the acting agent, so an agent can still name another agent's session id.
 */
export function callerTraceId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > MAX_CALLER_TRACE_ID_LENGTH) return null
  if (!CALLER_TRACE_ID_PATTERN.test(value)) return null
  if (value.slice(0, 4).toLowerCase() === 'w3c-') return null
  if (SERVER_TRACE_ID_SHAPE.test(value)) return null
  return value
}

/** The context of the running call, or undefined when none was set. */
export function currentDbContext(): DbContext | undefined {
  return store.getStore()
}

// ---- Counting calls without a context ---------------------------------------------------------------------

const WARN_INTERVAL_MS = 60_000
/** Distinct call sites and job names kept; one more is folded into "(other)" so the maps cannot grow without bound. */
const MAX_SITES = 100
const MAX_JOBS = 200
/** Every call without a context is sampled for its call site until this many were seen, then one in SAMPLE_EVERY. */
const SAMPLE_ALL_UNTIL = 256
const SAMPLE_EVERY = 16
const OTHER = '(other)'
/** The job name the request path uses for a caller without a credential (db/background-jobs.ts). */
const ANONYMOUS_JOB = 'http-public'

// The boot phase: module-load reads (config values, migrations) run before any `runAs` can exist. They are counted
// apart (`duringBoot`) and are not "unexpected". The dashboard ends the phase once it listens; a test starts in the
// running phase (the reset hooks below), so a test never inherits the boot allowance.
let booting = true
const startedAt = Date.now()
let bootEndedAt: number | null = null

let total = 0
let withoutContext = 0
let duringBoot = 0
let lastCallSite: string | null = null
let lastWarnAt = 0
let sampledSeen = 0
let anonymousCalls = 0
let tenantMismatches = 0
const callSites = new Map<string, { count: number; boot: boolean }>()
const jobCalls = new Map<string, number>()
const tenantUnresolvedByJob = new Map<string, number>()
const rlsRefusalsByRoute = new Map<string, number>()
const roleCalls: Record<DbRole, number> = { system: 0, tenant: 0, agent: 0, admin: 0, viewer: 0, public: 0 }

export interface DbContextSite {
  /** The first stack frame outside src/db. */
  site: string
  /** Sampled count: a lower bound once the sampling has started. */
  count: number
  /** Seen before the boot phase ended. */
  boot: boolean
}

export interface DbContextStats {
  /** Every facade call since start. */
  total: number
  /** Calls that carried no context, boot phase included. */
  withoutContext: number
  /** Of those, the ones made before the boot phase ended: module-load reads and the boot sequence itself. */
  duringBoot: number
  /** `withoutContext - duringBoot`: the number the Phase 1 measurement window must hold at 0. */
  unexpected: number
  /** Calls of a route served without a credential (`http-public`): they carry a context but no principal, and are no measure of anything. */
  anonymous: number
  /** A route resolved a tenant other than the one its request context carries (see `noteTenantResolved`). */
  tenantMismatches: number
  /** Agent job ticks skipped because the tenant of the agent could not be resolved (fail closed), by job name. */
  tenantUnresolved: Record<string, number>
  /**
   * Requests the database refused with SQLSTATE 42501 (a row-level policy or a missing privilege) that no route handled and
   * the request handler answered as 403 instead of 500, by route (`METHOD /api/<area>/<sub>`). A refusal that is answered
   * is still a defect somewhere (a caller in a context too narrow for its write): this keeps it countable, not hidden.
   */
  rlsRefusals: Record<string, number>
  /**
   * `runAs.system|admin` opened while the running context was a `tenant` or an `agent` one (a tenant block that climbs to a
   * wider role). Counted, never refused: enforcement is the policies' job. A job that follows the per-item rule keeps it at 0.
   */
  escalations: number
  /** When the process started and when the boot phase ended (ms since the epoch): a measurement window is the difference of two snapshots. */
  startedAt: number
  bootEndedAt: number | null
  /** Calls with a context, by role. */
  byRole: Record<DbRole, number>
  /** Calls of `runAs.system|admin|viewer|public(name)`, by name: shows which classified jobs actually touch the db. */
  byJob: Record<string, number>
  /** Where calls without a context came from, most frequent first. Sampled (see SAMPLE_*), so the counts are lower bounds. */
  sites: DbContextSite[]
  /** Where a call without a context came from. Sampled: updated when the warning is logged (at most once per minute), not on every call. */
  lastCallSite: string | null
  /** True until `endDbBootPhase()` ran. */
  booting: boolean
}

/** The first stack line outside src/db and node internals: the module that called the db function, not the db function itself. */
function callerSite(): string {
  const lines = (new Error().stack ?? '').split('\n').slice(1)
  const outside = lines.find((l) => !/[\\/]src[\\/]db[\\/]|[\\/]src[\\/]db\.[jt]s|node:internal/.test(l))
  return (outside ?? lines[0] ?? 'unknown').trim()
}

function bump(map: Map<string, number>, key: string, cap: number): void {
  const k = map.has(key) || map.size < cap ? key : OTHER
  map.set(k, (map.get(k) ?? 0) + 1)
}

/** Called by the facade on every call (statement or transaction). Cheap on the hot path: a stack is captured only for a sampled call without a context. */
export function noteDbCall(): void {
  total += 1
  const ctx = store.getStore()
  if (ctx !== undefined) {
    roleCalls[ctx.role] += 1
    if (ctx.name) {
      bump(jobCalls, ctx.name, MAX_JOBS)
      if (ctx.name === ANONYMOUS_JOB) anonymousCalls += 1
    }
    return
  }
  withoutContext += 1
  if (booting) duringBoot += 1
  if (sampledSeen < SAMPLE_ALL_UNTIL || withoutContext % SAMPLE_EVERY === 0) {
    sampledSeen += 1
    const site = callerSite()
    const key = booting ? `boot|${site}` : site
    const known = callSites.get(key)
    if (known) known.count += 1
    else if (callSites.size < MAX_SITES) callSites.set(key, { count: 1, boot: booting })
    else {
      const other = callSites.get(OTHER)
      if (other) other.count += 1
      else callSites.set(OTHER, { count: 1, boot: false })
    }
  }
  if (booting) return
  const now = Date.now()
  if (now - lastWarnAt < WARN_INTERVAL_MS && lastWarnAt !== 0) return
  lastWarnAt = now
  lastCallSite = captureOrigin()
  logger.warn({ callSite: lastCallSite, withoutContext, unexpected: withoutContext - duringBoot, total }, 'db: call without a db context (runAs.system / tenant / agent); not enforced yet')
}

/** The dashboard is up: from here a call without a context is unexpected. */
export function endDbBootPhase(): void {
  if (booting) bootEndedAt = Date.now()
  booting = false
}

/**
 * A route says which tenant it is about to work in. When the request context carries another tenant, that is counted: the
 * ambient tenant and the one the route resolves for itself must agree for a caller that belongs to a tenant. Returns its
 * argument, so a resolver can `return noteTenantResolved(...)`. A global admin or a system job has no ambient tenant and is skipped.
 */
export function noteTenantResolved(tenantId: string | null): string | null {
  const ambient = store.getStore()?.tenantId
  if (ambient !== undefined && tenantId !== null && ambient !== tenantId) tenantMismatches += 1
  return tenantId
}

/**
 * An agent job could not resolve the tenant of its agent and was skipped (fail closed: it does not run as `default`).
 * Counted by job name, so a resolver that keeps failing shows up in the measurement view instead of only in the log.
 */
export function noteTenantUnresolved(job: string): void {
  bump(tenantUnresolvedByJob, job, MAX_JOBS)
}

/** A request the database refused with 42501 was answered as 403 (see `DbContextStats.rlsRefusals`). `route` is already coarse, never an id. */
export function noteRlsRefusal(route: string): void {
  bump(rlsRefusalsByRoute, route, MAX_JOBS)
}

export function getDbContextStats(): DbContextStats {
  const sites = [...callSites.entries()]
    .map(([key, v]) => ({ site: v.boot ? key.slice('boot|'.length) : key, count: v.count, boot: v.boot }))
    .sort((a, b) => b.count - a.count)
  return {
    total,
    withoutContext,
    duringBoot,
    unexpected: withoutContext - duringBoot,
    anonymous: anonymousCalls,
    tenantMismatches,
    tenantUnresolved: Object.fromEntries(tenantUnresolvedByJob),
    rlsRefusals: Object.fromEntries(rlsRefusalsByRoute),
    escalations,
    startedAt,
    bootEndedAt,
    byRole: { ...roleCalls },
    byJob: Object.fromEntries(jobCalls),
    sites,
    lastCallSite,
    booting,
  }
}

/** Test hook: zero the counters and the warning timer, and leave the boot phase (a test counts as running). */
export function resetDbContextStats(): void {
  total = 0
  withoutContext = 0
  duringBoot = 0
  lastCallSite = null
  lastWarnAt = 0
  sampledSeen = 0
  anonymousCalls = 0
  tenantMismatches = 0
  escalations = 0
  callSites.clear()
  jobCalls.clear()
  tenantUnresolvedByJob.clear()
  rlsRefusalsByRoute.clear()
  for (const role of DB_ROLES) roleCalls[role] = 0
  booting = false
}

/** Test hook: the counters AND the carrier itself (a leaked `runAs` from a previous test must not reach the next one). */
export function resetDbContextForTest(): void {
  resetDbContextStats()
  store.disable()
}
