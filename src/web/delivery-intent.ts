/**
 * Per-session delivery-intent registry.
 *
 * Records content that the router/scheduler genuinely delivered into a session,
 * and exposes a truncation-tolerant match so the stuck-input recovery can
 * verify that parked text originated from a real delivery before re-injecting it.
 *
 * Security invariant: only content the router has explicitly recorded here may
 * be re-submitted by the recovery path. Unmatched parked text is held (not
 * re-injected), degrading to a surfaced alert rather than a silent phantom-inject.
 */

const FRESHNESS_MS = 5 * 60 * 1000   // 5-minute window
const RING_CAP = 10                   // per-session ring buffer size

// Minimum length below which we require an exact match (no substring coincidence).
const EXACT_MATCH_THRESHOLD = 40

/**
 * What the head-lost requeue needs to put an inter-agent message back in the queue: the ledger row it came from.
 * A scheduled-task delivery has none (the next schedule fire re-delivers it), so it can never be requeued.
 */
export interface DeliveryLedgerRef {
  msgId: number
  toAgent: string
  tenantId: string
}

interface DeliveryRecord {
  content: string
  ts: number
  /** A short label for the delivery (the message id, or the kind of a delivery that has none): diagnostics only. */
  ref: string
  /** The ledger row of an inter-agent delivery; absent for anything else. */
  ledger?: DeliveryLedgerRef
}

// session -> ring of recent deliveries (newest last)
const registry = new Map<string, DeliveryRecord[]>()

/**
 * Record a genuine delivery into session. Called at the actual inject point. `ref` labels it for the park forensics
 * (the inter-agent message id; a scheduled task passes its kind): it is never matched on and never carries content.
 */
export function recordDelivery(session: string, content: string, ref = 'unlabeled', ledger?: DeliveryLedgerRef): void {
  const ring = registry.get(session) ?? []
  ring.push({ content, ts: Date.now(), ref, ...(ledger ? { ledger } : {}) })
  if (ring.length > RING_CAP) ring.shift()
  registry.set(session, ring)
}

/** The labels of the last `n` deliveries into session, oldest first. Empty for an unknown session. */
export function recentDeliveryRefs(session: string, n = 3): string[] {
  const ring = registry.get(session)
  return ring ? ring.slice(-n).map((r) => r.ref) : []
}

/**
 * Check whether boxContent matches a recent delivery for session.
 *
 * Truncation-tolerant: a long delivery may only be partially visible in the
 * input box. We match if the boxContent is a leading prefix of a fresh delivery
 * (and the boxContent is at least EXACT_MATCH_THRESHOLD chars, to avoid
 * accidental short-string hits).
 *
 * For short boxContent we require an exact match.
 */
export function matchDelivery(session: string, boxContent: string): boolean {
  const trimmed = boxContent.trim()
  if (!trimmed) return false

  const now = Date.now()
  const ring = registry.get(session)
  if (!ring) return false

  for (const rec of ring) {
    if (now - rec.ts > FRESHNESS_MS) continue
    const recTrimmed = rec.content.trim()
    if (trimmed.length >= EXACT_MATCH_THRESHOLD) {
      // Long content: accept if the box shows a leading prefix of the delivery.
      if (recTrimmed.startsWith(trimmed) || recTrimmed === trimmed) return true
    } else {
      // Short content: exact match only to avoid substring coincidence.
      if (recTrimmed === trimmed) return true
    }
  }
  return false
}

/** Whitespace-collapse the way the parked-box scrape is (terminal wrap folded into single spaces). */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The shortest box text that can be attributed to a delivery by its TAIL (shorter ones are coincidence-prone). */
export const TAIL_MATCH_MIN_CHARS = 40

export type DeliveryTailMatch =
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'match'; ref: string; ledger: DeliveryLedgerRef }

/**
 * Positive attribution of a HEAD-LOST box: the TUI drops the leading rows of an overfull input box, so what is left
 * is the tail of the frame the router pasted. The box is attributed to a delivery only when its collapsed text is a
 * verbatim SUFFIX of exactly ONE fresh (<= 5 min) delivery's collapsed content, i.e. it ends where the delivery ends
 * (text typed after the frame breaks the suffix: a human may have added to it, so no match). A prefix or a middle
 * piece does not match. No fresh delivery matching, or two matching (the same text twice, two frames with the same
 * closing boilerplate), is not a match either. A match also needs the ledger row of the delivery: a scheduled-task
 * delivery has none and is never matched. Pure read: the registry is not changed.
 */
export function matchDeliveryTail(session: string, boxText: string): DeliveryTailMatch {
  const flat = collapse(boxText)
  if (flat.length < TAIL_MATCH_MIN_CHARS) return { kind: 'none' }
  const ring = registry.get(session)
  if (!ring) return { kind: 'none' }
  const now = Date.now()
  const hits = ring.filter((rec) => now - rec.ts <= FRESHNESS_MS && collapse(rec.content).endsWith(flat))
  if (hits.length === 0) return { kind: 'none' }
  if (hits.length > 1) return { kind: 'ambiguous' }
  const hit = hits[0]!
  return hit.ledger ? { kind: 'match', ref: hit.ref, ledger: hit.ledger } : { kind: 'none' }
}

/** Drop the record(s) of an inter-agent message from the session's ring (after a successful requeue: no second match on it). */
export function removeDeliveryByMsgId(session: string, msgId: number): void {
  const ring = registry.get(session)
  if (!ring) return
  const kept = ring.filter((rec) => rec.ledger?.msgId !== msgId)
  if (kept.length === 0) registry.delete(session)
  else registry.set(session, kept)
}

/** Remove all delivery records for session (e.g. after a hard restart). */
export function clearDeliveries(session: string): void {
  registry.delete(session)
}

/** Exposed for testing only. */
export function _registrySize(session: string): number {
  return registry.get(session)?.length ?? 0
}
