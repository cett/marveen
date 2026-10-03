import { describe, it, expect, beforeEach, vi } from 'vitest'

// vault.json is file I/O and not what this suite is about (vault.test.ts covers it).
vi.mock('../web/vault.js', () => ({
  purgeSecretsForTenant: vi.fn().mockReturnValue(0),
}))

import {
  initDatabase,
  getDb,
  createTenant,
  deleteTenant,
  TENANT_PURGE_SIMPLE_TABLES,
  TENANT_PURGE_AGENT_KEYED_TABLES,
  TENANT_PURGE_HANDLED_TABLES,
  TENANT_PURGE_EXEMPT_TABLES,
} from '../db.js'

// Real in-memory DB. The point of every test here is the NEGATIVE side: after the delete, the rows of
// the other tenants (default, a sibling tenant, the `_multi_` sentinel) must still be there.

const TARGET = 'gone'
const SIBLING = 'sibling'
const OTHERS = ['default', SIBLING, '_multi_']

function db() { return getDb() }

function count(table: string, tenantId: string): number {
  return (db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(tenantId) as { n: number }).n
}

// One row per tenant in the table. The tables with a UNIQUE key get a per-tenant value.
const SEEDERS: Record<string, (t: string) => void> = {
  cost_budgets: (t) => db().prepare('INSERT INTO cost_budgets (id, name, amount, tenant_id) VALUES (?, ?, 100, ?)').run('b1', 'b', t),
  egress_allowlist: (t) => db().prepare("INSERT INTO egress_allowlist (value, type, tenant_id) VALUES ('example.org', 'domain', ?)").run(t),
  idea_box: (t) => db().prepare("INSERT INTO idea_box (id, title, created_at, updated_at, tenant_id) VALUES (?, 'idea', 0, 0, ?)").run(`idea-${t}`, t),
  vault_bindings: (t) => db().prepare("INSERT INTO vault_bindings (vault_secret_id, env_var, tenant_id) VALUES ('s1', 'E', ?)").run(t),
  token_usage: (t) => db().prepare("INSERT INTO token_usage (agent, session_id, timestamp, content_preview, tenant_id) VALUES ('a', 's', ?, 'secret text', ?)").run(OTHERS.concat(TARGET).indexOf(t) + 1, t),
  fleet_blackboard_history: (t) => db().prepare("INSERT INTO fleet_blackboard_history (agent_id, status, summary, tenant_id) VALUES ('a', 'done', 'x', ?)").run(t),
  rbac_shadow_log: (t) => db().prepare("INSERT INTO rbac_shadow_log (tenant_id, principal_kind, principal, role, method, route, permission, decision) VALUES (?, 'session', 'user-a', 'viewer', 'GET', '/api/memories', 'memories:read', 'permitted')").run(t),
  import_sources: (t) => db().prepare("INSERT INTO import_sources (id, type, path, created_at, updated_at, tenant_id) VALUES (?, 'local', '/x', 0, 0, ?)").run(`src-${t}`, t),
  import_audit_log: (t) => db().prepare('INSERT INTO import_audit_log (source_id, run_at, tenant_id) VALUES (?, 0, ?)').run(`src-${t}`, t),
}

function seedSimple(): void {
  for (const t of [TARGET, ...OTHERS]) {
    SEEDERS.import_sources!(t)
    for (const table of [...TENANT_PURGE_SIMPLE_TABLES, 'import_audit_log']) SEEDERS[table]!(t)
  }
}

describe('deleteTenant: tenant-keyed leftovers', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createTenant(TARGET, 'Gone')
    createTenant(SIBLING, 'Sibling')
  })

  it('removes the target tenant\'s rows in every simple table and import table, and only those', () => {
    seedSimple()
    const tables = [...TENANT_PURGE_SIMPLE_TABLES, 'import_sources', 'import_audit_log']
    // A fresh DB already carries seeded rows for `default` (egress allowlist), so compare before/after, not to 1.
    const before = Object.fromEntries(tables.map((t) => [t, OTHERS.map((o) => count(t, o))]))
    const result = deleteTenant(TARGET)

    for (const table of tables) {
      expect(count(table, TARGET), `${table}: target rows`).toBe(0)
      expect(OTHERS.map((o) => count(table, o)), `${table}: other tenants' rows`).toEqual(before[table])
      expect(result.purged[table], `${table}: purged count`).toBe(1)
    }
  })

  it('reports zero counts for an empty tenant and no exclusive agents', () => {
    const result = deleteTenant(TARGET)
    expect(result.memoriesDeleted).toBe(0)
    expect(result.exclusiveAgents).toEqual([])
    for (const n of Object.values(result.purged)) expect(n).toBe(0)
  })
})

describe('deleteTenant: agent-keyed rows', () => {
  function avail(tenant: string, agent: string, enabled = 1) {
    db().prepare('INSERT INTO tenant_agent_availability (tenant_id, agent_id, enabled) VALUES (?, ?, ?)').run(tenant, agent, enabled)
  }
  function setting(agent: string, key: string, tenant: string) {
    db().prepare("INSERT INTO agent_settings (agent_id, setting_key, setting_value, tenant_id) VALUES (?, ?, '{}', ?)").run(agent, key, tenant)
  }
  function state(agent: string, key: string, tenant: string) {
    db().prepare("INSERT INTO agent_state (agent_id, state_key, state_value, tenant_id) VALUES (?, ?, '{}', ?)").run(agent, key, tenant)
  }
  function board(agent: string, tenant: string) {
    db().prepare("INSERT INTO fleet_blackboard (id, agent_id, status, summary, tenant_id) VALUES (?, ?, 'active', 's', ?)").run(`id-${agent}`, agent, tenant)
  }
  const tenantOf = (table: string, agent: string) =>
    (db().prepare(`SELECT tenant_id FROM ${table} WHERE agent_id = ?`).all(agent) as { tenant_id: string }[]).map((r) => r.tenant_id)

  beforeEach(() => {
    initDatabase(':memory:')
    createTenant(TARGET, 'Gone')
    createTenant(SIBLING, 'Sibling')
    // solo: only serves TARGET. shared: serves TARGET and default. other: only SIBLING. fleet: no availability row at all.
    avail(TARGET, 'solo'); avail(TARGET, 'shared'); avail('default', 'shared'); avail(SIBLING, 'other')
    for (const agent of ['solo', 'shared', 'other', 'fleet']) {
      setting(agent, 'context_guard', agent === 'solo' || agent === 'shared' ? TARGET : agent === 'other' ? SIBLING : 'default')
      state(agent, 'gate_run_state', agent === 'solo' || agent === 'shared' ? TARGET : agent === 'other' ? SIBLING : 'default')
    }
    board('solo', TARGET); board('shared', TARGET); board('other', SIBLING); board('fleet', 'default')
  })

  it('names the agents that serve only the deleted tenant, in the result', () => {
    expect(deleteTenant(TARGET).exclusiveAgents).toEqual(['solo'])
  })

  it('deletes the exclusive agent\'s settings, state and blackboard row', () => {
    deleteTenant(TARGET)
    for (const table of TENANT_PURGE_AGENT_KEYED_TABLES) expect(tenantOf(table, 'solo'), table).toEqual([])
  })

  it('keeps a shared agent\'s configuration and re-tags it to default (not deleted, not left on the dead tenant)', () => {
    const result = deleteTenant(TARGET)
    for (const table of TENANT_PURGE_AGENT_KEYED_TABLES) expect(tenantOf(table, 'shared'), table).toEqual(['default'])
    expect(result.purged.agent_settings_retagged).toBe(1)
    expect(result.purged.agent_settings).toBe(1)
  })

  it('does not touch the rows of agents that never served the deleted tenant', () => {
    deleteTenant(TARGET)
    for (const table of TENANT_PURGE_AGENT_KEYED_TABLES) {
      expect(tenantOf(table, 'other'), table).toEqual([SIBLING])
      expect(tenantOf(table, 'fleet'), table).toEqual(['default'])
    }
  })

  it('does not count a disabled availability row as a second tenant: the agent is still exclusive', () => {
    avail(SIBLING, 'solo', 0)
    expect(deleteTenant(TARGET).exclusiveAgents).toEqual(['solo'])
    expect(tenantOf('agent_settings', 'solo')).toEqual([])
  })

  it('an agent whose only availability row for the tenant is disabled is not exclusive: its row is re-tagged, not deleted', () => {
    avail(TARGET, 'ghost', 0)
    setting('ghost', 'auto_restart', TARGET)
    const result = deleteTenant(TARGET)
    expect(result.exclusiveAgents).toEqual(['solo'])
    expect(tenantOf('agent_settings', 'ghost')).toEqual(['default'])
  })

  it('does not delete a row of an exclusive agent that is tagged with another tenant', () => {
    db().prepare("UPDATE agent_settings SET tenant_id = 'default' WHERE agent_id = 'solo'").run()
    deleteTenant(TARGET)
    expect(tenantOf('agent_settings', 'solo')).toEqual(['default'])
  })
})

describe('deleteTenant: drift guard', () => {
  it('every table with a tenant_id column is either purged, handled, agent-keyed or explicitly exempt', () => {
    initDatabase(':memory:')
    const tables = (db().prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' AND name NOT LIKE 'sqlite_%'",
    ).all() as { name: string }[]).map((r) => r.name)
    const tenantTables = tables.filter((name) =>
      (db().prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).some((c) => c.name === 'tenant_id'))
    // tenants itself is dropped by the last statement and has `id`, not `tenant_id`; this guards the guard.
    expect(tenantTables.length).toBeGreaterThan(25)

    const known = new Set<string>([
      ...TENANT_PURGE_SIMPLE_TABLES, ...TENANT_PURGE_AGENT_KEYED_TABLES, ...TENANT_PURGE_HANDLED_TABLES, ...TENANT_PURGE_EXEMPT_TABLES,
    ])
    const unknownTables = tenantTables.filter((t) => !known.has(t))
    // A new tenant_id table lands here: add it to deleteTenant and to one of the sets, or exempt it with a reason.
    expect(unknownTables).toEqual([])
    // And the other way round: a set entry for a table that no longer exists is a stale registry.
    expect([...known].filter((t) => !tenantTables.includes(t))).toEqual([])
  })

  it('the sets do not overlap', () => {
    const all = [...TENANT_PURGE_SIMPLE_TABLES, ...TENANT_PURGE_AGENT_KEYED_TABLES, ...TENANT_PURGE_HANDLED_TABLES, ...TENANT_PURGE_EXEMPT_TABLES]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('deleteTenant: tombstones and untouched rollups', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createTenant(TARGET, 'Gone')
  })

  it('keeps the api_tokens row as a revoked tombstone', () => {
    db().prepare("INSERT INTO api_tokens (name, token_hash, role, tenant_id, created_at) VALUES ('n', 'h', 'admin', ?, 0)").run(TARGET)
    deleteTenant(TARGET)
    const row = db().prepare("SELECT revoked_at FROM api_tokens WHERE token_hash = 'h'").get() as { revoked_at: number | null } | undefined
    expect(row).toBeDefined()
    expect(row!.revoked_at).not.toBeNull()
  })
})
