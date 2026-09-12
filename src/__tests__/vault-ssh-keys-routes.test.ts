// Route-level tests for vault-ssh-keys.ts (#751 step 15). Before this file,
// only fleet-transfer-vault-ssh.test.ts touched this module, and only via
// the export/import bundle path -- the route handler itself (generate,
// import, list, public-key lookup, delete) had zero direct tests.
//
// node:child_process (ssh-keygen) and node:fs (the scratch tmp-dir dance
// around it) are mocked so no real key material is ever generated on disk.
// vault.js (the generic secret store) is mocked the same way
// connectors-routes.test.ts mocks it. db.js is real (in-memory sqlite) --
// the vault_ssh_keys CRUD itself is already covered elsewhere; this file's
// job is the HTTP layer wrapped around it (validation, tenant scoping,
// error shapes).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

const ED25519_PUB = 'ssh-ed25519 ' + Buffer.from('ed25519-fixture-bytes').toString('base64') + ' test@marveen'
const RSA_PUB = 'ssh-rsa ' + Buffer.from('rsa-fixture-bytes').toString('base64') + ' test@marveen'
const ECDSA_PUB = 'ecdsa-sha2-nistp256 ' + Buffer.from('ecdsa-fixture-bytes').toString('base64') + ' test@marveen'
const UNKNOWN_PUB = 'ssh-dss ' + Buffer.from('dss-fixture-bytes').toString('base64') + ' test@marveen'
// Not a real PEM/OpenSSH block on purpose -- the route only ever writes this
// string opaquely to a (mocked) scratch file and passes it to (mocked)
// ssh-keygen; nothing in this test suite parses its structure.
const PRIVATE_KEY_FIXTURE = 'FAKE-SSH-PRIVATE-KEY-MATERIAL-fixture-not-a-real-key'

const execFileSync = vi.fn(() => ED25519_PUB)

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSync(...(args as [])),
}))

// Partial mock: initDatabase() needs the real readdirSync/statSync/readFileSync
// to load migration files from disk, so only the scratch-tmp-dir functions
// vault-ssh-keys.ts actually calls are overridden.
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
const getSecret = vi.fn().mockReturnValue(null)
const deleteSecret = vi.fn()
vi.mock('../web/vault.js', () => ({
  setSecret: (...a: unknown[]) => setSecret(...(a as [])),
  getSecret: (...a: unknown[]) => getSecret(...(a as [])),
  deleteSecret: (...a: unknown[]) => deleteSecret(...(a as [])),
}))

import { tryHandleVaultSshKeys, extractPublicKeyFromVault } from '../web/routes/vault-ssh-keys.js'

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  execFileSync.mockClear().mockImplementation(() => ED25519_PUB)
  setSecret.mockClear()
  getSecret.mockClear().mockReturnValue(null)
  deleteSecret.mockClear()
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

describe('tryHandleVaultSshKeys', () => {
  it('returns false for an unrelated path', async () => {
    const { ctx } = makeCtx('GET', '/api/other')
    expect(await tryHandleVaultSshKeys(ctx)).toBe(false)
  })

  it('returns false for an unsupported method under the ssh-keys prefix', async () => {
    const { ctx } = makeCtx('PUT', '/api/vault/ssh-keys')
    expect(await tryHandleVaultSshKeys(ctx)).toBe(false)
  })

  describe('extractPublicKeyFromVault', () => {
    it('returns null without touching the filesystem when the secret is missing', () => {
      getSecret.mockReturnValue(null)
      expect(extractPublicKeyFromVault('ssh-key-missing')).toBeNull()
    })

    it('derives the public key from the stored private key', () => {
      getSecret.mockReturnValue(PRIVATE_KEY_FIXTURE)
      execFileSync.mockImplementation(() => ED25519_PUB + '\n')
      expect(extractPublicKeyFromVault('ssh-key-present')).toBe(ED25519_PUB)
      expect(getSecret).toHaveBeenCalledWith('ssh-key-present')
    })
  })

  describe('GET /api/vault/ssh-keys', () => {
    it('lists only the caller tenant\'s keys for a non-admin', async () => {
      await tryHandleVaultSshKeys(makeCtx('POST', '/api/vault/ssh-keys', {
        body: { label: 'tenant-a key', username: 'deploy' }, role: 'user', tenantId: 'tenant-a',
      }).ctx)
      await tryHandleVaultSshKeys(makeCtx('POST', '/api/vault/ssh-keys', {
        body: { label: 'tenant-b key', username: 'deploy' }, role: 'user', tenantId: 'tenant-b',
      }).ctx)

      const { ctx, out } = makeCtx('GET', '/api/vault/ssh-keys', { role: 'user', tenantId: 'tenant-a' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.body.keys.map((k: any) => k.label)).toEqual(['tenant-a key'])
    })

    it('admin without ?tenant sees every tenant', async () => {
      const { ctx, out } = makeCtx('GET', '/api/vault/ssh-keys', { role: 'admin' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      const labels = out.body.keys.map((k: any) => k.label)
      expect(labels).toContain('tenant-a key')
      expect(labels).toContain('tenant-b key')
    })

    it('admin with ?tenant= narrows to that tenant', async () => {
      const { ctx, out } = makeCtx('GET', '/api/vault/ssh-keys?tenant=tenant-b', { role: 'admin' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.body.keys.map((k: any) => k.label)).toEqual(['tenant-b key'])
    })

    it('returns the API shape with fingerprint/keyType/createdAt derived fields', async () => {
      const { ctx, out } = makeCtx('GET', '/api/vault/ssh-keys?tenant=tenant-a', { role: 'admin' })
      await tryHandleVaultSshKeys(ctx)
      const key = out.body.keys[0]
      expect(key.fingerprint).toMatch(/^SHA256:/)
      expect(key.keyType).toBe('ed25519')
      expect(typeof key.createdAt).toBe('string')
      expect(key.publicKey).toBe(ED25519_PUB)
    })
  })

  describe('POST /api/vault/ssh-keys', () => {
    it('400s when label is missing', async () => {
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-keys', { body: { username: 'deploy' }, role: 'user', tenantId: 'default' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(400)
    })

    it('400s when username is missing', async () => {
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-keys', { body: { label: 'x' }, role: 'user', tenantId: 'default' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(400)
    })

    it('generates a key pair, stores the private key in the vault, and 201s', async () => {
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-keys', {
        body: { label: 'deploy key', username: 'deploy' }, role: 'user', tenantId: 'my-tenant',
      })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(201)
      expect(out.body.publicKey).toBe(ED25519_PUB)
      expect(out.body.key.label).toBe('deploy key')
      expect(out.body.key.keyType).toBe('ed25519')
      expect(setSecret).toHaveBeenCalledWith(
        expect.stringMatching(/^ssh-key-/), expect.any(String), PRIVATE_KEY_FIXTURE, 'my-tenant',
      )
    })

    it('non-admin ignores a supplied tenant_id and uses ctx.tenantId', async () => {
      const { ctx } = makeCtx('POST', '/api/vault/ssh-keys', {
        body: { label: 'spoof attempt', username: 'deploy', tenant_id: 'other-tenant' }, role: 'user', tenantId: 'my-tenant',
      })
      await tryHandleVaultSshKeys(ctx)
      expect(setSecret).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), 'my-tenant')
    })

    it('admin can target an explicit tenant_id in the body', async () => {
      const { ctx } = makeCtx('POST', '/api/vault/ssh-keys', {
        body: { label: 'admin-targeted', username: 'deploy', tenant_id: 'chosen-tenant' }, role: 'admin',
      })
      await tryHandleVaultSshKeys(ctx)
      expect(setSecret).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), 'chosen-tenant')
    })

    it('500s when the request body is not valid JSON', async () => {
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-keys', { body: '{not json', role: 'user', tenantId: 'default' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(500)
      expect(out.body.error).toBe('internal_error')
    })
  })

  describe('POST /api/vault/ssh-keys/import', () => {
    it('400s when privateKey is missing', async () => {
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-keys/import', {
        body: { label: 'x', username: 'deploy' }, role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(400)
    })

    it('imports an ed25519 key and autodetects the type', async () => {
      execFileSync.mockImplementation(() => ED25519_PUB)
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-keys/import', {
        body: { label: 'imported', username: 'deploy', privateKey: PRIVATE_KEY_FIXTURE }, role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(201)
      expect(out.body.key.keyType).toBe('ed25519')
    })

    it('imports an rsa key and autodetects the type', async () => {
      execFileSync.mockImplementation(() => RSA_PUB)
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-keys/import', {
        body: { label: 'imported-rsa', username: 'deploy', privateKey: PRIVATE_KEY_FIXTURE }, role: 'user', tenantId: 'default',
      })
      await tryHandleVaultSshKeys(ctx)
      expect(out.body.key.keyType).toBe('rsa')
    })

    it('imports an ecdsa key and autodetects the type', async () => {
      execFileSync.mockImplementation(() => ECDSA_PUB)
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-keys/import', {
        body: { label: 'imported-ecdsa', username: 'deploy', privateKey: PRIVATE_KEY_FIXTURE }, role: 'user', tenantId: 'default',
      })
      await tryHandleVaultSshKeys(ctx)
      expect(out.body.key.keyType).toBe('ecdsa')
    })

    it('falls back to "unknown" for an unrecognised public key prefix', async () => {
      execFileSync.mockImplementation(() => UNKNOWN_PUB)
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-keys/import', {
        body: { label: 'imported-unknown', username: 'deploy', privateKey: PRIVATE_KEY_FIXTURE }, role: 'user', tenantId: 'default',
      })
      await tryHandleVaultSshKeys(ctx)
      expect(out.body.key.keyType).toBe('unknown')
    })

    it('400s with invalid_value when ssh-keygen rejects the private key', async () => {
      execFileSync.mockImplementation(() => { throw new Error('not a valid key') })
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-keys/import', {
        body: { label: 'bad', username: 'deploy', privateKey: 'not-a-real-key' }, role: 'user', tenantId: 'default',
      })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('invalid_value')
    })

    it('500s when the request body is not valid JSON', async () => {
      const { ctx, out } = makeCtx('POST', '/api/vault/ssh-keys/import', { body: '{not json', role: 'user', tenantId: 'default' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(500)
      expect(out.body.error).toBe('internal_error')
    })
  })

  describe('GET /api/vault/ssh-keys/:id/public-key', () => {
    it('returns the public key, fingerprint and keyType for an owned key', async () => {
      const { ctx: createCtx, out: createOut } = makeCtx('POST', '/api/vault/ssh-keys', {
        body: { label: 'pubkey-lookup', username: 'deploy' }, role: 'user', tenantId: 'default',
      })
      await tryHandleVaultSshKeys(createCtx)
      const id = createOut.body.key.id

      const { ctx, out } = makeCtx('GET', `/api/vault/ssh-keys/${id}/public-key`, { role: 'user', tenantId: 'default' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.body).toEqual({ publicKey: ED25519_PUB, fingerprint: expect.stringMatching(/^SHA256:/), keyType: 'ed25519' })
    })

    it('404s for a non-existent id', async () => {
      const { ctx, out } = makeCtx('GET', '/api/vault/ssh-keys/does-not-exist/public-key', { role: 'user', tenantId: 'default' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('404s (not 403) when a non-admin requests a key belonging to another tenant', async () => {
      const { ctx: createCtx, out: createOut } = makeCtx('POST', '/api/vault/ssh-keys', {
        body: { label: 'other-tenant-key', username: 'deploy' }, role: 'admin', tenantId: null,
      })
      await tryHandleVaultSshKeys(createCtx)
      const id = createOut.body.key.id

      const { ctx, out } = makeCtx('GET', `/api/vault/ssh-keys/${id}/public-key`, { role: 'user', tenantId: 'unrelated-tenant' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })
  })

  describe('DELETE /api/vault/ssh-keys/:id', () => {
    it('deletes the key row and the underlying vault secret', async () => {
      const { ctx: createCtx, out: createOut } = makeCtx('POST', '/api/vault/ssh-keys', {
        body: { label: 'to-delete', username: 'deploy' }, role: 'user', tenantId: 'default',
      })
      await tryHandleVaultSshKeys(createCtx)
      const id = createOut.body.key.id
      const vaultKeyId = `ssh-key-${id}`

      const { ctx, out } = makeCtx('DELETE', `/api/vault/ssh-keys/${id}`, { role: 'user', tenantId: 'default' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
      expect(typeof out.body.unassigned).toBe('number')
      expect(deleteSecret).toHaveBeenCalledWith(vaultKeyId, 'default')

      const { ctx: getCtx, out: getOut } = makeCtx('GET', `/api/vault/ssh-keys/${id}/public-key`, { role: 'user', tenantId: 'default' })
      await tryHandleVaultSshKeys(getCtx)
      expect(getOut.status).toBe(404)
    })

    it('404s for a non-existent id', async () => {
      const { ctx, out } = makeCtx('DELETE', '/api/vault/ssh-keys/does-not-exist', { role: 'user', tenantId: 'default' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('404s (not 403) when a non-admin deletes a key belonging to another tenant', async () => {
      const { ctx: createCtx, out: createOut } = makeCtx('POST', '/api/vault/ssh-keys', {
        body: { label: 'cross-tenant-delete', username: 'deploy' }, role: 'admin', tenantId: null,
      })
      await tryHandleVaultSshKeys(createCtx)
      const id = createOut.body.key.id

      const { ctx, out } = makeCtx('DELETE', `/api/vault/ssh-keys/${id}`, { role: 'user', tenantId: 'unrelated-tenant' })
      expect(await tryHandleVaultSshKeys(ctx)).toBe(true)
      expect(out.status).toBe(404)
      expect(deleteSecret).not.toHaveBeenCalled()
    })
  })
})
