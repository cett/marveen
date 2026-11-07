import type { SenderRouteCheckRow } from '../db/audit.js'

// The numbers behind GET /api/admin/sender-route-audit: what the sender routing rule decided in a window, counted
// from the audit rows (`sender_route_checked`, written by sender-routing-wire.ts). Pure: rows in, summary out, so
// the counting is tested without a database or a request.
//
// TWO BLOCKS, NEVER ONE SUM. The route (POST /api/messages) audits every message it judges, but it does so BEFORE
// the message is stored, on purpose (a refused message is never stored, so it never gets an id): a route row has no
// message id (entity_id is null), and one route row is one request. The delivery gate (router tick, backlog, inbox
// pull) audits only what is not allowed, plus the system lane and the federated senders, and its row names the
// message. In audit mode the same not-ok message therefore shows up in BOTH stages, and nothing joins the two rows
// (no shared id), so the answer keeps them apart: `by_stage.route` and `by_stage.delivery`, each with its own
// total / would_deny / denied, reasons and modes. They overlap and must not be added together. An exact count of
// messages across the two stages is a later change (the route audit written after the message is stored, for ok
// verdicts); until then the pairs list per stage is the data to read, and the number of messages an agent sent to
// itself (from equal to) is read from the route block alone, where it is counted once.
//
// Counting in a block. Route: one row, one unit. Delivery: the unit is the message id AND the mode (the mode is
// part of the once-per-message memory of the gate, so a switch between audit and enforce writes a second row by
// design, and a restart forgets the memory); rows of the same message and mode are one unit, the newest verdict
// wins. A delivery row without a message id is a unit of its own.

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
  /** The number of units of this shape IN ITS STAGE. */
  count: number
}

export interface Counts { total: number; would_deny: number; denied: number }

/** One stage's numbers. `would_deny` counts every verdict that is not ok (audit mode included), `denied` what enforce refused. */
export interface StageSummary extends Counts {
  by_reason: Record<string, number>
  by_mode: Record<string, Counts>
}

export interface SenderRouteAuditSummary {
  /** The two stages overlap (see above): there is no total over both. */
  by_stage: { route: StageSummary; delivery: StageSummary }
  /** Rows whose stored detail could not be read as a verdict; they are in no other number. */
  unreadable: number
  pairs: SenderRoutePair[]
  pairs_truncated: boolean
}

type Stage = 'route' | 'delivery'

interface Verdict {
  stage: Stage
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
  if (o.stage !== 'route' && o.stage !== 'delivery') return null
  if (!str(o.mode) || !str(o.lane) || !str(o.senderClass) || !str(o.from) || !str(o.to)) return null
  if (typeof o.ok !== 'boolean' || typeof o.denied !== 'boolean') return null
  return {
    stage: o.stage, mode: o.mode, lane: o.lane, senderClass: o.senderClass, from: o.from, to: o.to,
    ok: o.ok, reason: str(o.reason) ? o.reason : null, denied: o.denied,
  }
}

/** The keys come from stored text: counted in Maps and turned into objects at the end (a key such as __proto__ stays a key). */
class StageCounter {
  total = 0
  would_deny = 0
  denied = 0
  private byReason = new Map<string, number>()
  private byMode = new Map<string, Counts>()

  add(v: Verdict): void {
    this.total += 1
    if (!v.ok) {
      this.would_deny += 1
      const reason = v.reason ?? 'unspecified'
      this.byReason.set(reason, (this.byReason.get(reason) ?? 0) + 1)
    }
    if (v.denied) this.denied += 1
    let m = this.byMode.get(v.mode)
    if (!m) { m = { total: 0, would_deny: 0, denied: 0 }; this.byMode.set(v.mode, m) }
    m.total += 1
    if (!v.ok) m.would_deny += 1
    if (v.denied) m.denied += 1
  }

  result(): StageSummary {
    return {
      total: this.total, would_deny: this.would_deny, denied: this.denied,
      by_reason: Object.fromEntries(this.byReason), by_mode: Object.fromEntries(this.byMode),
    }
  }
}

/**
 * Count the rows. `rows` must be newest first (the order listSenderRouteChecks returns): of several delivery rows of
 * one message and mode the first seen is the newest and is that unit's verdict.
 */
export function summarizeSenderRouteChecks(rows: readonly SenderRouteCheckRow[]): SenderRouteAuditSummary {
  const stages: Record<Stage, StageCounter> = { route: new StageCounter(), delivery: new StageCounter() }
  let unreadable = 0
  const seenUnit = new Set<string>()
  const pairs = new Map<string, SenderRoutePair>()

  for (const row of rows) {
    const v = readVerdict(row.detail)
    if (!v) { unreadable += 1; continue }
    // Route: a row is its own unit. Delivery: the message id and the mode, when the row names its message.
    const unit = v.stage === 'delivery' && row.entity_id !== null ? `d:${row.entity_id}|${v.mode}` : `${v.stage}:row:${row.id}`
    if (seenUnit.has(unit)) continue
    seenUnit.add(unit)
    stages[v.stage].add(v)
    const key = JSON.stringify([v.stage, v.mode, v.lane, v.senderClass, v.from, v.to, v.ok, v.reason, v.denied])
    const existing = pairs.get(key)
    if (existing) existing.count += 1
    else pairs.set(key, { stage: v.stage, mode: v.mode, lane: v.lane, senderClass: v.senderClass, from: v.from, to: v.to, ok: v.ok, reason: v.reason, denied: v.denied, count: 1 })
  }

  const sorted = [...pairs.values()].sort((a, b) =>
    b.count - a.count
    || a.stage.localeCompare(b.stage) || a.mode.localeCompare(b.mode) || a.senderClass.localeCompare(b.senderClass)
    || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  const truncated = sorted.length > SENDER_ROUTE_AUDIT_MAX_PAIRS
  return {
    by_stage: { route: stages.route.result(), delivery: stages.delivery.result() },
    unreadable,
    pairs: truncated ? sorted.slice(0, SENDER_ROUTE_AUDIT_MAX_PAIRS) : sorted,
    pairs_truncated: truncated,
  }
}
