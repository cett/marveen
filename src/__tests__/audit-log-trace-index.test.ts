// The trace_id indexes of migration 0089 (config_change_log, agent_audit_log, hook_audit_log): GET /api/audit-log?trace_id=
// is served by them. The filter itself is covered on both engines by audit-log-trace-filter.test.ts.
//
// SQLite only (pg-modules.ts, reason sqlite-only): the two cells assert the SQLite planner (EXPLAIN QUERY PLAN) and
// catalog (sqlite_master). On PostgreSQL a tiny test table gets a sequential scan whatever the index says, so an
// equivalent assertion would test a planner switch, not the filter.

import { describe, it, expect } from 'vitest'
import { dbx } from '../db.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

describe('queryAuditLog with a trace_id: the migration 0089 indexes', () => {
  it('is served by the partial indexes of migration 0089: a SEARCH on trace_id through the index, never a scan', async () => {
    for (const [table, index] of [['config_change_log', 'idx_config_change_log_trace'], ['agent_audit_log', 'idx_agent_audit_log_trace'], ['hook_audit_log', 'idx_hook_audit_log_trace']] as const) {
      const plan = ((await dbx.all(`EXPLAIN QUERY PLAN SELECT id FROM ${table} WHERE trace_id = ?`, 'x')) as Array<{ detail: string }>).map((p) => p.detail)
      expect(plan, table).toHaveLength(1)
      expect(plan[0], table).toMatch(new RegExp(`^SEARCH ${table} USING (COVERING )?INDEX ${index} \\(trace_id=\\?\\)$`))
    }
  })

  it('the indexes are partial: only the rows that have a trace are in them', async () => {
    for (const index of ['idx_config_change_log_trace', 'idx_agent_audit_log_trace', 'idx_hook_audit_log_trace']) {
      const row = await dbx.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", index)
      expect(row?.sql, index).toContain('WHERE trace_id IS NOT NULL')
    }
  })
})
