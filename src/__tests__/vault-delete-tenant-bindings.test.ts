// Integration test: deleting a vault secret only touches the default tenant's bindings and grantee list when
// the DELETED secret belongs to the default tenant.
//
// The bindings (vault_bindings) and the grantee list (vault_secret_acl) are kept under the 'default' tenant,
// and a secret id is unique only per (tenant, id). Before the fix, DELETE /api/vault/:id always ran
// removeBindingsForSecret(id), so deleting another tenant's secret of the same id tore down the default
// tenant's bindings and stripped the env reference from the default MCP file (a silent outage).
//
// Everything here is real: the route, vault.ts (temp vault.json), the DB tables (in-memory SQLite),
// vault-bindings.ts and the MCP file on disk. Only the surroundings that are out of scope are stubbed.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'
import { initDatabase } from '../db.js'

const { TMP_ROOT, STORE_DIR, PROJECT_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  const root = mkdtempSync(join(tmpdir(), 'vault-delete-bindings-'))
  mkdirSync(join(root, 'store'), { recursive: true })
  mkdirSync(join(root, 'project'), { recursive: true })
  return { TMP_ROOT: root, STORE_DIR: join(root, 'store'), PROJECT_DIR: join(root, 'project') }
})

vi.mock('../web/keychain.js', () => ({
  isKeychainAvailable: vi.fn().mockReturnValue(false),
  keychainStore: vi.fn(),
  keychainRetrieve: vi.fn().mockReturnValue(null),
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: PROJECT_DIR,
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
  return { ...orig, execSync: vi.fn() }
})

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue([]),
  readFileOr: (p: string, fallback: string) => {
    try { return require('node:fs').readFileSync(p, 'utf-8') } catch { return fallback }
  },
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

import { tryHandleConnectors } from '../web/routes/connectors.js'
import { getSecret, setSecret } from '../web/vault.js'
import { addBinding, getBindings, getSecretAcl, setSecretAcl, syncSecret } from '../web/vault-bindings.js'

const VAULT_JSON = join(STORE_DIR, 'vault.json')
const VAULT_KEY = join(STORE_DIR, '.vault-key')
const MCP_FILE = join(PROJECT_DIR, '.mcp.json')
const SECRET_ID = 'shared-id'
const ENV_VAR = 'SERVICE_TOKEN'

beforeEach(() => {
  if (existsSync(VAULT_JSON)) unlinkSync(VAULT_JSON)
  if (existsSync(VAULT_KEY)) unlinkSync(VAULT_KEY)
  initDatabase(':memory:')
  mkdirSync(PROJECT_DIR, { recursive: true })
  writeFileSync(MCP_FILE, JSON.stringify({ mcpServers: { svc: { command: 'node', args: ['server.js'] } } }))
})
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

function adminDelete(id: string): Promise<{ status: number }> {
  const req = new EventEmitter() as unknown as NodeJS.EventEmitter & { method: string, headers: Record<string, string> }
  req.method = 'DELETE'
  req.headers = {}
  setImmediate(() => {
    ;(req as NodeJS.EventEmitter).emit('data', Buffer.alloc(0))
    ;(req as NodeJS.EventEmitter).emit('end')
  })
  const out = { status: 200 }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end() {},
  }
  const path = `/api/vault/${id}`
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method: 'DELETE', url, role: 'admin', tenantId: null } as unknown as RouteContext
  return tryHandleConnectors(ctx).then(() => out)
}

/** A default-tenant binding of SECRET_ID into the project MCP file, synced, with a one-entry grantee list. */
async function bindDefaultSecret(): Promise<void> {
  await addBinding({ vaultSecretId: SECRET_ID, envVar: ENV_VAR, targets: [{ mcpFilePath: MCP_FILE, serverName: 'svc' }] })
  await setSecretAcl(SECRET_ID, ['scope:project'])
  const synced = await syncSecret(SECRET_ID)
  expect(synced.errors).toEqual([])
  expect(synced.updated).toBe(1)
}

describe('DELETE /api/vault/:id -- same id in two tenants', () => {
  it('deleting the other tenant\'s secret leaves the default tenant\'s bindings, MCP env reference and grantee list unchanged', async () => {
    // The other tenant's entry is written first, so findSecretTenant(id) resolves it as the owner.
    setSecret(SECRET_ID, 'label-b', 'value-b', 'tenant-b')
    setSecret(SECRET_ID, 'label-default', 'value-default', 'default')
    await bindDefaultSecret()
    const fileBefore = readFileSync(MCP_FILE, 'utf-8')
    const bindingsBefore = await getBindings()
    expect(JSON.parse(fileBefore).mcpServers.svc.env[ENV_VAR]).toBe(`vault:${SECRET_ID}`)
    expect(bindingsBefore).toHaveLength(1)

    const out = await adminDelete(SECRET_ID)

    expect(out.status).toBe(200)
    expect(getSecret(SECRET_ID, 'tenant-b')).toBeNull()
    expect(getSecret(SECRET_ID, 'default')).toBe('value-default')
    expect(await getBindings()).toEqual(bindingsBefore)
    expect(readFileSync(MCP_FILE, 'utf-8')).toBe(fileBefore)
    expect(await getSecretAcl(SECRET_ID)).toEqual(['scope:project'])
  })

  it('deleting the default tenant\'s secret still removes its bindings, the env reference and the grantee list', async () => {
    setSecret(SECRET_ID, 'label-default', 'value-default', 'default')
    await bindDefaultSecret()

    const out = await adminDelete(SECRET_ID)

    expect(out.status).toBe(200)
    expect(getSecret(SECRET_ID, 'default')).toBeNull()
    expect(await getBindings()).toEqual([])
    const svc = JSON.parse(readFileSync(MCP_FILE, 'utf-8')).mcpServers.svc
    expect(svc.env?.[ENV_VAR]).toBeUndefined()
    expect(await getSecretAcl(SECRET_ID)).toEqual([])
  })
})
