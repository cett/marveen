// gen_ai.client.operation.duration, built from the model.call spans as the push exporter sends them.
//
// A model.call span has a duration only when the context watchdog hook could approximate one from the
// transcript (it then marks the span marveen.duration.source=transcript). Each such span is exported once
// (otel_spans.exported_at), so the metric is fed from the same batch: the observations are folded into an
// in-memory DELTA histogram and sent with the next metrics export. That avoids a second watermark over rows
// whose end_ms is the transcript time of the response, not the time they were written.
//
// Consequences, documented: the figure is an approximation (the time between the line the model answered and
// the last block of its answer, as the transcript stamps them); observations that were not yet sent when the
// process stopped are lost; a batch the collector refuses for good is dropped, a failed send is retried.

import type { OtelSpan } from './db.js'
import {
  GENAI_DURATION_BUCKET_BOUNDS, DURATION_SOURCE_KEY, DURATION_SOURCE_TRANSCRIPT, DURATION_MAX_SECONDS,
} from './otel-genai.js'

export interface DurationSeries {
  agentId: string
  tenantId: string
  model: string | null
  count: number
  sum: number
  min: number
  max: number
  buckets: number[]
}

export interface PendingDurations {
  series: DurationSeries[]
  sinceMs: number
}

const BUCKET_TOTAL = GENAI_DURATION_BUCKET_BOUNDS.length + 1
const UNRESOLVED_TENANT = 'unresolved'

let pending = new Map<string, DurationSeries>()
let pendingSinceMs: number | null = null

// The measured duration of a model.call span in seconds, or null when it has none (or none worth trusting).
export function durationSecondsOf(span: OtelSpan): number | null {
  if (span.operation !== 'model.call' || span.status !== 'ok' || span.end_ms == null) return null
  const ms = span.end_ms - span.start_ms
  if (!Number.isFinite(ms) || ms <= 0 || ms > DURATION_MAX_SECONDS * 1000) return null
  try {
    const blob = JSON.parse(span.attributes ?? '{}') as Record<string, unknown>
    if (blob?.[DURATION_SOURCE_KEY] !== DURATION_SOURCE_TRANSCRIPT) return null
  } catch {
    return null
  }
  return ms / 1000
}

function modelOf(span: OtelSpan): string | null {
  try {
    const m = (JSON.parse(span.attributes ?? '{}') as Record<string, unknown>)?.model
    return typeof m === 'string' && m ? m : null
  } catch {
    return null
  }
}

function bucketIndex(seconds: number): number {
  const idx = GENAI_DURATION_BUCKET_BOUNDS.findIndex((b) => seconds <= b)
  return idx === -1 ? GENAI_DURATION_BUCKET_BOUNDS.length : idx
}

function seriesFor(map: Map<string, DurationSeries>, agentId: string, tenantId: string, model: string | null): DurationSeries {
  const key = `${agentId}\u0000${tenantId}\u0000${model ?? ''}`
  let s = map.get(key)
  if (!s) {
    s = { agentId, tenantId, model, count: 0, sum: 0, min: Infinity, max: -Infinity, buckets: new Array(BUCKET_TOTAL).fill(0) }
    map.set(key, s)
  }
  return s
}

// Folds the measured durations of a batch of successfully exported spans into the pending histogram.
// Returns how many observations it added. Never throws: a span that cannot be read is skipped.
export function recordDurations(spans: OtelSpan[], nowMs: number = Date.now()): number {
  let added = 0
  for (const span of spans) {
    try {
      const seconds = durationSecondsOf(span)
      if (seconds === null) continue
      const s = seriesFor(pending, span.agent_id, span.tenant_id ?? UNRESOLVED_TENANT, modelOf(span))
      s.count += 1
      s.sum += seconds
      s.min = Math.min(s.min, seconds)
      s.max = Math.max(s.max, seconds)
      s.buckets[bucketIndex(seconds)] += 1
      added += 1
    } catch {
      /* instrumentation: skip */
    }
  }
  if (added > 0 && pendingSinceMs === null) pendingSinceMs = nowMs
  return added
}

// Empties the pending histogram and hands it over; null when there is nothing to send.
export function takePendingDurations(): PendingDurations | null {
  if (pending.size === 0 || pendingSinceMs === null) return null
  const taken = { series: [...pending.values()], sinceMs: pendingSinceMs }
  pending = new Map()
  pendingSinceMs = null
  return taken
}

// Puts a taken batch back (the send failed), merged with whatever came in meanwhile.
export function restorePendingDurations(batch: PendingDurations): void {
  for (const b of batch.series) {
    const s = seriesFor(pending, b.agentId, b.tenantId, b.model)
    s.count += b.count
    s.sum += b.sum
    s.min = Math.min(s.min, b.min)
    s.max = Math.max(s.max, b.max)
    b.buckets.forEach((n, i) => { s.buckets[i] += n })
  }
  pendingSinceMs = pendingSinceMs === null ? batch.sinceMs : Math.min(pendingSinceMs, batch.sinceMs)
}

export function resetPendingDurations(): void {
  pending = new Map()
  pendingSinceMs = null
}
