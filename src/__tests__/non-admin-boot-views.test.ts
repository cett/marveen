// GET /api/marveen and GET /api/settings are read by EVERY dashboard session at boot. Every role may
// read them (memories:read); the admin gets the full response, anyone else only the allowlisted
// fields; writes stay admin-only. Real route handlers and the real permission table.
//
// Privacy: neutral fixtures only.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteContext } from '../web/routes/types.js'
import { applyRbacGate } from '../web/authz.js'
import { ALL_ROLES, hasPermission, resolveRequiredPermission, type Role } from '../web/rbac.js'
import { NON_ADMIN_MARVEEN_FIELDS, NON_ADMIN_SETTING_KEYS, NON_ADMIN_SETTING_ROW_FIELDS, pickFields } from '../web/non-admin-views.js'

let marveen: typeof import('../web/routes/marveen.js')
let settings: typeof import('../web/routes/settings.js')
let registry: typeof import('../config-registry.js')

beforeEach(async () => {
  vi.resetModules()
  const dbMod = await import('../db.js')
  dbMod.initDatabase(':memory:')
  marveen = await import('../web/routes/marveen.js')
  settings = await import('../web/routes/settings.js')
  registry = await import('../config-registry.js')
})

async function get(handler: 'marveen' | 'settings', role: Role | undefined) {
  const path = handler === 'marveen' ? '/api/marveen' : '/api/settings'
  const out = { status: 0, body: {} as Record<string, any> }
  const res = {
    writeHead: (s: number) => { out.status = s },
    setHeader: () => undefined,
    end: (b?: string) => { if (b) out.body = JSON.parse(b) },
  }
  const ctx = { req: { method: 'GET', headers: {} }, res, path, method: 'GET', url: new URL('http://localhost:3420' + path), role, tenantId: null } as unknown as RouteContext
  const claimed = await (handler === 'marveen' ? marveen.tryHandleMarveen(ctx, '/nonexistent-web-dir') : settings.tryHandleSettings(ctx))
  return { claimed, ...out }
}

describe('permission table', () => {
  it('every role may GET both; the writes and the neighbours stay admin:all', () => {
    for (const p of ['/api/marveen', '/api/settings']) {
      expect(resolveRequiredPermission('GET', p)).toBe('memories:read')
      for (const role of ALL_ROLES) expect(hasPermission(role, 'memories:read'), `${role} ${p}`).toBe(true)
    }
    expect(resolveRequiredPermission('PUT', '/api/marveen')).toBeNull()
    expect(resolveRequiredPermission('POST', '/api/settings')).toBeNull()
    expect(resolveRequiredPermission('GET', '/api/marveen/avatar')).not.toBe('memories:read')
    expect(resolveRequiredPermission('GET', '/api/settings/other')).not.toBe('memories:read')
  })
})

describe('writes stay admin-only through the real gate (enforce)', () => {
  const res = () => ({ writeHead: vi.fn(), setHeader: vi.fn(), end: vi.fn() }) as never
  it.each([['PUT', '/api/marveen'], ['POST', '/api/settings']])('%s %s: a viewer is refused with 403, an admin passes', (method, path) => {
    const viewer = { kind: 'session', user: 'user-a', role: 'viewer', tenantId: 'tenant-a' } as never
    const admin = { kind: 'session', user: 'user-b', role: 'admin', tenantId: null } as never
    const r = res()
    expect(applyRbacGate(viewer, method, path, r, 'enforce')).toBe(false)
    expect((r as unknown as { writeHead: ReturnType<typeof vi.fn> }).writeHead).toHaveBeenCalledWith(403, expect.anything())
    expect(applyRbacGate(admin, method, path, res(), 'enforce')).toBe(true)
  })
  it('the reads pass the gate for a viewer in enforce mode', () => {
    const viewer = { kind: 'session', user: 'user-a', role: 'viewer', tenantId: 'tenant-a' } as never
    for (const p of ['/api/marveen', '/api/settings']) expect(applyRbacGate(viewer, 'GET', p, res(), 'enforce')).toBe(true)
  })
})

describe('GET /api/marveen', () => {
  it('admin gets the full response, instruction files and owner details included', async () => {
    const r = await get('marveen', 'admin')
    expect(r.status).toBe(200)
    for (const k of ['claudeMd', 'soulMd', 'mcpJson', 'ownerName', 'description', 'tmuxSession', 'contextTokens', 'personality', 'model', 'autoRestart']) {
      expect(r.body, k).toHaveProperty(k)
    }
  })

  it.each(['viewer', 'read_only', 'agent'] as const)('%s gets exactly the allowlisted fields, nothing else', async (role) => {
    const full = (await get('marveen', 'admin')).body
    const r = await get('marveen', role)
    expect(r.status).toBe(200)
    expect(Object.keys(r.body).sort()).toEqual([...NON_ADMIN_MARVEEN_FIELDS].filter((f) => f in full).sort())
    expect(r.body['agentId']).toBe(full['agentId'])
    expect(r.body['brandName']).toBe(full['brandName'])
  })

  it('no sensitive field leaks to a non-admin, and a missing role is treated as non-admin (fail closed)', async () => {
    for (const role of ['viewer', undefined] as const) {
      const r = await get('marveen', role)
      for (const k of ['claudeMd', 'soulMd', 'mcpJson', 'ownerName', 'description', 'tmuxSession', 'contextTokens', 'personality', 'model', 'autoRestart', 'telegramBotUsername', 'hasTelegram', 'running']) {
        expect(r.body, `${role}: ${k}`).not.toHaveProperty(k)
      }
    }
  })

  it('the allowlist is a subset of what the admin response actually has (no dead entries)', async () => {
    const full = (await get('marveen', 'admin')).body
    for (const f of NON_ADMIN_MARVEEN_FIELDS) expect(full, f).toHaveProperty(f)
  })
})

describe('GET /api/settings', () => {
  it('admin gets every registry key with the full row', async () => {
    const r = await get('settings', 'admin')
    expect(r.status).toBe(200)
    expect(r.body['settings']).toHaveLength(registry.SETTINGS_REGISTRY.length)
    expect(r.body['settings'][0]).toHaveProperty('description')
  })

  it.each(['viewer', 'read_only', 'agent'] as const)('%s gets only the allowlisted keys with the slim row', async (role) => {
    const r = await get('settings', role)
    expect(r.status).toBe(200)
    const rows = r.body['settings'] as Array<Record<string, unknown>>
    expect(rows.map((x) => x['key'])).toEqual([...NON_ADMIN_SETTING_KEYS])
    for (const row of rows) expect(Object.keys(row).sort()).toEqual([...NON_ADMIN_SETTING_ROW_FIELDS].sort())
  })

  it('no secret setting and no non-allowlisted key leaves the process for a non-admin; a missing role is non-admin', async () => {
    const secretKeys = registry.SETTINGS_REGISTRY.filter((d) => d.secret).map((d) => d.key)
    for (const role of ['viewer', undefined] as const) {
      const text = JSON.stringify((await get('settings', role)).body)
      for (const k of secretKeys) expect(text, `${role}: ${k}`).not.toContain(k)
      expect((await get('settings', role)).body['settings']).toHaveLength(NON_ADMIN_SETTING_KEYS.length)
    }
  })

  it('every allowlisted key exists in the registry and is not a secret', () => {
    for (const k of NON_ADMIN_SETTING_KEYS) {
      const def = registry.SETTINGS_REGISTRY.find((d) => d.key === k)
      expect(def, k).toBeDefined()
      expect(def!.secret, k).toBeFalsy()
    }
  })
})

describe('pickFields', () => {
  it('keeps only named own fields, never inherited ones', () => {
    expect(pickFields({ a: 1, b: 2 }, ['a', 'zzz', 'toString'])).toEqual({ a: 1 })
  })
})
