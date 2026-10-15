// OpenTelemetry GenAI semantic-convention constants shared by the DB window query (src/db/observability.ts)
// and the OTLP mapping (src/otel-exporter.ts). No imports, so both can use it without a cycle.

// Explicit bucket bounds the GenAI conventions recommend for gen_ai.client.token.usage (4^0 ... 4^13).
// A value v falls in the first bucket whose bound is >= v; the last bucket is open-ended.
export const GENAI_TOKEN_BUCKET_BOUNDS: readonly number[] = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864,
]

// Explicit bucket bounds (seconds) the GenAI conventions recommend for gen_ai.client.operation.duration.
export const GENAI_DURATION_BUCKET_BOUNDS: readonly number[] = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92,
]
// A model.call span gets a duration only from the context watchdog hook, which approximates it from transcript
// timestamps and says so with this attribute. A span without it has start == end (no duration was measured).
export const DURATION_SOURCE_KEY = 'marveen.duration.source'
export const DURATION_SOURCE_TRANSCRIPT = 'transcript'
// The hook drops anything longer (a pause, not a response); the exporter does not trust a longer figure either.
export const DURATION_MAX_SECONDS = 30 * 60

// Claude is the only model provider the fleet talks to.
export const GENAI_PROVIDER_NAME = 'anthropic'

// OTLP span kinds (opentelemetry-proto trace.proto SpanKind).
export const SPAN_KIND_INTERNAL = 1
export const SPAN_KIND_SERVER = 2
export const SPAN_KIND_CLIENT = 3
export const SPAN_KIND_PRODUCER = 4

// OTLP aggregation temporality (metrics.proto): 1 = DELTA, 2 = CUMULATIVE.
export const TEMPORALITY_DELTA = 1
export const TEMPORALITY_CUMULATIVE = 2
