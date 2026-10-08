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

import { logger } from '../logger.js'
import type http from 'node:http'
import { applyRbacGate, resolveRole, resolveTenantId } from './authz.js'
import type { RbacMode } from './authz.js'
import { resolveRequiredPermission } from './rbac.js'
import type { AuthResult } from './auth-gate.js'
import {
  insertRbacShadowRow,
  deleteRbacShadowRowsBefore,
  queryRbacShadowRows,
  summarizeRbacShadowRows,
  SHADOW_MAX_LIMIT,
  SHADOW_DEFAULT_LIMIT,
  type ShadowDecision,
  type ShadowLogRow,
  type ShadowLogFilter,
  type ShadowSummary,
} from '../db.js'

export type { ShadowDecision, ShadowLogRow, ShadowLogFilter, ShadowSummary }

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
    insertRbacShadowRow({
      ts: nowSec,
      tenantId: resolveTenantId(auth),
      principalKind: kind,
      principal: name,
      role: resolveRole(auth),
      method,
      route: path,
      permission: resolveRequiredPermission(method, path) ?? 'admin:all',
      decision,
      reason,
    })
  } catch (err) {
    logger.warn({ err, path, method, decision }, 'rbac:shadow-log insert failed')
    return false
  }
  pruneShadowLogThrottled(nowSec)
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
      recordRbacDecision(auth, method, path, 'would-deny', reason)
    },
    (reason) => {
      logger.warn({ path, method, authKind: auth.kind, reason, outcome: 'denied' }, 'rbac:enforce')
      recordRbacDecision(auth, method, path, 'denied', reason)
    },
  )
  if (!passed) return false
  if (resolveRole(auth) !== 'admin' && !wouldDeny) {
    if (mode === 'shadow') {
      logger.info({ path, method, authKind: auth.kind, role: resolveRole(auth), outcome: 'permitted' }, 'rbac:shadow')
    }
    recordRbacDecision(auth, method, path, 'permitted')
  }
  return true
}

/** Delete rows older than RETENTION_DAYS. Returns the number removed. */
export function pruneShadowLog(nowSec: number = Math.floor(Date.now() / 1000)): number {
  const cutoff = nowSec - RETENTION_DAYS * SECONDS_PER_DAY
  return deleteRbacShadowRowsBefore(cutoff)
}

function pruneShadowLogThrottled(nowSec: number): void {
  if (nowSec - lastPruneAt < PRUNE_INTERVAL_SEC) return
  lastPruneAt = nowSec
  try {
    pruneShadowLog(nowSec)
  } catch (err) {
    logger.warn({ err }, 'rbac:shadow-log prune failed')
  }
}

export const MAX_LIMIT = SHADOW_MAX_LIMIT
export const DEFAULT_LIMIT = SHADOW_DEFAULT_LIMIT

export function queryShadowLog(f: ShadowLogFilter): ReturnType<typeof queryRbacShadowRows> {
  return queryRbacShadowRows(f)
}

/** Aggregate view used by the daily monitor and the dashboard. */
export function summarizeShadowLog(f: Pick<ShadowLogFilter, 'from' | 'to' | 'tenantId'> = {}): ShadowSummary {
  return summarizeRbacShadowRows(f)
}
