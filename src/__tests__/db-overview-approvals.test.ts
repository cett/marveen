// listOverviewRecentApprovals: the rows behind the approvals in the Overview activity feed. The query once selected
// a created_at column the approvals table does not have (the column is requested_at), so every call threw.

import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { listOverviewRecentApprovals } from '../db/overview.js'

beforeEach(() => {
  initDatabase(':memory:')
  getDb().prepare("INSERT OR IGNORE INTO tenants (id, display_name, created_at) VALUES ('default', 'Fleet', 0)").run()
  getDb().prepare("INSERT INTO tenants (id, display_name, created_at) VALUES ('acme', 'Acme', 1)").run()
})

function addApproval(id: string, status: string, requestedAt: number, tenantId: string): void {
  getDb().prepare(
    `INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, tenant_id)
     VALUES (?, 'agent-a', 'email_send', ?, ?, ?, ?)`
  ).run(id, `act ${id}`, status, requestedAt, tenantId)
}

describe('listOverviewRecentApprovals', () => {
  it('is empty without approvals', () => {
    expect(listOverviewRecentApprovals(0, null)).toEqual([])
  })

  it('newest first, from the cut-off, tenant narrowing, capped at 10', () => {
    addApproval('old', 'pending', 5, 'default')
    addApproval('mid', 'approved', 20, 'acme')
    addApproval('new', 'rejected', 30, 'default')
    // The cut-off is inclusive: a row requested exactly at the cut-off is in, the one before it is out.
    expect(listOverviewRecentApprovals(20, null).map(a => a.created_at)).toEqual([30, 20])
    expect(listOverviewRecentApprovals(21, null).map(a => a.created_at)).toEqual([30])
    expect(listOverviewRecentApprovals(10, null)).toEqual([
      { agent_id: 'agent-a', action_description: 'act new', status: 'rejected', created_at: 30 },
      { agent_id: 'agent-a', action_description: 'act mid', status: 'approved', created_at: 20 },
    ])
    expect(listOverviewRecentApprovals(10, 'acme').map(a => a.status)).toEqual(['approved'])
    for (let i = 0; i < 15; i++) addApproval(`bulk-${i}`, 'pending', 100 + i, 'default')
    expect(listOverviewRecentApprovals(0, null)).toHaveLength(10)
  })
})
