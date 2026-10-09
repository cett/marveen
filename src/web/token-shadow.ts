// Phase T2 shadow counter: measures how the shared dashboard token and the per-agent tokens are
// used, BEFORE any rule is enforced on them. It only counts. Nothing here allows, refuses, delays or
// changes a request: every entry point swallows its own errors (a counter fault must never become an
// outage), and the numbers live in the aggregate table token_usage_shadow (migration 0079).
//
// What is counted (category -> meaning):
//   shared_token_use                 a request authenticated with the shared dashboard token (the
//                                    file token, enrolled in api_tokens as 'dashboard'; no agent). Who it was is the
//                                    X-Agent-Id header: a SELF-DECLARATION (caller_source
//                                    'self_declared'), or nobody ('none').
//   agent_id_mismatch                a non-main-agent caller names ANOTHER agent on an endpoint that
//                                    takes an agent id and trusts the caller's word (the ledger,
//                                    agent state, daily log, telemetry, artifacts, messages.from,
//                                    approvals). target = the agent it named.
//   foreign_row_access               the same for the endpoints a fleet_agent token reaches by
//                                    permission only (memories, workspace, kanban, blackboard,
//                                    schedules): the agent id the request names, or the owner of the
//                                    row it addresses, is not the caller. target = that agent.
//   unscoped_read                    a memories / workspace listing with no agent filter: it reads
//                                    across agents (target '*').
//   missing_tenant_context           a shared agent (one that serves several tenants) acts with no
//                                    fresh tenant context: a fleet-agent token refused 403 for it
//                                    (caller_source 'token'), or a shared-token request that
//                                    declares such an agent and names no ?tenant= (self_declared).
//   shared_agent_memories_no_tenant  GET /api/memories?agent=<shared agent> with no ?tenant= and no
//                                    tenant context for that agent (the memory read of a shared
//                                    agent the tenant-less shared token makes). target = the agent.
//   fleet_skill_write_denied         a fleet_agent token tried to write a skill it may not (T1's
//                                    deliberate narrowing). target = the skill's owner.
//
// The caller of an identity category is the token's agent (caller_source 'token') or the X-Agent-Id
// of a shared-token request (self_declared). The main agent is the coordinator and legitimately
// acts across agents, so it is never the caller of agent_id_mismatch / foreign_row_access.
//
// The server cannot see the calling PROCESS (a loopback socket gives a port, not a pid, and mapping
// it would cost a subprocess per request), so the row carries a coarse User-Agent bucket instead.
//
// Cardinality is bounded: routes are templates, caller / target are charset-checked, and the writer
// folds shapes beyond MAX_ROWS_PER_DAY into one overflow row, because the header is attacker-chosen.

import type http from 'node:http'
import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import {
  bumpTokenShadow,
  countTokenShadowRowsForDay,
  deleteTokenShadowRowsBefore,
  getBlackboardRowById,
  getKanbanCard,
  getMemoryOwnerRow,
  getScheduleFromDb,
  peekWorkspaceDoc,
  tokenShadowKeyExists,
  type TokenShadowCallerSource,
  type TokenShadowKey,
} from '../db.js'
import { resolveWriteTenant } from '../db/write-tenant.js'
import { resolveAgentIdHeader, type AuthResult } from './auth-gate.js'
import { setRequestBodyObserver } from './http-helpers.js'

export const TOKEN_SHADOW_CATEGORIES = [
  'shared_token_use',
  'agent_id_mismatch',
  'foreign_row_access',
  'unscoped_read',
  'missing_tenant_context',
  'shared_agent_memories_no_tenant',
  'fleet_skill_write_denied',
] as const
export type TokenShadowCategory = (typeof TOKEN_SHADOW_CATEGORIES)[number]

/**
 * The name the shared dashboard token is enrolled under in api_tokens (db/api-tokens.ts). Once
 * enrolled it resolves as a NAMED admin token with no agent, so the shared token is either the
 * file token with no name (before enrollment) or the token carrying this name.
 */
export const DASHBOARD_TOKEN_NAME = 'dashboard'

/** The admin read endpoint; never counted itself (reading the counter must not move it). */
export const TOKEN_SHADOW_ROUTE = '/api/token-shadow'

/** Distinct (shape) rows per UTC day; beyond it new shapes fold into one overflow row. */
export const MAX_ROWS_PER_DAY = 4000
/** Rows of days older than this are pruned (opportunistically, by the writer). */
export const RETENTION_DAYS = 90
export const PRUNE_INTERVAL_SEC = 3600
/** A request body larger than this is not parsed for agent ids (the counter stays cheap). */
export const BODY_PEEK_MAX_BYTES = 256 * 1024
const BODY_ARRAY_PEEK_MAX = 200
const TENANTLESS_TTL_MS = 5000
const WARN_INTERVAL_MS = 60_000
const OVERFLOW = '_overflow'
const INVALID = '_invalid'
const SECONDS_PER_DAY = 86_400

// ── pure helpers ────────────────────────────────────────────────────────────

/** /api/v1/x -> /api/x (the canonical and legacy spellings are one route). */
export function stripApiVersion(path: string): string {
  return path.replace(/^\/api\/v1(?=\/|$)/, '/api')
}

const AGENT_CHARSET = /^[a-z0-9][a-z0-9_-]{0,47}$/

/** An agent id fit to be a counter key: lower-case, charset-checked; anything else is '_invalid'. */
export function cleanAgentId(raw: string | undefined | null): string {
  const v = (raw ?? '').trim().toLowerCase()
  if (!v) return ''
  return AGENT_CHARSET.test(v) ? v : INVALID
}

/** Coarse bucket of a User-Agent: the stand-in for the calling process the server cannot see. */
export function classifyClient(userAgent: string | string[] | undefined): string {
  const ua = (Array.isArray(userAgent) ? userAgent[0] : userAgent)?.trim()
  if (!ua) return 'none'
  if (/^curl\b/i.test(ua)) return 'curl'
  if (/python|urllib|requests|httpx|aiohttp/i.test(ua)) return 'python'
  if (/node|undici/i.test(ua)) return 'node'
  if (/mozilla|chrome|safari|firefox/i.test(ua)) return 'browser'
  return 'other'
}

export interface ShadowCaller {
  caller: string
  source: TokenShadowCallerSource
  /** True for the shared file-based dashboard token. */
  shared: boolean
  /** True for a fleet_agent token. */
  fleetAgent: boolean
}

/**
 * Who a token request acts as. null when the credential is not one the counter watches (a session,
 * a device, a federation peer, a named token that names no agent such as the operator's).
 */
export function resolveShadowCaller(auth: AuthResult, headerAgentId: string | undefined): ShadowCaller | null {
  if (auth.kind !== 'token') return null
  if (auth.agentId) {
    return { caller: cleanAgentId(auth.agentId), source: 'token', shared: false, fleetAgent: auth.role === 'fleet_agent' }
  }
  if (auth.tokenName && auth.tokenName !== DASHBOARD_TOKEN_NAME) return null // a registered token that names no agent (the operator's): not the shared token
  const declared = cleanAgentId(headerAgentId)
  return { caller: declared, source: declared ? 'self_declared' : 'none', shared: true, fleetAgent: false }
}

export interface ShadowHit {
  category: TokenShadowCategory
  target: string
}

/**
 * Identity categories for a request: every distinct agent the request names (or whose row it
 * addresses) that is not the caller. Pure. A caller that is empty or the main agent is never a hit.
 */
export function identityHits(input: {
  kind: 'own' | 'unscoped'
  caller: string
  mainAgentId: string
  targets: Iterable<string>
}): ShadowHit[] {
  const { kind, caller, mainAgentId } = input
  if (!caller || caller === mainAgentId.trim().toLowerCase()) return []
  const category: TokenShadowCategory = kind === 'own' ? 'agent_id_mismatch' : 'foreign_row_access'
  const seen = new Set<string>()
  const hits: ShadowHit[] = []
  for (const raw of input.targets) {
    const target = cleanAgentId(raw)
    if (!target || target === caller || seen.has(target)) continue
    seen.add(target)
    hits.push({ category, target })
  }
  return hits
}

/** Agent ids a JSON body names under `keys`: top level, and the objects of top-level arrays (batches). */
export function collectBodyAgents(data: unknown, keys: readonly string[]): string[] {
  const out = new Set<string>()
  const take = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k]
      if (typeof v === 'string' && v.trim()) out.add(v)
    }
  }
  take(data)
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const v of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(v)) v.slice(0, BODY_ARRAY_PEEK_MAX).forEach(take)
    }
  } else if (Array.isArray(data)) {
    data.slice(0, BODY_ARRAY_PEEK_MAX).forEach(take)
  }
  return [...out]
}

// ── watched endpoints ───────────────────────────────────────────────────────

interface WatchSpec {
  /** Path prefix at a segment boundary. */
  prefix: string
  /** own: endpoints a fleet_agent is already held to its own agent on. unscoped: reachable by permission only. */
  kind: 'own' | 'unscoped'
  /** 0-based index of the path parameter after the prefix, and what it is called in the route template. */
  paramSeg?: number
  paramName?: ':agent' | ':id' | ':name'
  /** Path segments at paramSeg that are literal sub-routes, not the parameter. */
  paramLiterals?: ReadonlySet<string>
  /** The path parameter IS an agent id (otherwise it addresses a row, see `owner`). */
  paramIsAgent?: boolean
  /** Owner agent of the row the path parameter addresses. */
  owner?: (param: string) => string | null | undefined
  queryKeys: readonly string[]
  bodyKeys: readonly string[]
  /** A GET with none of queryKeys lists across agents. */
  listsAcrossAgents?: boolean
}

const AGENT_QUERY = ['agent', 'agent_id'] as const
const AGENT_BODY = ['agent_id', 'agent'] as const
const NONE: ReadonlySet<string> = new Set()

const WATCHED: readonly WatchSpec[] = [
  { prefix: '/api/conversation-ledger', kind: 'own', paramSeg: 0, paramName: ':agent', paramIsAgent: true, queryKeys: AGENT_QUERY, bodyKeys: AGENT_BODY },
  { prefix: '/api/agent-state', kind: 'own', paramSeg: 0, paramName: ':agent', paramIsAgent: true, queryKeys: AGENT_QUERY, bodyKeys: AGENT_BODY },
  { prefix: '/api/agent-taskstate', kind: 'own', paramSeg: 0, paramName: ':agent', paramIsAgent: true, queryKeys: AGENT_QUERY, bodyKeys: AGENT_BODY },
  { prefix: '/api/daily-log', kind: 'own', queryKeys: AGENT_QUERY, bodyKeys: AGENT_BODY },
  { prefix: '/api/spans', kind: 'own', queryKeys: AGENT_QUERY, bodyKeys: AGENT_BODY },
  { prefix: '/api/hook-audit', kind: 'own', queryKeys: AGENT_QUERY, bodyKeys: AGENT_BODY },
  { prefix: '/api/tool-log', kind: 'own', queryKeys: AGENT_QUERY, bodyKeys: AGENT_BODY },
  { prefix: '/api/skill-usage', kind: 'own', queryKeys: AGENT_QUERY, bodyKeys: AGENT_BODY },
  { prefix: '/api/artifacts', kind: 'own', queryKeys: AGENT_QUERY, bodyKeys: AGENT_BODY },
  { prefix: '/api/approvals', kind: 'own', queryKeys: AGENT_QUERY, bodyKeys: AGENT_BODY },
  { prefix: '/api/messages', kind: 'own', queryKeys: [], bodyKeys: ['from'] },
  {
    prefix: '/api/memories', kind: 'unscoped', paramSeg: 0, paramName: ':id',
    owner: (p) => (/^\d+$/.test(p) ? getMemoryOwnerRow(Number(p))?.agent_id : undefined),
    queryKeys: AGENT_QUERY, bodyKeys: AGENT_BODY, listsAcrossAgents: true,
  },
  {
    prefix: '/api/workspace', kind: 'unscoped', paramSeg: 0, paramName: ':id',
    owner: (p) => peekWorkspaceDoc(p)?.agent_id,
    queryKeys: AGENT_QUERY, bodyKeys: AGENT_BODY, listsAcrossAgents: true,
  },
  {
    prefix: '/api/kanban', kind: 'unscoped', paramSeg: 0, paramName: ':id',
    paramLiterals: new Set(['labels', 'heartbeat-summary', 'assignees', 'archived', 'search']),
    owner: (p) => getKanbanCard(p)?.assignee,
    queryKeys: ['assignee'], bodyKeys: ['assignee'],
  },
  {
    prefix: '/api/blackboard', kind: 'unscoped', paramSeg: 0, paramName: ':id',
    paramLiterals: new Set(['history']),
    owner: (p) => getBlackboardRowById(p)?.agent_id,
    queryKeys: ['agent_id'], bodyKeys: ['agent_id'],
  },
  {
    prefix: '/api/schedules', kind: 'unscoped', paramSeg: 0, paramName: ':name',
    paramLiterals: new Set(['tick-status', 'agents', 'expand-questions', 'expand-prompt', 'pending']),
    owner: (p) => getScheduleFromDb(p)?.agent,
    queryKeys: AGENT_QUERY, bodyKeys: ['agent'],
  },
]

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function watchSpecFor(path: string): WatchSpec | undefined {
  return WATCHED.find((s) => matchesPrefix(path, s.prefix))
}

const ID_LIKE = /^(?:\d+|[0-9a-f]{8,}(?:-[0-9a-f]+)*)$/i
const SEGMENT_SAFE = /^[A-Za-z0-9._-]{1,40}$/
const MAX_ROUTE_SEGMENTS = 6

/**
 * A route template: ids, agent ids and schedule names replaced by :id / :agent / :name, so the
 * number of distinct routes does not grow with the data. An unknown shape keeps its literal
 * segments (capped in length and depth) and replaces anything id-like or odd by :id.
 */
export function normalizeRoute(rawPath: string): string {
  const path = stripApiVersion(rawPath.split('?')[0] ?? '')
  const segs = path.split('/').filter(Boolean)
  const spec = watchSpecFor(path)
  const base = spec ? spec.prefix.split('/').filter(Boolean).length : -1
  const out = segs.slice(0, MAX_ROUTE_SEGMENTS).map((seg, i) => {
    if (spec && spec.paramSeg !== undefined && i === base + spec.paramSeg && !(spec.paramLiterals ?? NONE).has(seg)) {
      return spec.paramName ?? ':id'
    }
    if (ID_LIKE.test(seg) || !SEGMENT_SAFE.test(seg)) return ':id'
    return seg
  })
  const route = `/${out.join('/')}`
  return route.length > 120 ? route.slice(0, 120) : route
}

function paramOf(spec: WatchSpec, path: string): string | undefined {
  if (spec.paramSeg === undefined) return undefined
  const base = spec.prefix.split('/').filter(Boolean).length
  const raw = path.split('/').filter(Boolean)[base + spec.paramSeg]
  if (raw === undefined || (spec.paramLiterals ?? NONE).has(raw)) return undefined
  try { return decodeURIComponent(raw) } catch { return raw }
}

// ── recording ───────────────────────────────────────────────────────────────

interface DayState { day: string; known: Set<string>; rows: number }
let dayState: DayState = { day: '', known: new Set(), rows: 0 }
let lastPruneAt = 0
let lastWarnAt = 0

/** Test hook: forget every in-memory throttle / cache. */
export function resetTokenShadowForTests(): void {
  dayState = { day: '', known: new Set(), rows: 0 }
  lastPruneAt = 0
  lastWarnAt = 0
  tenantless.clear()
}

function utcDay(nowSec: number): string {
  return new Date(nowSec * 1000).toISOString().slice(0, 10)
}

/** The UTC day `days - 1` days before `nowSec` (days=1 is today only). */
export function windowStartDay(nowSec: number, days: number): string {
  return utcDay(nowSec - (days - 1) * SECONDS_PER_DAY)
}

function keyString(k: TokenShadowKey): string {
  return [k.day, k.category, k.method, k.route, k.caller, k.callerSource, k.client, k.target].join('\u0000')
}

function warnThrottled(err: unknown, msg: string): void {
  const now = Date.now()
  if (now - lastWarnAt < WARN_INTERVAL_MS) return
  lastWarnAt = now
  logger.warn({ err }, msg)
}

interface Base { method: string; route: string; client: string; caller: string; callerSource: TokenShadowCallerSource }

/** Adds one to the counter of this shape. Never throws. `nowSec` is injectable for tests. */
export function recordTokenShadow(base: Base, hit: ShadowHit, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  try {
    const day = utcDay(nowSec)
    if (dayState.day !== day) dayState = { day, known: new Set(), rows: countTokenShadowRowsForDay(day) }
    let key: TokenShadowKey = {
      day, category: hit.category, method: base.method, route: base.route,
      caller: base.caller, callerSource: base.callerSource, client: base.client, target: hit.target,
    }
    let ks = keyString(key)
    if (!dayState.known.has(ks)) {
      if (tokenShadowKeyExists(key)) {
        dayState.known.add(ks)
      } else if (dayState.rows >= MAX_ROWS_PER_DAY) {
        // Over the cap: fold into one overflow row per (day, category, method) instead of growing.
        key = { day, category: hit.category, method: base.method, route: OVERFLOW, caller: OVERFLOW, callerSource: 'none', client: 'other', target: '' }
        ks = keyString(key)
        if (!dayState.known.has(ks)) {
          if (!tokenShadowKeyExists(key)) dayState.rows += 1
          dayState.known.add(ks)
        }
      } else {
        dayState.rows += 1
        dayState.known.add(ks)
      }
    }
    bumpTokenShadow(key, nowSec)
    pruneThrottled(nowSec)
    return true
  } catch (err) {
    warnThrottled(err, 'token-shadow: counter write failed')
    return false
  }
}

function pruneThrottled(nowSec: number): void {
  if (nowSec - lastPruneAt < PRUNE_INTERVAL_SEC) return
  lastPruneAt = nowSec
  try {
    deleteTokenShadowRowsBefore(utcDay(nowSec - RETENTION_DAYS * SECONDS_PER_DAY))
  } catch (err) {
    warnThrottled(err, 'token-shadow: prune failed')
  }
}

// ── tenant context ──────────────────────────────────────────────────────────

const tenantless = new Map<string, { v: boolean; at: number }>()

/** True when `agentId` has no tenant to act in right now (a shared agent with no fresh context). Cached 5 s. */
function agentHasNoTenant(agentId: string): boolean {
  const now = Date.now()
  const hit = tenantless.get(agentId)
  if (hit && now - hit.at < TENANTLESS_TTL_MS) return hit.v
  const v = resolveWriteTenant(agentId) === null
  if (tenantless.size > 200) tenantless.clear()
  tenantless.set(agentId, { v, at: now })
  return v
}

// ── request entry points ────────────────────────────────────────────────────

interface Pending { base: Base; spec: WatchSpec; recorded: Set<string> }
const pendingBodies = new WeakMap<http.IncomingMessage, Pending>()

/**
 * Observe one authenticated request, after the auth and RBAC gates and before dispatch. Synchronous
 * and bounded: a few string operations, at most one row-owner lookup and one counter upsert per hit.
 * Never throws and never touches the request or the response (the body is not consumed here).
 */
export function observeTokenUsage(
  req: http.IncomingMessage,
  auth: AuthResult,
  method: string,
  rawPath: string,
  url: URL,
  mainAgentId: string = MAIN_AGENT_ID,
): void {
  try {
    const path = stripApiVersion(rawPath)
    if (path === TOKEN_SHADOW_ROUTE) return
    const who = resolveShadowCaller(auth, resolveAgentIdHeader(req))
    if (!who) return

    const base: Base = {
      method, route: normalizeRoute(path), client: classifyClient(req.headers['user-agent']),
      caller: who.caller, callerSource: who.source,
    }
    if (who.shared) recordTokenShadow(base, { category: 'shared_token_use', target: '' })

    const spec = watchSpecFor(path)
    const hasTenantParam = !!url.searchParams.get('tenant')

    // (4) tenant context. A shared-token request that declares a shared agent and names no tenant.
    if (who.shared && who.source === 'self_declared' && !hasTenantParam && agentHasNoTenant(who.caller)) {
      recordTokenShadow(base, { category: 'missing_tenant_context', target: '' })
    }
    // The memory read of a shared agent from a caller that has no tenant of its own to scope it by.
    if (spec?.prefix === '/api/memories' && method === 'GET' && !hasTenantParam && (who.shared || who.fleetAgent)) {
      const named = cleanAgentId(url.searchParams.get('agent') ?? url.searchParams.get('agent_id'))
      if (named && named !== INVALID && agentHasNoTenant(named)) {
        recordTokenShadow(base, { category: 'shared_agent_memories_no_tenant', target: named })
      }
    }

    // (2) / (3) identity: only for a caller that is an agent and not the coordinator.
    if (!spec || !who.caller || who.caller === mainAgentId.trim().toLowerCase()) return

    const targets = new Set<string>()
    const param = paramOf(spec, path)
    if (param !== undefined) {
      if (spec.paramIsAgent) targets.add(param)
      else if (spec.owner) {
        try {
          const owner = spec.owner(param)
          if (owner) targets.add(owner)
        } catch (err) {
          warnThrottled(err, 'token-shadow: row owner lookup failed')
        }
      }
    }
    let queryNamed = false
    for (const k of spec.queryKeys) {
      const v = url.searchParams.get(k)
      if (v && v.trim()) { targets.add(v); queryNamed = true }
    }

    const recorded = new Set<string>()
    for (const hit of identityHits({ kind: spec.kind, caller: who.caller, mainAgentId, targets })) {
      recordTokenShadow(base, hit)
      recorded.add(hit.target)
    }
    if (spec.listsAcrossAgents && method === 'GET' && param === undefined && !queryNamed) {
      recordTokenShadow(base, { category: 'unscoped_read', target: '*' })
    }

    if (spec.bodyKeys.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
      pendingBodies.set(req, { base, spec, recorded })
    }
  } catch (err) {
    warnThrottled(err, 'token-shadow: observe failed')
  }
}

/** Called by readBody once the body is complete; counts the agent ids a body names. Never throws. */
export function observeRequestBody(req: http.IncomingMessage, body: Buffer, mainAgentId: string = MAIN_AGENT_ID): void {
  const pending = pendingBodies.get(req)
  if (!pending) return
  pendingBodies.delete(req)
  try {
    if (body.length === 0 || body.length > BODY_PEEK_MAX_BYTES) return
    const data: unknown = JSON.parse(body.toString('utf8'))
    const named = collectBodyAgents(data, pending.spec.bodyKeys)
    for (const hit of identityHits({ kind: pending.spec.kind, caller: pending.base.caller, mainAgentId, targets: named })) {
      if (pending.recorded.has(hit.target)) continue
      pending.recorded.add(hit.target)
      recordTokenShadow(pending.base, hit)
    }
  } catch {
    // A body that is not JSON is the handler's 400 to give; the counter has nothing to count.
  }
}

setRequestBodyObserver((req, body) => observeRequestBody(req, body))

/** A fleet-agent token of a shared agent was refused 403 for lack of tenant context (web.ts). */
export function recordTenantContextRefusal(req: http.IncomingMessage, auth: AuthResult, method: string, rawPath: string): void {
  try {
    const who = resolveShadowCaller(auth, undefined)
    if (!who || who.source !== 'token') return
    recordTokenShadow(
      { method, route: normalizeRoute(rawPath), client: classifyClient(req.headers['user-agent']), caller: who.caller, callerSource: 'token' },
      { category: 'missing_tenant_context', target: '' },
    )
  } catch (err) {
    warnThrottled(err, 'token-shadow: refusal record failed')
  }
}

/** Owner label of a skill id for the counter: the agent in agent/<x>/..., 'global' for global/..., else ''. */
export function skillOwnerTarget(skillId: string): string {
  const m = /^agent\/([^/]+)\//.exec(skillId)
  if (m) return cleanAgentId(m[1])
  return skillId.startsWith('global/') ? 'global' : ''
}

/** A fleet_agent token tried a skill write T1 refuses (skills.ts, at the 403). */
export function recordFleetSkillWriteDenied(
  req: http.IncomingMessage,
  tokenAgentId: string | undefined,
  method: string,
  rawPath: string,
  skillId: string,
): void {
  try {
    const caller = cleanAgentId(tokenAgentId)
    if (!caller) return
    const owner = skillOwnerTarget(skillId)
    recordTokenShadow(
      { method, route: normalizeRoute(rawPath), client: classifyClient(req.headers['user-agent']), caller, callerSource: 'token' },
      { category: 'fleet_skill_write_denied', target: owner === caller ? '' : owner },
    )
  } catch (err) {
    warnThrottled(err, 'token-shadow: skill-denial record failed')
  }
}
