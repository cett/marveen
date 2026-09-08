-- Migration 0037: structured hook audit log.
--
-- Hooks (PreToolUse gates, the new PostToolUse injection-detection gate) can
-- block an action, but until now that decision left no queryable trail --
-- only whatever the hook happened to write to a local logfile, if anything.
-- This table gives every hook a single place to record a DENY verdict, and
-- the dashboard a single place to surface them.
--
-- By design only DENY verdicts are written here (noise reduction on a
-- healthy fleet where allow is the overwhelming majority); content_hash is
-- populated only for deny rows carrying inspectable content, never the raw
-- content itself.

CREATE TABLE IF NOT EXISTS hook_audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL DEFAULT (unixepoch()),
  agent_id     TEXT,
  hook_type    TEXT NOT NULL,   -- 'PreToolUse' | 'PostToolUse' | 'PreCompact' | 'Stop'
  verdict      TEXT NOT NULL,   -- 'allow' | 'deny' | 'defer'
  tool_name    TEXT,            -- null if not a tool-hook
  content_hash TEXT,            -- sha256 of tool_response.content[:4096], deny-only
  reason       TEXT,            -- short machine-readable reason, e.g. 'injection_pattern_A3'
  session_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_hook_audit_ts       ON hook_audit_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_hook_audit_agent_id ON hook_audit_log(agent_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_hook_audit_verdict  ON hook_audit_log(verdict, ts DESC);
