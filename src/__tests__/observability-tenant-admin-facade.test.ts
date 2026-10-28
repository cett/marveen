// W3-7a: the tenant and admin part of src/db/observability.ts on the async facade.
//  - adminPatchDashboardUser: one conditional UPDATE keeps the last active admin (role change and disabled flag),
//  - deleteTenant: one dbx.tx on the tx handle, the vault file step after the commit, idempotent,
//  - updateTenant: the read, the update and the context drop are one transaction,
//  - createPartnerSender: one statement.
// Real in-memory database; vault.json is replaced by a mock (its own suite is vault.test.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const purge = vi.hoisted(() => ({ fn: vi.fn<(tenantId: string) => number>() }))
const log = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('../logger.js', async (orig) => {
  const real = await orig<typeof import('../logger.js')>()
  return { ...real, logger: Object.assign(Object.create(real.logger), { error: log.error }) }
})
vi.mock('../web/vault.js', () => ({ purgeSecretsForTenant: (t: string) => purge.fn(t) }))

import {
  dbx, getDb, initDatabase, createTenant, deleteTenant, updateTenant, getTenant, provisionDashboardUser,
  adminPatchDashboardUser, countActiveAdmins, createPartnerSender, vecExtensionLoaded,
} from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
  purge.fn.mockReset()
  purge.fn.mockReturnValue(0)
})
afterEach(() => { vi.restoreAllMocks() })

function role(id: number): { role: string; disabled: number } {
  return getDb().prepare('SELECT role, disabled FROM dashboard_users WHERE id = ?').get(id) as { role: string; disabled: number }
}

/** Records the SQL of every facade (dbx) statement from now on. */
function spyFacade(): string[] {
  const seen: string[] = []
  for (const m of ['get', 'run', 'all'] as const) {
    const real = dbx[m].bind(dbx) as (...a: unknown[]) => Promise<unknown>
    vi.spyOn(dbx, m).mockImplementation((async (sql: string, ...a: unknown[]) => {
      seen.push(sql.replace(/\s+/g, ' ').trim())
      return real(sql, ...a)
    }) as never)
  }
  return seen
}

describe('adminPatchDashboardUser: the last active admin', () => {
  it('refuses to demote the last active admin and leaves the row as it was', async () => {
    const a = await provisionDashboardUser('only-admin', 'h', 'admin', null)
    const outcome = await adminPatchDashboardUser(a.id, { role: 'viewer', tenant_id: 'default' })
    expect(outcome).toEqual({ status: 'last_admin' })
    expect(role(a.id)).toEqual({ role: 'admin', disabled: 0 })
  })

  it('refuses to disable the last active admin', async () => {
    const a = await provisionDashboardUser('only-admin', 'h', 'admin', null)
    expect(await adminPatchDashboardUser(a.id, { disabled: true })).toEqual({ status: 'last_admin' })
    expect(role(a.id)).toEqual({ role: 'admin', disabled: 0 })
  })

  it('a role change and the disabled flag together do not get past the guard either', async () => {
    const a = await provisionDashboardUser('only-admin', 'h', 'admin', null)
    expect(await adminPatchDashboardUser(a.id, { role: 'viewer', disabled: true, email: 'x@y.z' })).toEqual({ status: 'last_admin' })
    expect(role(a.id)).toEqual({ role: 'admin', disabled: 0 })
    // the refused statement wrote nothing at all, not even the other fields
    expect((getDb().prepare('SELECT email FROM dashboard_users WHERE id = ?').get(a.id) as { email: string | null }).email).toBeNull()
  })

  it('demotes an admin while another active admin remains', async () => {
    const a = await provisionDashboardUser('admin-a', 'h', 'admin', null)
    await provisionDashboardUser('admin-b', 'h', 'admin', null)
    const outcome = await adminPatchDashboardUser(a.id, { role: 'viewer' })
    expect(outcome.status).toBe('updated')
    expect(role(a.id).role).toBe('viewer')
    expect(await countActiveAdmins()).toBe(1)
  })

  it('two concurrent demotions of the two remaining admins: exactly one succeeds', async () => {
    const a = await provisionDashboardUser('admin-a', 'h', 'admin', null)
    const b = await provisionDashboardUser('admin-b', 'h', 'admin', null)
    const outcomes = await Promise.all([
      adminPatchDashboardUser(a.id, { role: 'viewer' }),
      adminPatchDashboardUser(b.id, { role: 'viewer' }),
    ])
    expect(outcomes.map((o) => o.status).sort()).toEqual(['last_admin', 'updated'])
    expect(await countActiveAdmins()).toBe(1)
  })

  it('a concurrent disable and a concurrent demotion of the two admins: exactly one succeeds', async () => {
    const a = await provisionDashboardUser('admin-a', 'h', 'admin', null)
    const b = await provisionDashboardUser('admin-b', 'h', 'admin', null)
    const outcomes = await Promise.all([
      adminPatchDashboardUser(a.id, { disabled: true }),
      adminPatchDashboardUser(b.id, { role: 'viewer' }),
    ])
    expect(outcomes.map((o) => o.status).sort()).toEqual(['last_admin', 'updated'])
    expect(await countActiveAdmins()).toBe(1)
  })

  it('does not refuse a patch that keeps the admin an active admin (email, role admin again, enabling)', async () => {
    const a = await provisionDashboardUser('only-admin', 'h', 'admin', null)
    expect((await adminPatchDashboardUser(a.id, { email: 'a@b.c' })).status).toBe('updated')
    expect((await adminPatchDashboardUser(a.id, { role: 'admin', display_name: 'A' })).status).toBe('updated')
    expect((await adminPatchDashboardUser(a.id, { disabled: false })).status).toBe('updated')
    expect(role(a.id)).toEqual({ role: 'admin', disabled: 0 })
  })

  it('a disabled admin is not counted: it can be demoted while one active admin remains, and the active one stays protected', async () => {
    const active = await provisionDashboardUser('admin-on', 'h', 'admin', null)
    const off = await provisionDashboardUser('admin-off', 'h', 'admin', null)
    await getDb().prepare('UPDATE dashboard_users SET disabled = 1 WHERE id = ?').run(off.id)
    expect((await adminPatchDashboardUser(off.id, { role: 'viewer' })).status).toBe('updated')
    expect(await adminPatchDashboardUser(active.id, { role: 'viewer' })).toEqual({ status: 'last_admin' })
  })

  it('answers not_found for a missing id, not last_admin', async () => {
    await provisionDashboardUser('only-admin', 'h', 'admin', null)
    expect(await adminPatchDashboardUser(424242, { role: 'viewer' })).toEqual({ status: 'not_found' })
  })

  it('the update and the read-back are one statement (no facade read of the old row)', async () => {
    const a = await provisionDashboardUser('admin-a', 'h', 'admin', null)
    await provisionDashboardUser('admin-b', 'h', 'admin', null)
    const seen = spyFacade()
    await adminPatchDashboardUser(a.id, { role: 'viewer' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^UPDATE dashboard_users SET .* RETURNING \*$/)
  })
})

function seedTenantRows(tenant: string): void {
  const d = getDb()
  d.prepare("INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at) VALUES (?, 'h', 'viewer', ?, 0, 0)").run(`u-${tenant}`, tenant)
  d.prepare("INSERT INTO partner_senders (sender_id, tenant_id, display_name, created_by) VALUES (?, ?, 'S', 'x')").run(`s-${tenant}`, tenant)
  d.prepare("INSERT INTO approvals (id, agent_id, category, action_description, status, tenant_id, requested_at) VALUES (?, 'agent-a', 'cat', 'do', 'pending', ?, 1)").run(`ap-${tenant}`, tenant)
  d.prepare("INSERT INTO approval_events (approval_id, tenant_id, event, created_at) VALUES (?, ?, 'consumed', 0)").run(`ap-${tenant}`, tenant)
  d.prepare("INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at, tenant_id) VALUES (?, 't', 'planned', 'normal', 0, 0, ?)").run(`kc-${tenant}`, tenant)
  d.prepare("INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, 'a', 'c', 0)").run(`kc-${tenant}`)
  d.prepare("INSERT INTO memories (chat_id, content, sector, salience, category, agent_id, auto_generated, created_at, accessed_at, tenant_id) VALUES ('c', ?, 'semantic', 1, 'warm', 'agent-a', 0, 0, 0, ?)").run(`m-${tenant}`, tenant)
}

function rows(table: string, column: string, value: string): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number }).n
}

describe('deleteTenant: one transaction on the tx handle', () => {
  it('every SQL statement of the delete runs on the tx handle: none goes through the facade (the vec0 sync is the one ambient join)', async () => {
    await createTenant('gone', 'Gone')
    seedTenantRows('gone')
    const seen = spyFacade()
    await deleteTenant('gone')
    expect(seen.filter((s) => !/^DELETE FROM vec_memories WHERE memory_id = \?$/.test(s))).toEqual([])
    expect(rows('dashboard_users', 'tenant_id', 'gone')).toBe(0)
  })

  it('deletes the kanban children of its cards explicitly (not only through the foreign-key cascade)', async () => {
    await createTenant('gone', 'Gone')
    seedTenantRows('gone')
    getDb().prepare("INSERT INTO labels (id, name, color, created_at, tenant_id) VALUES ('lb', 'l', '#fff', 0, 'gone')").run()
    getDb().prepare("INSERT INTO kanban_card_labels (card_id, label_id, created_at) VALUES ('kc-gone', 'lb', 0)").run()
    getDb().pragma('foreign_keys = OFF') // the cascade would mask a missing explicit delete
    await deleteTenant('gone')
    expect(rows('kanban_comments', 'card_id', 'kc-gone')).toBe(0)
    expect(rows('kanban_card_labels', 'card_id', 'kc-gone')).toBe(0)
    expect(rows('kanban_cards', 'tenant_id', 'gone')).toBe(0)
  })

  it('a failure on the last statement rolls everything back: approvals still pending, rows still there, no file step', async () => {
    await createTenant('gone', 'Gone')
    seedTenantRows('gone')
    getDb().exec("CREATE TRIGGER tenant_delete_blocked BEFORE DELETE ON tenants BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    await expect(deleteTenant('gone')).rejects.toThrow(/blocked/)
    expect(await getTenant('gone')).toBeDefined()
    expect(rows('dashboard_users', 'tenant_id', 'gone')).toBe(1)
    expect(rows('partner_senders', 'tenant_id', 'gone')).toBe(1)
    expect(rows('approvals', 'tenant_id', 'gone')).toBe(1)
    expect(rows('approval_events', 'tenant_id', 'gone')).toBe(1)
    expect(rows('kanban_cards', 'tenant_id', 'gone')).toBe(1)
    expect(rows('kanban_comments', 'card_id', 'kc-gone')).toBe(1)
    expect(rows('memories', 'tenant_id', 'gone')).toBe(1)
    // the reject statement of step 1 was rolled back with the rest: the approval is still pending
    expect((getDb().prepare("SELECT status FROM approvals WHERE id = 'ap-gone'").get() as { status: string }).status).toBe('pending')
    expect(purge.fn).not.toHaveBeenCalled()
  })

  it('the rows of the other tenants are untouched, their pending approvals stay pending', async () => {
    await createTenant('gone', 'Gone')
    await createTenant('sibling', 'Sibling')
    seedTenantRows('gone')
    seedTenantRows('sibling')
    await deleteTenant('gone')
    expect(rows('approvals', 'tenant_id', 'gone')).toBe(0)
    expect(rows('approvals', 'tenant_id', 'sibling')).toBe(1)
    expect(rows('approval_events', 'tenant_id', 'sibling')).toBe(1)
    expect((getDb().prepare("SELECT status FROM approvals WHERE id = 'ap-sibling'").get() as { status: string }).status).toBe('pending')
    expect(rows('dashboard_users', 'tenant_id', 'sibling')).toBe(1)
    expect(rows('kanban_comments', 'card_id', 'kc-sibling')).toBe(1)
    expect(rows('memories', 'tenant_id', 'sibling')).toBe(1)
    expect(await getTenant('sibling')).toBeDefined()
  })

  it('rejects the pending approvals BEFORE it deletes them (a delete trigger sees status rejected)', async () => {
    await createTenant('gone', 'Gone')
    seedTenantRows('gone')
    getDb().exec(`CREATE TABLE approval_probe (status TEXT);
      CREATE TRIGGER approval_probe_ins BEFORE DELETE ON approvals BEGIN INSERT INTO approval_probe (status) VALUES (OLD.status); END`)
    await deleteTenant('gone')
    expect(getDb().prepare('SELECT status FROM approval_probe').all()).toEqual([{ status: 'rejected' }])
  })

  it('drops the memory rows and their vec entries in the same transaction (rollback brings both back)', async (ctx) => {
    if (!vecExtensionLoaded) ctx.skip()
    await createTenant('gone', 'Gone')
    seedTenantRows('gone')
    const id = (getDb().prepare("SELECT id FROM memories WHERE tenant_id = 'gone'").get() as { id: number }).id
    const blob = Buffer.from(new Float32Array(768).fill(0.1).buffer)
    getDb().prepare('INSERT INTO vec_memories(memory_id, embedding) VALUES(?, ?)').run(BigInt(id), blob)
    getDb().exec("CREATE TRIGGER tenant_delete_blocked BEFORE DELETE ON tenants BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    await expect(deleteTenant('gone')).rejects.toThrow(/blocked/)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM vec_memories WHERE memory_id = ?').get(BigInt(id))).toEqual({ n: 1 })
  })
})

describe('deleteTenant: the vault file step', () => {
  it('runs once, after the commit: no transaction open, the tenant row already gone', async () => {
    await createTenant('gone', 'Gone')
    const seenAtPurge: Array<{ inTransaction: boolean; tenantRows: number; arg: string }> = []
    purge.fn.mockImplementation((t: string) => {
      seenAtPurge.push({ inTransaction: getDb().inTransaction, tenantRows: rows('tenants', 'id', 'gone'), arg: t })
      return 3
    })
    const result = await deleteTenant('gone')
    expect(seenAtPurge).toEqual([{ inTransaction: false, tenantRows: 0, arg: 'gone' }])
    expect(result.secretsDeleted).toBe(3)
  })

  it('a vault failure after the commit rejects with the file error, the SQL part stays committed, a second call purges again', async () => {
    await createTenant('gone', 'Gone')
    seedTenantRows('gone')
    purge.fn.mockImplementationOnce(() => { throw new Error('vault write failed') })
    await expect(deleteTenant('gone')).rejects.toThrow('vault write failed')
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'gone' }), expect.stringContaining('repeat the delete'))
    expect(await getTenant('gone')).toBeUndefined()
    expect(rows('dashboard_users', 'tenant_id', 'gone')).toBe(0)

    purge.fn.mockReturnValueOnce(2)
    const second = await deleteTenant('gone')
    expect(purge.fn).toHaveBeenCalledTimes(2)
    expect(second.secretsDeleted).toBe(2)
    expect(second.memoriesDeleted).toBe(0)
  })

  it('two concurrent deletes of the same tenant both resolve; the rows are counted once', async () => {
    await createTenant('gone', 'Gone')
    seedTenantRows('gone')
    const results = await Promise.all([deleteTenant('gone'), deleteTenant('gone')])
    expect(results.map((r) => r.memoriesDeleted).sort()).toEqual([0, 1])
    expect(await getTenant('gone')).toBeUndefined()
  })

  it('refuses the default tenant before it touches anything', async () => {
    await expect(deleteTenant('default')).rejects.toThrow('Cannot delete the default tenant')
    expect(purge.fn).not.toHaveBeenCalled()
  })
})

describe('updateTenant: one transaction', () => {
  it('a failure of the context drop rolls the tenant update back', async () => {
    await createTenant('acme', 'Acme')
    getDb().prepare("INSERT INTO agent_tenant_context (agent_id, tenant_id, status) VALUES ('a', 'acme', 'bound')").run()
    getDb().exec("CREATE TRIGGER ctx_delete_blocked BEFORE DELETE ON agent_tenant_context BEGIN SELECT RAISE(ABORT, 'blocked'); END")
    await expect(updateTenant('acme', { disabled: true })).rejects.toThrow(/blocked/)
    expect((await getTenant('acme'))?.disabled_at).toBeNull()
    expect(rows('agent_tenant_context', 'tenant_id', 'acme')).toBe(1)
  })

  it('reads, updates and drops the context on the tx handle: nothing goes through the facade', async () => {
    await createTenant('acme', 'Acme')
    const seen = spyFacade()
    await updateTenant('acme', { main_agent_id: 'lead', disabled: true })
    expect(seen).toEqual([])
  })

  it('answers null for a missing tenant and returns the row of an empty patch without writing', async () => {
    expect(await updateTenant('nope', { display_name: 'x' })).toBeNull()
    await createTenant('acme', 'Acme')
    const before = getDb().prepare("SELECT * FROM tenants WHERE id = 'acme'").get()
    expect(await updateTenant('acme', {})).toEqual(before)
  })
})

describe('createPartnerSender', () => {
  beforeEach(async () => { await createTenant('pt', 'Partner') })

  it('is one statement and returns the row it wrote', async () => {
    const seen = spyFacade()
    const row = await createPartnerSender('s1', 'pt', 'Sender', 'alice')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^INSERT INTO partner_senders .* RETURNING /)
    expect(row).toMatchObject({ sender_id: 's1', tenant_id: 'pt', display_name: 'Sender', created_by: 'alice', disabled_at: null })
    expect(typeof row.created_at).toBe('number')
  })

  it('a duplicate key rejects with the constraint error', async () => {
    await createPartnerSender('s1', 'pt', 'Sender', 'alice')
    await expect(createPartnerSender('s1', 'pt', 'Again', 'bob')).rejects.toThrow(/UNIQUE|constraint/i)
  })
})
