import { describe, it, expect, beforeAll, vi } from 'vitest'
import { initDatabase, getDb, getAgentTier, getActiveBlackboardAgentIds, markBlackboardStale } from '../db.js'

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/bb-sweeper-test-' + process.pid,
  STORE_DIR: '/tmp/bb-sweeper-test-' + process.pid,
  OLLAMA_URL: 'http://localhost:11434',
  APP_TZ: 'Europe/Budapest',
  MAIN_AGENT_ID: 'agent-a',
  ALLOWED_CHAT_ID: '123456',
}))
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: vi.fn((key: string) => {
    const vals: Record<string, number> = {
      BB_STALE_ORCHESTRATOR_MIN: 120,
      BB_STALE_INTERACTIVE_MIN: 90,
      BB_STALE_SHORT_RUNNING_MIN: 15,
      BB_STALE_DEFAULT_MIN: 60,
      BB_STALE_ASSIGNED_MIN: 120,
    }
    return vals[key] ?? 60
  }),
}))

beforeAll(() => {
  initDatabase(':memory:')
})

// ---------------------------------------------------------------------------
// getAgentTier
// ---------------------------------------------------------------------------

describe('getAgentTier', () => {
  it('returns "default" for an agent not in the tier table', () => {
    expect(getAgentTier('agent-unknown')).toBe('default')
  })

  it('returns the stored tier when the agent is in the table', () => {
    getDb().prepare(
      "INSERT OR REPLACE INTO agent_blackboard_tier (agent_id, tier) VALUES (?, ?)",
    ).run('agent-orch', 'orchestrator')

    expect(getAgentTier('agent-orch')).toBe('orchestrator')
  })

  it('supports all four valid tiers', () => {
    const tiers = ['orchestrator', 'interactive', 'short-running', 'default'] as const
    for (const tier of tiers) {
      getDb().prepare(
        "INSERT OR REPLACE INTO agent_blackboard_tier (agent_id, tier) VALUES (?, ?)",
      ).run(`agent-${tier}`, tier)
      expect(getAgentTier(`agent-${tier}`)).toBe(tier)
    }
  })

  it('rejects invalid tier values via CHECK constraint', () => {
    expect(() => {
      getDb().prepare(
        "INSERT INTO agent_blackboard_tier (agent_id, tier) VALUES (?, ?)",
      ).run('agent-bad', 'superuser')
    }).toThrow()
  })
})

// ---------------------------------------------------------------------------
// getActiveBlackboardAgentIds
// ---------------------------------------------------------------------------

describe('getActiveBlackboardAgentIds', () => {
  it('returns only active rows, deduplicated', () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      "INSERT OR IGNORE INTO fleet_blackboard (id, agent_id, status, summary, updated_at) VALUES (?,?,?,?,?)",
    ).run('bb-active-1', 'agent-x', 'active', 'task x', now)
    db.prepare(
      "INSERT OR IGNORE INTO fleet_blackboard (id, agent_id, status, summary, updated_at) VALUES (?,?,?,?,?)",
    ).run('bb-done-1', 'agent-y', 'done', 'task y', now)

    const ids = getActiveBlackboardAgentIds()
    expect(ids).toContain('agent-x')
    expect(ids).not.toContain('agent-y')
  })

  it('also includes assigned rows, not just active', () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      "INSERT OR IGNORE INTO fleet_blackboard (id, agent_id, status, summary, updated_at) VALUES (?,?,?,?,?)",
    ).run('bb-assigned-1', 'agent-z', 'assigned', 'delegated task', now)

    const ids = getActiveBlackboardAgentIds()
    expect(ids).toContain('agent-z')
  })
})

// ---------------------------------------------------------------------------
// markBlackboardStale: tier-based thresholds (no agent names in assertions)
// ---------------------------------------------------------------------------

describe('markBlackboardStale with tier thresholds', () => {
  const NOW = Math.floor(Date.now() / 1000)

  it('marks a row stale when elapsed time exceeds its tier threshold', () => {
    const db = getDb()
    // orchestrator tier: 120 min = 7200 sec; 121 min elapsed -> stale
    db.prepare(
      "INSERT OR REPLACE INTO agent_blackboard_tier (agent_id, tier) VALUES (?,?)",
    ).run('agent-orch2', 'orchestrator')
    db.prepare(
      "INSERT OR IGNORE INTO fleet_blackboard (id, agent_id, status, summary, updated_at) VALUES (?,?,?,?,?)",
    ).run('bb-orch2', 'agent-orch2', 'active', 'long task', NOW - 121 * 60)

    const marked = markBlackboardStale({ 'agent-orch2': 120 * 60 }, 60 * 60, 120 * 60, NOW)
    expect(marked).toBeGreaterThanOrEqual(1)

    const row = db.prepare("SELECT status FROM fleet_blackboard WHERE id = ?").get('bb-orch2') as { status: string }
    expect(row.status).toBe('stale')
  })

  it('does not mark a row stale when elapsed time is below the threshold', () => {
    const db = getDb()
    // short-running tier: 15 min = 900 sec; only 10 min elapsed -> not stale
    db.prepare(
      "INSERT OR REPLACE INTO agent_blackboard_tier (agent_id, tier) VALUES (?,?)",
    ).run('agent-short2', 'short-running')
    db.prepare(
      "INSERT OR IGNORE INTO fleet_blackboard (id, agent_id, status, summary, updated_at) VALUES (?,?,?,?,?)",
    ).run('bb-short2', 'agent-short2', 'active', 'quick task', NOW - 10 * 60)

    const marked = markBlackboardStale({ 'agent-short2': 15 * 60 }, 60 * 60, 120 * 60, NOW)
    expect(marked).toBe(0)

    const row = db.prepare("SELECT status FROM fleet_blackboard WHERE id = ?").get('bb-short2') as { status: string }
    expect(row.status).toBe('active')
  })

  it('applies default threshold to agents not in thresholdsByAgent map', () => {
    const db = getDb()
    // No tier entry, falls through to defaultThresholdSec=60*60; 61 min elapsed -> stale
    db.prepare(
      "INSERT OR IGNORE INTO fleet_blackboard (id, agent_id, status, summary, updated_at) VALUES (?,?,?,?,?)",
    ).run('bb-defagent', 'agent-nomap', 'active', 'unknown task', NOW - 61 * 60)

    const marked = markBlackboardStale({}, 60 * 60, 120 * 60, NOW)
    expect(marked).toBeGreaterThanOrEqual(1)

    const row = db.prepare("SELECT status FROM fleet_blackboard WHERE id = ?").get('bb-defagent') as { status: string }
    expect(row.status).toBe('stale')
  })
})

// ---------------------------------------------------------------------------
// markBlackboardStale: 'assigned' rows use the flat assigned threshold,
// never the tier-based active thresholds
// ---------------------------------------------------------------------------

describe('markBlackboardStale with assigned rows', () => {
  const NOW = Math.floor(Date.now() / 1000)

  it('marks an assigned row stale using assignedThresholdSec, ignoring the tier map', () => {
    const db = getDb()
    // Give the agent an orchestrator tier (120 min) so we can prove the
    // assigned threshold (here set to a short 20 min) wins for this row,
    // not the tier-based thresholdsByAgent entry.
    db.prepare(
      "INSERT OR REPLACE INTO agent_blackboard_tier (agent_id, tier) VALUES (?,?)",
    ).run('agent-assigned1', 'orchestrator')
    db.prepare(
      "INSERT OR IGNORE INTO fleet_blackboard (id, agent_id, status, summary, updated_at) VALUES (?,?,?,?,?)",
    ).run('bb-assigned1', 'agent-assigned1', 'assigned', 'delegated, not picked up', NOW - 21 * 60)

    const marked = markBlackboardStale({ 'agent-assigned1': 120 * 60 }, 60 * 60, 20 * 60, NOW)
    expect(marked).toBeGreaterThanOrEqual(1)

    const row = db.prepare("SELECT status FROM fleet_blackboard WHERE id = ?").get('bb-assigned1') as { status: string }
    expect(row.status).toBe('stale')
  })

  it('does not mark an assigned row stale when below assignedThresholdSec', () => {
    const db = getDb()
    db.prepare(
      "INSERT OR IGNORE INTO fleet_blackboard (id, agent_id, status, summary, updated_at) VALUES (?,?,?,?,?)",
    ).run('bb-assigned2', 'agent-assigned2', 'assigned', 'delegated, fresh', NOW - 5 * 60)

    const marked = markBlackboardStale({}, 60 * 60, 20 * 60, NOW)
    expect(marked).toBe(0)

    const row = db.prepare("SELECT status FROM fleet_blackboard WHERE id = ?").get('bb-assigned2') as { status: string }
    expect(row.status).toBe('assigned')
  })

  it('never marks an assigned row as done -- only stale', () => {
    const db = getDb()
    db.prepare(
      "INSERT OR IGNORE INTO fleet_blackboard (id, agent_id, status, summary, updated_at) VALUES (?,?,?,?,?)",
    ).run('bb-assigned3', 'agent-assigned3', 'assigned', 'delegated, stuck', NOW - 200 * 60)

    markBlackboardStale({}, 60 * 60, 20 * 60, NOW)

    const row = db.prepare("SELECT status FROM fleet_blackboard WHERE id = ?").get('bb-assigned3') as { status: string }
    expect(row.status).toBe('stale')
    expect(row.status).not.toBe('done')
  })
})
