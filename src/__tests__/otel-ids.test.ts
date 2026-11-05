// toHexId and the places that use it: a `w3c-<hex>` trace id goes out as the traceparent's own hex ONLY for the server's own
// http.server span (and the log records of it). Every other id, and every span id, is hashed, so a span written through
// POST /api/spans cannot be steered into someone else's trace.
//
// Privacy: neutral fixtures only (agent-a, the traceparent example ids of the W3C specification).

import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { toHexId } from '../otel-ids.js'
import { spansToOtelJson } from '../otel-exporter.js'
import { traceFields } from '../otel-logs.js'
import type { OtelSpan } from '../db.js'

const HEX = '4bf92f3577b34da6a3ce929d0e0e4736'
const SPAN_HEX = '00f067aa0ba902b7'
const W3C = `w3c-${HEX}`
const W3C_SPAN = `w3c-${SPAN_HEX}`

const sha = (s: string, len: number): string => createHash('sha256').update(s).digest('hex').slice(0, len)

function span(overrides: Partial<OtelSpan>): OtelSpan {
  return {
    trace_id: W3C, span_id: 'span-a', parent_span_id: null, agent_id: 'agent-a', operation: 'http.server',
    start_ms: 1000, end_ms: 2000, status: 'ok', attributes: null, ...overrides,
  }
}
const exported = (s: OtelSpan) => (spansToOtelJson([s], 'ns').resourceSpans[0] as any).scopeSpans[0].spans[0] as { traceId: string; spanId: string; parentSpanId?: string }

describe('toHexId: the trace id', () => {
  it('passes a well-formed w3c- id through as its own hex, only when asked to', () => {
    expect(toHexId(W3C, 16, true)).toBe(HEX)
    expect(toHexId(W3C, 16)).toBe(sha(W3C, 32))
    expect(toHexId(W3C, 16, false)).not.toBe(HEX)
  })

  it('hashes a 32 hex id WITHOUT the w3c- prefix, passthrough or not (the prefix is what says "this came from a traceparent")', () => {
    for (const id of [HEX, `abcd${HEX}`, `w3d-${HEX}`, `W3C-${HEX}`, ` w3c-${HEX}`]) {
      expect(toHexId(id, 16, true), id).toBe(sha(id, 32))
      expect(toHexId(id, 16, true), id).not.toBe(HEX)
      expect(toHexId(id, 16, false), id).toBe(sha(id, 32))
    }
  })

  it('goes the same way through traceFields (the log records)', () => {
    expect(traceFields({ trace_id: W3C, span_id: null })).toEqual({ traceId: HEX })
    for (const id of [HEX, `abcd${HEX}`, `w3d-${HEX}`]) {
      expect(traceFields({ trace_id: id, span_id: null }), id).toEqual({ traceId: sha(id, 32) })
    }
  })
})

describe('toHexId: the span id is always hashed', () => {
  it('a w3c- shaped span id is hashed by default, and the exporter and traceFields never pass it through', () => {
    expect(toHexId(W3C_SPAN, 8)).toBe(sha(W3C_SPAN, 16))
    expect(toHexId(W3C_SPAN, 8)).not.toBe(SPAN_HEX)
    expect(traceFields({ trace_id: W3C, span_id: W3C_SPAN })).toEqual({ traceId: HEX, spanId: sha(W3C_SPAN, 16) })
    const out = exported(span({ span_id: W3C_SPAN, parent_span_id: W3C_SPAN }))
    expect(out.spanId).toBe(sha(W3C_SPAN, 16))
    expect(out.parentSpanId).toBe(sha(W3C_SPAN, 16))
    expect(out.spanId).not.toBe(SPAN_HEX)
    expect(out.parentSpanId).not.toBe(SPAN_HEX)
  })
})

describe('spansToOtelJson: the passthrough is for the server\'s own http.server span only', () => {
  it('an http.server span with a w3c- trace id goes out as the raw hex', () => {
    expect(exported(span({ operation: 'http.server' })).traceId).toBe(HEX)
  })

  it.each(['agent.tool', 'inter-agent.message', 'http.client', 'http.server.extra', 'HTTP.SERVER', ''])(
    'a span of operation %j with the same w3c- trace id is hashed, never the raw hex',
    (operation) => {
      const out = exported(span({ operation }))
      expect(out.traceId).toBe(sha(W3C, 32))
      expect(out.traceId).not.toBe(HEX)
    },
  )

  it('two spans with the same stored trace id differ on the wire exactly when their operation differs', () => {
    expect(exported(span({ operation: 'http.server' })).traceId).not.toBe(exported(span({ operation: 'agent.tool' })).traceId)
    expect(exported(span({ operation: 'agent.tool' })).traceId).toBe(exported(span({ operation: 'inter-agent.message' })).traceId)
  })
})
