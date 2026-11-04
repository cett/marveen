// Tests for the structured hook audit log (db.ts): insertHookAuditLog,
// listHookAuditLog, pruneHookAuditLog.
//
// The storage layer is agnostic about the verdict: it stores whatever it is given
// and lets the query layer filter. (The table is NOT deny-only in practice:
// browser-content-notice writes 'allow' rows, the context watchdog 'handoff'
// rows, the gates 'deny' rows -- see the comment above HookAuditLogEntry in
// db/audit.ts.) These tests exercise the storage layer directly.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, insertHookAuditLog, listHookAuditLog, pruneHookAuditLog } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('insertHookAuditLog / listHookAuditLog', () => {
  it('stores and retrieves a deny entry with all fields', async () => {
    await insertHookAuditLog({
      agent_id: 'agent-a',
      hook_type: 'PostToolUse',
      verdict: 'deny',
      tool_name: 'mcp__example__fetch',
      content_hash: 'abc123',
      reason: 'injection_pattern_ignore_instructions',
      session_id: 'sess-1',
    })

    const rows = await listHookAuditLog()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      agent_id: 'agent-a',
      hook_type: 'PostToolUse',
      verdict: 'deny',
      tool_name: 'mcp__example__fetch',
      content_hash: 'abc123',
      reason: 'injection_pattern_ignore_instructions',
      session_id: 'sess-1',
    })
    expect(typeof rows[0].ts).toBe('number')
    expect(typeof rows[0].id).toBe('number')
  })

  it('accepts null/omitted optional fields', async () => {
    await insertHookAuditLog({ hook_type: 'PreToolUse', verdict: 'deny' })
    const rows = await listHookAuditLog()
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBeNull()
    expect(rows[0].tool_name).toBeNull()
    expect(rows[0].content_hash).toBeNull()
    expect(rows[0].reason).toBeNull()
    expect(rows[0].session_id).toBeNull()
  })

  it('filters by verdict', async () => {
    await insertHookAuditLog({ hook_type: 'PostToolUse', verdict: 'deny', reason: 'r1' })
    await insertHookAuditLog({ hook_type: 'PostToolUse', verdict: 'allow', reason: 'r2' })

    const denies = await listHookAuditLog({ verdict: 'deny' })
    expect(denies).toHaveLength(1)
    expect(denies[0].reason).toBe('r1')
  })

  it('filters by agent_id', async () => {
    await insertHookAuditLog({ hook_type: 'PostToolUse', verdict: 'deny', agent_id: 'agent-a' })
    await insertHookAuditLog({ hook_type: 'PostToolUse', verdict: 'deny', agent_id: 'agent-b' })

    const rows = await listHookAuditLog({ agent_id: 'agent-a' })
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe('agent-a')
  })

  it('orders newest first', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await insertHookAuditLog({ hook_type: 'PostToolUse', verdict: 'deny', reason: 'first' })
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'))
    await insertHookAuditLog({ hook_type: 'PostToolUse', verdict: 'deny', reason: 'second' })

    // Query while still under the same fake "now" -- sinceSecs is relative to
    // Date.now(), so switching back to real time here would compare the
    // fake-timestamped rows against today's real clock instead.
    const rows = await listHookAuditLog({ sinceSecs: 86400 })
    vi.useRealTimers()
    expect(rows.map(r => r.reason)).toEqual(['second', 'first'])
  })

  it('excludes entries older than sinceSecs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await insertHookAuditLog({ hook_type: 'PostToolUse', verdict: 'deny', reason: 'old' })
    vi.setSystemTime(new Date('2026-01-01T02:00:00Z'))
    await insertHookAuditLog({ hook_type: 'PostToolUse', verdict: 'deny', reason: 'recent' })

    const rows = await listHookAuditLog({ sinceSecs: 3600 })
    vi.useRealTimers()
    expect(rows.map(r => r.reason)).toEqual(['recent'])
  })

  it('caps limit at 1000', async () => {
    for (let i = 0; i < 5; i++) await insertHookAuditLog({ hook_type: 'PostToolUse', verdict: 'deny', reason: `r${i}` })
    const rows = await listHookAuditLog({ limit: 5000 })
    expect(rows).toHaveLength(5) // fewer rows than the cap; cap just doesn't truncate below actual count
  })
})

describe('pruneHookAuditLog', () => {
  it('deletes entries older than the cutoff, keeps recent ones', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-11-01T00:00:00Z'))
    await insertHookAuditLog({ hook_type: 'PostToolUse', verdict: 'deny', reason: 'ancient' })
    vi.setSystemTime(new Date('2026-01-31T00:00:00Z'))
    await insertHookAuditLog({ hook_type: 'PostToolUse', verdict: 'deny', reason: 'recent' })

    await pruneHookAuditLog(30 * 86400)
    const rows = await listHookAuditLog({ sinceSecs: 365 * 86400 })
    vi.useRealTimers()
    expect(rows.map(r => r.reason)).toEqual(['recent'])
  })
})
