-- Migration 0083: gate_decision_counts, how often each PreToolUse gate allowed, denied or failed (OTel H5b).
--
-- hook_audit_log keeps one row per DENY (migration 0037), which says nothing about the allows: a gate that
-- denies 3 times a day is a very different signal at 30 calls and at 30000. One row per (gate, decision,
-- reason) with a running count answers that without writing a row per tool call.
--
-- Written by scripts/hooks/gate_audit_lib.py from inside the gate process (a direct SQLite write, like the
-- tenant gates: the gates must work while the dashboard is down). The write is best effort and happens AFTER
-- the gate has decided, so a failed write never changes a verdict. Read by the OTLP exporter as the
-- marveen.gate.decisions counter (src/otel-signals.ts).
--
--   gate      the gate's name, from a fixed list in gate_audit_lib.py (destructive-gate, secret-read-gate ...)
--   decision  'allow' | 'deny' | 'error'  (error: the gate process ended with an exit code other than 0 or 2)
--   reason    '' for an allow; for a deny/error one code of the fixed enum in gate_audit_lib.py
--             (denied, gate_error, unreadable_input, timeout). Never free text: the writer validates it.
--   count     decisions since first_at
--   first_at  unix seconds of the first row, the start time of the cumulative counter
--   updated_at  unix seconds of the last decision
--
-- No tenant_id: these are counts of gate runs, not tenant data, and a gate process often cannot tell the tenant.
-- Plain addition (CREATE TABLE IF NOT EXISTS), nothing is altered or rebuilt.

CREATE TABLE IF NOT EXISTS gate_decision_counts (
  gate       TEXT    NOT NULL,
  decision   TEXT    NOT NULL,
  reason     TEXT    NOT NULL DEFAULT '',
  count      INTEGER NOT NULL DEFAULT 0,
  first_at   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (gate, decision, reason)
);
