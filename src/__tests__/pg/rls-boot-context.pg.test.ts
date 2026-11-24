// The boot runs as the app role (marveen_app, no BYPASSRLS, FORCE on every table) and carries no db context of its own, so
// every boot step that reads or writes a global table has to open its OWN system context (db/background-jobs.ts: the
// jobs pg-boot-caches, rbac-mode-load, boot-marker). An empty context sees ZERO rows, it does not fail: before this, the
// caches booted empty and the stored RBAC mode was never applied. Each cell seeds through the admin pool (the oracle that the
// row exists) and boots through the app URL, with NO runAs around the boot call: a wrapper in the test would hide the gap.
//
// Privacy: neutral fixtures only.
import { afterEach, afterAll, describe, expect, it } from 'vitest'
import { createPgTestDb, type PgTestDb } from '../helpers/pg-test-db.js'
import { bootPgBackend, closePgBackend } from '../../db/pg-boot.js'
import { getSystemConfig, listSystemConfig } from '../../db.js'
import { getAgentSetting } from '../../db/agent-settings.js'
import { runAs } from '../../db/context.js'
import { loadRbacMode, getRbacMode, RBAC_MODE_KEY } from '../../web/rbac-mode.js'
import { startBootMarker } from '../../web/boot-marker.js'

const made: PgTestDb[] = []
afterEach(async () => { await closePgBackend() })
afterAll(async () => { for (const d of made) await d.close() })

async function freshDb(): Promise<PgTestDb> {
  const d = await createPgTestDb()
  made.push(d)
  return d
}

describe('the boot of the app role fills what a global read needs', () => {
  it('the system_config and agent_settings caches hold the rows that exist, they do not boot empty', async () => {
    const db = await freshDb()
    await db.pool.query("INSERT INTO system_config (key, value, updated_at) VALUES ('boot_probe_key', 'boot-v', 1)")
    await db.pool.query("INSERT INTO agent_settings (agent_id, setting_key, setting_value, tenant_id) VALUES ('agent-a', 'context_guard', '{\"enabled\":true}', 'tenant-a')")
    await bootPgBackend({ url: db.appUrl })
    // no context here: the synchronous readers answer from the caches the boot filled
    expect(listSystemConfig().map((r) => r.key)).toContain('boot_probe_key')
    expect(getSystemConfig('boot_probe_key')?.value).toBe('boot-v')
    expect(getAgentSetting('agent-a', 'context_guard')?.tenant_id).toBe('tenant-a')
  })

  it('with NO context the app role sees zero rows of a privileged-only table (the cell that keeps the other cells honest)', async () => {
    const db = await freshDb()
    await db.pool.query("INSERT INTO system_config (key, value, updated_at) VALUES ('boot_probe_key', 'boot-v', 1)")
    await bootPgBackend({ url: db.appUrl })
    const seen = await db.appDbx().all('SELECT key FROM system_config')
    expect(seen).toEqual([])
    // the same read in the system context sees the row: the zero above is the policy, not an empty table
    const asSystem = await runAs.system('boot-context-probe', () => db.appDbx().all('SELECT key FROM system_config WHERE key = ?', 'boot_probe_key'))
    expect(asSystem).toHaveLength(1)
  })
})

describe('the stored RBAC mode is applied by a boot as the app role', () => {
  it('a shadow row that the journal confirms is in force after loadRbacMode (an empty read would serve the default)', async () => {
    const db = await freshDb()
    await db.pool.query('INSERT INTO system_config (key, value, updated_at) VALUES ($1, $2, 1)', [RBAC_MODE_KEY, 'shadow'])
    await db.pool.query("INSERT INTO config_change_log (key, old_value, new_value, actor, created_at) VALUES ($1, 'enforce', 'shadow', 'user-a', 1)", [RBAC_MODE_KEY])
    await bootPgBackend({ url: db.appUrl })
    expect(await loadRbacMode(undefined)).toBe('shadow')
    expect(getRbacMode()).toBe('shadow')
    // the row was neither overwritten by the env seed nor lost
    expect((await db.pool.query('SELECT value FROM system_config WHERE key = $1', [RBAC_MODE_KEY])).rows[0]?.value).toBe('shadow')
  })

  it('a database without the row gets the enforce row seeded and journaled by the boot', async () => {
    const db = await freshDb()
    await bootPgBackend({ url: db.appUrl })
    expect(await loadRbacMode(undefined)).toBe('enforce')
    expect((await db.pool.query('SELECT value FROM system_config WHERE key = $1', [RBAC_MODE_KEY])).rows[0]?.value).toBe('enforce')
    expect((await db.pool.query('SELECT count(*)::int AS n FROM config_change_log WHERE key = $1', [RBAC_MODE_KEY])).rows[0]?.n).toBe(1)
  })
})

describe('the boot marker is written by a boot as the app role', () => {
  it('startBootMarker records the boot in system_config (a refused write would answer null and leave no row)', async () => {
    const db = await freshDb()
    await bootPgBackend({ url: db.appUrl })
    const record = await startBootMarker()
    expect(record).not.toBeNull()
    const row = (await db.pool.query("SELECT value FROM system_config WHERE key = 'last_boot'")).rows[0]
    expect(JSON.parse(row.value).boot_id).toBe(record!.boot_id)
  })
})
