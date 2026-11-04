// The one mapping from a stored trace / span id to the id OTLP sends. Shared by the span export (otel-exporter.ts) and
// the log export (otel-logs.ts), so a log record and a span of the same trace land in the same OTLP trace by
// construction. Pure: no I/O, nothing but node:crypto.

import { createHash } from 'node:crypto'

// OTLP requires traceId to be exactly 16 bytes (32 hex chars) and spanId
// exactly 8 bytes (16 hex chars) of raw hex -- not a UUID, not a Claude-native
// id. Our ids are session_ids, msg_... ids, tool_use ids and transcript UUIDs,
// none of which are hex or the right length, so a collector validates and
// rejects (400) every export. Hash deterministically instead of trying to
// "clean up" the original string: the same input always yields the same
// output, so trace/span correlation (parent-child links across multiple
// export calls) is preserved.
export function toHexId(id: string, byteLen: 8 | 16, passthrough = false): string {
  // A trace id taken over from a W3C traceparent header (src/otel-http.ts) is already the id to send. Only for the
  // server's own http.server spans: any other span that carries such an id (written through POST /api/spans or by
  // mistake) is hashed like every other id, so it cannot be steered into someone else's trace.
  if (passthrough && id.startsWith('w3c-') && new RegExp(`^[0-9a-f]{${byteLen * 2}}$`).test(id.slice(4))) return id.slice(4)
  return createHash('sha256').update(id).digest('hex').slice(0, byteLen * 2)
}
