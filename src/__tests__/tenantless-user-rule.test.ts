// A dashboard user without a tenant may hold only admin, viewer or read_only. The admin routes already refuse every
// tenant-less non-admin; this is the rule one layer down (the two writers in db/observability.ts), plus the boot
// report of the rows that predate it. Real in-memory database; no existing row is ever changed by the rule.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  initDatabase, getDb, createTenant, provisionDashboardUser, adminPatchDashboardUser, getDashboardUser,
  getDashboardUserById, countTenantlessWriteRoleUsers, dbx,
} from '../db.js'
import { roleNeedsTenant, assertTenantForRole, isBlankTenant, TenantlessRoleError, TENANTLESS_ROLES } from '../db/user-tenant-rule.js'
import { warnTenantlessWriteRoleUsers } from '../web/tenantless-user-check.js'
import { logger } from '../logger.js'

const NOW = () => Math.floor(Date.now() / 1000)

// A row written the way an older version could have written it: the writers refuse it now, so the test inserts it directly.
function legacyRow(username: string, role: string, tenantId: string | null, disabled = 0): number {
  const info = getDb().prepare(
    'INSERT INTO dashboard_users (username, password_hash, role, tenant_id, created_at, updated_at, disabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(username, 'hash', role, tenantId, NOW(), NOW(), disabled)
  return Number(info.lastInsertRowid)
}

beforeEach(async () => {
  initDatabase(':memory:')
  await createTenant('tenant-a', 'Tenant A')
})

afterEach(() => { vi.restoreAllMocks() })

describe('the rule itself', () => {
  it('names exactly admin, viewer and read_only as the tenant-less roles', () => {
    expect([...TENANTLESS_ROLES]).toEqual(['admin', 'viewer', 'read_only'])
  })

  it.each(['admin', 'viewer', 'read_only'])('%s does not need a tenant', (role) => {
    expect(roleNeedsTenant(role)).toBe(false)
  })

  // an allowlist: a role nobody named yet, an empty role and a machine role are all refused (fail closed)
  it.each(['agent', 'fleet_agent', 'superuser', '', 'ADMIN'])('%j needs a tenant', (role) => {
    expect(roleNeedsTenant(role)).toBe(true)
  })

  it('refuses a role that needs a tenant when the tenant is null, undefined, empty or blank', () => {
    for (const t of [null, undefined, '', '   ']) {
      expect(() => assertTenantForRole('agent', t)).toThrow(TenantlessRoleError)
    }
  })

  it('allows it with a tenant, and the three roles without one', () => {
    expect(() => assertTenantForRole('agent', 'tenant-a')).not.toThrow()
    for (const role of TENANTLESS_ROLES) expect(() => assertTenantForRole(role, null)).not.toThrow()
  })

  it('the error is typed and carries the role, not a tenant or a name', () => {
    try { assertTenantForRole('agent', null) } catch (e) {
      expect(e).toBeInstanceOf(TenantlessRoleError)
      expect((e as TenantlessRoleError).code).toBe('tenantless_role')
      expect((e as TenantlessRoleError).role).toBe('agent')
    }
  })
})

describe('provisionDashboardUser', () => {
  it('refuses a tenant-less agent and writes no row', async () => {
    await expect(provisionDashboardUser('user-a', 'hash', 'agent', null)).rejects.toBeInstanceOf(TenantlessRoleError)
    expect(await getDashboardUser('user-a')).toBeUndefined()
  })

  it('refuses a tenant-less unknown role too', async () => {
    await expect(provisionDashboardUser('user-a', 'hash', 'superuser', null)).rejects.toBeInstanceOf(TenantlessRoleError)
    expect(await getDashboardUser('user-a')).toBeUndefined()
  })

  it.each(['admin', 'viewer', 'read_only'])('creates a tenant-less %s', async (role) => {
    const u = await provisionDashboardUser(`user-${role}`, 'hash', role, null)
    expect(u.role).toBe(role)
    expect(u.tenant_id).toBeNull()
  })

  it('creates an agent that has a tenant', async () => {
    const u = await provisionDashboardUser('user-a', 'hash', 'agent', 'tenant-a')
    expect(u.role).toBe('agent')
    expect(u.tenant_id).toBe('tenant-a')
  })
})

describe('adminPatchDashboardUser', () => {
  const rowOf = async (id: number) => (await getDashboardUserById(id))!

  it('refuses to take the tenant from an agent, and the row is unchanged', async () => {
    const id = (await provisionDashboardUser('user-a', 'hash', 'agent', 'tenant-a')).id
    expect(await adminPatchDashboardUser(id, { tenant_id: null })).toEqual({ status: 'tenantless_role' })
    expect((await rowOf(id)).tenant_id).toBe('tenant-a')
  })

  it('refuses a blank tenant the same way', async () => {
    const id = (await provisionDashboardUser('user-a', 'hash', 'agent', 'tenant-a')).id
    expect(await adminPatchDashboardUser(id, { tenant_id: '  ' })).toEqual({ status: 'tenantless_role' })
    expect((await rowOf(id)).tenant_id).toBe('tenant-a')
  })

  it('refuses to make a tenant-less viewer an agent (the stored tenant decides), the row is unchanged', async () => {
    const id = (await provisionDashboardUser('user-v', 'hash', 'viewer', null)).id
    expect(await adminPatchDashboardUser(id, { role: 'agent' })).toEqual({ status: 'tenantless_role' })
    expect((await rowOf(id)).role).toBe('viewer')
  })

  // one reading of "no tenant" (isBlankTenant, JavaScript trim): a SQL TRIM would only strip the spaces
  it.each(['', '   ', '\t', '\n', ' ', ' \t\n  '])('a stored tenant of %j is no tenant: raising the role to agent is refused, the row is unchanged', async (stored) => {
    const id = legacyRow('user-blank', 'viewer', stored)
    expect(await adminPatchDashboardUser(id, { role: 'agent' })).toEqual({ status: 'tenantless_role' })
    const r = await rowOf(id)
    expect([r.role, r.tenant_id]).toEqual(['viewer', stored])
    // giving it a real tenant in the same patch is the way out
    expect((await adminPatchDashboardUser(id, { role: 'agent', tenant_id: 'tenant-a' })).status).toBe('updated')
  })

  it('positive path: a stored real tenant and a role-only patch to agent is updated', async () => {
    const id = legacyRow('user-has-tenant', 'viewer', 'tenant-a')
    const out = await adminPatchDashboardUser(id, { role: 'agent' })
    expect(out.status).toBe('updated')
    const r = await rowOf(id)
    expect([r.role, r.tenant_id]).toEqual(['agent', 'tenant-a'])
  })

  // Another writer changes the row's tenant right after the stored tenant was read. The role raise runs in a transaction
  // (the guarded path), so the read goes through the transaction handle: wrap its `get`.
  function changeTenantAfterTheRead(id: number, to: string): void {
    const realTx = dbx.tx.bind(dbx)
    let done = false
    vi.spyOn(dbx, 'tx').mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) => realTx(async (tx) => {
      const wrapped = Object.create(tx) as { get: (sql: string, ...p: unknown[]) => Promise<unknown> }
      const realGet = (tx as unknown as typeof wrapped).get.bind(tx)
      wrapped.get = async (sql, ...p) => {
        const row = await realGet(sql, ...p)
        if (!done && sql.startsWith('SELECT tenant_id FROM dashboard_users WHERE id')) {
          done = true
          getDb().prepare('UPDATE dashboard_users SET tenant_id = ? WHERE id = ?').run(to, id)
        }
        return row
      }
      return fn(wrapped)
    })) as never)
  }

  it('a tenant that is blanked between the read and the write is not written over: the decision is made again on the fresh value', async () => {
    const id = legacyRow('user-race', 'viewer', 'tenant-a')
    changeTenantAfterTheRead(id, '')
    expect(await adminPatchDashboardUser(id, { role: 'agent' })).toEqual({ status: 'tenantless_role' })
    vi.restoreAllMocks()
    const r = await rowOf(id)
    expect([r.role, r.tenant_id]).toEqual(['viewer', ''])
  })

  it('a tenant that changes to another real one between the read and the write is retried and then updated', async () => {
    const id = legacyRow('user-race-2', 'viewer', 'tenant-a')
    changeTenantAfterTheRead(id, 'tenant-b')
    expect((await adminPatchDashboardUser(id, { role: 'agent' })).status).toBe('updated')
    vi.restoreAllMocks()
    const r = await rowOf(id)
    expect([r.role, r.tenant_id]).toEqual(['agent', 'tenant-b'])
  })

  it('refuses agent and no tenant in the same patch without touching the row', async () => {
    const id = (await provisionDashboardUser('user-v', 'hash', 'viewer', null)).id
    expect(await adminPatchDashboardUser(id, { role: 'agent', tenant_id: null })).toEqual({ status: 'tenantless_role' })
    expect((await rowOf(id)).role).toBe('viewer')
  })

  it('allows the role change when the same patch gives the tenant', async () => {
    const id = (await provisionDashboardUser('user-v', 'hash', 'viewer', null)).id
    const out = await adminPatchDashboardUser(id, { role: 'agent', tenant_id: 'tenant-a' })
    expect(out.status).toBe('updated')
    const r = await rowOf(id)
    expect([r.role, r.tenant_id]).toEqual(['agent', 'tenant-a'])
  })

  it('allows an agent to become a tenant-less viewer or read_only', async () => {
    for (const role of ['viewer', 'read_only']) {
      const id = (await provisionDashboardUser(`user-${role}`, 'hash', 'agent', 'tenant-a')).id
      expect((await adminPatchDashboardUser(id, { role, tenant_id: null })).status).toBe('updated')
      const r = await rowOf(id)
      expect([r.role, r.tenant_id]).toEqual([role, null])
    }
  })

  it('does not lock out a legacy tenant-less agent: an unrelated patch still passes, and giving it a tenant does too', async () => {
    const id = legacyRow('user-legacy', 'agent', null)
    expect((await adminPatchDashboardUser(id, { email: 'x@example.test' })).status).toBe('updated')
    expect((await adminPatchDashboardUser(id, { disabled: true })).status).toBe('updated')
    expect((await adminPatchDashboardUser(id, { tenant_id: 'tenant-a' })).status).toBe('updated')
    expect((await rowOf(id)).tenant_id).toBe('tenant-a')
  })

  it('refuses a patch that keeps a legacy tenant-less agent tenant-less AND changes the tenant field to null again', async () => {
    const id = legacyRow('user-legacy', 'agent', null)
    expect(await adminPatchDashboardUser(id, { tenant_id: null })).toEqual({ status: 'tenantless_role' })
  })

  it('still answers last_admin for the last admin who is demoted to a role that is allowed without a tenant', async () => {
    const id = (await provisionDashboardUser('user-admin', 'hash', 'admin', null)).id
    expect(await adminPatchDashboardUser(id, { role: 'viewer' })).toEqual({ status: 'last_admin' })
  })

  it('answers not_found for an unknown id, with or without a tenant rule in play', async () => {
    expect(await adminPatchDashboardUser(9999, { email: 'x@example.test' })).toEqual({ status: 'not_found' })
    expect(await adminPatchDashboardUser(9999, { role: 'viewer', tenant_id: null })).toEqual({ status: 'not_found' })
    expect(await adminPatchDashboardUser(9999, { tenant_id: null })).toEqual({ status: 'not_found' })
  })
})

describe('the boot report', () => {
  it('counts only tenant-less users whose role needs a tenant, the disabled ones too', async () => {
    expect(await countTenantlessWriteRoleUsers()).toBe(0)
    legacyRow('user-admin', 'admin', null)
    legacyRow('user-viewer', 'viewer', null)
    legacyRow('user-ro', 'read_only', null)
    legacyRow('user-tenant', 'agent', 'tenant-a')
    expect(await countTenantlessWriteRoleUsers()).toBe(0)
    legacyRow('user-legacy-1', 'agent', null)
    legacyRow('user-legacy-2', 'agent', null, 1)
    legacyRow('user-legacy-3', 'agent', '')
    expect(await countTenantlessWriteRoleUsers()).toBe(3)
  })

  it('counts a stored tenant of spaces, a tab, a newline or a no-break space as none (the same reading as the writers)', async () => {
    for (const [i, t] of ['   ', '\t', '\n', ' ', ' \t\n  '].entries()) legacyRow(`user-ws-${i}`, 'agent', t)
    legacyRow('user-real', 'agent', 'tenant-a')
    legacyRow('user-viewer-ws', 'viewer', '\t')
    expect(await countTenantlessWriteRoleUsers()).toBe(5)
  })

  it('the count and the writers read blank the same way for every whitespace sample', () => {
    for (const t of [null, undefined, '', ' ', '\t', '\n', '\r', ' ', ' ', ' \t\n  ']) {
      expect(isBlankTenant(t)).toBe(true)
      expect(() => assertTenantForRole('agent', t)).toThrow(TenantlessRoleError)
    }
    for (const t of ['tenant-a', ' tenant-a ', 'a']) {
      expect(isBlankTenant(t)).toBe(false)
      expect(() => assertTenantForRole('agent', t)).not.toThrow()
    }
  })

  it('warns once with the count for a fixture with one such row, and carries no name', async () => {
    legacyRow('user-legacy-name', 'agent', null)
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    expect(await warnTenantlessWriteRoleUsers()).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    const [obj, msg] = warn.mock.calls[0] as unknown as [Record<string, unknown>, string]
    expect(obj).toEqual({ count: 1 })
    expect(typeof msg).toBe('string')
    expect(JSON.stringify(warn.mock.calls)).not.toContain('user-legacy-name')
  })

  it('does not warn for a clean fixture', async () => {
    legacyRow('user-admin', 'admin', null)
    legacyRow('user-tenant', 'agent', 'tenant-a')
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    expect(await warnTenantlessWriteRoleUsers()).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a failing count logs a warning, answers -1 and does not throw into the boot', async () => {
    vi.spyOn(getDb(), 'prepare').mockImplementation(() => { throw new Error('boom') })
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    expect(await warnTenantlessWriteRoleUsers()).toBe(-1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('the boot sequence calls it after the database is up', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts'), 'utf8')
    // the database boot (which awaits initDatabaseAsync) is bootProcessDatabase, src/process-db-boot.ts, called from main()
    const up = src.indexOf('await bootProcessDatabase()')
    const call = src.indexOf("runAs.system('boot-sequence', () => warnTenantlessWriteRoleUsers())")
    expect(up).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(up)
    const dbBoot = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'process-db-boot.ts'), 'utf8')
    expect(dbBoot).toContain('await initDatabaseAsync()')
  })
})
