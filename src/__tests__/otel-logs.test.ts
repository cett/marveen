// OTel H5a: the audit-table rows -> OTLP log records mapping (src/otel-logs.ts) and the DB layer under it
// (src/db/otel-logs.ts): which columns are read, the cursor rules, the actor pseudonym.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDatabase, getDb, getOtelLogBatch, getOtelLogCursor, setOtelLogCursor, getOtelLogHashSalt } from '../db.js'
import { mapLogBatch, logsToOtelJson, token, actorHash, type OtelLogRecord } from '../otel-logs.js'

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM approval_events; DELETE FROM rbac_shadow_log; DELETE FROM config_change_log; DELETE FROM agent_audit_log; DELETE FROM hook_audit_log;')
  db.exec('DELETE FROM otel_logs_export_state')
})

const SALT = 'salt-for-tests'

function attrs(r: OtelLogRecord): Record<string, string> {
  return Object.fromEntries(r.attributes.map((a) => [a.key, a.value.stringValue ?? '']))
}

function seedApproval(event: string, reason: string | null, actor: string | null, ref: string | null = null) {
  getDb().prepare(
    'INSERT INTO approval_events (approval_id, tenant_id, event, reason, actor, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('approval-1', 'tenant-a', event, reason, actor, ref, 1_700_000_000)
}

function seedRbac(decision: string, route = '/api/kanban/card-1?x=1', principal = 'user-a') {
  getDb().prepare(
    `INSERT INTO rbac_shadow_log (ts, tenant_id, principal_kind, principal, role, method, route, permission, decision, reason)
     VALUES (1700000001, 'tenant-a', 'session', ?, 'viewer', 'POST', ?, 'kanban:write', ?, 'role_lacks_permission')`,
  ).run(principal, route, decision)
}

describe('token', () => {
  it('keeps a short identifier and replaces anything else with _other', () => {
    expect(token('hash_mismatch')).toBe('hash_mismatch')
    expect(token('kanban:write')).toBe('kanban:write')
    expect(token('/api/kanban/card-1')).toBe('_other')
    expect(token('has a space')).toBe('_other')
    expect(token('a'.repeat(65))).toBe('_other')
    expect(token('a'.repeat(64))).toBe('a'.repeat(64))
    expect(token('line\nbreak')).toBe('_other')
  })
  it('has no token for null, undefined or the empty string', () => {
    expect(token(null)).toBeNull()
    expect(token(undefined)).toBeNull()
    expect(token('')).toBeNull()
  })
})

describe('actorHash', () => {
  it('is stable per salt, differs per actor and per salt, and shows no part of the name', () => {
    const a = actorHash('user-a', SALT)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(actorHash('user-a', SALT)).toBe(a)
    expect(actorHash('user-b', SALT)).not.toBe(a)
    expect(actorHash('user-a', 'other-salt')).not.toBe(a)
    expect(a).not.toContain('user')
  })
  it('has no hash for an empty actor', () => {
    expect(actorHash('', SALT)).toBeNull()
    expect(actorHash(null, SALT)).toBeNull()
  })
})

describe('getOtelLogHashSalt', () => {
  it('is created once and stays the same', () => {
    const first = getOtelLogHashSalt()
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(getOtelLogHashSalt()).toBe(first)
  })
})

describe('cursors', () => {
  it('start at the current end of the table: the history is not replayed', () => {
    seedApproval('consumed', null, 'user-a')
    seedApproval('consumed', null, 'user-a')
    expect(getOtelLogBatch(100).approval_events).toHaveLength(0)
    seedApproval('consume_refused', 'expired', 'user-a')
    expect(getOtelLogBatch(100).approval_events.map((r) => r.event)).toEqual(['consume_refused'])
  })

  it('start at 0 on an empty table, so the first row is exported', () => {
    expect(getOtelLogCursor('config_change_log')).toBe(0)
    getDb().prepare("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ('K', 'a', 'b', 'user-a', 1)").run()
    expect(getOtelLogBatch(100).config_change_log).toHaveLength(1)
  })

  it('only move forward', () => {
    getOtelLogCursor('agent_audit_log')
    setOtelLogCursor('agent_audit_log', 10)
    setOtelLogCursor('agent_audit_log', 4)
    expect(getOtelLogCursor('agent_audit_log')).toBe(10)
  })

  it('give the oldest rows first and respect the per-source limit', () => {
    getOtelLogCursor('agent_audit_log')
    const ins = getDb().prepare("INSERT INTO agent_audit_log (agent_id, entity, action, entity_id, detail, created_at) VALUES ('agent-a', 'memory', 'create', ?, '{}', ?)")
    for (let i = 1; i <= 5; i++) ins.run(String(i), 100 + i)
    const rows = getOtelLogBatch(3).agent_audit_log
    expect(rows.map((r) => r.created_at)).toEqual([101, 102, 103])
    setOtelLogCursor('agent_audit_log', rows[rows.length - 1].id)
    expect(getOtelLogBatch(3).agent_audit_log.map((r) => r.created_at)).toEqual([104, 105])
  })
})

describe('what is read from the database', () => {
  it('leaves out the rbac permitted rows, which are request-level traffic', () => {
    getOtelLogCursor('rbac_shadow_log')
    seedRbac('permitted')
    seedRbac('denied')
    seedRbac('would-deny')
    expect(getOtelLogBatch(100).rbac_shadow_log.map((r) => r.decision)).toEqual(['denied', 'would-deny'])
  })

  it('does not select the content columns at all', () => {
    getOtelLogCursor('approval_events'); getOtelLogCursor('rbac_shadow_log'); getOtelLogCursor('config_change_log'); getOtelLogCursor('agent_audit_log')
    seedApproval('consumed', null, 'user-a', 'REF-CONTENT')
    seedRbac('denied', '/api/ROUTE-CONTENT')
    getDb().prepare("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ('K', 'OLD-CONTENT', 'NEW-CONTENT', 'user-a', 1)").run()
    getDb().prepare("INSERT INTO agent_audit_log (agent_id, entity, action, entity_id, detail, created_at) VALUES ('agent-a', 'memory', 'create', 'ENTITY-CONTENT', '{\"v\":\"DETAIL-CONTENT\"}', 1)").run()
    const dump = JSON.stringify(getOtelLogBatch(100))
    for (const secret of ['REF-CONTENT', 'ROUTE-CONTENT', 'OLD-CONTENT', 'NEW-CONTENT', 'ENTITY-CONTENT', 'DETAIL-CONTENT']) {
      expect(dump).not.toContain(secret)
    }
  })
})

describe('mapLogBatch', () => {
  it('maps an approval refusal as a WARN with bounded attributes and a pseudonymous actor', () => {
    getOtelLogCursor('approval_events')
    seedApproval('consume_refused', 'hash_mismatch', 'user-a')
    const { records, cursors } = mapLogBatch(getOtelLogBatch(100), SALT, 1_800_000_000_000)
    expect(records).toHaveLength(1)
    const r = records[0]
    expect(r.body.stringValue).toBe('marveen.approval.consume_refused')
    expect(r.severityNumber).toBe(13)
    expect(r.severityText).toBe('WARN')
    expect(r.timeUnixNano).toBe('1700000000000000000')
    expect(r.observedTimeUnixNano).toBe('1800000000000000000')
    const a = attrs(r)
    expect(a['event.name']).toBe('marveen.approval.consume_refused')
    expect(a['marveen.approval.reason']).toBe('hash_mismatch')
    expect(a['marveen.tenant.id']).toBe('tenant-a')
    expect(a['marveen.actor.hash']).toBe(actorHash('user-a', SALT))
    expect(JSON.stringify(r)).not.toContain('user-a')
    expect(cursors.approval_events).toBeGreaterThan(0)
  })

  it('maps a routine approval event as INFO', () => {
    getOtelLogCursor('approval_events')
    seedApproval('consumed', null, 'user-a')
    const [r] = mapLogBatch(getOtelLogBatch(100), SALT).records
    expect(r.severityNumber).toBe(9)
    expect(attrs(r)['marveen.approval.reason']).toBeUndefined()
  })

  it('maps an rbac decision with the permission and never the route or the principal name', () => {
    getOtelLogCursor('rbac_shadow_log')
    seedRbac('denied', '/api/kanban/card-1?token=ROUTE-SECRET', 'principal-name-a')
    const [r] = mapLogBatch(getOtelLogBatch(100), SALT).records
    const a = attrs(r)
    expect(a['marveen.rbac.decision']).toBe('denied')
    expect(a['marveen.rbac.permission']).toBe('kanban:write')
    expect(a['http.request.method']).toBe('POST')
    expect(a['marveen.principal.kind']).toBe('session')
    expect(a['marveen.actor.hash']).toBe(actorHash('principal-name-a', SALT))
    const json = JSON.stringify(r)
    expect(json).not.toContain('ROUTE-SECRET')
    expect(json).not.toContain('/api/')
    expect(json).not.toContain('principal-name-a')
  })

  it('maps a config change by its key only', () => {
    getOtelLogCursor('config_change_log')
    getDb().prepare("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ('SOME_SETTING', 'OLD-CONTENT', 'NEW-CONTENT', 'user-a', 5)").run()
    const [r] = mapLogBatch(getOtelLogBatch(100), SALT).records
    expect(attrs(r)['marveen.config.key']).toBe('SOME_SETTING')
    const json = JSON.stringify(r)
    expect(json).not.toContain('CONTENT')
    expect(json).not.toContain('user-a')
  })

  it('pseudonymises the agent_audit_log agent_id, which can be a user, token or device name', () => {
    getOtelLogCursor('agent_audit_log')
    getDb().prepare("INSERT INTO agent_audit_log (agent_id, entity, action, entity_id, detail, created_at) VALUES ('claimed:user-a', 'kanban', 'update', 'x', '{}', 7)").run()
    const [r] = mapLogBatch(getOtelLogBatch(100), SALT).records
    expect(r.body.stringValue).toBe('marveen.audit.kanban.update')
    expect(JSON.stringify(r)).not.toContain('user-a')
    expect(attrs(r)['marveen.actor.hash']).toBe(actorHash('claimed:user-a', SALT))
  })

  it('turns a writer value that is not an identifier into _other instead of exporting it', () => {
    getOtelLogCursor('approval_events')
    seedApproval('consume refused: see /home/path', 'free text, with spaces and a name', 'user-a')
    const [r] = mapLogBatch(getOtelLogBatch(100), SALT).records
    const json = JSON.stringify(r)
    expect(json).not.toContain('/home/path')
    expect(json).not.toContain('with spaces')
    expect(r.body.stringValue).toBe('marveen.approval._other')
    expect(attrs(r)['marveen.approval.reason']).toBe('_other')
  })

  it('labels a record without a resolvable tenant as unresolved, not default', () => {
    getOtelLogCursor('rbac_shadow_log')
    getDb().prepare(
      `INSERT INTO rbac_shadow_log (ts, tenant_id, principal_kind, principal, role, method, route, permission, decision, reason)
       VALUES (1, NULL, 'token', '', 'admin', 'GET', '/x', 'admin:all', 'denied', 'r')`,
    ).run()
    const [r] = mapLogBatch(getOtelLogBatch(100), SALT).records
    expect(attrs(r)['marveen.tenant.id']).toBe('unresolved')
    expect(attrs(r)['marveen.actor.hash']).toBeUndefined() // an empty principal has nothing to pseudonymise
  })

  it('reports the highest id per source and nothing for an empty source', () => {
    getOtelLogCursor('approval_events'); getOtelLogCursor('config_change_log')
    seedApproval('consumed', null, 'user-a')
    seedApproval('consumed', null, 'user-a')
    const batch = getOtelLogBatch(100)
    const { cursors } = mapLogBatch(batch, SALT)
    expect(cursors.approval_events).toBe(batch.approval_events[1].id)
    expect(cursors.config_change_log).toBeUndefined()
  })
})

describe('hook_audit_log (the gate refusals)', () => {
  function seedHook(verdict: string, over: Partial<{ tool: string | null; hash: string | null; reason: string | null; session: string | null; source: string | null; agent: string | null; tenant: string | null }> = {}) {
    const o = { tool: 'TOOL-CONTENT', hash: 'HASH-CONTENT', reason: 'denied', session: 'SESSION-CONTENT', source: 'secret-read-gate', agent: 'agent-a', tenant: null, ...over }
    getDb().prepare(
      `INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict, tool_name, content_hash, reason, session_id, trigger_source, tenant_id)
       VALUES (1700000002, ?, 'PreToolUse', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(o.agent, verdict, o.tool, o.hash, o.reason, o.session, o.source, o.tenant)
  }

  it('exports deny and defer rows only: the allow and handoff rows are not security events', () => {
    getOtelLogCursor('hook_audit_log')
    seedHook('allow'); seedHook('handoff'); seedHook('deny'); seedHook('defer')
    expect(getOtelLogBatch(100).hook_audit_log.map((r) => r.verdict)).toEqual(['deny', 'defer'])
  })

  it('maps a refusal to a WARN with the gate, the reason code and the agent, and nothing that came from the call', () => {
    getOtelLogCursor('hook_audit_log')
    seedHook('deny', { tenant: 'tenant-a' })
    const batch = getOtelLogBatch(100)
    expect(JSON.stringify(batch)).not.toMatch(/CONTENT/)
    const [r] = mapLogBatch(batch, SALT).records
    expect(r.body.stringValue).toBe('marveen.hook.deny')
    expect(r.severityNumber).toBe(13)
    const a = attrs(r)
    expect(a).toMatchObject({
      'marveen.hook.verdict': 'deny', 'marveen.hook.type': 'PreToolUse', 'marveen.gate': 'secret-read-gate',
      'marveen.hook.reason': 'denied', 'marveen.agent.id': 'agent-a', 'marveen.tenant.id': 'tenant-a',
    })
    expect(JSON.stringify(r)).not.toMatch(/CONTENT/)
  })

  it('bounds a reason or a producer that is not an identifier, and labels a missing tenant unresolved', () => {
    getOtelLogCursor('hook_audit_log')
    seedHook('deny', { reason: 'ctx=45% of /some/path', source: null, agent: null })
    const [r] = mapLogBatch(getOtelLogBatch(100), SALT).records
    const a = attrs(r)
    expect(a['marveen.hook.reason']).toBe('_other')
    expect(a['marveen.gate']).toBeUndefined()
    expect(a['marveen.agent.id']).toBeUndefined()
    expect(a['marveen.tenant.id']).toBe('unresolved')
    expect(JSON.stringify(r)).not.toContain('/some/path')
  })

  it('starts at the end of the table like the other sources', () => {
    seedHook('deny'); seedHook('deny')
    expect(getOtelLogBatch(100).hook_audit_log).toHaveLength(0)
    seedHook('deny', { reason: 'gate_error' })
    expect(getOtelLogBatch(100).hook_audit_log.map((r) => r.reason)).toEqual(['gate_error'])
  })
})

describe('logsToOtelJson', () => {
  it('wraps the records in one resource of the dashboard service with the audit scope', () => {
    const json = logsToOtelJson([], 'ns-a', 'inst-a') as {
      resourceLogs: { resource: { attributes: { key: string; value: { stringValue: string } }[] }; scopeLogs: { scope: { name: string } }[] }[]
    }
    const res = json.resourceLogs[0]
    const r = Object.fromEntries(res.resource.attributes.map((a) => [a.key, a.value.stringValue]))
    expect(r).toEqual({ 'service.name': 'marveen-dashboard', 'service.namespace': 'ns-a', 'service.instance.id': 'inst-a' })
    expect(res.scopeLogs[0].scope.name).toBe('marveen.audit')
  })
})
