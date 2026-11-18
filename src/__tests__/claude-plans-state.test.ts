// PR2b: readClaudePlansState(), the reader for store/claude-plans-state.json.
// PR2c: writeClaudePlansState() + the pure recordObservation()/applyRotation()
// transitions, finalizing the schema per design decision #1 (2026-09-12):
// activePlanId -> activePlanByAgent, keyed by agent id.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-claude-plans-state-test-'))
const storeDir = join(tmpRoot, 'store')
mkdirSync(storeDir, { recursive: true })

vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot, STORE_DIR: storeDir }))

const {
  readClaudePlansState,
  writeClaudePlansState,
  recordObservation,
  applyRotation,
  patchMonitorState,
  appendRotationLog,
  ROTATION_LOG_MAX,
  CLAUDE_PLANS_STATE_PATH,
} = await import('../web/claude-plans-state.js')

describe('readClaudePlansState', () => {
  it('returns an empty state when the file does not exist', () => {
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
  })

  it('returns an empty state on unparseable JSON', () => {
    writeFileSync(CLAUDE_PLANS_STATE_PATH, 'not json')
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
  })

  it('returns an empty state when the JSON is not an object (array, null, primitive)', () => {
    writeFileSync(CLAUDE_PLANS_STATE_PATH, '[]')
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
    writeFileSync(CLAUDE_PLANS_STATE_PATH, 'null')
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
    writeFileSync(CLAUDE_PLANS_STATE_PATH, '"pro"')
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
  })

  it('reads a well-formed snapshot back verbatim', () => {
    const snapshot = {
      activePlanByAgent: { marveen: 'pro', devy: 'team' },
      plans: {
        pro: { observedAt: 1_700_000_000_000, source: 'authoritative', windows: { five_hour: { usedPercent: 42, resetsAt: 1_700_010_000 } } },
        team: { observedAt: 1_699_000_000_000, source: 'authoritative_cached', windows: {} },
      },
    }
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify(snapshot))
    expect(readClaudePlansState()).toEqual(snapshot)
  })

  it('defaults a missing/bad-typed activePlanByAgent or plans key rather than throwing', () => {
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({ activePlanByAgent: 42, plans: 'nope' }))
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })

    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({}))
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
  })

  it('drops activePlanByAgent when any value is not a string', () => {
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({ activePlanByAgent: { marveen: 42 }, plans: {} }))
    expect(readClaudePlansState()).toEqual({ activePlanByAgent: {}, plans: {} })
  })
})

describe('writeClaudePlansState', () => {
  it('creates store/ and writes the file atomically (readable back)', () => {
    const state = { activePlanByAgent: { marveen: 'pro' }, plans: {} }
    writeClaudePlansState(state)
    expect(JSON.parse(readFileSync(CLAUDE_PLANS_STATE_PATH, 'utf8'))).toEqual(state)
    expect(readClaudePlansState()).toEqual(state)
  })

  it('leaves no .tmp file behind after a successful write', () => {
    writeClaudePlansState({ activePlanByAgent: {}, plans: {} })
    const leftovers = readdirSync(join(tmpRoot, 'store')).filter((f: string) => f.includes('.tmp'))
    expect(leftovers).toEqual([])
  })
})

describe('recordObservation', () => {
  it('sets the agent active on the plan and records its window snapshot', () => {
    const before = { activePlanByAgent: {}, plans: {} }
    const observed = { observedAt: 123, source: 'authoritative', windows: { five_hour: { usedPercent: 10, resetsAt: 456 } } }
    const after = recordObservation(before, 'marveen', 'pro', observed)
    expect(after).toEqual({ activePlanByAgent: { marveen: 'pro' }, plans: { pro: observed } })
  })

  it('does not mutate the input state (pure)', () => {
    const before = { activePlanByAgent: { marveen: 'pro' }, plans: { pro: { observedAt: 1, source: 'x', windows: {} } } }
    const snapshot = JSON.parse(JSON.stringify(before))
    recordObservation(before, 'marveen', 'pro', { observedAt: 2, source: 'y', windows: {} })
    expect(before).toEqual(snapshot)
  })

  it('leaves other agents and other plans untouched', () => {
    const before = {
      activePlanByAgent: { marveen: 'pro', devy: 'team' },
      plans: { team: { observedAt: 1, source: 'authoritative', windows: {} } },
    }
    const after = recordObservation(before, 'marveen', 'pro', { observedAt: 2, source: 'authoritative', windows: {} })
    expect(after.activePlanByAgent.devy).toBe('team')
    expect(after.plans.team).toEqual(before.plans.team)
  })
})

describe('applyRotation', () => {
  it('points the agent at the target plan, leaving plans untouched', () => {
    const before = { activePlanByAgent: { marveen: 'pro' }, plans: { pro: { observedAt: 1, source: 'x', windows: {} } } }
    const after = applyRotation(before, 'marveen', 'team')
    expect(after.activePlanByAgent).toEqual({ marveen: 'team' })
    expect(after.plans).toEqual(before.plans)
  })

  it('adds a fresh entry for an agent with no prior active plan (the bootstrap case)', () => {
    const before = { activePlanByAgent: {}, plans: {} }
    const after = applyRotation(before, 'marveen', 'pro')
    expect(after.activePlanByAgent).toEqual({ marveen: 'pro' })
  })

  it('does not mutate the input state (pure)', () => {
    const before = { activePlanByAgent: { marveen: 'pro' }, plans: {} }
    const snapshot = JSON.parse(JSON.stringify(before))
    applyRotation(before, 'marveen', 'team')
    expect(before).toEqual(snapshot)
  })
})

// ---------------------------------------------------------------------------
// Backend monitor block (c3b): optional, backward compatible, field by field.
// ---------------------------------------------------------------------------
const goodEntry = {
  ts: 1_700_000_000_000,
  agentId: 'agent-a',
  from: 'plan-a',
  to: 'plan-b',
  trigger: 'soft',
  mode: 'act',
  result: 'rotated',
}

describe('monitor block: reading', () => {
  it('a file without a monitor block reads back with NO monitor key (old files unchanged)', () => {
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({ activePlanByAgent: { 'agent-a': 'plan-a' }, plans: {} }))
    const s = readClaudePlansState()
    expect(s).toEqual({ activePlanByAgent: { 'agent-a': 'plan-a' }, plans: {} })
    expect('monitor' in s).toBe(false)
  })

  it('reads a full monitor block back', () => {
    const monitor = {
      lastTickAt: 1_700_000_100_000,
      consecutiveUnknown: 2,
      health: { 'plan-a': { observedAt: 1_700_000_050_000, status: 'pressure', window: 'five_hour', usedPercent: 93 } },
      rotationLog: [goodEntry],
      breaker: { tripped: true, since: 1_700_000_090_000 },
    }
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({ activePlanByAgent: {}, plans: {}, monitor }))
    expect(readClaudePlansState().monitor).toEqual(monitor)
  })

  it('drops a damaged field but keeps the others (the breaker flag survives a bad log)', () => {
    writeFileSync(
      CLAUDE_PLANS_STATE_PATH,
      JSON.stringify({
        activePlanByAgent: {},
        plans: {},
        monitor: {
          lastTickAt: 'yesterday',
          consecutiveUnknown: -3,
          health: 'nope',
          rotationLog: 'nope',
          breaker: { tripped: true, since: 1_700_000_090_000 },
        },
      }),
    )
    expect(readClaudePlansState().monitor).toEqual({ breaker: { tripped: true, since: 1_700_000_090_000 } })
  })

  it('a breaker flag whose tripped is not a boolean is dropped (a string must not read as tripped)', () => {
    writeFileSync(
      CLAUDE_PLANS_STATE_PATH,
      JSON.stringify({ activePlanByAgent: {}, plans: {}, monitor: { lastTickAt: 5, breaker: { tripped: 'yes', since: 1 } } }),
    )
    expect(readClaudePlansState().monitor).toEqual({ lastTickAt: 5 })
  })

  it('drops invalid log entries one by one and keeps the valid ones', () => {
    writeFileSync(
      CLAUDE_PLANS_STATE_PATH,
      JSON.stringify({
        activePlanByAgent: {},
        plans: {},
        monitor: {
          rotationLog: [
            goodEntry,
            { ...goodEntry, trigger: 'sideways' },
            { ...goodEntry, result: 'exploded' },
            { ...goodEntry, mode: 'maybe' },
            { ...goodEntry, ts: 'now' },
            { ...goodEntry, from: 7 },
            null,
            { ...goodEntry, from: null, ts: 1_700_000_000_001 },
          ],
        },
      }),
    )
    const log = readClaudePlansState().monitor?.rotationLog
    expect(log?.map((e) => e.ts)).toEqual([1_700_000_000_000, 1_700_000_000_001])
  })

  it('an unknown health status is dropped, a known one kept', () => {
    writeFileSync(
      CLAUDE_PLANS_STATE_PATH,
      JSON.stringify({
        activePlanByAgent: {},
        plans: {},
        monitor: { health: { 'plan-a': { observedAt: 1, status: 'bogus' }, 'plan-b': { observedAt: 2, status: 'ok' } } },
      }),
    )
    expect(readClaudePlansState().monitor?.health).toEqual({ 'plan-b': { observedAt: 2, status: 'ok' } })
  })

  it('caps an oversized log on read to the newest ROTATION_LOG_MAX', () => {
    const many = Array.from({ length: ROTATION_LOG_MAX + 10 }, (_, i) => ({ ...goodEntry, ts: 1_700_000_000_000 + i }))
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({ activePlanByAgent: {}, plans: {}, monitor: { rotationLog: many } }))
    const log = readClaudePlansState().monitor!.rotationLog!
    expect(log).toHaveLength(ROTATION_LOG_MAX)
    expect(log[log.length - 1]!.ts).toBe(1_700_000_000_000 + ROTATION_LOG_MAX + 9)
  })

  it('a monitor block that is not an object reads as absent', () => {
    writeFileSync(CLAUDE_PLANS_STATE_PATH, JSON.stringify({ activePlanByAgent: {}, plans: {}, monitor: [] }))
    expect('monitor' in readClaudePlansState()).toBe(false)
  })
})

describe('monitor block: transitions', () => {
  const base = {
    activePlanByAgent: { 'agent-a': 'plan-a' },
    plans: {},
    monitor: { lastTickAt: 5, breaker: { tripped: true, since: 4 } },
  }

  it('recordObservation (the legacy heartbeat) keeps the monitor block', () => {
    const next = recordObservation(base, 'agent-a', 'plan-a', { observedAt: 1, source: 's', windows: {} })
    expect(next.monitor).toEqual(base.monitor)
  })

  it('applyRotation keeps the monitor block', () => {
    expect(applyRotation(base, 'agent-a', 'plan-b').monitor).toEqual(base.monitor)
  })

  it('patchMonitorState merges, leaves absent keys alone and does not mutate the input', () => {
    const frozen = JSON.parse(JSON.stringify(base))
    const next = patchMonitorState(base, { lastTickAt: 9 })
    expect(next.monitor).toEqual({ lastTickAt: 9, breaker: { tripped: true, since: 4 } })
    expect(base).toEqual(frozen)
  })

  it('appendRotationLog appends newest last and caps at ROTATION_LOG_MAX', () => {
    let s: ReturnType<typeof appendRotationLog> = { activePlanByAgent: {}, plans: {} }
    for (let i = 0; i < ROTATION_LOG_MAX + 5; i++) {
      s = appendRotationLog(s, { ...goodEntry, ts: i } as never)
    }
    const log = s.monitor!.rotationLog!
    expect(log).toHaveLength(ROTATION_LOG_MAX)
    expect(log[0]!.ts).toBe(5)
    expect(log[log.length - 1]!.ts).toBe(ROTATION_LOG_MAX + 4)
  })

  it('a written monitor block round-trips through the file', () => {
    const s = appendRotationLog({ activePlanByAgent: {}, plans: {} }, goodEntry as never)
    writeClaudePlansState(s)
    expect(readClaudePlansState()).toEqual(s)
  })
})
