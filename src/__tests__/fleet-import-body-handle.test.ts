// The body of the fleet import transaction (inFleetImportTransaction) runs every write on the handle it is given. On
// PostgreSQL a call on the outer `dbx` inside the body is refused (strict rule); on SQLite it would quietly join the
// transaction through the facade's ambient scope, so the structural counter (helpers/single-transaction.ts) is what
// tells the two apart there: exactly one `tx` (the wrapper) and zero plain facade calls while the body runs.
//
// This file holds the cells of the callees one family at a time (system_config here); each cell has three parts:
// the handle (0 plain facade calls), the rollback (a throw after the writes leaves the database as it was), and the
// commit (a body that finishes keeps every write).
//
// Privacy: neutral fixtures only (agent-a, model-a).
import { describe, expect, it } from 'vitest'
import { dbx } from '../db.js'
import { inFleetImportTransaction, listEnabledTenantIds, rebuildMemoriesFts } from '../db/fleet-transfer.js'
import { replaceCostBudgets, listCostBudgets } from '../db/cost-budgets.js'
import { mergeEgressAllowlistEntries } from '../db/egress-allowlist.js'
import { seedSkillIfAbsent } from '../db/tasks.js'
import type { Tx } from '../db/facade.js'
import { loadSystemConfigCacheAsync, cachedSystemConfig } from '../db/config-cache.js'
import { listAutonomyCategories, upsertAutonomyCategory, type AutonomyCategoryRow } from '../db/autonomy.js'
import { upsertModelProfileMapEntry } from '../db/model-profile-map.js'
import { loadModelProfileMapCacheAsync, cachedModelProfileMapEntry } from '../db/model-profile-map-cache.js'
import { setAgentSetting } from '../db/agent-settings.js'
import { loadAgentSettingsCacheAsync, cachedAgentSetting } from '../db/agent-settings-cache.js'
import { auditAutonomyLevelChange, resolveAutonomyAuditTenant } from '../web/autonomy-audit.js'
import { setSystemConfig, setSystemConfigMany } from '../db/system-config.js'
import { setFederationConfigRaw } from '../db/federation.js'
import { setDesiredAgents } from '../web/agent-desired-state.js'
import { writeModelFallbackFieldsRaw } from '../web/model-fallback-store.js'
import { writeTerminalInputEnabled } from '../web/terminal-input-store.js'
import { testDbMode, useTestDb } from './helpers/with-test-db.js'
import { countFacadeCalls } from './helpers/single-transaction.js'
import { refuseWrite } from './helpers/refuse-write.js'

useTestDb()

const snapshot = async () => dbx.all<{ key: string; value: string }>('SELECT key, value FROM system_config ORDER BY key')
const valueOf = async (key: string) => (await dbx.get<{ value: string }>('SELECT value FROM system_config WHERE key = ?', key))?.value

/** Every system_config writer the import body calls, in one go, on the handle. */
async function writeAll(tx: Parameters<Parameters<typeof inFleetImportTransaction>[0]>[0]): Promise<void> {
  await setSystemConfig('probe_single', 'v1', 'db', tx)
  await setSystemConfigMany([['probe_many_a', '1'], ['probe_many_b', '2']], 'db', tx)
  await writeTerminalInputEnabled(true, tx)
  await writeModelFallbackFieldsRaw({ enabled: true, chain: ['model-a'], revertAfterMinutes: 5 }, tx)
  await setFederationConfigRaw('{"peers":[]}', 'db', tx)
  await setDesiredAgents(['agent-a'], tx)
}

const KEYS = [
  'probe_single', 'probe_many_a', 'probe_many_b', 'terminal_input_enabled', 'model_fallback_enabled',
  'model_fallback_chain', 'model_fallback_revert_after_minutes', 'federation_config_json', 'agents_desired',
]

describe('system_config writers on the import handle', () => {
  it('the handle: one transaction and no plain facade call while the body runs (the cache read-back included)', async () => {
    await loadSystemConfigCacheAsync() // a live cache, so the PG read-back after each write really runs
    const counts = await countFacadeCalls(dbx, () => inFleetImportTransaction(writeAll))
    expect(counts).toEqual({ tx: 1, outsideTx: 0 })
  })

  it('the commit: a body that finishes keeps every write, and the cache follows', async () => {
    await loadSystemConfigCacheAsync()
    await inFleetImportTransaction(writeAll)
    const rows = await snapshot()
    expect(rows.map((r) => r.key)).toEqual(expect.arrayContaining(KEYS))
    expect(await valueOf('probe_many_b')).toBe('2')
    expect(await valueOf('terminal_input_enabled')).toBe('1')
    expect(JSON.parse((await valueOf('agents_desired')) ?? 'null')).toEqual(['agent-a'])
    expect(cachedSystemConfig('probe_single')?.value).toBe('v1')
  })

  it('the rollback: a throw after the writes leaves system_config as it was', async () => {
    const before = await snapshot()
    await expect(inFleetImportTransaction(async (tx) => {
      await writeAll(tx)
      // the writes are inside the transaction (visible on its handle) before the throw takes them back
      expect(await tx.get('SELECT 1 AS x FROM system_config WHERE key = ?', 'probe_single')).toBeTruthy()
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await snapshot()).toEqual(before)
    expect(await valueOf('agents_desired')).toBeUndefined()
  })

  it('the rollback after a refused write in the middle: the earlier writers of the family are taken back too', async () => {
    const before = await snapshot()
    await refuseWrite(dbx, { name: 'no_federation_row', table: 'system_config', message: 'insert refused', when: { column: 'key', equals: 'federation_config_json' } })
    await expect(inFleetImportTransaction(writeAll)).rejects.toThrow('insert refused')
    expect(await snapshot()).toEqual(before)
  })
})

// ---- autonomy rows + their audit row, the model profile map, the per-agent settings ----------------------------------

const auditRows = async () =>
  dbx.all<{ agent_id: string; entity: string; entity_id: string | null; detail: string | null; tenant_id: string | null }>(
    "SELECT agent_id, entity, entity_id, detail, tenant_id FROM agent_audit_log WHERE agent_id = 'actor-a' ORDER BY id")
const autonomyRow = async (key: string) => dbx.get<{ label: string; level: number }>('SELECT label, level FROM autonomy_categories WHERE key = ?', key)
const profileRow = async () => dbx.get<{ model_id: string; updated_by: string }>("SELECT model_id, updated_by FROM model_profile_map WHERE profile_id = 'routine_lowcost'")
const settingRow = async () => dbx.get<{ setting_value: string }>("SELECT setting_value FROM agent_settings WHERE agent_id = 'agent-a' AND setting_key = 'auto_restart'")

/** The tenant of the audit rows, looked up BEFORE the transaction opens (the lookup is a facade call). */
async function auditTenantOf(who: string): Promise<{ tenantId: string | null }> {
  const at = await resolveAutonomyAuditTenant(who)
  if (at === undefined) throw new Error('the audit tenant lookup failed')
  return at
}

async function seedCategory(): Promise<AutonomyCategoryRow> {
  const [row] = await listAutonomyCategories()
  if (!row) throw new Error('the baseline has no autonomy category')
  return row
}

/** The autonomy, model map and agent settings writers the import body calls, on the handle. */
async function writeRows(tx: Tx, cat: AutonomyCategoryRow, auditTenant: { tenantId: string | null }): Promise<void> {
  await upsertAutonomyCategory({ ...cat, label: 'Label A' }, tx)
  await auditAutonomyLevelChange('actor-a', cat.key, cat.level, cat.level + 1, { tx, tenantId: auditTenant.tenantId })
  await upsertModelProfileMapEntry({ profile_id: 'routine_lowcost', model_id: 'model-a', updated_by: 'actor-a' }, tx)
  await setAgentSetting('agent-a', 'auto_restart', { enabled: true }, 'default', tx)
}

describe('autonomy, model profile map and agent settings on the import handle', () => {
  it('the handle: one transaction and no plain facade call while the body runs (the audit row and both cache read-backs included)', async () => {
    await loadModelProfileMapCacheAsync()
    await loadAgentSettingsCacheAsync()
    const cat = await seedCategory()
    const at = await auditTenantOf('actor-a') // the lookup is the one facade call, made before the body
    const counts = await countFacadeCalls(dbx, () => inFleetImportTransaction(async (tx) => {
      await upsertAutonomyCategory({ ...cat, label: 'Label A' }, tx)
      await auditAutonomyLevelChange('actor-a', cat.key, cat.level, cat.level + 1, { tx, tenantId: at.tenantId })
      await upsertModelProfileMapEntry({ profile_id: 'routine_lowcost', model_id: 'model-a', updated_by: 'actor-a' }, tx)
      await setAgentSetting('agent-a', 'auto_restart', { enabled: true }, 'default', tx)
    }))
    expect(counts).toEqual({ tx: 1, outsideTx: 0 })
  })

  it('the commit: every row lands, the audit row carries the resolved tenant, both caches follow', async () => {
    await loadModelProfileMapCacheAsync()
    await loadAgentSettingsCacheAsync()
    const cat = await seedCategory()
    const at = await auditTenantOf('actor-a')
    await inFleetImportTransaction((tx) => writeRows(tx, cat, at))
    expect((await autonomyRow(cat.key))?.label).toBe('Label A')
    expect(await profileRow()).toEqual({ model_id: 'model-a', updated_by: 'actor-a' })
    expect(JSON.parse((await settingRow())?.setting_value ?? 'null')).toEqual({ enabled: true })
    const audit = await auditRows()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ entity: 'approval', entity_id: cat.key, tenant_id: at.tenantId })
    expect(JSON.parse(audit[0]!.detail ?? 'null')).toMatchObject({ autonomy_category: cat.key, level_from: cat.level, level_to: cat.level + 1 })
    expect(cachedModelProfileMapEntry('routine_lowcost')?.model_id).toBe('model-a')
    expect(cachedAgentSetting('agent-a', 'auto_restart')?.setting_value).toBe(JSON.stringify({ enabled: true }))
  })

  it('the rollback: a throw after the writes takes the rows and the audit row back', async () => {
    const cat = await seedCategory()
    const profileBefore = await profileRow()
    const at = await auditTenantOf('actor-a')
    await expect(inFleetImportTransaction(async (tx) => {
      await writeRows(tx, cat, at)
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect((await autonomyRow(cat.key))?.label).toBe(cat.label)
    expect(await profileRow()).toEqual(profileBefore)
    expect(await settingRow()).toBeUndefined()
    expect(await auditRows()).toEqual([])
  })

  it('a refused audit row does not abort the change it describes: the savepoint takes only the audit insert back', async () => {
    const cat = await seedCategory()
    const at = await auditTenantOf('actor-a')
    await refuseWrite(dbx, { name: 'no_audit_row', table: 'agent_audit_log', message: 'audit refused' })
    await inFleetImportTransaction((tx) => writeRows(tx, cat, at)) // must not reject: on PG a swallowed failure without a savepoint leaves the transaction aborted
    expect((await autonomyRow(cat.key))?.label).toBe('Label A')
    expect(await profileRow()).toEqual({ model_id: 'model-a', updated_by: 'actor-a' })
    expect(await auditRows()).toEqual([])
  })
})

// ---- cost budgets, egress allowlist, skill seeds, the tenant list, the memory index rebuild ---------------------------

const budget = (id: string, amount: number) => ({ id, amount })
const skillSeed = { id: 'skill/seed-a', name: 'seed-a', description: 'd', content: 'body', tenant_id: 'default', is_global: false }
const skillRows = async () => dbx.all<{ id: string }>("SELECT id FROM skills WHERE id = 'skill/seed-a'")
const revisionRows = async () => dbx.all<{ action: string; source_ref: string | null }>("SELECT action, source_ref FROM skill_revisions WHERE skill_id = 'skill/seed-a'")
const egressRows = async () => dbx.all<{ value: string; added_by: string }>("SELECT value, added_by FROM egress_allowlist WHERE value IN ('old.example', 'new.example') ORDER BY value")

async function seedTenants(): Promise<void> {
  await dbx.run("INSERT INTO tenants (id, display_name, created_at) VALUES ('t-on', 'On', 1)")
  await dbx.run("INSERT INTO tenants (id, display_name, created_at, disabled_at) VALUES ('t-off', 'Off', 1, 2)")
}

async function seedBefore(): Promise<void> {
  await replaceCostBudgets('default', [budget('b-old', 1)])
  await mergeEgressAllowlistEntries([{ value: 'old.example', type: 'domain', added_by: 'actor-old' }])
}

/** The remaining writers of the import body, on the handle. Resolves to the tenant ids the handle read. */
async function writeTail(tx: Tx): Promise<string[]> {
  await replaceCostBudgets('default', [budget('b-new', 2)], tx)
  await mergeEgressAllowlistEntries([
    { value: 'old.example', type: 'domain', added_by: 'actor-new' }, // already there: left completely untouched
    { value: 'new.example', type: 'domain', added_by: 'actor-new' },
  ], tx)
  expect(await seedSkillIfAbsent(skillSeed, { kind: 'import', id: null }, { sourceRef: 'fleet-transfer' }, tx)).toBe(true)
  const tenants = await listEnabledTenantIds(tx)
  await rebuildMemoriesFts(tx)
  return tenants
}

describe('cost budgets, egress allowlist, skill seeds, tenant list and index rebuild on the import handle', () => {
  it('the handle: one transaction and no plain facade call while the body runs', async () => {
    await seedTenants()
    await seedBefore()
    const counts = await countFacadeCalls(dbx, () => inFleetImportTransaction(async (tx) => { await writeTail(tx) }))
    expect(counts).toEqual({ tx: 1, outsideTx: 0 })
  })

  it('the commit: budgets replaced, egress merged without touching the existing row, skill row and its revision written', async () => {
    await seedTenants()
    await seedBefore()
    let tenants: string[] = []
    await inFleetImportTransaction(async (tx) => { tenants = await writeTail(tx) })
    expect(await listCostBudgets('default')).toEqual([expect.objectContaining({ id: 'b-new', amount: 2 })])
    expect(await egressRows()).toEqual([{ value: 'new.example', added_by: 'actor-new' }, { value: 'old.example', added_by: 'actor-old' }])
    expect(await skillRows()).toEqual([{ id: 'skill/seed-a' }])
    expect(await revisionRows()).toEqual([{ action: 'seed', source_ref: 'fleet-transfer' }])
    expect(tenants).toContain('t-on')
    expect(tenants).not.toContain('t-off') // a disabled tenant is not offered to the schedule import
  })

  it('the rollback: a throw after the writes restores the budgets (the DELETE too), the allowlist, the skills', async () => {
    await seedTenants()
    await seedBefore()
    await expect(inFleetImportTransaction(async (tx) => {
      await writeTail(tx)
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect((await listCostBudgets('default')).map((b) => b.id)).toEqual(['b-old'])
    expect(await egressRows()).toEqual([{ value: 'old.example', added_by: 'actor-old' }])
    expect(await skillRows()).toEqual([])
    expect(await revisionRows()).toEqual([])
  })

  it('rebuildMemoriesFts: SQLite brings the index up to date on the handle, Postgres has none and does nothing', async () => {
    await dbx.run("INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated) VALUES ('', 'quokka-needle', 'semantic', 1, 5, 5, 'agent-a', 'warm', 0)")
    if (testDbMode() === 'sqlite') {
      await dbx.run("INSERT INTO memories_fts(memories_fts) VALUES('delete-all')") // the index forgets everything
      const hits = () => dbx.all("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'quokka'")
      expect(await hits()).toHaveLength(0)
      await inFleetImportTransaction((tx) => rebuildMemoriesFts(tx))
      expect(await hits()).toHaveLength(1)
    } else {
      await expect(inFleetImportTransaction((tx) => rebuildMemoriesFts(tx))).resolves.toBeUndefined()
    }
  })
})

describe('setDesiredAgents', () => {
  it('without a handle a refused write is logged and swallowed, as before', async () => {
    await refuseWrite(dbx, { name: 'no_desired_row', table: 'system_config', message: 'insert refused', when: { column: 'key', equals: 'agents_desired' } })
    await expect(setDesiredAgents(['agent-a'])).resolves.toBeUndefined()
    expect(await valueOf('agents_desired')).toBeUndefined()
  })

  it('with a handle the refusal is rethrown, so the caller rolls back instead of committing into a failed transaction', async () => {
    await refuseWrite(dbx, { name: 'no_desired_row', table: 'system_config', message: 'insert refused', when: { column: 'key', equals: 'agents_desired' } })
    await expect(inFleetImportTransaction(async (tx) => {
      await setSystemConfig('probe_single', 'v1', 'db', tx)
      await setDesiredAgents(['agent-a'], tx)
    })).rejects.toThrow('insert refused')
    expect(await valueOf('probe_single')).toBeUndefined()
  })
})
