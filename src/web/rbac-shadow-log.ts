// Persistent RBAC decision log (table rbac_shadow_log, migration 0068).
//
// The RBAC gate in web.ts records one row per interesting decision in BOTH
// shadow and enforce mode, so the observation window before RBAC_MODE=enforce
// is measurable from the database instead of from a rotating log file.
//
// Design rules:
//   - Recording never throws into the request path: a failed insert is logged
//     at warn level and the request proceeds (a logging fault must not become
//     an outage, and in enforce mode it must not change the gate's decision).
//   - Retention is bounded by the writer: at most once per PRUNE_INTERVAL_SEC
//     it deletes rows older than RETENTION_DAYS, so no scheduled job is needed.
//   - Admin traffic is not recorded as 'permitted' (callers decide that; this
//     module records whatever it is told).

import type Database from 'better-sqlite3'
import { logger } from '../logger.js'
import type http from 'node:http'
import { applyRbacGate, resolveRole, resolveTenantId } from './authz.js'
import type { RbacMode } from './authz.js'
import { resolveRequiredPermission } from './rbac.js'
import type { AuthResult } from './auth-gate.js'

export type ShadowDecision = 'would-deny' | 'denied' | 'permitted'

export const SHADOW_DECISIONS: readonly ShadowDecision[] = ['would-deny', 'denied', 'permitted']

/** Rows older than this are pruned. */
export const RETENTION_DAYS = 30
/** Minimum gap between two opportunistic prune passes. */
export const PRUNE_INTERVAL_SEC = 3600

const SECONDS_PER_DAY = 86_400

let lastPruneAt = 0

/** Test hook: forget the prune throttle so a prune can run immediately. */
export function resetPruneThrottleForTests(): void {
  lastPruneAt = 0
}

export interface ShadowLogRow {
  id: number
  ts: number
  tenant_id: string | null
  principal_kind: string
  principal: string
  role: string
  method: string
  route: string
  permission: string
  decision: ShadowDecision
  reason: string
}

/** Human label of the caller; '' when the credential carries none. */
export function principalOf(auth: AuthResult): { kind: string; name: string } {
  switch (auth.kind) {
    case 'token':
      return { kind: 'token', name: auth.tokenName ?? '' }
    case 'session':
      return { kind: 'session', name: auth.user }
    case 'device':
      return { kind: 'device', name: auth.device }
    case 'federation':
      return { kind: 'federation', name: auth.peer }
    case 'none':
      return { kind: 'none', name: '' }
  }
}

/**
 * Insert one decision row. Returns true when a row was written. Never throws.
 * `nowSec` is injectable for tests.
 */
export function recordRbacDecision(
  db: Database.Database,
  auth: AuthResult,
  method: string,
  path: string,
  decision: ShadowDecision,
  reason = '',
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (auth.kind === 'none') return false // unauthenticated requests never reach the gate
  try {
    const { kind, name } = principalOf(auth)
    db.prepare(
      `INSERT INTO rbac_shadow_log
         (ts, tenant_id, principal_kind, principal, role, method, route, permission, decision, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nowSec,
      resolveTenantId(auth),
      kind,
      name,
      resolveRole(auth),
      method,
      path,
      resolveRequiredPermission(method, path) ?? 'admin:all',
      decision,
      reason,
    )
  } catch (err) {
    logger.warn({ err, path, method, decision }, 'rbac:shadow-log insert failed')
    return false
  }
  pruneShadowLogThrottled(db, nowSec)
  return true
}

/**
 * The request-path entry point: runs the RBAC gate and records its outcome.
 * Returns false when the request was refused (enforce mode; the response is
 * already written), true when it may proceed.
 *
 *   shadow  + would be refused  -> 'would-deny' row (request proceeds)
 *   enforce + refused           -> 'denied' row
 *   non-admin + passed          -> 'permitted' row (both modes)
 *   admin + passed              -> nothing: admin (bearer and legacy file token) is
 *                                  100% of the legacy traffic and carries no signal
 *
 * would-deny and permitted are mutually exclusive for one request.
 */
export function runRbacGate(
  db: Database.Database,
  auth: AuthResult,
  method: string,
  path: string,
  res: http.ServerResponse,
  mode: RbacMode,
): boolean {
  let wouldDeny = false
  const passed = applyRbacGate(
    auth, method, path, res, mode,
    (reason) => {
      wouldDeny = true
      logger.warn({ path, method, authKind: auth.kind, reason, outcome: 'would-deny' }, 'rbac:shadow')
      recordRbacDecision(db, auth, method, path, 'would-deny', reason)
    },
    (reason) => {
      logger.warn({ path, method, authKind: auth.kind, reason, outcome: 'denied' }, 'rbac:enforce')
      recordRbacDecision(db, auth, method, path, 'denied', reason)
    },
  )
  if (!passed) return false
  if (resolveRole(auth) !== 'admin' && !wouldDeny) {
    if (mode === 'shadow') {
      logger.info({ path, method, authKind: auth.kind, role: resolveRole(auth), outcome: 'permitted' }, 'rbac:shadow')
    }
    recordRbacDecision(db, auth, method, path, 'permitted')
  }
  return true
}

/** Delete rows older than RETENTION_DAYS. Returns the number removed. */
export function pruneShadowLog(db: Database.Database, nowSec: number = Math.floor(Date.now() / 1000)): number {
  const cutoff = nowSec - RETENTION_DAYS * SECONDS_PER_DAY
  return db.prepare('DELETE FROM rbac_shadow_log WHERE ts < ?').run(cutoff).changes
}

function pruneShadowLogThrottled(db: Database.Database, nowSec: number): void {
  if (nowSec - lastPruneAt < PRUNE_INTERVAL_SEC) return
  lastPruneAt = nowSec
  try {
    pruneShadowLog(db, nowSec)
  } catch (err) {
    logger.warn({ err }, 'rbac:shadow-log prune failed')
  }
}

export interface ShadowLogFilter {
  decision?: ShadowDecision
  tenantId?: string
  principal?: string
  role?: string
  permission?: string
  /** Substring match on the route. */
  route?: string
  /** unix seconds, inclusive */
  from?: number
  /** unix seconds, exclusive */
  to?: number
  limit?: number
  offset?: number
}

export const MAX_LIMIT = 500
export const DEFAULT_LIMIT = 100

function buildWhere(f: ShadowLogFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (f.decision) { clauses.push('decision = ?'); params.push(f.decision) }
  if (f.tenantId !== undefined) { clauses.push('tenant_id = ?'); params.push(f.tenantId) }
  if (f.principal) { clauses.push('principal = ?'); params.push(f.principal) }
  if (f.role) { clauses.push('role = ?'); params.push(f.role) }
  if (f.permission) { clauses.push('permission = ?'); params.push(f.permission) }
  if (f.route) {
    // instr() is a plain substring test: no LIKE wildcard in the input is special.
    clauses.push('instr(route, ?) > 0')
    params.push(f.route)
  }
  if (f.from !== undefined) { clauses.push('ts >= ?'); params.push(f.from) }
  if (f.to !== undefined) { clauses.push('ts < ?'); params.push(f.to) }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export function queryShadowLog(
  db: Database.Database,
  f: ShadowLogFilter,
): { entries: ShadowLogRow[]; total: number; limit: number; offset: number } {
  const limit = Math.min(Math.max(f.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(f.offset ?? 0, 0)
  const { sql, params } = buildWhere(f)
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM rbac_shadow_log ${sql}`).get(...params) as { n: number }).n
  // Newest first; id breaks ties between rows written in the same second.
  const entries = db
    .prepare(`SELECT * FROM rbac_shadow_log ${sql} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as ShadowLogRow[]
  return { entries, total, limit, offset }
}

export interface ShadowSummary {
  from: number | null
  to: number | null
  total: number
  by_decision: Record<ShadowDecision, number>
  /** Distinct (method, route, permission, role) shapes that would be / were denied, most frequent first. */
  top_denials: Array<{ method: string; route: string; permission: string; role: string; decision: ShadowDecision; count: number }>
  /** Callers behind the denials. */
  denied_principals: Array<{ principal_kind: string; principal: string; role: string; count: number }>
}

const TOP_N = 20

/** Aggregate view used by the daily monitor and the dashboard. */
export function summarizeShadowLog(db: Database.Database, f: Pick<ShadowLogFilter, 'from' | 'to' | 'tenantId'> = {}): ShadowSummary {
  const { sql, params } = buildWhere(f)

  const by_decision: Record<ShadowDecision, number> = { 'would-deny': 0, denied: 0, permitted: 0 }
  const rows = db
    .prepare(`SELECT decision, COUNT(*) AS n FROM rbac_shadow_log ${sql} GROUP BY decision`)
    .all(...params) as Array<{ decision: ShadowDecision; n: number }>
  for (const r of rows) by_decision[r.decision] = r.n
  const total = by_decision['would-deny'] + by_decision.denied + by_decision.permitted

  // Denial shapes: would-deny and denied only (permitted rows are not a false-positive signal).
  const denialWhere = sql ? `${sql} AND decision IN ('would-deny','denied')` : `WHERE decision IN ('would-deny','denied')`
  const top_denials = db
    .prepare(
      `SELECT method, route, permission, role, decision, COUNT(*) AS count
         FROM rbac_shadow_log ${denialWhere}
        GROUP BY method, route, permission, role, decision
        ORDER BY count DESC, route ASC
        LIMIT ${TOP_N}`,
    )
    .all(...params) as ShadowSummary['top_denials']
  const denied_principals = db
    .prepare(
      `SELECT principal_kind, principal, role, COUNT(*) AS count
         FROM rbac_shadow_log ${denialWhere}
        GROUP BY principal_kind, principal, role
        ORDER BY count DESC, principal ASC
        LIMIT ${TOP_N}`,
    )
    .all(...params) as ShadowSummary['denied_principals']

  return { from: f.from ?? null, to: f.to ?? null, total, by_decision, top_denials, denied_principals }
}
