// OpenTelemetry GenAI semantic-convention constants shared by the DB window query (src/db/observability.ts)
// and the OTLP mapping (src/otel-exporter.ts). No imports, so both can use it without a cycle.

// Explicit bucket bounds the GenAI conventions recommend for gen_ai.client.token.usage (4^0 ... 4^13).
// A value v falls in the first bucket whose bound is >= v; the last bucket is open-ended.
export const GENAI_TOKEN_BUCKET_BOUNDS: readonly number[] = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
]

// Claude is the only model provider the fleet talks to.
export const GENAI_PROVIDER_NAME = 'anthropic'

// OTLP span kinds (opentelemetry-proto trace.proto SpanKind).
export const SPAN_KIND_INTERNAL = 1
export const SPAN_KIND_CLIENT = 3
export const SPAN_KIND_PRODUCER = 4

// OTLP aggregation temporality (metrics.proto): 1 = DELTA, 2 = CUMULATIVE.
export const TEMPORALITY_DELTA = 1
export const TEMPORALITY_CUMULATIVE = 2
