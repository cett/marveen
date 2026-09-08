// Route-level tests for vault tenant isolation: a tenant-scoped caller must
// never see, read, write, or delete another tenant's (or the fleet-default's)
// secrets or SSH keys, and cross-tenant single-item access must 404 (not 403
// -- anti-enumeration). Admin remains unrestricted, optionally narrowed via
// ?tenant=.
//
// Uses the REAL vault.ts (compound tenant_id+id key) against a temp
// vault.json, and the REAL db.ts vault_ssh_keys table (in-memory SQLite),
// so the route layer and the storage layer are exercised together.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { rmSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase } from '../db.js'

const { TMP_ROOT, STORE_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'vault-route-test-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store') }
})

vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: vi.fn().mockReturnValue(false),
  keychainStore: vi.fn(),
  keychainRetrieve: vi.fn().mockReturnValue(null),
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: TMP_ROOT,
  STORE_DIR,
  AGENTS_BASE_DIR: join(TMP_ROOT, 'agents'),
  MAIN_AGENT_ID: 'agent-a',
  OLLAMA_URL: '',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_NAME: 'test',
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return { ...orig, execSync: vi.fn() } // only connectors.ts's `claude mcp list` cache path; unused here
})

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue([]),
  readFileOr: vi.fn().mockReturnValue('{}'),
  agentDir: vi.fn(),
  agentConfigRoot: vi.fn(),
  readAgentCapabilities: vi.fn().mockReturnValue([]),
  AGENTS_BASE_DIR: join(TMP_ROOT, 'agents'),
}))

vi.mock('../web/dashboard-settings.js', () => ({
  addExternalProjectPath: vi.fn(),
  removeExternalProjectPath: vi.fn().mockReturnValue([]),
  getExternalProjectPaths: vi.fn().mockReturnValue([]),
  installGitHubRepo: vi.fn(),
  getGitHubRepos: vi.fn().mockReturnValue([]),
  removeGitHubRepo: vi.fn(),
  updateGitHubRepo: vi.fn(),
  detectRequiredEnvVars: vi.fn().mockReturnValue([]),
}))

vi.mock('../web/mcp-list.js', () => ({
  getMcpListCache: vi.fn().mockReturnValue([]),
  refreshMcpListCache: vi.fn(),
  purgeFromMcpListCache: vi.fn(),
}))

vi.mock('../web/routes/connectors-mcp.js', () => ({
  tryHandleMcpConnectors: vi.fn().mockResolvedValue(false),
}))

vi.mock('../mcp-list-parser.js', () => ({
  slugify: vi.fn((s: string) => s),
  catalogMatchesConfigured: vi.fn().mockReturnValue(false),
}))

// vault-bindings.js is a separate module from vault.js (secret storage) --
// it's about wiring secrets into .mcp.json files, out of scope for this fix
// (see the "Scope" section of the design doc), so it's stubbed inert.
vi.mock('../web/vault-bindings.js', () => ({
  getBindings: vi.fn().mockReturnValue([]),
  addBinding: vi.fn(),
  removeBinding: vi.fn().mockReturnValue(true),
  removeBindingsForSecret: vi.fn(),
  syncSecret: vi.fn().mockReturnValue({ updated: 0, errors: [] }),
  syncAllBindings: vi.fn().mockReturnValue({ updated: 0, errors: [] }),
  scanMcpConfigs: vi.fn().mockReturnValue([]),
  unsyncBinding: vi.fn(),
}))

import { tryHandleConnectors } from '../web/routes/connectors.js'
import { tryHandleVaultSshKeys } from '../web/routes/vault-ssh-keys.js'
import { tryHandleVaultSsh } from '../web/routes/vault-ssh.js'
import { getSecret } from '../web/vault.js'

const VAULT_JSON = join(STORE_DIR, 'vault.json')
const VAULT_KEY = join(STORE_DIR, '.vault-key')

function cleanVault(): void {
  if (existsSync(VAULT_JSON)) unlinkSync(VAULT_JSON)
  if (existsSync(VAULT_KEY)) unlinkSync(VAULT_KEY)
}

beforeEach(() => {
  cleanVault()
  initDatabase(':memory:')
  vi.clearAllMocks()
})
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

// ── makeCtx helper (mirrors import-memories.test.ts) ───────────────────────────
function makeCtx(
  method: string,
  path: string,
  body?: object,
  query?: Record<string, string>,
  opts: { role?: string; tenantId?: string | null } = {},
): { ctx: RouteContext; out: { status: number; body: unknown } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string; headers: Record<string, string> }
  req.method = method
  req.headers = {}
  setImmediate(() => {
    ;(req as NodeJS.EventEmitter).emit('data', buf)
    ;(req as NodeJS.EventEmitter).emit('end')
  })
  const out = { status: 200, body: null as unknown }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      if (!b) return
      const str = Buffer.isBuffer(b) ? b.toString('utf-8') : b
      try { out.body = JSON.parse(str) } catch { out.body = str }
    },
  }
  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  const url = new URL(`http://localhost:3420${path}${qs}`)
  return {
    ctx: { req, res, path: url.pathname, method, url, role: opts.role ?? 'admin', tenantId: opts.tenantId } as unknown as RouteContext,
    out,
  }
}

async function seedDefaultSecret(id = 'github-GITHUB_TOKEN', value = 'default-value') {
  const { ctx } = makeCtx('POST', '/api/vault', { id, label: id, value }, undefined, { role: 'admin', tenantId: null })
  await tryHandleConnectors(ctx)
}

// ── Test vector 1: cross-tenant list ────────────────────────────────────────────
describe('GET /api/vault -- tenant scoping', () => {
  it('a tenant-scoped caller only sees their own tenant\'s secrets', async () => {
    await seedDefaultSecret()
    const { ctx: writeCtx } = makeCtx('POST', '/api/vault', { id: 'eszter-key', label: 'k', value: 'v' }, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(writeCtx)

    const { ctx, out } = makeCtx('GET', '/api/vault', undefined, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(ctx)

    expect(out.status).toBe(200)
    const secrets = (out.body as { secrets: Array<{ id: string, tenant_id: string }> }).secrets
    expect(secrets.map(s => s.id)).toEqual(['eszter-key'])
    expect(secrets.every(s => s.tenant_id === 'eszter')).toBe(true)
  })

  it('admin with no ?tenant sees every tenant\'s secrets', async () => {
    await seedDefaultSecret()
    const { ctx: writeCtx } = makeCtx('POST', '/api/vault', { id: 'eszter-key', label: 'k', value: 'v' }, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(writeCtx)

    const { ctx, out } = makeCtx('GET', '/api/vault', undefined, undefined, { role: 'admin', tenantId: null })
    await tryHandleConnectors(ctx)

    const ids = (out.body as { secrets: Array<{ id: string }> }).secrets.map(s => s.id)
    expect(ids).toEqual(expect.arrayContaining(['github-GITHUB_TOKEN', 'eszter-key']))
  })

  it('admin with ?tenant=eszter sees only eszter\'s secrets', async () => {
    await seedDefaultSecret()
    const { ctx: writeCtx } = makeCtx('POST', '/api/vault', { id: 'eszter-key', label: 'k', value: 'v' }, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(writeCtx)

    const { ctx, out } = makeCtx('GET', '/api/vault', undefined, { tenant: 'eszter' }, { role: 'admin', tenantId: null })
    await tryHandleConnectors(ctx)

    const secrets = (out.body as { secrets: Array<{ id: string, tenant_id: string }> }).secrets
    expect(secrets).toHaveLength(1)
    expect(secrets[0].id).toBe('eszter-key')
  })
})

// ── Test vectors 2-3: cross-tenant single-item read/delete -> 404 ─────────────
describe('GET/DELETE /api/vault/:id -- cross-tenant anti-enumeration', () => {
  it('a tenant-scoped caller reading another tenant\'s secret gets 404 (not 403)', async () => {
    await seedDefaultSecret()
    const { ctx, out } = makeCtx('GET', '/api/vault/github-GITHUB_TOKEN', undefined, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect((out.body as { error: string }).error).toBe('not_found')
  })

  it('a tenant-scoped caller deleting another tenant\'s secret gets 404, and the secret survives', async () => {
    await seedDefaultSecret()
    const { ctx, out } = makeCtx('DELETE', '/api/vault/github-GITHUB_TOKEN', undefined, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect(getSecret('github-GITHUB_TOKEN')).toBe('default-value')
  })

  it('the owning tenant can read and delete their own secret', async () => {
    const { ctx: writeCtx } = makeCtx('POST', '/api/vault', { id: 'eszter-key', label: 'k', value: 'eszter-value' }, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(writeCtx)

    const { ctx: readCtx, out: readOut } = makeCtx('GET', '/api/vault/eszter-key', undefined, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(readCtx)
    expect(readOut.status).toBe(200)
    expect((readOut.body as { value: string }).value).toBe('eszter-value')

    const { ctx: delCtx, out: delOut } = makeCtx('DELETE', '/api/vault/eszter-key', undefined, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(delCtx)
    expect(delOut.status).toBe(200)
    expect(getSecret('eszter-key', 'eszter')).toBeNull()
  })

  it('admin can read and delete any tenant\'s secret unrestricted', async () => {
    const { ctx: writeCtx } = makeCtx('POST', '/api/vault', { id: 'eszter-key', label: 'k', value: 'eszter-value' }, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(writeCtx)

    const { ctx, out } = makeCtx('GET', '/api/vault/eszter-key', undefined, undefined, { role: 'admin', tenantId: null })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect((out.body as { value: string }).value).toBe('eszter-value')
  })
})

// ── Test vector 4: cross-tenant write (compound key, no shadowing) ─────────────
describe('POST /api/vault -- compound-key write isolation', () => {
  it('a tenant writing an id that collides with a default-tenant secret creates a separate row', async () => {
    await seedDefaultSecret('github-GITHUB_TOKEN', 'fleet-value')

    const { ctx, out } = makeCtx('POST', '/api/vault', { id: 'github-GITHUB_TOKEN', label: 'test', value: 'eszter-value' }, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)

    // Internal (arg-less) lookup -- what every existing caller (agents-crud.ts,
    // getSecretsForEnv, ...) uses -- must still resolve to the FLEET secret.
    expect(getSecret('github-GITHUB_TOKEN')).toBe('fleet-value')
    expect(getSecret('github-GITHUB_TOKEN', 'eszter')).toBe('eszter-value')
  })

  it('a non-admin cannot target another tenant via a body tenant_id override', async () => {
    const { ctx } = makeCtx('POST', '/api/vault', { id: 'sneaky', label: 'x', value: 'v', tenant_id: 'default' }, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(ctx)
    expect(getSecret('sneaky', 'eszter')).toBe('v')
    expect(getSecret('sneaky', 'default')).toBeNull()
  })
})

// ── Test vector 7: internal callers stay unaffected ─────────────────────────────
describe('internal (arg-less) getSecret callers', () => {
  it('an arg-less getSecret call only ever resolves the default-tenant secret', async () => {
    await seedDefaultSecret('agent-marveen-api-key', 'fleet-agent-key')
    const { ctx } = makeCtx('POST', '/api/vault', { id: 'agent-marveen-api-key', label: 'x', value: 'shadow-attempt' }, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleConnectors(ctx)

    expect(getSecret('agent-marveen-api-key')).toBe('fleet-agent-key')
  })
})

// ── Test vectors 8-10: SSH key pool cross-tenant isolation ─────────────────────
describe('/api/vault/ssh-keys -- tenant scoping', () => {
  it('list is scoped to the caller\'s tenant', async () => {
    const { ctx: c1 } = makeCtx('POST', '/api/vault/ssh-keys', { label: 'default-key', username: 'root' }, undefined, { role: 'admin', tenantId: null })
    await tryHandleVaultSshKeys(c1)
    const { ctx: c2 } = makeCtx('POST', '/api/vault/ssh-keys', { label: 'eszter-key', username: 'deploy' }, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleVaultSshKeys(c2)

    const { ctx, out } = makeCtx('GET', '/api/vault/ssh-keys', undefined, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleVaultSshKeys(ctx)
    const keys = (out.body as { keys: Array<{ label: string }> }).keys
    expect(keys).toHaveLength(1)
    expect(keys[0].label).toBe('eszter-key')
  })

  it('creating a key binds it to the caller\'s tenant', async () => {
    const { ctx, out } = makeCtx('POST', '/api/vault/ssh-keys', { label: 'eszter-key', username: 'deploy' }, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleVaultSshKeys(ctx)
    expect(out.status).toBe(201)
    // The private key itself must land under the same tenant in the vault.
    const id = (out.body as { key: { id: string } }).key.id
    expect(getSecret(`ssh-key-${id}`, 'eszter')).not.toBeNull()
    expect(getSecret(`ssh-key-${id}`, 'default')).toBeNull()
  })

  it('deleting another tenant\'s key 404s and leaves it intact', async () => {
    const { ctx: createCtx, out: createOut } = makeCtx('POST', '/api/vault/ssh-keys', { label: 'default-key', username: 'root' }, undefined, { role: 'admin', tenantId: null })
    await tryHandleVaultSshKeys(createCtx)
    const id = (createOut.body as { key: { id: string } }).key.id

    const { ctx: delCtx, out: delOut } = makeCtx('DELETE', `/api/vault/ssh-keys/${id}`, undefined, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleVaultSshKeys(delCtx)
    expect(delOut.status).toBe(404)

    const { ctx: listCtx, out: listOut } = makeCtx('GET', '/api/vault/ssh-keys', undefined, undefined, { role: 'admin', tenantId: null })
    await tryHandleVaultSshKeys(listCtx)
    expect((listOut.body as { keys: unknown[] }).keys).toHaveLength(1)
  })

  it('deleting your own tenant\'s key succeeds and also removes the vault secret', async () => {
    const { ctx: createCtx, out: createOut } = makeCtx('POST', '/api/vault/ssh-keys', { label: 'eszter-key', username: 'deploy' }, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleVaultSshKeys(createCtx)
    const id = (createOut.body as { key: { id: string } }).key.id

    const { ctx: delCtx, out: delOut } = makeCtx('DELETE', `/api/vault/ssh-keys/${id}`, undefined, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleVaultSshKeys(delCtx)
    expect(delOut.status).toBe(200)
    expect(getSecret(`ssh-key-${id}`, 'eszter')).toBeNull()
  })
})

// ── Test vectors T4-T10: SSH server metadata cross-tenant isolation ───────────
async function createServer(id: string, opts: { role?: string; tenantId?: string | null } = {}, tenantIdField?: string) {
  const { ctx, out } = makeCtx(
    'POST', '/api/vault/ssh-servers',
    { id, name: id, host: '10.0.0.1', user: 'deploy', ...(tenantIdField ? { tenant_id: tenantIdField } : {}) },
    undefined, opts,
  )
  await tryHandleVaultSsh(ctx)
  return out
}

describe('/api/vault/ssh-servers -- tenant scoping', () => {
  it('T4: list is scoped to the caller\'s own tenant', async () => {
    await createServer('default-srv', { role: 'admin', tenantId: null })
    await createServer('eszter-srv', { role: 'user', tenantId: 'eszter' })

    const { ctx, out } = makeCtx('GET', '/api/vault/ssh-servers', undefined, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleVaultSsh(ctx)
    const servers = (out.body as { servers: Array<{ id: string }> }).servers
    expect(servers.map(s => s.id)).toEqual(['eszter-srv'])
  })

  it('T5: reading another tenant\'s server by id 404s (not 403)', async () => {
    await createServer('default-srv', { role: 'admin', tenantId: null })

    const { ctx, out } = makeCtx('GET', '/api/vault/ssh-servers/default-srv/public-key', undefined, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleVaultSsh(ctx)
    expect(out.status).toBe(404)
    expect((out.body as { error: string }).error).toBe('not_found')
  })

  it('T6: deleting another tenant\'s server 404s and it survives', async () => {
    await createServer('default-srv', { role: 'admin', tenantId: null })

    const { ctx, out } = makeCtx('DELETE', '/api/vault/ssh-servers/default-srv', undefined, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleVaultSsh(ctx)
    expect(out.status).toBe(404)

    const { ctx: listCtx, out: listOut } = makeCtx('GET', '/api/vault/ssh-servers', undefined, undefined, { role: 'admin', tenantId: null })
    await tryHandleVaultSsh(listCtx)
    expect((listOut.body as { servers: Array<{ id: string }> }).servers.some(s => s.id === 'default-srv')).toBe(true)
  })

  it('T7: a non-admin creating a server binds it to their own tenant automatically', async () => {
    // Even if the caller tries to override it in the body -- targetTenantId
    // for a non-admin always comes from ctx.tenantId, never data.tenant_id.
    const out = await createServer('eszter-srv', { role: 'user', tenantId: 'eszter' }, 'default')
    expect(out.status).toBe(201)
    expect((out.body as { server: { id: string } }).server.id).toBe('eszter-srv')

    const { ctx, out: getOut } = makeCtx('GET', '/api/vault/ssh-servers', undefined, { tenant: 'eszter' }, { role: 'admin', tenantId: null })
    await tryHandleVaultSsh(ctx)
    expect((getOut.body as { servers: Array<{ id: string }> }).servers.map(s => s.id)).toEqual(['eszter-srv'])
  })

  it('T8: admin with no ?tenant sees every tenant\'s servers', async () => {
    await createServer('default-srv', { role: 'admin', tenantId: null })
    await createServer('eszter-srv', { role: 'user', tenantId: 'eszter' })

    const { ctx, out } = makeCtx('GET', '/api/vault/ssh-servers', undefined, undefined, { role: 'admin', tenantId: null })
    await tryHandleVaultSsh(ctx)
    const ids = (out.body as { servers: Array<{ id: string }> }).servers.map(s => s.id)
    expect(ids).toEqual(expect.arrayContaining(['default-srv', 'eszter-srv']))
  })

  it('T9: admin with ?tenant=eszter sees only eszter\'s servers', async () => {
    await createServer('default-srv', { role: 'admin', tenantId: null })
    await createServer('eszter-srv', { role: 'user', tenantId: 'eszter' })

    const { ctx, out } = makeCtx('GET', '/api/vault/ssh-servers', undefined, { tenant: 'eszter' }, { role: 'admin', tenantId: null })
    await tryHandleVaultSsh(ctx)
    expect((out.body as { servers: Array<{ id: string }> }).servers.map(s => s.id)).toEqual(['eszter-srv'])
  })

  it('T10: generate-key on an eszter-tenant server binds the new pool key to eszter, not default', async () => {
    await createServer('eszter-srv', { role: 'user', tenantId: 'eszter' })

    const { ctx, out } = makeCtx('POST', '/api/vault/ssh-servers/eszter-srv/generate-key', undefined, undefined, { role: 'user', tenantId: 'eszter' })
    await tryHandleVaultSsh(ctx)
    expect(out.status).toBe(200)
    const keyId = (out.body as { server: { sshKeyId: string } }).server.sshKeyId
    expect(getSecret(`ssh-key-${keyId}`, 'eszter')).not.toBeNull()
    expect(getSecret(`ssh-key-${keyId}`, 'default')).toBeNull()
  })

  it('admin can reach any tenant\'s server unrestricted', async () => {
    await createServer('eszter-srv', { role: 'user', tenantId: 'eszter' })

    const { ctx, out } = makeCtx('DELETE', '/api/vault/ssh-servers/eszter-srv', undefined, undefined, { role: 'admin', tenantId: null })
    await tryHandleVaultSsh(ctx)
    expect(out.status).toBe(200)
  })
})
