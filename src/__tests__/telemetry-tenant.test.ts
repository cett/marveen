// tenant_id on the telemetry and journal tables (migration 0077): the Q3b backfill, the write-site
// tenant resolution, every TS writer, the label tenant rules and the rollup split. Real in-memory SQLite.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from '../db-migrations.js'

vi.mock('../web/vault.js', () => ({ purgeSecretsForTenant: vi.fn().mockReturnValue(0) }))

import {
  initDatabase, db, createTenant, updateTenant, setTenantAgentAvailability,
  upsertOtelSpan, appendDailyLog, appendTaskRun, createBackgroundTaskAtomic, logSkillUsage, insertHookAuditLog,
  logStoreFileEvent, writeAgentAuditLog, writeAdminAuditLog, pruneTokenUsage,
  createLabel, listLabels, getMonthlyTokenSpend,
} from '../db.js'
import { resolveWriteTenant } from '../db/write-tenant.js'

const tenantsOf = (table: string, where = '1=1'): (string | null)[] =>
  (db.prepare(`SELECT tenant_id FROM ${table} WHERE ${where} ORDER BY rowid`).all() as { tenant_id: string | null }[]).map(r => r.tenant_id)

describe('migration 0077 backfill (Q3b)', () => {
  function migrate(seed: (old: Database.Database) => void): Database.Database {
    const src = join(__dirname, '..', 'migrations')
    const dir = mkdtempSync(join(tmpdir(), 'telemetry-migr-'))
    try {
      const files = readdirSync(src).filter(f => f.endsWith('.sql')).sort()
      for (const f of files.filter(f => f < '0077')) copyFileSync(join(src, f), join(dir, f))
      const old = new Database(':memory:')
      applyMigrations(old, dir)
      old.pragma('foreign_keys = OFF')
      seed(old)
      const f77 = files.find(f => f.startsWith('0077'))!
      copyFileSync(join(src, f77), join(dir, f77))
      applyMigrations(old, dir)
      return old
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('files shared agents _multi_, a one-tenant agent under its tenant, an agent serving none under default, and keeps the unknown ones NULL', () => {
    const m = migrate(old => {
      old.exec(`
        INSERT INTO tenants (id, display_name, created_at) VALUES ('t1', 'T1', 0), ('t2', 'T2', 0);
        UPDATE tenants SET main_agent_id = 'coord' WHERE id = 't1';
        UPDATE tenants SET main_agent_id = 'boss' WHERE id = 't2';
        INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES
          ('t1', 'multi', 1), ('t2', 'multi', 1), ('t1', 'single', 1), ('t2', 'coord', 1), ('t2', 'half', 1), ('t1', 'half', 0);
        INSERT INTO dashboard_users (username, password_hash, created_at, updated_at, tenant_id) VALUES
          ('tenantadmin', 'x', 0, 0, 't2'), ('root', 'x', 0, 0, NULL);
        INSERT INTO agent_audit_log (agent_id, entity, action) VALUES
          ('multi', 'kanban', 'create'), ('single', 'kanban', 'create'), ('coord', 'kanban', 'create'),
          ('boss', 'kanban', 'create'), ('half', 'kanban', 'create'), ('nobody', 'kanban', 'create');
        INSERT INTO agent_audit_log (agent_id, entity, action) VALUES ('TenantAdmin', 'admin', 'x'), ('root', 'admin', 'x');
        INSERT INTO hook_audit_log (ts, agent_id, hook_type, verdict) VALUES (0, 'multi', 'PreToolUse', 'allow'), (0, NULL, 'PreToolUse', 'allow'), (0, 'single', 'PreToolUse', 'allow');
        INSERT INTO otel_spans (trace_id, span_id, agent_id, operation, start_ms) VALUES ('a', '1', 'multi', 'op', 0), ('a', '2', 'single', 'op', 0);
        INSERT INTO daily_logs (agent_id, date, content, created_at) VALUES ('multi', 'd', 'c', 0), ('single', 'd', 'c', 0);
        INSERT INTO background_tasks (id, agent_id, prompt, started_at) VALUES ('b1', 'multi', 'p', 0), ('b2', 'single', 'p', 0);
        INSERT INTO skill_usage (agent_id, skill_name, trigger_type, created_at) VALUES ('multi', 's', 'tool_call', 0), ('single', 's', 'tool_call', 0);
        INSERT INTO store_file_audit (rel_path, event_type, agent, created_at) VALUES ('a', 'w', 'multi', 0), ('b', 'w', NULL, 0), ('c', 'w', 'single', 0);
        INSERT INTO labels (id, name, color, created_at) VALUES ('l1', 'x', '#fff', 0);
      `)
    })
    const col = (sql: string) => (m.prepare(sql).all() as { t: string | null }[]).map(r => r.t)
    // multi: two tenants; single: one non-default tenant; coord: coordinates t1 and is enabled for t2;
    // boss: only coordinates t2 (no availability row); half: one enabled row, one disabled; nobody: none.
    expect(col('SELECT tenant_id AS t FROM agent_audit_log ORDER BY id'))
      .toEqual(['_multi_', 't1', '_multi_', 't2', 't2', 'default', 't2', null])
    expect(col('SELECT tenant_id AS t FROM hook_audit_log ORDER BY id')).toEqual(['_multi_', null, 't1'])
    expect(col('SELECT tenant_id AS t FROM otel_spans ORDER BY span_id')).toEqual(['_multi_', 't1'])
    expect(col('SELECT tenant_id AS t FROM daily_logs ORDER BY rowid')).toEqual(['_multi_', 't1'])
    expect(col('SELECT tenant_id AS t FROM background_tasks ORDER BY id')).toEqual(['_multi_', 't1'])
    expect(col('SELECT tenant_id AS t FROM skill_usage ORDER BY rowid')).toEqual(['_multi_', 't1'])
    expect(col('SELECT tenant_id AS t FROM store_file_audit ORDER BY rowid')).toEqual(['_multi_', null, 't1'])
    expect(col('SELECT tenant_id AS t FROM labels')).toEqual(['default'])
    // The scratch maps are gone and the biggest table has its tenant index.
    expect(m.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE '_agent_tenant%'").all()).toEqual([])
    expect(m.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_otel_spans_tenant'").get()).toBeDefined()
    m.close()
  })

  it('takes the tenant of the schedule for a task run, the agent rule when there is no such schedule', () => {
    const m = migrate(old => {
      old.exec(`
        INSERT INTO tenants (id, display_name, created_at) VALUES ('t1', 'T1', 0), ('t2', 'T2', 0);
        INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES ('t1', 'multi', 1), ('t2', 'multi', 1);
        INSERT INTO schedules (id, schedule, agent, tenant_id) VALUES ('nightly', '0 3 * * *', 'multi', 't2'), ('fleetwide', '0 4 * * *', 'multi', 'default');
        INSERT INTO task_runs (name, agent, ts) VALUES ('nightly', 'multi', 1), ('fleetwide', 'multi', 1), ('adhoc', 'multi', 1), ('adhoc', 'solo', 1);
      `)
    })
    expect((m.prepare('SELECT tenant_id AS t FROM task_runs ORDER BY id').all() as { t: string }[]).map(r => r.t))
      .toEqual(['t2', 'default', '_multi_', 'default'])
    m.close()
  })

  it('rebuilds the rollups with tenant_id in the key, from the same agent map', () => {
    const m = migrate(old => {
      old.exec(`
        INSERT INTO tenants (id, display_name, created_at) VALUES ('t1', 'T1', 0), ('t2', 'T2', 0);
        INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES ('t1', 'multi', 1), ('t2', 'multi', 1), ('t1', 'single', 1);
        INSERT INTO token_usage_daily (day, agent, model, input_tokens, row_count) VALUES
          ('2026-09-01', 'multi', 'm', 10, 1), ('2026-09-01', 'single', 'm', 20, 2), ('2026-09-01', 'nobody', 'm', 30, 3);
        INSERT INTO token_usage_monthly (month, agent, model, input_tokens, session_count, row_count) VALUES
          ('2026-09', 'multi', 'm', 10, 1, 1), ('2026-09', 'single', 'm', 20, 2, 2);
      `)
    })
    expect(m.prepare('SELECT agent, tenant_id, input_tokens, row_count FROM token_usage_daily ORDER BY agent').all()).toEqual([
      { agent: 'multi', tenant_id: '_multi_', input_tokens: 10, row_count: 1 },
      { agent: 'nobody', tenant_id: 'default', input_tokens: 30, row_count: 3 },
      { agent: 'single', tenant_id: 't1', input_tokens: 20, row_count: 2 },
    ])
    expect(m.prepare('SELECT agent, tenant_id, session_count FROM token_usage_monthly ORDER BY agent').all()).toEqual([
      { agent: 'multi', tenant_id: '_multi_', session_count: 1 },
      { agent: 'single', tenant_id: 't1', session_count: 2 },
    ])
    // Two tenants can now share a day/agent/model key.
    m.exec("INSERT INTO token_usage_daily (day, agent, model, tenant_id) VALUES ('2026-09-01', 'multi', 'm', 't1')")
    expect(() => m.exec("INSERT INTO token_usage_daily (day, agent, model, tenant_id) VALUES ('2026-09-01', 'multi', 'm', 't1')")).toThrow()
    m.close()
  })
})

describe('resolveWriteTenant', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createTenant('acme', 'Acme')
    createTenant('beta', 'Beta')
    setTenantAgentAvailability('acme', 'solo', true)
    setTenantAgentAvailability('acme', 'shared', true)
    setTenantAgentAvailability('beta', 'shared', true)
  })

  const setContext = (agent: string, tenant: string, status = 'bound', ageSeconds = 0) =>
    db.prepare('INSERT OR REPLACE INTO agent_tenant_context (agent_id, tenant_id, status, updated_at) VALUES (?, ?, ?, ?)')
      .run(agent, tenant, status, Math.floor(Date.now() / 1000) - ageSeconds)

  it('is NULL for no agent', () => {
    expect(resolveWriteTenant(null)).toBeNull()
    expect(resolveWriteTenant('')).toBeNull()
  })

  it('is the one tenant a single-tenant agent serves, default for an agent that serves none', () => {
    expect(resolveWriteTenant('solo')).toBe('acme')
    expect(resolveWriteTenant('fleet-internal')).toBe('default')
  })

  it('counts the tenant an agent coordinates', () => {
    updateTenant('beta', { main_agent_id: 'boss' })
    expect(resolveWriteTenant('boss')).toBe('beta')
    setTenantAgentAvailability('acme', 'boss', true)
    expect(resolveWriteTenant('boss')).toBeNull()
  })

  it('is NULL for a shared agent without a fresh context, never default', () => {
    expect(resolveWriteTenant('shared')).toBeNull()
    setContext('shared', 'beta', 'bound', 999_999)
    expect(resolveWriteTenant('shared')).toBeNull()
    setContext('shared', '', 'unknown')
    expect(resolveWriteTenant('shared')).toBeNull()
  })

  it('takes the fresh context of a shared agent, and only for a tenant it still serves', () => {
    setContext('shared', 'beta')
    expect(resolveWriteTenant('shared')).toBe('beta')
    setContext('shared', 'initech')
    expect(resolveWriteTenant('shared')).toBeNull()
  })

  it('lets a fresh context win over the single served tenant', () => {
    setContext('solo', 'default', 'default')
    expect(resolveWriteTenant('solo')).toBe('default')
  })
})

describe('the writers stamp the tenant', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createTenant('acme', 'Acme')
    createTenant('beta', 'Beta')
    setTenantAgentAvailability('acme', 'solo', true)
    setTenantAgentAvailability('acme', 'shared', true)
    setTenantAgentAvailability('beta', 'shared', true)
    db.prepare("INSERT INTO agent_tenant_context (agent_id, tenant_id, status, updated_at) VALUES ('shared', 'beta', 'bound', ?)")
      .run(Math.floor(Date.now() / 1000))
  })

  it('otel_spans: the first stamp survives the upsert that closes the span', () => {
    upsertOtelSpan({ trace_id: 't', span_id: '1', agent_id: 'solo', operation: 'op', start_ms: 1, parent_span_id: null, attributes: null })
    upsertOtelSpan({ trace_id: 't', span_id: '2', agent_id: 'shared', operation: 'op', start_ms: 1, parent_span_id: null, attributes: null })
    db.prepare("UPDATE agent_tenant_context SET tenant_id = 'acme' WHERE agent_id = 'shared'").run()
    upsertOtelSpan({ trace_id: 't', span_id: '2', agent_id: 'shared', operation: 'op', start_ms: 1, parent_span_id: null, attributes: null, end_ms: 2, status: 'ok' })
    expect(tenantsOf('otel_spans', "span_id IN ('1','2')")).toEqual(['acme', 'beta'])
  })

  it('daily_logs, background_tasks, skill_usage', () => {
    appendDailyLog('solo', 'a')
    appendDailyLog('shared', 'b')
    expect(tenantsOf('daily_logs')).toEqual(['acme', 'beta'])
    createBackgroundTaskAtomic('b1', 'shared', 'p', 'tmux', 5)
    expect(tenantsOf('background_tasks')).toEqual(['beta'])
    logSkillUsage('solo', 'sk', 'tool_call', 's1')
    logSkillUsage('shared', 'sk', 'tool_call', 's2')
    expect(tenantsOf('skill_usage')).toEqual(['acme', 'beta'])
  })

  it('task_runs: the schedule decides, the agent only when there is no such schedule', () => {
    db.prepare("INSERT INTO schedules (id, schedule, agent, tenant_id) VALUES ('nightly', '0 3 * * *', 'shared', 'acme')").run()
    appendTaskRun('nightly', 'shared')
    appendTaskRun('adhoc', 'shared')
    appendTaskRun('adhoc', 'solo')
    expect(tenantsOf('task_runs')).toEqual(['acme', 'beta', 'acme'])
  })

  it('hook_audit_log, store_file_audit, agent_audit_log; an event with no agent is NULL', () => {
    insertHookAuditLog({ agent_id: 'shared', hook_type: 'PreToolUse', verdict: 'allow' })
    insertHookAuditLog({ hook_type: 'PreToolUse', verdict: 'allow' })
    expect(tenantsOf('hook_audit_log')).toEqual(['beta', null])
    logStoreFileEvent('f', 'write', 0, 1, 'solo')
    logStoreFileEvent('f', 'write', 0, 1, null)
    expect(tenantsOf('store_file_audit')).toEqual(['acme', null])
    writeAgentAuditLog({ agent_id: 'shared', entity: 'kanban', action: 'create' })
    expect(tenantsOf('agent_audit_log')).toEqual(['beta'])
  })

  it('an admin audit row takes the tenant of the dashboard user, NULL for the global admin', () => {
    db.prepare("INSERT INTO dashboard_users (username, password_hash, created_at, updated_at, tenant_id) VALUES ('tadmin', 'x', 0, 0, 'acme'), ('root', 'x', 0, 0, NULL)").run()
    writeAdminAuditLog('TAdmin', 'tenant.update', 'acme', {})
    writeAdminAuditLog('root', 'tenant.create', 'beta', {})
    writeAdminAuditLog('ghost', 'x', 'y', {})
    expect(tenantsOf('agent_audit_log', "entity = 'admin'")).toEqual(['acme', null, null])
  })
})

describe('token rollups keep the tenants of a shared agent apart', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createTenant('acme', 'Acme')
    createTenant('beta', 'Beta')
  })

  const raw = (tenant: string, ts: number, tokens: number) =>
    db.prepare("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, model, tenant_id) VALUES ('shared', ?, ?, ?, 'm', ?)")
      .run(`s-${tenant}-${ts}`, ts, tokens, tenant)

  it('one daily and one monthly row per tenant, and the tenant budget sees the old months', () => {
    const old = Math.floor(Date.now() / 1000) - 100 * 86400
    raw('acme', old, 10)
    raw('acme', old + 60, 5)
    raw('beta', old + 120, 7)
    pruneTokenUsage()
    const daily = db.prepare('SELECT tenant_id, input_tokens, row_count FROM token_usage_daily ORDER BY tenant_id').all()
    expect(daily).toEqual([
      { tenant_id: 'acme', input_tokens: 15, row_count: 2 },
      { tenant_id: 'beta', input_tokens: 7, row_count: 1 },
    ])
    const month = db.prepare("SELECT strftime('%Y-%m', ?, 'unixepoch', 'localtime') AS m").get(old) as { m: string }
    expect(db.prepare('SELECT tenant_id, input_tokens FROM token_usage_monthly WHERE month = ? ORDER BY tenant_id').all(month.m)).toEqual([
      { tenant_id: 'acme', input_tokens: 15 },
      { tenant_id: 'beta', input_tokens: 7 },
    ])
    expect(getMonthlyTokenSpend({ tenant: 'acme' }, old)).toBe(15)
    expect(getMonthlyTokenSpend({ tenant: 'beta' }, old)).toBe(7)
    expect(getMonthlyTokenSpend({}, old)).toBe(22)
  })
})

describe('labels belong to a tenant', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createTenant('acme', 'Acme')
  })

  it('a new label is default unless a tenant is named, and the list narrows to a tenant', () => {
    const a = createLabel({ id: 'a', name: 'bug', color: '#fff' })
    const b = createLabel({ id: 'b', name: 'bug', color: '#fff', tenant_id: 'acme' })
    expect([a.tenant_id, b.tenant_id]).toEqual(['default', 'acme'])
    expect(listLabels('acme').map(l => l.id)).toEqual(['b'])
    expect(listLabels(null).map(l => l.id).sort()).toEqual(['a', 'b'])
  })
})
