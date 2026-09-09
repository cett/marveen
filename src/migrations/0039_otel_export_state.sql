-- Migration 0039: state for the OTLP push exporter (#800/#802, OTel F1).
--
-- Two additions:
--
-- 1. otel_spans.exported_at -- watermark per span so the push loop (30s
--    setInterval, src/web/otel-push-exporter.ts) only re-sends spans it
--    hasn't successfully pushed yet. NULL = not exported. A partial index
--    keeps the "find unexported, closed spans" query cheap even as the
--    table grows, since the vast majority of rows are already exported.
--
-- 2. otel_metrics_export_state -- single-row watermark (last_export_ms) for
--    the token_usage -> gen_ai.client.token.usage metrics export. A metric
--    export is a delta aggregate over [last_export_ms, now), so it needs its
--    own cursor independent of otel_spans.exported_at.

ALTER TABLE otel_spans ADD COLUMN exported_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_otel_spans_unexported
  ON otel_spans(end_ms)
  WHERE exported_at IS NULL;

CREATE TABLE IF NOT EXISTS otel_metrics_export_state (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  last_export_ms INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO otel_metrics_export_state (id, last_export_ms) VALUES (1, 0);
