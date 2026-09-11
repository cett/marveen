-- Migration 0042: retire tool_call_log.
--
-- tool_call_log has been superseded by otel_spans as the single writer/reader
-- path for tool-call audit data (see src/db/audit.ts: logToolCall,
-- getRecentToolCalls, analyzeWorkflowCandidates). SQLite drops a table's own
-- indexes automatically when the table is dropped, so idx_tool_log_session
-- and idx_tool_log_ts need no explicit DROP INDEX.
DROP TABLE IF EXISTS tool_call_log;
