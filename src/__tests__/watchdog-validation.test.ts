import { describe, it, expect } from 'vitest'
import { computeWatchdogCycles, DEFAULT_COOLDOWN_SECS, DEFAULT_VALIDATION_TARGET } from '../watchdog-validation.js'
import type { HookAuditLogEntry } from '../db.js'

const AGENT = 'agent-main'

let nextId = 1
function row(overrides: Partial<HookAuditLogEntry>): HookAuditLogEntry {
  return {
    id: nextId++,
    ts: 0,
    agent_id: AGENT,
    hook_type: 'PostToolUse',
    verdict: 'handoff',
    tool_name: null,
    content_hash: null,
    reason: null,
    session_id: null,
    ...overrides,
  }
}

function handoffRow(ts: number, pct: number, interlock: 'yes' | 'no', overrides: Partial<HookAuditLogEntry> = {}) {
  return row({ ts, reason: `ctx=${pct}%;interlock=${interlock}`, ...overrides })
}

function compactRow(ts: number, overrides: Partial<HookAuditLogEntry> = {}) {
  return row({ ts, hook_type: 'PreCompact', verdict: 'allow', reason: 'pct=75%', ...overrides })
}

describe('computeWatchdogCycles', () => {
  it('counts a handoff with a landed interlock and no follow-up compact as success', () => {
    const now = 10_000
    const rows = [handoffRow(now - DEFAULT_COOLDOWN_SECS - 1, 62, 'yes')]
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now })
    expect(result.cycles).toHaveLength(1)
    expect(result.cycles[0].status).toBe('success')
    expect(result.successful).toBe(1)
  })

  it('marks a handoff as pending before the cooldown window elapses', () => {
    const now = 10_000
    const rows = [handoffRow(now - 100, 62, 'yes')] // well inside the 45-min window
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now })
    expect(result.cycles[0].status).toBe('pending')
    expect(result.successful).toBe(0)
  })

  it('marks a handoff as interlock_failed when the reason says interlock=no', () => {
    const now = 10_000
    const rows = [handoffRow(now - DEFAULT_COOLDOWN_SECS - 1, 62, 'no')]
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now })
    expect(result.cycles[0].status).toBe('interlock_failed')
    expect(result.successful).toBe(0)
  })

  it('detects a double-compact: a PreCompact/allow row inside the cooldown window after the handoff', () => {
    const handoffTs = 10_000
    const now = handoffTs + DEFAULT_COOLDOWN_SECS + 10
    const rows = [
      handoffRow(handoffTs, 62, 'yes'),
      compactRow(handoffTs + 300), // fired 5 min after the handoff, inside the 45-min window
    ]
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now })
    expect(result.cycles[0].status).toBe('double_compact')
    expect(result.successful).toBe(0)
  })

  it('a compact BEFORE the handoff does not count as a double-compact', () => {
    const handoffTs = 10_000
    const now = handoffTs + DEFAULT_COOLDOWN_SECS + 10
    const rows = [
      compactRow(handoffTs - 60), // pre-existing compact, unrelated to this handoff
      handoffRow(handoffTs, 62, 'yes'),
    ]
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now })
    expect(result.cycles[0].status).toBe('success')
  })

  it('a compact just OUTSIDE the cooldown window does not count as a double-compact', () => {
    const handoffTs = 10_000
    const now = handoffTs + DEFAULT_COOLDOWN_SECS + 3600
    const rows = [
      handoffRow(handoffTs, 62, 'yes'),
      compactRow(handoffTs + DEFAULT_COOLDOWN_SECS + 1), // 1s past the window
    ]
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now })
    expect(result.cycles[0].status).toBe('success')
  })

  it('a compact exactly at the window boundary DOES count as a double-compact (inclusive end)', () => {
    const handoffTs = 10_000
    const now = handoffTs + DEFAULT_COOLDOWN_SECS + 3600
    const rows = [
      handoffRow(handoffTs, 62, 'yes'),
      compactRow(handoffTs + DEFAULT_COOLDOWN_SECS),
    ]
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now })
    expect(result.cycles[0].status).toBe('double_compact')
  })

  it('ignores rows for a different agent', () => {
    const now = 10_000
    const rows = [handoffRow(now - DEFAULT_COOLDOWN_SECS - 1, 62, 'yes', { agent_id: 'someone-else' })]
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now })
    expect(result.cycles).toHaveLength(0)
    expect(result.totalHandoffs).toBe(0)
  })

  it('ignores unrelated hook_audit_log rows (e.g. the injection gate deny verdict)', () => {
    const now = 10_000
    const rows = [
      handoffRow(now - DEFAULT_COOLDOWN_SECS - 1, 62, 'yes'),
      row({ ts: now - 500, hook_type: 'PostToolUse', verdict: 'deny', reason: 'injection_pattern_A3' }),
    ]
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now })
    expect(result.cycles).toHaveLength(1)
    expect(result.successful).toBe(1)
  })

  it('treats an unparsable reason string as interlock_failed (fail conservative, not success)', () => {
    const now = 10_000
    const rows = [row({ ts: now - DEFAULT_COOLDOWN_SECS - 1, hook_type: 'PostToolUse', verdict: 'handoff', reason: 'garbled' })]
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now })
    expect(result.cycles[0].status).toBe('interlock_failed')
    expect(result.cycles[0].pct).toBeNull()
  })

  it('ready flips true once successful reaches the target', () => {
    const now = 10_000
    const rows = Array.from({ length: 10 }, (_, i) => handoffRow(now - DEFAULT_COOLDOWN_SECS - 1 - i * 10, 62, 'yes'))
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now })
    expect(result.successful).toBe(10)
    expect(result.target).toBe(DEFAULT_VALIDATION_TARGET)
    expect(result.ready).toBe(true)
  })

  it('respects a custom target', () => {
    const now = 10_000
    const rows = [handoffRow(now - DEFAULT_COOLDOWN_SECS - 1, 62, 'yes')]
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now, target: 1 })
    expect(result.ready).toBe(true)
  })

  it('parses the pct out of the reason string', () => {
    const now = 10_000
    const rows = [handoffRow(now - DEFAULT_COOLDOWN_SECS - 1, 73, 'yes')]
    const result = computeWatchdogCycles(rows, { agentId: AGENT, nowSecs: now })
    expect(result.cycles[0].pct).toBeCloseTo(0.73)
  })

  it('returns an empty, not-ready result for no rows at all', () => {
    const result = computeWatchdogCycles([], { agentId: AGENT, nowSecs: 10_000 })
    expect(result.successful).toBe(0)
    expect(result.totalHandoffs).toBe(0)
    expect(result.ready).toBe(false)
  })
})
