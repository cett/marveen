-- Migration 0068: rbac_shadow_log, a persistent record of RBAC gate decisions.
--
-- Until now the shadow gate's would-deny / permitted outcomes went only to the pino
-- log, so the observation window before RBAC_MODE=enforce could not be measured: a
-- rotated or filtered log looks the same as "no non-admin traffic arrived". This table
-- is the durable evidence. The gate inserts a row in BOTH modes:
--   would-deny  shadow mode: the request was let through but enforce would have refused it
--   denied      enforce mode: the request was refused (401/403/503)
--   permitted   a non-admin request that passed the gate (admin traffic is 100% of the
--               legacy volume and carries no signal, so it is not recorded)
--
--   ts          unix seconds (UTC)
--   tenant_id   resolved tenant scope; NULL = global admin scope
--   principal_kind  token | session | device | federation
--   principal   human label of the caller (token name, user, device, peer); '' when the
--               credential has none (the legacy file-based dashboard token)
--   role        resolved RBAC role
--   permission  the permission the route required (admin:all for unmapped routes)
--   reason      the gate's refusal reason; '' for permitted rows
--
-- Retention is enforced by the application (30 days, pruned opportunistically by the
-- writer), so the table stays bounded without a separate scheduled job.
CREATE TABLE IF NOT EXISTS rbac_shadow_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL DEFAULT (unixepoch()),
  tenant_id      TEXT,
  principal_kind TEXT    NOT NULL,
  principal      TEXT    NOT NULL DEFAULT '',
  role           TEXT    NOT NULL,
  method         TEXT    NOT NULL,
  route          TEXT    NOT NULL,
  permission     TEXT    NOT NULL,
  decision       TEXT    NOT NULL CHECK (decision IN ('would-deny', 'denied', 'permitted')),
  reason         TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_rbac_shadow_log_ts ON rbac_shadow_log(ts);
CREATE INDEX IF NOT EXISTS idx_rbac_shadow_log_decision_ts ON rbac_shadow_log(decision, ts);
