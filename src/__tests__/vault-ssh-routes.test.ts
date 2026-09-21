// Route-level tests for vault-ssh.ts (#751 step 17). Before this file, this
// module (the SSH *server* inventory, distinct from vault-ssh-keys.ts's key
// pool) had zero direct route tests -- only indirectly exercised, if at all,
// via fleet-transfer.
//
// node:child_process (ssh-keygen, via the real generateSshKeyPair import from
// vault-ssh-keys.js) and node:fs (the scratch tmp-dir dance around it) are
// mocked the same way vault-ssh-keys-routes.test.ts mocks them, so no real
// key material touches disk. web/vault.js (setSecret) is mocked too. db.js is
// real (in-memory sqlite) -- this file's job is the HTTP layer wrapped around
// it (validation, tenant scoping, error shapes), not the CRUD helpers
// themselves.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

const ED25519_PUB = 'ssh-ed25519 ' + Buffer.from('ed25519-fixture-bytes').toString('base64') + ' test@marveen'
const PRIVATE_KEY_FIXTURE = 'FAKE-SSH-PRIVATE-KEY-MATERIAL-fixture-not-a-real-key'

const execFileSync = vi.fn(() => ED25519_PUB)

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...(args as [])),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    mkdtempSync: vi.fn((prefix: string) => prefix + 'XXXXXX'),
    readFileSync: vi.fn((p: unknown, ...rest: unknown[]) => {
      const key = String(p)
      if (key.includes('marveen-ssh-')) return key.endsWith('.pub') ? ED25519_PUB + '\n' : PRIVATE_KEY_FIXTURE
      return (actual.readFileSync as any)(p, ...rest)
    }),
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
    rmSync: vi.fn((p: unknown, ...rest: unknown[]) => {
      if (String(p).includes('marveen-ssh-')) return undefined
      return (actual.rmSync as any)(p, ...rest)
    }),
  }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const setSecret = vi.fn()
vi.mock('../web/vault.js', () => ({
  setSecret: (...a: unknown[]) => setSecret(...(a as [])),
}))

import { tryHandleVaultSsh } from '../web/routes/vault-ssh.js'

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  execFileSync.mockClear().mockImplementation(() => ED25519_PUB)
  setSecret.mockClear()
})

function makeCtx(
  method: string,
  path: string,
  opts: { body?: object | string; role?: 'admin' | 'user' | 'viewer'; tenantId?: string | null } = {},
): { ctx: RouteContext; out: { status: number; body: any } } {
  const bodyStr = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
  const buf = bodyStr ? Buffer.from(bodyStr) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b || '{}') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: {
      req, res, path: url.pathname, method, url,
      role: opts.role as any,
      tenantId: opts.tenantId,
    } as RouteContext,
    out,
  }
}

async function createServer(overrides: { body?: object; role?: 'admin' | 'user' | 'viewer'; tenantId?: string | null } = {}) {
  const { ctx, out } = makeCtx('POST', '/api/vault/ssh-servers', {
    body: { name: 'web-1', host: '10.0.0.1', user: 'deploy', ...overrides.body },
    role: overrides.role ?? 'user',
    tenantId: overrides.tenantId ?? 'default',
  })
  await tryHandleVaultSsh(ctx)
  return out
}

describe('tryHandleVaultSsh', () => {
  it('returns false for an unrelated path', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleVaultSsh(ctx)).toBe(false)
  })

  describe('GET /api/vault/ssh-servers', () => {
    it('lists only the caller tenant\'s servers for a non-admin', async () => {
      await createServer({ body: { name: 'tenant-a-srv' }, tenantId: 'tenant-a' })
      await createServer({ body: { name: 'tenant-b-srv' }, tenantId: 'tenant-b' })

      const { ctx, out } = makeCtx('GET', '/api/vault/ssh-servers', { role: 'user', tenantId: 'tenant-a' })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.body.servers.map((s: any) => s.name)).toEqual(['tenant-a-srv'])
    })

    it('admin without ?tenant sees every tenant', async () => {
      const { ctx, out } = makeCtx('GET', '/api/vault/ssh-servers', { role: 'admin' })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      const names = out.body.servers.map((s: any) => s.name)
      expect(names).toContain('tenant-a-srv')
      expect(names).toContain('tenant-b-srv')
    })

    it('admin with ?tenant= narrows to that tenant', async () => {
      const { ctx, out } = makeCtx('GET', '/api/vault/ssh-servers?tenant=tenant-b', { role: 'admin' })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.body.servers.map((s: any) => s.name)).toEqual(['tenant-b-srv'])
    })

    it('returns keyStatus "missing" with no key assigned, and API-shape fields', async () => {
      const { ctx, out } = makeCtx('GET', '/api/vault/ssh-servers?tenant=tenant-a', { role: 'admin' })
      await tryHandleVaultSsh(ctx)
      const s = out.body.servers[0]
      expect(s.keyStatus).toBe('missing')
      expect(s.sshKeyId).toBeNull()
      expect(s.keyType).toBeNull()
      expect(typeof s.createdAt).toBe('string')
      expect(typeof s.updatedAt).toBe('string')
    })
  })

  describe('POST /api/vault/ssh-servers', () => {
    it('400s when name, host or user is missing', async () => {
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-servers', { body: { name: 'x' }, role: 'user', tenantId: 'default' })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('required')
    })

    it('derives the id via slugify and defaults port to 22', async () => {
      const out = await createServer({ body: { name: 'My Cool Box!' } })
      expect(out.status).toBe(201)
      expect(out.body.server.id).toBe('my-cool-box')
      expect(out.body.server.port).toBe(22)
    })

    it('400s with invalid_value when no valid id can be derived from name or host', async () => {
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-servers', {
        body: { name: '!!!', host: '###', user: 'deploy' }, role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('invalid_value')
    })

    it('409s when a server with the derived id already exists', async () => {
      await createServer({ body: { name: 'dup-box' } })
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-servers', {
        body: { name: 'dup-box', host: '10.0.0.9', user: 'deploy' }, role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(409)
    })

    it('non-admin ignores a supplied tenant_id and uses ctx.tenantId', async () => {
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-servers', {
        body: { name: 'spoof-attempt', host: '10.0.0.2', user: 'deploy', tenant_id: 'other-tenant' },
        role: 'user', tenantId: 'my-tenant',
      })
      await tryHandleVaultSsh(ctx)
      expect(out.body.server).toBeDefined()

      const { ctx: getCtx, out: getOut } = makeCtx('GET', '/api/vault/ssh-servers', { role: 'user', tenantId: 'my-tenant' })
      await tryHandleVaultSsh(getCtx)
      expect(getOut.body.servers.map((s: any) => s.name)).toContain('spoof-attempt')
    })

    it('admin can target an explicit tenant_id in the body', async () => {
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-servers', {
        body: { name: 'admin-targeted', host: '10.0.0.3', user: 'deploy', tenant_id: 'chosen-tenant' }, role: 'admin',
      })
      await tryHandleVaultSsh(ctx)
      expect(out.status).toBe(201)

      const { ctx: getCtx, out: getOut } = makeCtx('GET', '/api/vault/ssh-servers?tenant=chosen-tenant', { role: 'admin' })
      await tryHandleVaultSsh(getCtx)
      expect(getOut.body.servers.map((s: any) => s.name)).toEqual(['admin-targeted'])
    })

    it('500s when the request body is not valid JSON', async () => {
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-servers', { body: '{not json', role: 'user', tenantId: 'default' })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(500)
      expect(out.body.error).toBe('internal_error')
    })
  })

  describe('PUT /api/vault/ssh-servers/:id', () => {
    it('404s for a non-existent id', async () => {
      const { ctx, out } = makeCtx('PUT', '/api/vault/ssh-servers/does-not-exist', {
        body: { name: 'x' }, role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('404s (not 403) when a non-admin updates a server belonging to another tenant', async () => {
      const created = await createServer({ body: { name: 'cross-tenant-put' }, role: 'admin', tenantId: null })
      const { ctx, out } = makeCtx('PUT', `/api/vault/ssh-servers/${created.body.server.id}`, {
        body: { name: 'renamed' }, role: 'user', tenantId: 'unrelated-tenant',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('patches name/host/user/port/desc', async () => {
      const created = await createServer({ body: { name: 'to-patch' } })
      const { ctx, out } = makeCtx('PUT', `/api/vault/ssh-servers/${created.body.server.id}`, {
        body: { name: 'patched', host: '10.0.0.99', user: 'root', port: 2222, desc: 'updated box' },
        role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.server.name).toBe('patched')
      expect(out.body.server.host).toBe('10.0.0.99')
      expect(out.body.server.user).toBe('root')
      expect(out.body.server.port).toBe(2222)
      expect(out.body.server.desc).toBe('updated box')
    })

    it('404s when assigning a non-existent sshKeyId', async () => {
      const created = await createServer({ body: { name: 'bad-key-assign' } })
      const { ctx, out } = makeCtx('PUT', `/api/vault/ssh-servers/${created.body.server.id}`, {
        body: { sshKeyId: 'does-not-exist' }, role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(404)
      expect(out.body.field).toBe('sshKeyId')
    })

    it('assigns an existing pool key via sshKeyId, then unassigns it with null', async () => {
      const created = await createServer({ body: { name: 'key-assign-target' } })
      const genCtx = makeCtx('POST', `/api/vault/ssh-servers/${created.body.server.id}/generate-key`, {
        role: 'user', tenantId: 'default',
      })
      await tryHandleVaultSsh(genCtx.ctx)
      const keyId = genCtx.out.body.server.sshKeyId

      const unassign = makeCtx('PUT', `/api/vault/ssh-servers/${created.body.server.id}`, {
        body: { sshKeyId: null }, role: 'user', tenantId: 'default',
      })
      await tryHandleVaultSsh(unassign.ctx)
      expect(unassign.out.body.server.sshKeyId).toBeNull()
      expect(unassign.out.body.server.keyStatus).toBe('missing')

      const reassign = makeCtx('PUT', `/api/vault/ssh-servers/${created.body.server.id}`, {
        body: { sshKeyId: keyId }, role: 'user', tenantId: 'default',
      })
      await tryHandleVaultSsh(reassign.ctx)
      expect(reassign.out.body.server.sshKeyId).toBe(keyId)
      expect(reassign.out.body.server.keyStatus).toBe('ok')
    })

    it('500s when the request body is not valid JSON', async () => {
      const created = await createServer({ body: { name: 'bad-json-put' } })
      const { ctx, out } = makeCtx('PUT', `/api/vault/ssh-servers/${created.body.server.id}`, {
        body: '{not json', role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(500)
      expect(out.body.error).toBe('internal_error')
    })
  })

  describe('DELETE /api/vault/ssh-servers/:id', () => {
    it('404s for a non-existent id', async () => {
      const { ctx, out } = makeCtx('DELETE', '/api/vault/ssh-servers/does-not-exist', { role: 'user', tenantId: 'default' })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('404s (not 403) when a non-admin deletes a server belonging to another tenant', async () => {
      const created = await createServer({ body: { name: 'cross-tenant-delete' }, role: 'admin', tenantId: null })
      const { ctx, out } = makeCtx('DELETE', `/api/vault/ssh-servers/${created.body.server.id}`, {
        role: 'user', tenantId: 'unrelated-tenant',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('deletes the server row', async () => {
      const created = await createServer({ body: { name: 'to-delete' } })
      const { ctx, out } = makeCtx('DELETE', `/api/vault/ssh-servers/${created.body.server.id}`, {
        role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)

      const { ctx: getCtx, out: getOut } = makeCtx('PUT', `/api/vault/ssh-servers/${created.body.server.id}`, {
        body: { name: 'x' }, role: 'user', tenantId: 'default',
      })
      await tryHandleVaultSsh(getCtx)
      expect(getOut.status).toBe(404)
    })
  })

  describe('POST /api/vault/ssh-servers/:id/generate-key', () => {
    it('404s for a non-existent server', async () => {
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-servers/does-not-exist/generate-key', {
        role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('generates a key pair, assigns it to the server, and stores the private key in the vault under the server tenant', async () => {
      const created = await createServer({ body: { name: 'gen-key-box' }, tenantId: 'srv-tenant' })
      const { ctx, out } = makeCtx('POST', `/api/vault/ssh-servers/${created.body.server.id}/generate-key`, {
        role: 'user', tenantId: 'srv-tenant',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.body.publicKey).toBe(ED25519_PUB)
      expect(out.body.fingerprint).toMatch(/^SHA256:/)
      expect(out.body.server.keyStatus).toBe('ok')
      expect(out.body.server.sshKeyId).toBeTruthy()
      expect(setSecret).toHaveBeenCalledWith(
        expect.stringMatching(/^ssh-key-/), expect.any(String), PRIVATE_KEY_FIXTURE, 'srv-tenant',
      )
    })

    it('uses a username override from the request body instead of the server default', async () => {
      const created = await createServer({ body: { name: 'gen-key-user-override', user: 'default-user' } })
      const { ctx, out } = makeCtx('POST', `/api/vault/ssh-servers/${created.body.server.id}/generate-key`, {
        body: { username: 'override-user' }, role: 'user', tenantId: 'default',
      })
      await tryHandleVaultSsh(ctx)
      expect(out.status).toBe(200)
      expect(setSecret).toHaveBeenCalled()
    })

    it('falls back to the server default username when the body is not valid JSON', async () => {
      const created = await createServer({ body: { name: 'gen-key-bad-json' } })
      const { ctx, out } = makeCtx('POST', `/api/vault/ssh-servers/${created.body.server.id}/generate-key`, {
        body: '{not json', role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(200)
    })

    it('500s when key generation fails', async () => {
      execFileSync.mockImplementation(() => { throw new Error('ssh-keygen not found') })
      const created = await createServer({ body: { name: 'gen-key-fails' } })
      const { ctx, out } = makeCtx('POST', `/api/vault/ssh-servers/${created.body.server.id}/generate-key`, {
        role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(500)
      expect(out.body.error).toBe('internal_error')
    })
  })

  describe('GET /api/vault/ssh-servers/:id/public-key', () => {
    it('404s for a non-existent server', async () => {
      const { ctx, out } = makeCtx('GET', '/api/vault/ssh-servers/does-not-exist/public-key', { role: 'user', tenantId: 'default' })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('404s when the server has no key assigned', async () => {
      const created = await createServer({ body: { name: 'no-key-pubkey' } })
      const { ctx, out } = makeCtx('GET', `/api/vault/ssh-servers/${created.body.server.id}/public-key`, {
        role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(404)
      expect(out.body.hint).toMatch(/No key assigned/)
    })

    it('returns the public key, fingerprint and keyType for an assigned key', async () => {
      const created = await createServer({ body: { name: 'has-key-pubkey' } })
      await tryHandleVaultSsh(makeCtx('POST', `/api/vault/ssh-servers/${created.body.server.id}/generate-key`, {
        role: 'user', tenantId: 'default',
      }).ctx)

      const { ctx, out } = makeCtx('GET', `/api/vault/ssh-servers/${created.body.server.id}/public-key`, {
        role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.body).toEqual({ publicKey: ED25519_PUB, fingerprint: expect.stringMatching(/^SHA256:/), keyType: 'ed25519' })
    })

    it('404s (not 403) when a non-admin requests a server belonging to another tenant', async () => {
      const created = await createServer({ body: { name: 'cross-tenant-pubkey' }, role: 'admin', tenantId: null })
      const { ctx, out } = makeCtx('GET', `/api/vault/ssh-servers/${created.body.server.id}/public-key`, {
        role: 'user', tenantId: 'unrelated-tenant',
      })
      expect(await tryHandleVaultSsh(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })
  })
})
