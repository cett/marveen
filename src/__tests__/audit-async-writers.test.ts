// The audit / telemetry writers on the async facade (1017 W3-5). The sync driver finished every statement
// before the next line ran, so a dropped `await` could not show in a test that read the row back at once.
// These tests slow the driver down (the row exists only after the write has really been awaited) or make it
// fail (the failure must reach the caller, an audit row must not vanish silently), and they pin the two
// behaviour changes of the conversion: the skill-usage dedup is one statement, and the RBAC decision row is
// written before a refusal goes out.
//
// Privacy: neutral fixtures only (agent-a, user-a, tenant-a).
import { afterEach, describe, expect, it, vi } from 'vitest'
import type http from 'node:http'
import { db, dbx } from '../db.js'
import {
  deleteRbacShadowRowsBefore, insertHookAuditLog, insertRbacShadowRow, logConfigChange, logSkillUsage,
  logStoreFileEvent, pruneAuditLogs, pruneHookAuditLog, pruneOtelSpans, pruneTokenUsage,
  writeAdminAuditLog, writeAgentAuditLog,
} from '../db/audit.js'
import { logger } from '../logger.js'
import { recordRbacDecision, resetPruneThrottleForTests, runRbacGate } from '../web/rbac-shadow-log.js'
import type { AuthResult } from '../web/auth-gate.js'
import { useTestDb } from './helpers/with-test-db.js'

useTestDb()

afterEach(() => {
  vi.restoreAllMocks()
  resetPruneThrottleForTests()
})

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n

/** The driver answers late: a row is there only when the caller really awaited the statement. */
function slowDriver() {
  const real = dbx.run.bind(dbx)
  return vi.spyOn(dbx, 'run').mockImplementation(async (sql: string, ...params: unknown[]) => {
    await sleep(15)
    return real(sql, ...params)
  })
}

function failingDriver() {
  return vi.spyOn(dbx, 'run').mockRejectedValue(new Error('driver down'))
}

const NOW = Math.floor(Date.now() / 1000)
const OLD = NOW - 400 * 86400

const WRITERS: Array<{ name: string; call: () => Promise<unknown>; countSql: string }> = [
  {
    name: 'writeAgentAuditLog',
    call: () => writeAgentAuditLog({ agent_id: 'agent-a', entity: 'agent', action: 'create', entity_id: 'x' }),
    countSql: "SELECT COUNT(*) AS n FROM agent_audit_log WHERE action = 'create' AND entity = 'agent'",
  },
  {
    name: 'writeAdminAuditLog',
    call: () => writeAdminAuditLog('user-a', 'security.test', 'target-a', { k: 1 }),
    countSql: "SELECT COUNT(*) AS n FROM agent_audit_log WHERE entity = 'admin' AND action = 'security.test'",
  },
  {
    name: 'logConfigChange',
    call: () => logConfigChange('some.key', 'old', 'new', 'actor-a'),
    countSql: "SELECT COUNT(*) AS n FROM config_change_log WHERE key = 'some.key'",
  },
  {
    name: 'logStoreFileEvent',
    call: () => logStoreFileEvent('dir/file.md', 'create', 0, 12, 'agent-a', 'tenant-a'),
    countSql: "SELECT COUNT(*) AS n FROM store_file_audit WHERE rel_path = 'dir/file.md'",
  },
  {
    name: 'insertHookAuditLog',
    call: () => insertHookAuditLog({ agent_id: 'agent-a', hook_type: 'PreToolUse', verdict: 'allow', tool_name: 'Bash' }),
    countSql: "SELECT COUNT(*) AS n FROM hook_audit_log WHERE tool_name = 'Bash'",
  },
  {
    name: 'logSkillUsage',
    call: () => logSkillUsage('agent-a', 'skill-a', 'tool_call', 'session-a'),
    countSql: "SELECT COUNT(*) AS n FROM skill_usage WHERE skill_name = 'skill-a'",
  },
  {
    name: 'insertRbacShadowRow',
    call: () => insertRbacShadowRow({
      ts: NOW, tenantId: 'tenant-a', principalKind: 'session', principal: 'user-a', role: 'viewer', method: 'POST',
      route: '/api/x', permission: 'kanban:write', decision: 'would-deny', reason: 'r',
    }),
    countSql: "SELECT COUNT(*) AS n FROM rbac_shadow_log WHERE route = '/api/x'",
  },
]

describe('audit writers: the row exists once the call resolved (slow driver)', () => {
  it.each(WRITERS)('$name', async ({ call, countSql }) => {
    const before = count(countSql)
    slowDriver()
    await call()
    expect(count(countSql) - before).toBe(1)
  })
})

describe('audit writers: a driver failure reaches the caller (an audit row must not vanish silently)', () => {
  it.each(WRITERS)('$name', async ({ call, countSql }) => {
    const before = count(countSql)
    failingDriver()
    await expect(call()).rejects.toThrow('driver down')
    expect(count(countSql)).toBe(before)
  })
})

describe('audit prunes: every statement is awaited (slow driver)', () => {
  it('pruneAuditLogs clears the four audit tables, the hook table and the spans', async () => {
    db.prepare("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ('k', 'a', 'b', 'u', ?)").run(OLD)
    db.prepare("INSERT INTO idea_status_log (idea_id, from_status, to_status, actor, created_at) VALUES ('i', NULL, 'new', 'u', ?)").run(OLD)
    db.prepare("INSERT INTO store_file_audit (rel_path, event_type, is_sensitive, created_at) VALUES ('p', 'create', 0, ?)").run(OLD)
    db.prepare("INSERT INTO agent_audit_log (agent_id, entity, action, created_at) VALUES ('a', 'agent', 'create', ?)").run(OLD)
    db.prepare("INSERT INTO hook_audit_log (ts, hook_type, verdict) VALUES (?, 'Stop', 'allow')").run(OLD)
    db.prepare("INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms, end_ms, status) VALUES ('t', 's', 'a', 'tool.x', ?, ?, 'ok')").run(OLD * 1000, OLD * 1000 + 5)
    slowDriver()
    await pruneAuditLogs()
    for (const table of ['config_change_log', 'idea_status_log', 'store_file_audit', 'agent_audit_log', 'hook_audit_log', 'otel_spans']) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table}`), table).toBe(0)
    }
  })

  it('pruneHookAuditLog and pruneOtelSpans', async () => {
    db.prepare("INSERT INTO hook_audit_log (ts, hook_type, verdict) VALUES (?, 'Stop', 'allow')").run(OLD)
    db.prepare("INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms, end_ms, status) VALUES ('t', 's', 'a', 'tool.x', ?, ?, 'ok')").run(OLD * 1000, OLD * 1000 + 5)
    slowDriver()
    await pruneHookAuditLog()
    await pruneOtelSpans()
    expect(count('SELECT COUNT(*) AS n FROM hook_audit_log')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM otel_spans')).toBe(0)
  })

  it('pruneTokenUsage aggregates before it deletes, and every step is awaited', async () => {
    const cols = (db.prepare('PRAGMA table_info(token_usage)').all() as Array<{ name: string }>).map(c => c.name)
    expect(cols).toContain('timestamp')
    db.prepare(
      "INSERT INTO token_usage (agent, session_id, model, input_tokens, output_tokens, timestamp) VALUES ('agent-a', 'session-a', 'm', 10, 5, ?)",
    ).run(NOW - 200 * 86400)
    slowDriver()
    const res = await pruneTokenUsage()
    expect(res.rawDeleted).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM token_usage')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM token_usage_daily')).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM token_usage_monthly')).toBe(1)
  })

  it('deleteRbacShadowRowsBefore returns the number of removed rows', async () => {
    for (const ts of [OLD, OLD, NOW]) {
      db.prepare(
        "INSERT INTO rbac_shadow_log (ts, tenant_id, principal_kind, principal, role, method, route, permission, decision, reason) VALUES (?, 'tenant-a', 'session', 'user-a', 'viewer', 'GET', '/r', 'p', 'permitted', '')",
      ).run(ts)
    }
    slowDriver()
    expect(await deleteRbacShadowRowsBefore(NOW - 86400)).toBe(2)
    expect(count('SELECT COUNT(*) AS n FROM rbac_shadow_log')).toBe(1)
  })
})

describe('logSkillUsage: the dedup and the insert are one statement', () => {
  it('five concurrent calls for one invocation write one row and exactly one answers true', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => logSkillUsage('agent-a', 'skill-a', 'tool_call', 'session-a')))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(count("SELECT COUNT(*) AS n FROM skill_usage WHERE skill_name = 'skill-a'")).toBe(1)
  })

  it('the same holds with a slow driver, and with no session (session_id IS NULL matches NULL)', async () => {
    slowDriver()
    const results = await Promise.all([
      logSkillUsage('agent-a', 'skill-b', 'skill_read', null),
      logSkillUsage('agent-a', 'skill-b', 'skill_read', null),
      logSkillUsage('agent-a', 'skill-b', 'skill_read', null),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(count("SELECT COUNT(*) AS n FROM skill_usage WHERE skill_name = 'skill-b'")).toBe(1)
  })

  it('a different session, source or skill is a different use', async () => {
    const results = await Promise.all([
      logSkillUsage('agent-a', 'skill-c', 'tool_call', 'session-a'),
      logSkillUsage('agent-a', 'skill-c', 'tool_call', 'session-b'),
      logSkillUsage('agent-a', 'skill-c', 'tool_call', 'session-a', 'read_tool'),
      logSkillUsage('agent-a', 'skill-d', 'tool_call', 'session-a'),
      logSkillUsage('agent-b', 'skill-c', 'tool_call', 'session-a'),
    ])
    expect(results).toEqual([true, true, true, true, true])
  })

  it('a row older than the window does not swallow a new one; a source-less old row dedups under its derived source', async () => {
    db.prepare("INSERT INTO skill_usage (agent_id, skill_name, trigger_type, session_id, created_at) VALUES ('agent-a', 'skill-e', 'tool_call', 'session-a', ?)").run(NOW - 3600)
    expect(await logSkillUsage('agent-a', 'skill-e', 'tool_call', 'session-a')).toBe(true)
    db.prepare("INSERT INTO skill_usage (agent_id, skill_name, trigger_type, session_id, created_at) VALUES ('agent-a', 'skill-f', 'tool_call', 'session-a', ?)").run(NOW)
    expect(await logSkillUsage('agent-a', 'skill-f', 'tool_call', 'session-a', 'skill_tool')).toBe(false)
    expect(await logSkillUsage('agent-a', 'skill-f', 'tool_call', 'session-a', 'read_tool')).toBe(true)
  })

  it('stamps the resolved tenant on the row', async () => {
    await logSkillUsage('agent-a', 'skill-g', 'tool_call', 'session-a')
    const row = db.prepare("SELECT tenant_id FROM skill_usage WHERE skill_name = 'skill-g'").get() as { tenant_id: string | null }
    expect(row.tenant_id).toBe('default')
  })
})

describe('runRbacGate: the decision row is written before a refusal goes out, and a write fault changes nothing', () => {
  const viewer: AuthResult = { kind: 'session', user: 'user-a', role: 'viewer', tenantId: 'tenant-a' }

  function fakeRes(events: string[]) {
    return {
      writeHead: vi.fn(() => { events.push('response') }),
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as http.ServerResponse
  }

  it('enforce: the denied row is committed before the 403 is written', async () => {
    const events: string[] = []
    const real = dbx.run.bind(dbx)
    vi.spyOn(dbx, 'run').mockImplementation(async (sql: string, ...params: unknown[]) => {
      await sleep(15)
      const out = await real(sql, ...params)
      if (sql.startsWith('INSERT INTO rbac_shadow_log')) events.push('row')
      return out
    })
    expect(await runRbacGate(viewer, 'POST', '/api/kanban/cards', fakeRes(events), 'enforce')).toBe(false)
    expect(events).toEqual(['row', 'response'])
  })

  it('shadow: the would-deny row exists when the gate resolves, and the request proceeds', async () => {
    slowDriver()
    expect(await runRbacGate(viewer, 'POST', '/api/kanban/cards', fakeRes([]), 'shadow')).toBe(true)
    expect(count("SELECT COUNT(*) AS n FROM rbac_shadow_log WHERE decision = 'would-deny'")).toBe(1)
  })

  it('a permitted non-admin request: the row exists when the gate resolves', async () => {
    slowDriver()
    expect(await runRbacGate(viewer, 'GET', '/api/memories', fakeRes([]), 'enforce')).toBe(true)
    expect(count("SELECT COUNT(*) AS n FROM rbac_shadow_log WHERE decision = 'permitted'")).toBe(1)
  })

  it.each(['enforce', 'shadow'] as const)('%s: an ASYNC write failure keeps the decision and raises no unhandled rejection', async (mode) => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      failingDriver()
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
      const events: string[] = []
      const passed = await runRbacGate(viewer, 'POST', '/api/kanban/cards', fakeRes(events), mode)
      expect(passed).toBe(mode === 'shadow')
      expect(events).toEqual(mode === 'enforce' ? ['response'] : [])
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ decision: mode === 'enforce' ? 'denied' : 'would-deny' }), expect.stringContaining('insert failed'))
      expect(await runRbacGate(viewer, 'GET', '/api/memories', fakeRes([]), mode)).toBe(true)
      await sleep(30)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('the opportunistic prune is awaited: the old row is gone when the record resolves (slow driver)', async () => {
    db.prepare(
      "INSERT INTO rbac_shadow_log (ts, tenant_id, principal_kind, principal, role, method, route, permission, decision, reason) VALUES (?, 'tenant-a', 'session', 'user-a', 'viewer', 'GET', '/old', 'p', 'permitted', '')",
    ).run(OLD)
    slowDriver()
    expect(await recordRbacDecision(viewer, 'GET', '/api/memories', 'permitted')).toBe(true)
    expect(count("SELECT COUNT(*) AS n FROM rbac_shadow_log WHERE route = '/old'")).toBe(0)
    expect(count("SELECT COUNT(*) AS n FROM rbac_shadow_log WHERE route = '/api/memories'")).toBe(1)
  })

  it('a failing prune does not fail the record and raises no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const real = dbx.run.bind(dbx)
      vi.spyOn(dbx, 'run').mockImplementation(async (sql: string, ...params: unknown[]) => {
        if (sql.startsWith('DELETE FROM rbac_shadow_log')) throw new Error('prune down')
        return real(sql, ...params)
      })
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
      expect(await recordRbacDecision(viewer, 'GET', '/api/memories', 'permitted')).toBe(true)
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('prune failed'))
      await sleep(30)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('recordRbacDecision answers false (never rejects) when the insert fails, true when the row is written', async () => {
    failingDriver()
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    expect(await recordRbacDecision(viewer, 'GET', '/api/memories', 'permitted')).toBe(false)
    vi.restoreAllMocks()
    slowDriver()
    expect(await recordRbacDecision(viewer, 'GET', '/api/memories', 'permitted')).toBe(true)
  })
})
