import type { SenderRouteCheckRow } from '../db/audit.js'

// The numbers behind GET /api/admin/sender-route-audit: what the sender routing rule decided in a window, counted
// from the audit rows (`sender_route_checked`, written by sender-routing-wire.ts). Pure: rows in, summary out, so
// the counting is tested without a database or a request.
//
// What a "message" is here. The route (POST /api/messages) audits EVERY message it judges, but it does so before the
// message is stored, so a route row carries no message id (entity_id is null): one route row is one request. The
// delivery gate (router tick, backlog, inbox pull) audits only what is not allowed, plus the system lane and the
// federated senders, and its row carries the message id. A stored message that was judged at delivery in two modes
// (a switch between audit and enforce) or twice after a restart (the once-per-message memory is process-local) has
// several delivery rows: those are ONE message (entity_id), counted once, with the newest verdict. A message that
// shows up in both stages (a refusal the route logged in audit mode and the delivery gate logged again) cannot be
// joined across the two, because the route row has no id: it is counted once per stage, which is why the answer
// splits the numbers by stage. The count of messages an agent sent to itself, for one, is read from the route stage.

export const SENDER_ROUTE_AUDIT_DEFAULT_DAYS = 7
export const SENDER_ROUTE_AUDIT_MAX_DAYS = 90
/** The most rows read for one answer; a busier window is reported as truncated (the newest rows are kept). */
export const SENDER_ROUTE_AUDIT_MAX_ROWS = 50_000
/** The most distinct pair shapes listed; a longer list is cut and says so. */
export const SENDER_ROUTE_AUDIT_MAX_PAIRS = 500

export interface SenderRoutePair {
  stage: string
  mode: string
  lane: string
  senderClass: string
  from: string
  to: string
  ok: boolean
  reason: string | null
  denied: boolean
  count: number
}

interface Counts { total: number; would_deny: number; denied: number }

export interface SenderRouteAuditSummary {
  total: number
  would_deny: number
  denied: number
  by_reason: Record<string, number>
  by_mode: Record<string, Counts>
  by_stage: Record<string, Counts>
  /** Rows whose stored detail could not be read as a verdict; they are in no other number. */
  unreadable: number
  pairs: SenderRoutePair[]
  pairs_truncated: boolean
}

interface Verdict {
  stage: string
  mode: string
  lane: string
  senderClass: string
  from: string
  to: string
  ok: boolean
  reason: string | null
  denied: boolean
}

const str = (v: unknown): v is string => typeof v === 'string'

/** The verdict a row holds, or null when its detail is missing, not JSON, or not shaped like a verdict. */
function readVerdict(detail: string | null): Verdict | null {
  if (detail === null) return null
  let d: unknown
  try { d = JSON.parse(detail) } catch { return null }
  if (typeof d !== 'object' || d === null) return null
  const o = d as Record<string, unknown>
  if (!str(o.stage) || !str(o.mode) || !str(o.lane) || !str(o.senderClass) || !str(o.from) || !str(o.to)) return null
  if (typeof o.ok !== 'boolean' || typeof o.denied !== 'boolean') return null
  return {
    stage: o.stage, mode: o.mode, lane: o.lane, senderClass: o.senderClass, from: o.from, to: o.to,
    ok: o.ok, reason: str(o.reason) ? o.reason : null, denied: o.denied,
  }
}

const add = (c: Counts, v: Verdict): void => {
  c.total += 1
  if (!v.ok) c.would_deny += 1
  if (v.denied) c.denied += 1
}
const bucket = (m: Map<string, Counts>, key: string): Counts => {
  let c = m.get(key)
  if (!c) { c = { total: 0, would_deny: 0, denied: 0 }; m.set(key, c) }
  return c
}

/**
 * Count the rows. `rows` must be newest first (the order listSenderRouteChecks returns): of several delivery rows of
 * one message the first seen is the newest and is its verdict. `would_deny` counts every verdict that is not ok
 * (audit mode included: it is what enforce would refuse); `denied` counts what enforce actually refused.
 */
export function summarizeSenderRouteChecks(rows: readonly SenderRouteCheckRow[]): SenderRouteAuditSummary {
  const out: SenderRouteAuditSummary = {
    total: 0, would_deny: 0, denied: 0, by_reason: {}, by_mode: {}, by_stage: {}, unreadable: 0, pairs: [], pairs_truncated: false,
  }
  // Keys come from stored text: counted in Maps and turned into objects at the end (a key such as __proto__ stays a key).
  const byReason = new Map<string, number>()
  const byMode = new Map<string, Counts>()
  const byStage = new Map<string, Counts>()
  const seenMessage = new Set<string>()
  const seenMessageMode = new Set<string>()
  const pairs = new Map<string, SenderRoutePair>()

  for (const row of rows) {
    const v = readVerdict(row.detail)
    if (!v) { out.unreadable += 1; continue }
    // A delivery row names its message; a route row is its own unit (it has no message id yet).
    const message = v.stage === 'delivery' && row.entity_id !== null ? `d:${row.entity_id}` : `r:${row.id}`

    // by_mode: one count per message AND mode, so a message judged in both modes shows under each.
    const modeKey = `${message}|${v.mode}`
    if (!seenMessageMode.has(modeKey)) {
      seenMessageMode.add(modeKey)
      add(bucket(byMode, v.mode), v)
    }

    // Everything else: one count per message, its newest verdict.
    if (seenMessage.has(message)) continue
    seenMessage.add(message)
    out.total += 1
    if (!v.ok) out.would_deny += 1
    if (v.denied) out.denied += 1
    add(bucket(byStage, v.stage), v)
    if (!v.ok) {
      const reason = v.reason ?? 'unspecified'
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
    }
    const key = JSON.stringify([v.stage, v.mode, v.lane, v.senderClass, v.from, v.to, v.ok, v.reason, v.denied])
    const existing = pairs.get(key)
    if (existing) existing.count += 1
    else pairs.set(key, { stage: v.stage, mode: v.mode, lane: v.lane, senderClass: v.senderClass, from: v.from, to: v.to, ok: v.ok, reason: v.reason, denied: v.denied, count: 1 })
  }

  out.by_reason = Object.fromEntries(byReason)
  out.by_mode = Object.fromEntries(byMode)
  out.by_stage = Object.fromEntries(byStage)

  const sorted = [...pairs.values()].sort((a, b) =>
    b.count - a.count
    || a.stage.localeCompare(b.stage) || a.mode.localeCompare(b.mode) || a.senderClass.localeCompare(b.senderClass)
    || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  out.pairs_truncated = sorted.length > SENDER_ROUTE_AUDIT_MAX_PAIRS
  out.pairs = out.pairs_truncated ? sorted.slice(0, SENDER_ROUTE_AUDIT_MAX_PAIRS) : sorted
  return out
}
