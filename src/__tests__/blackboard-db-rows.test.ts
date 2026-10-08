// Real-DB checks for the blackboard reads that the route tests stub out: the
// tenant narrowing of listBlackboardRows and the per-agent aggregates behind
// the staleness signals.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  getDb,
  listBlackboardRows,
  getLastOutboundMessageTimes,
  getLastBlackboardChangeTimes,
  blackboardRowExistsForAgent,
} from '../db.js'

function seedRow(agentId: string, tenantId: string, updatedAt: number): void {
  getDb()
    .prepare("INSERT INTO fleet_blackboard (id, agent_id, status, summary, tenant_id, updated_at) VALUES (?, ?, 'active', 's', ?, ?)")
    .run(`bb-${agentId}`, agentId, tenantId, updatedAt)
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('listBlackboardRows', () => {
  it('returns every tenant when unfiltered, newest first', () => {
    seedRow('agent-a', 'tenant-a', 100)
    seedRow('agent-b', 'tenant-b', 200)
    expect(listBlackboardRows(10, null).map((r) => r.agent_id)).toEqual(['agent-b', 'agent-a'])
  })

  it('narrows to one tenant and never leaks another tenant\'s rows', () => {
    seedRow('agent-a', 'tenant-a', 100)
    seedRow('agent-b', 'tenant-b', 200)
    expect(listBlackboardRows(10, 'tenant-a').map((r) => r.agent_id)).toEqual(['agent-a'])
    expect(listBlackboardRows(10, 'tenant-c')).toEqual([])
  })

  it('honours the limit', () => {
    seedRow('agent-a', 'tenant-a', 100)
    seedRow('agent-b', 'tenant-a', 200)
    expect(listBlackboardRows(1, 'tenant-a').map((r) => r.agent_id)).toEqual(['agent-b'])
  })
})

describe('blackboardRowExistsForAgent', () => {
  it('is true only for an agent with a row', () => {
    seedRow('agent-a', 'tenant-a', 100)
    expect(blackboardRowExistsForAgent('agent-a')).toBe(true)
    expect(blackboardRowExistsForAgent('agent-z')).toBe(false)
  })
})

describe('signal aggregates', () => {
  it('returns the latest outbound message per sender after the cutoff', () => {
    const ins = getDb().prepare("INSERT INTO agent_messages (from_agent, to_agent, content, created_at) VALUES (?, 'x', 'm', ?)")
    ins.run('agent-a', 1000)
    ins.run('agent-a', 3000)
    ins.run('agent-b', 500)
    expect(getLastOutboundMessageTimes(['agent-a', 'agent-b'], 900)).toEqual([{ agent_id: 'agent-a', last_msg_at: 3000 }])
  })

  it('returns the latest history change per agent', () => {
    const ins = getDb().prepare("INSERT INTO fleet_blackboard_history (agent_id, status, summary, tenant_id, created_at) VALUES (?, 'active', 's', 'tenant-a', ?)")
    ins.run('agent-a', 10)
    ins.run('agent-a', 30)
    expect(getLastBlackboardChangeTimes(['agent-a', 'agent-b'])).toEqual([{ agent_id: 'agent-a', last_changed_at: 30 }])
  })
})
