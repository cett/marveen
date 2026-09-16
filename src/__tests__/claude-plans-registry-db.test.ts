import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  getDb,
  activatePlanForAgent,
  deactivatePlanForAgent,
  touchActivePlanHeartbeat,
  getActivePlanForAgent,
  listActivePlansForAgents,
  sweepStaleActivePlans,
  replaceClaudePlanRows,
  deleteClaudePlanRow,
  listClaudePlanRows,
  upsertBlackboard,
  markBlackboardStale,
  findBlackboardRowByAgent,
} from '../db.js'

// #886: claude_plans_registry (DB mirror) + agent_active_plans (per-agent
// binding lifecycle). See db/claude-plans.ts header for why the registry is a
// mirror, not the operational source of truth.

beforeEach(() => {
  initDatabase(':memory:')
})

// replaceClaudePlanRows replaces the WHOLE table -- seed every id a test
// needs in one call, not one call per id (a later call would drop earlier ids).
function seedPlans(...ids: string[]) {
  replaceClaudePlanRows(ids.map((id) => ({ id, label: `Team ${id}`, configDir: '/tmp/x', planType: 'team' as const, channelsAllowed: true })))
}

describe('claude_plans_registry mirror', () => {
  it('replaceClaudePlanRows replaces the whole table, not just appends', () => {
    replaceClaudePlanRows([{ id: 'p1', label: 'P1', configDir: '/a', planType: 'personal', channelsAllowed: false }])
    replaceClaudePlanRows([{ id: 'p2', label: 'P2', configDir: '/b', planType: 'team', channelsAllowed: true }])
    const rows = listClaudePlanRows()
    expect(rows.map((r) => r.id)).toEqual(['p2'])
  })

  it('deleteClaudePlanRow cascades: an agent bound to the deleted plan loses its binding', () => {
    seedPlans('p1')
    activatePlanForAgent('agent-a', 'p1', 'manual')
    deleteClaudePlanRow('p1')
    expect(getActivePlanForAgent('agent-a')).toBeNull()
  })

  it('replaceClaudePlanRows also cascades: dropping a plan id from a bulk replace removes its bindings too', () => {
    seedPlans('p1')
    activatePlanForAgent('agent-a', 'p1', 'manual')
    replaceClaudePlanRows([{ id: 'p2', label: 'P2', configDir: '/b', planType: 'team', channelsAllowed: true }])
    expect(getActivePlanForAgent('agent-a')).toBeNull()
  })
})

describe('agent_active_plans lifecycle', () => {
  it('activatePlanForAgent then getActivePlanForAgent round-trips label/type/channelsAllowed', () => {
    seedPlans('team-a')
    activatePlanForAgent('agent-a', 'team-a', 'rotation')
    const plan = getActivePlanForAgent('agent-a')
    expect(plan).toMatchObject({ id: 'team-a', label: 'Team team-a', planType: 'team', channelsAllowed: true, source: 'rotation', planUnresolved: false })
  })

  it('re-activating the same agent replaces (not duplicates) its binding', () => {
    seedPlans('p1', 'p2')
    activatePlanForAgent('agent-a', 'p1', 'manual')
    activatePlanForAgent('agent-a', 'p2', 'rotation')
    const plan = getActivePlanForAgent('agent-a')
    expect(plan?.id).toBe('p2')
    expect(plan?.source).toBe('rotation')
  })

  it('deactivatePlanForAgent removes the binding; a second call is a safe no-op', () => {
    seedPlans('p1')
    activatePlanForAgent('agent-a', 'p1', 'manual')
    deactivatePlanForAgent('agent-a')
    expect(getActivePlanForAgent('agent-a')).toBeNull()
    expect(() => deactivatePlanForAgent('agent-a')).not.toThrow()
  })

  it('activatePlanForAgent rejects an unknown plan id (this connection enforces PRAGMA foreign_keys)', () => {
    expect(() => activatePlanForAgent('agent-a', 'ghost-plan', 'manual')).toThrow()
  })

  // getActivePlanForAgent's planUnresolved fallback (LEFT JOIN, not INNER) is
  // deliberately untestable here: with `PRAGMA foreign_keys` enforced on this
  // connection, no SQL path through this module -- or even a raw DELETE --
  // can leave agent_active_plans pointing at a row claude_plans_registry no
  // longer has, so the branch has no reachable in-process repro. It stays as
  // defense-in-depth for a row from before this migration, or a foreign_keys
  // pragma that a future connection change turns off again.

  it('listActivePlansForAgents bulk-resolves several agents in one call, and skips agents with no binding', () => {
    seedPlans('p1')
    activatePlanForAgent('agent-a', 'p1', 'manual')
    activatePlanForAgent('agent-b', 'p1', 'rotation')
    const map = listActivePlansForAgents(['agent-a', 'agent-b', 'agent-c'])
    expect(map.has('agent-a')).toBe(true)
    expect(map.has('agent-b')).toBe(true)
    expect(map.has('agent-c')).toBe(false)
  })

  it('listActivePlansForAgents returns an empty map for an empty input without querying', () => {
    expect(listActivePlansForAgents([]).size).toBe(0)
  })

  it('sweepStaleActivePlans drops only bindings whose last_heartbeat exceeds the ttl', () => {
    seedPlans('p1')
    const nowSec = 1_000_000
    activatePlanForAgent('agent-a', 'p1', 'manual')
    // Backdate agent-a's heartbeat directly (activatePlanForAgent always stamps "now").
    getDb().prepare('UPDATE agent_active_plans SET last_heartbeat = ? WHERE agent_id = ?').run(nowSec - 200 * 60, 'agent-a')
    activatePlanForAgent('agent-b', 'p1', 'manual')
    getDb().prepare('UPDATE agent_active_plans SET last_heartbeat = ? WHERE agent_id = ?').run(nowSec - 10 * 60, 'agent-b')

    const swept = sweepStaleActivePlans(90, nowSec)
    expect(swept).toBe(1)
    expect(getActivePlanForAgent('agent-a')).toBeNull()
    expect(getActivePlanForAgent('agent-b')).not.toBeNull()
  })

  it('touchActivePlanHeartbeat refreshes last_heartbeat without touching source/activated_at', () => {
    seedPlans('p1')
    activatePlanForAgent('agent-a', 'p1', 'rotation')
    const before = getActivePlanForAgent('agent-a')!
    touchActivePlanHeartbeat('agent-a')
    const after = getActivePlanForAgent('agent-a')!
    expect(after.source).toBe('rotation')
    expect(after.activatedAt).toBe(before.activatedAt)
  })
})

describe('blackboard integration (design section 3A)', () => {
  it('upsertBlackboard status=done deactivates the agent plan binding', () => {
    seedPlans('p1')
    activatePlanForAgent('agent-a', 'p1', 'manual')
    upsertBlackboard('agent-a', { status: 'active', summary: 'working' })
    expect(getActivePlanForAgent('agent-a')).not.toBeNull() // still active, not done yet
    upsertBlackboard('agent-a', { status: 'done', summary: 'finished' })
    expect(getActivePlanForAgent('agent-a')).toBeNull()
  })

  it('a no-op done->done upsert does not error and stays deactivated', () => {
    seedPlans('p1')
    activatePlanForAgent('agent-a', 'p1', 'manual')
    upsertBlackboard('agent-a', { status: 'done', summary: 'finished' })
    expect(() => upsertBlackboard('agent-a', { status: 'done', summary: 'finished' })).not.toThrow()
    expect(getActivePlanForAgent('agent-a')).toBeNull()
  })

  it('markBlackboardStale deactivates the plan binding of every row it marks stale', () => {
    seedPlans('p1')
    activatePlanForAgent('agent-a', 'p1', 'manual')
    upsertBlackboard('agent-a', { status: 'active', summary: 'working' })
    const nowSec = Math.floor(Date.now() / 1000)
    markBlackboardStale({}, 60, 120, nowSec + 4000)
    expect(findBlackboardRowByAgent('agent-a')?.status).toBe('stale')
    expect(getActivePlanForAgent('agent-a')).toBeNull()
  })
})
