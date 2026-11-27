import { readBody, json } from '../http-helpers.js'
import { recordGateAudit, type GateCountIncrement, type GateDenyRow } from '../../db/hook-gate-audit.js'
import type { RouteContext } from './types.js'

// POST /api/v1/hooks/gate-audit <- scripts/hooks/gate_audit_lib.py in PostgreSQL mode
//   { counts: [{gate, decision, reason, n}] (<= 20), denies: [{gate, reason, ts, trace_id?}] (<= 50) }
// One request carries the count increments and the deny rows; the db module writes them in ONE transaction (a deny row never
// without its count, a partial write is never acknowledged).
//
// WHO: the agent is the one the TOKEN names (ctx.tokenAgentId). An `agent_id` (or any other unknown field) in the body is ignored.
// A token that names no agent is a 403. RBAC: hook-gate:write (admin and fleet_agent only), pinned by hooks-gate-audit-route.test.ts.
//
// WHAT A ROW CAN CARRY (the contract of gate_audit_lib.py, enforced HERE, not trusted from the hook): the gate name from GATES,
// the decision from DECISIONS, a reason CODE from REASONS (never free text), and on a deny row the session id as trace_id. No
// command, path, recipient or tool input has a field, so none can be stored through this route. The sets below are pinned to the
// Python constants by hooks-gate-audit-python-parity.test.ts: a gate added on one side only fails there.
//
// NO FRESH TENANT CONTEXT IS NEEDED: this route is in the exemption of tenant-context-bootstrap.ts (a shared agent with no fresh
// context is refused 403 on every other route). It reads nothing of the tenant and writes only fixed-set audit rows for the
// caller's own agent id, and it is needed precisely when a gate denies in that state (the tenant-skill-gate deny of a
// context-less shared agent): a 403 would drop the evidence of the most security-relevant denial.

export const GATES: ReadonlySet<string> = new Set([
  'destructive-gate', 'secret-read-gate', 'email-approval-gate', 'outgoing-copy-gate',
  'auth-admin-gate', 'tenant-skill-gate', 'shell-rescan-guard',
])
export const DECISIONS: ReadonlySet<string> = new Set(['allow', 'deny', 'error'])
export const REASONS: ReadonlySet<string> = new Set(['denied', 'gate_error', 'exit_code', 'input_too_large'])

export const MAX_COUNTS = 20
export const MAX_DENIES = 50
export const MAX_COUNT_N = 10000
/** A deny row older than this, or further ahead than MAX_FUTURE_SECS, is filed with the server's time. */
export const MAX_AGE_SECS = 7 * 86400
export const MAX_FUTURE_SECS = 60

function bad(ctx: RouteContext, field: string, hint: string): true {
  json(ctx.res, { error: 'invalid_value', field, hint }, 400)
  return true
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** The clamp of a deny row's time: an integer inside [now - 7 days, now + 60 s] is kept, anything else becomes `now`. */
export function clampTs(ts: number, now: number): number {
  return ts >= now - MAX_AGE_SECS && ts <= now + MAX_FUTURE_SECS ? ts : now
}

function parseCounts(raw: unknown): GateCountIncrement[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_COUNTS) return `counts must be a list of at most ${MAX_COUNTS}`
  const out: GateCountIncrement[] = []
  for (const c of raw as unknown[]) {
    if (!isRecord(c)) return 'a count must be an object'
    const { gate, decision, reason, n } = c
    if (typeof gate !== 'string' || !GATES.has(gate)) return 'a count needs a known gate'
    if (typeof decision !== 'string' || !DECISIONS.has(decision)) return 'a count needs a decision of allow, deny or error'
    // an allow carries no reason (the empty string is the key of the running count); deny and error carry a code of the fixed set
    if (decision === 'allow' ? reason !== '' : (typeof reason !== 'string' || !REASONS.has(reason))) {
      return 'a count reason must be empty for allow and a reason code for deny and error'
    }
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_COUNT_N) return `a count n must be a whole number from 1 to ${MAX_COUNT_N}`
    out.push({ gate, decision, reason: reason as string, n })
  }
  return out
}

function parseDenies(raw: unknown, now: number): GateDenyRow[] | string {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > MAX_DENIES) return `denies must be a list of at most ${MAX_DENIES}`
  const out: GateDenyRow[] = []
  for (const d of raw as unknown[]) {
    if (!isRecord(d)) return 'a deny must be an object'
    const { gate, reason, ts, trace_id: traceId } = d
    if (typeof gate !== 'string' || !GATES.has(gate)) return 'a deny needs a known gate'
    if (typeof reason !== 'string' || !REASONS.has(reason)) return 'a deny needs a reason code'
    if (typeof ts !== 'number' || !Number.isInteger(ts)) return 'a deny ts must be a whole number of seconds'
    if (traceId !== undefined && traceId !== null && typeof traceId !== 'string') return 'a deny trace_id must be a string'
    // the writer normalises the trace id (a `w3c-` value or anything that is not an id is dropped there, as in the generic writer)
    out.push({ gate, reason, ts: clampTs(ts, now), trace_id: typeof traceId === 'string' ? traceId : null })
  }
  return out
}

export async function tryHandleHooksGateAudit(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path !== '/api/hooks/gate-audit' || method !== 'POST') return false

  const agentId = ctx.tokenAgentId
  if (!agentId) {
    json(res, { error: 'forbidden', hint: 'The hook routes need a token that names an agent' }, 403)
    return true
  }
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse((await readBody(ctx.req)).toString())
    if (!isRecord(parsed)) throw new Error('not an object')
    data = parsed
  } catch {
    json(res, { error: 'parse_error', hint: 'Body must be a JSON object' }, 400)
    return true
  }
  const now = Math.floor(Date.now() / 1000)
  const counts = parseCounts(data['counts'])
  if (typeof counts === 'string') return bad(ctx, 'counts', counts)
  const denies = parseDenies(data['denies'], now)
  if (typeof denies === 'string') return bad(ctx, 'denies', denies)

  const written = await recordGateAudit(agentId, counts, denies)
  json(res, { ok: true, counts: written.counts, denies: written.denies })
  return true
}
