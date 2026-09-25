// coverage batch-51: db/tasks.ts (0% covered before this file for these
// four functions): the tenant-scoped task_runs counter and three skill-store
// read helpers. Pure DB-query functions, real in-memory SQLite -- no mocking
// needed beyond initDatabase(':memory:').
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import { countTaskRunsBetween, countSkills, listAgentOwnedSkills, listGlobalFleetSkills, createSkill } from '../db/tasks.js'

beforeEach(() => {
  initDatabase(':memory:')
})

function insertTaskRun(name: string, agent: string, ts: number, status = 'fired'): void {
  getDb().prepare('INSERT INTO task_runs (name, agent, ts, status) VALUES (?, ?, ?, ?)').run(name, agent, ts, status)
}

describe('countTaskRunsBetween', () => {
  it('counts every run at or after fromTs when no upper bound or agent filter is given', () => {
    insertTaskRun('t1', 'agent-a', 1000)
    insertTaskRun('t2', 'agent-b', 2000)
    insertTaskRun('t3', 'agent-a', 500) // before fromTs, excluded
    expect(countTaskRunsBetween(1000)).toBe(2)
  })

  it('excludes runs at or after toTs when an upper bound is given', () => {
    insertTaskRun('t1', 'agent-a', 1000)
    insertTaskRun('t2', 'agent-a', 1999)
    insertTaskRun('t3', 'agent-a', 2000) // >= toTs, excluded
    expect(countTaskRunsBetween(1000, 2000)).toBe(2)
  })

  it('narrows to the given agentIds', () => {
    insertTaskRun('t1', 'agent-a', 1000)
    insertTaskRun('t2', 'agent-b', 1000)
    insertTaskRun('t3', 'agent-c', 1000)
    expect(countTaskRunsBetween(0, undefined, ['agent-a', 'agent-c'])).toBe(2)
  })

  it('returns 0 without querying when agentIds is an explicit empty array (tenant has no agents)', () => {
    insertTaskRun('t1', 'agent-a', 1000)
    expect(countTaskRunsBetween(0, undefined, [])).toBe(0)
  })

  it('undefined agentIds means unfiltered, fleet-wide', () => {
    insertTaskRun('t1', 'agent-a', 1000)
    insertTaskRun('t2', 'agent-b', 1000)
    expect(countTaskRunsBetween(0, undefined, undefined)).toBe(2)
  })
})

describe('countSkills', () => {
  it('is 0 on an empty table', () => {
    expect(countSkills()).toBe(0)
  })

  it('counts every row regardless of tenant or global flag', () => {
    createSkill({ id: 's1', name: 'One', content: 'x', tenant_id: 'tenant-a' })
    createSkill({ id: 's2', name: 'Two', content: 'x', tenant_id: 'fleet', is_global: true })
    expect(countSkills()).toBe(2)
  })
})

describe('listAgentOwnedSkills', () => {
  it('returns only skills whose id is prefixed agent/<agentId>/, ordered by name', () => {
    createSkill({ id: 'agent/agent-a/zeta', name: 'Zeta', content: 'x', tenant_id: 'tenant-a' })
    createSkill({ id: 'agent/agent-a/alpha', name: 'Alpha', content: 'x', tenant_id: 'tenant-a' })
    createSkill({ id: 'agent/agent-b/other', name: 'Other', content: 'x', tenant_id: 'tenant-b' })
    createSkill({ id: 'global-skill', name: 'Global', content: 'x', tenant_id: 'fleet', is_global: true })

    const rows = listAgentOwnedSkills('agent-a')
    expect(rows.map((r) => r.id)).toEqual(['agent/agent-a/alpha', 'agent/agent-a/zeta'])
  })

  it('a prefix must match a FULL path segment, not just a string prefix', () => {
    // agent-a's prefix must not accidentally match agent-ab's skills.
    createSkill({ id: 'agent/agent-ab/x', name: 'X', content: 'x', tenant_id: 'tenant-a' })
    const rows = listAgentOwnedSkills('agent-a')
    expect(rows).toHaveLength(0)
  })

  it('returns an empty array when the agent owns no skills', () => {
    expect(listAgentOwnedSkills('nobody')).toEqual([])
  })
})

describe('listGlobalFleetSkills', () => {
  it('returns only is_global=1 skills scoped to the fleet tenant', () => {
    createSkill({ id: 'g1', name: 'Fleet A', content: 'x', tenant_id: 'fleet', is_global: true })
    createSkill({ id: 'g2', name: 'Fleet B', content: 'x', tenant_id: 'fleet', is_global: true })
    createSkill({ id: 'tenant-only', name: 'Tenant', content: 'x', tenant_id: 'tenant-a', is_global: false })
    // is_global=1 but NOT tenant_id='fleet': must not qualify.
    createSkill({ id: 'stray-global', name: 'Stray', content: 'x', tenant_id: 'tenant-b', is_global: true })

    const rows = listGlobalFleetSkills()
    expect(rows.map((r) => r.id).sort()).toEqual(['g1', 'g2'])
  })

  it('returns an empty array when no fleet-global skills exist', () => {
    createSkill({ id: 'tenant-only', name: 'Tenant', content: 'x', tenant_id: 'tenant-a' })
    expect(listGlobalFleetSkills()).toEqual([])
  })
})
