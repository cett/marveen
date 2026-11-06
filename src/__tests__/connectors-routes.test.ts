// Route-level tests for connectors.ts (#751 step 12). The existing
// connectors-error-shapes.test.ts and connectors-external-paths.test.ts files
// only cover a handful of error tokens (catalog install/uninstall 500,
// vault-binding no-targets 400, external-paths/github-repos token mapping).
// This file adds the GET /api/connectors listing logic, connector detail/add/
// delete/assign, GET /api/mcp-catalog installed-detection, the whole Vault
// section (secrets, bindings, sync, scan, import), and GET /api/ollama/models
// -- all previously untested.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
}))

// Path-aware fs mock. Only existsSync/readFileSync/readdirSync/statSync are
// intercepted -- writeFileSync/chmodSync/renameSync are never reached because
// atomic-write.js is mocked below, so any success path that would persist to
// disk (add connector, delete connector, assign) stays in-memory.
const mockFsFiles: Record<string, string> = {}
const mockFsDirs: Record<string, string[]> = {}
function setMockFile(path: string, content: string) { mockFsFiles[path] = content }
function setMockDir(path: string, entries: string[]) { mockFsDirs[path] = entries }

vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: unknown) => String(p) in mockFsDirs),
  readFileSync: vi.fn((p: unknown) => {
    const key = String(p)
    if (key.endsWith('mcp-catalog.json')) {
      return JSON.stringify([
        { id: 'local-tool', name: 'Local Tool', type: 'local', command: 'npx', args: ['local-pkg'], env: {}, authType: 'none' },
        { id: 'remote-tool', name: 'Remote Tool', type: 'remote', url: 'https://example.test/mcp', authType: 'none' },
        { id: 'oauth-tool', name: 'OAuth Tool', type: 'remote', url: 'https://example.test/oauth', authType: 'oauth', authNote: 'Complete the OAuth flow in the browser.' },
      ])
    }
    const val = mockFsFiles[key]
    if (val !== undefined) return val
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }),
  readdirSync: vi.fn((p: unknown) => mockFsDirs[String(p)] ?? []),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/mock-root',
  STORE_DIR: '/tmp/mock-store',
  OLLAMA_URL: 'http://mock-ollama:11434',
  MAIN_AGENT_ID: 'main-a',
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue([]),
  readFileOr: vi.fn((path: string, fallback: string) => mockFsFiles[path] ?? fallback),
  AGENTS_BASE_DIR: '/tmp/mock-agents',
}))

vi.mock('../web/dashboard-settings.js', () => ({
  getExternalProjectPaths: vi.fn().mockReturnValue([]),
  addExternalProjectPath: vi.fn(),
  removeExternalProjectPath: vi.fn().mockReturnValue([]),
  getGitHubRepos: vi.fn().mockReturnValue([]),
  installGitHubRepo: vi.fn(),
  removeGitHubRepo: vi.fn(),
  updateGitHubRepo: vi.fn(),
  detectRequiredEnvVars: vi.fn().mockReturnValue([]),
}))

vi.mock('../web/vault.js', () => ({
  listSecrets: vi.fn().mockReturnValue([]),
  setSecret: vi.fn(),
  getSecret: vi.fn().mockReturnValue(null),
  deleteSecret: vi.fn(),
  findSecretTenant: vi.fn().mockReturnValue(null),
}))

// Stand-in for the real partition (granteeOfMcpFile + partitionTargetsByAcl are tested for real in
// vault-bindings.test.ts): the grantee is read from the mocked paths. A function declaration, so the
// hoisted factory below can reference it lazily.
function fakeGranteeOf(p: unknown): string | null {
  if (p === '/tmp/mock-root/.mcp.json') return 'scope:project'
  const m = typeof p === 'string' ? p.match(/^\/tmp\/mock-agents\/([^/]+)\/\.mcp\.json$/) : null
  return m ? `agent:${m[1]}` : null
}
function fakePartition(acl: string[], targets: Array<{ mcpFilePath: string, serverName: string }>) {
  if (acl.length === 0) return { allowed: [...targets], refused: [] }
  const allowed: typeof targets = []
  const refused: Array<{ target: (typeof targets)[number], grantee: string | null }> = []
  for (const target of targets) {
    const grantee = fakeGranteeOf(target.mcpFilePath)
    if (grantee !== null && acl.includes(grantee)) allowed.push(target)
    else refused.push({ target, grantee })
  }
  return { allowed, refused }
}

vi.mock('../web/vault-bindings.js', () => ({
  getBindings: vi.fn().mockResolvedValue([]),
  addBinding: vi.fn().mockResolvedValue(undefined),
  removeBinding: vi.fn().mockResolvedValue(true),
  removeBindingsForSecret: vi.fn().mockResolvedValue(undefined),
  removeSecretAcl: vi.fn().mockResolvedValue(undefined),
  getSecretAcl: vi.fn().mockResolvedValue([]),
  setSecretAcl: vi.fn().mockResolvedValue(undefined),
  getAllSecretAcls: vi.fn().mockResolvedValue({}),
  partitionTargetsByAcl: vi.fn((acl: string[], targets: Array<{ mcpFilePath: string, serverName: string }>) => fakePartition(acl, targets)),
  syncSecret: vi.fn().mockResolvedValue({ updated: 0, errors: [] }),
  syncAllBindings: vi.fn().mockResolvedValue({ updated: 0, errors: [] }),
  scanMcpConfigs: vi.fn().mockReturnValue([]),
  unsyncBinding: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../web/mcp-list.js', () => ({
  getMcpListCache: vi.fn().mockReturnValue({ entries: [], lastRefreshed: 0, refreshing: false }),
  refreshMcpListCache: vi.fn().mockResolvedValue({ entries: [], lastRefreshed: 0, refreshing: false }),
  purgeFromMcpListCache: vi.fn().mockReturnValue(false),
}))

import { tryHandleConnectors } from '../web/routes/connectors.js'
import { execSync } from 'node:child_process'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import { logger } from '../logger.js'
import { listAgentNames } from '../web/agent-config.js'
import {
  getExternalProjectPaths, addExternalProjectPath, removeExternalProjectPath,
  getGitHubRepos, installGitHubRepo, removeGitHubRepo, updateGitHubRepo,
} from '../web/dashboard-settings.js'
import {
  listSecrets, setSecret, getSecret, deleteSecret, findSecretTenant,
} from '../web/vault.js'
import {
  getBindings, addBinding, removeBinding, removeSecretAcl, getSecretAcl, setSecretAcl, getAllSecretAcls, syncSecret, syncAllBindings, scanMcpConfigs,
} from '../web/vault-bindings.js'
import { getMcpListCache, refreshMcpListCache, purgeFromMcpListCache } from '../web/mcp-list.js'

// ── makeCtx ───────────────────────────────────────────────────────────────────

function makeCtx(
  method: string,
  path: string,
  bodyOrRaw?: object | string | null,
  extra: Partial<RouteContext> = {},
): { ctx: RouteContext; out: { status: number; body: Record<string, unknown> } } {
  const buf =
    bodyOrRaw == null
      ? Buffer.alloc(0)
      : typeof bodyOrRaw === 'string'
        ? Buffer.from(bodyOrRaw)
        : Buffer.from(JSON.stringify(bodyOrRaw))
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { method: string; headers: Record<string, string> }).method = method
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  setImmediate(() => {
    ;(req as unknown as EventEmitter).emit('data', buf)
    ;(req as unknown as EventEmitter).emit('end')
  })
  const out: { status: number; body: Record<string, unknown> } = { status: 200, body: {} }
  const res = {
    writeHead(s: number) { out.status = s },
    setHeader(_k: string, _v: string) {},
    end(b?: string | Buffer) {
      const str = b ? (Buffer.isBuffer(b) ? b.toString('utf-8') : b) : ''
      try { out.body = JSON.parse(str) as Record<string, unknown> } catch { /* ignore */ }
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url, ...extra } as unknown as RouteContext,
    out,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(execSync).mockReturnValue('')
  vi.mocked(getMcpListCache).mockReturnValue({ entries: [], lastRefreshed: 0, refreshing: false })
  vi.mocked(refreshMcpListCache).mockResolvedValue({ entries: [], lastRefreshed: 0, refreshing: false })
  vi.mocked(purgeFromMcpListCache).mockReturnValue(false)
  vi.mocked(listAgentNames).mockReturnValue([])
  vi.mocked(getExternalProjectPaths).mockReturnValue([])
  vi.mocked(listSecrets).mockReturnValue([])
  vi.mocked(findSecretTenant).mockReturnValue(null)
  vi.mocked(getSecret).mockReturnValue(null)
  vi.mocked(getBindings).mockResolvedValue([])
  vi.mocked(removeBinding).mockResolvedValue(true)
  vi.mocked(getSecretAcl).mockResolvedValue([])
  vi.mocked(getAllSecretAcls).mockResolvedValue({})
  vi.mocked(syncSecret).mockResolvedValue({ updated: 0, errors: [] })
  vi.mocked(syncAllBindings).mockResolvedValue({ updated: 0, errors: [] })
  vi.mocked(scanMcpConfigs).mockReturnValue([])
  for (const k of Object.keys(mockFsFiles)) delete mockFsFiles[k]
  for (const k of Object.keys(mockFsDirs)) delete mockFsDirs[k]
})

// ── GET /api/connectors ────────────────────────────────────────────────────────

describe('GET /api/connectors', () => {
  it('lists enabled plugins from ~/.claude/settings.json, deduped by base name', async () => {
    setMockFile('/tmp/mock-root/.mcp.json', '{}')
    setMockFile(require('node:path').join(require('node:os').homedir(), '.claude.json'), '{}')
    setMockFile(require('node:path').join(require('node:os').homedir(), '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'telegram@myorg': true, 'gmail@myorg': false },
    }))
    const { ctx, out } = makeCtx('GET', '/api/connectors')
    await tryHandleConnectors(ctx)
    const connectors = out.body as unknown as Array<Record<string, unknown>>
    expect(Array.isArray(connectors)).toBe(true)
    expect(connectors.some(c => c.name === 'plugin:telegram')).toBe(true)
    expect(connectors.some(c => c.name === 'plugin:gmail')).toBe(false)
  })

  it('lists project and user .mcp.json servers, remote vs local by url presence', async () => {
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({ mcpServers: { 'proj-server': { command: 'npx', args: [] } } }))
    setMockFile(require('node:path').join(require('node:os').homedir(), '.claude.json'), JSON.stringify({ mcpServers: { 'user-remote': { url: 'https://example.test' } } }))
    const { ctx, out } = makeCtx('GET', '/api/connectors')
    await tryHandleConnectors(ctx)
    const connectors = out.body as unknown as Array<Record<string, unknown>>
    const proj = connectors.find(c => c.name === 'proj-server')
    const user = connectors.find(c => c.name === 'user-remote')
    expect(proj).toMatchObject({ type: 'local', source: 'local-project' })
    expect(user).toMatchObject({ type: 'remote', source: 'local-user' })
  })

  it('includes mcp-list cache entries not already seen from config files', async () => {
    vi.mocked(getMcpListCache).mockReturnValue({
      entries: [
        { name: 'cached-server', normalizedId: 'cached-server', endpoint: 'stdio', status: 'connected', source: 'local' },
        { name: 'claude-ai-server', normalizedId: 'claude-ai-server', endpoint: 'https://claude.ai', status: 'unknown', source: 'claude.ai' },
      ],
      lastRefreshed: Date.now(),
      refreshing: false,
    })
    const { ctx, out } = makeCtx('GET', '/api/connectors')
    await tryHandleConnectors(ctx)
    const connectors = out.body as unknown as Array<Record<string, unknown>>
    expect(connectors.find(c => c.name === 'cached-server')).toMatchObject({ status: 'connected', source: 'local' })
    expect(connectors.find(c => c.name === 'claude-ai-server')).toMatchObject({ status: 'configured', type: 'remote', source: 'claude.ai' })
  })

  it('includes per-agent and per-agent-project servers', async () => {
    vi.mocked(listAgentNames).mockReturnValue(['agent-x'])
    setMockFile('/tmp/mock-agents/agent-x/.mcp.json', JSON.stringify({ mcpServers: { 'agent-server': { command: 'foo' } } }))
    setMockDir('/tmp/mock-agents/agent-x/projects', ['proj-a'])
    setMockFile('/tmp/mock-agents/agent-x/projects/proj-a/.mcp.json', JSON.stringify({ mcpServers: { 'agent-proj-server': { command: 'bar' } } }))
    const { ctx, out } = makeCtx('GET', '/api/connectors')
    await tryHandleConnectors(ctx)
    const connectors = out.body as unknown as Array<Record<string, unknown>>
    expect(connectors.find(c => c.name === 'agent-server')).toMatchObject({ source: 'agent', scope: 'agent:agent-x' })
    expect(connectors.find(c => c.name === 'agent-proj-server')).toMatchObject({ source: 'agent-project' })
  })

  it('includes external project servers', async () => {
    vi.mocked(getExternalProjectPaths).mockReturnValue(['/tmp/ext/my-proj'])
    setMockFile('/tmp/ext/my-proj/.mcp.json', JSON.stringify({ mcpServers: { 'ext-server': { command: 'baz' } } }))
    const { ctx, out } = makeCtx('GET', '/api/connectors')
    await tryHandleConnectors(ctx)
    const connectors = out.body as unknown as Array<Record<string, unknown>>
    expect(connectors.find(c => c.name === 'ext-server')).toMatchObject({ source: 'external-project' })
  })
})

describe('GET /api/connectors/status', () => {
  it('returns the mcp-list cache summary', async () => {
    vi.mocked(getMcpListCache).mockReturnValue({ entries: [], lastRefreshed: 123, refreshing: true, error: 'boom' })
    const { ctx, out } = makeCtx('GET', '/api/connectors/status')
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ cacheLastRefreshed: 123, cacheError: 'boom', refreshing: true })
  })
})

describe('POST /api/connectors/refresh', () => {
  it('returns ok:true with the refreshed count on success', async () => {
    vi.mocked(refreshMcpListCache).mockResolvedValue({ entries: [{ name: 'a' } as never], lastRefreshed: 999, refreshing: false })
    const { ctx, out } = makeCtx('POST', '/api/connectors/refresh')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, count: 1, lastRefreshed: 999 })
  })

  it('returns 502 upstream_error when the cache reports an error', async () => {
    vi.mocked(refreshMcpListCache).mockResolvedValue({ entries: [], lastRefreshed: 999, refreshing: false, error: 'CLI timed out' })
    const { ctx, out } = makeCtx('POST', '/api/connectors/refresh')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(502)
    expect(out.body.error).toBe('upstream_error')
  })
})

describe('GET /api/connectors/external-paths', () => {
  it('returns the configured paths', async () => {
    vi.mocked(getExternalProjectPaths).mockReturnValue(['/a', '/b'])
    const { ctx, out } = makeCtx('GET', '/api/connectors/external-paths')
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ paths: ['/a', '/b'] })
  })
})

describe('POST/DELETE /api/connectors/external-paths -- success', () => {
  it('POST adds the path and returns the updated list', async () => {
    vi.mocked(addExternalProjectPath).mockReturnValue({ paths: ['/a', '/b'] })
    const { ctx, out } = makeCtx('POST', '/api/connectors/external-paths', { path: '/b' })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true, paths: ['/a', '/b'] })
  })

  it('DELETE removes the path and returns the updated list', async () => {
    vi.mocked(removeExternalProjectPath).mockReturnValue(['/a'])
    const { ctx, out } = makeCtx('DELETE', '/api/connectors/external-paths', { path: '/b' })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true, paths: ['/a'] })
  })
})

describe('GitHub repo connectors', () => {
  it('GET lists configured repos', async () => {
    vi.mocked(getGitHubRepos).mockReturnValue([{ name: 'owner--repo', url: 'https://github.com/owner/repo' } as never])
    const { ctx, out } = makeCtx('GET', '/api/connectors/github-repos')
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ repos: [{ name: 'owner--repo', url: 'https://github.com/owner/repo' }] })
  })

  it('POST requires a url', async () => {
    const { ctx, out } = makeCtx('POST', '/api/connectors/github-repos', { url: '  ' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
  })

  it('POST stores env vars in the vault and installs with the resulting mapping', async () => {
    vi.mocked(installGitHubRepo).mockReturnValue({
      repo: { url: 'https://github.com/owner/repo', name: 'owner--repo', path: '/tmp/repo', installedAt: '2026-09-12T00:00:00Z' },
      requiredEnvVars: ['API_KEY'],
    })
    const { ctx, out } = makeCtx('POST', '/api/connectors/github-repos', {
      url: 'https://github.com/owner/repo', env: { API_KEY: 'secret-value' },
    })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({
      ok: true,
      repo: { url: 'https://github.com/owner/repo', name: 'owner--repo', path: '/tmp/repo', installedAt: '2026-09-12T00:00:00Z' },
      requiredEnvVars: ['API_KEY'],
    })
    expect(setSecret).toHaveBeenCalledWith(expect.stringMatching(/^github-env-api_key-\d+$/), 'API_KEY (GitHub repo)', 'secret-value')
    expect(installGitHubRepo).toHaveBeenCalledWith('https://github.com/owner/repo', expect.objectContaining({ API_KEY: expect.stringMatching(/^github-env-api_key-\d+$/) }))
  })

  it('POST installs without an env mapping when no env vars are given', async () => {
    vi.mocked(installGitHubRepo).mockReturnValue({
      repo: { url: 'https://github.com/owner/repo', name: 'owner--repo', path: '/tmp/repo', installedAt: '2026-09-12T00:00:00Z' },
      requiredEnvVars: [],
    })
    const { ctx, out } = makeCtx('POST', '/api/connectors/github-repos', { url: 'https://github.com/owner/repo' })
    await tryHandleConnectors(ctx)
    expect(out.body.ok).toBe(true)
    expect(out.body.requiredEnvVars).toEqual([])
    expect(installGitHubRepo).toHaveBeenCalledWith('https://github.com/owner/repo', undefined)
  })

  it('DELETE removes a repo by name', async () => {
    vi.mocked(removeGitHubRepo).mockReturnValue({ ok: true })
    const { ctx, out } = makeCtx('DELETE', '/api/connectors/github-repos/owner--repo')
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true })
    expect(removeGitHubRepo).toHaveBeenCalledWith('owner--repo')
  })

  it('PATCH updates a repo by name', async () => {
    vi.mocked(updateGitHubRepo).mockReturnValue({ ok: true })
    const { ctx, out } = makeCtx('PATCH', '/api/connectors/github-repos/owner--repo')
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true })
    expect(updateGitHubRepo).toHaveBeenCalledWith('owner--repo')
  })

  it('PATCH surfaces an internal_error as 500', async () => {
    vi.mocked(updateGitHubRepo).mockReturnValue({ ok: false, error: 'internal_error', hint: 'git pull failed' })
    const { ctx, out } = makeCtx('PATCH', '/api/connectors/github-repos/owner--repo')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
  })
})

describe('GET /api/connectors/:name -- detail', () => {
  it('resolves a plugin connector by its base name', async () => {
    setMockFile(require('node:path').join(require('node:os').homedir(), '.claude', 'settings.json'), JSON.stringify({
      enabledPlugins: { 'telegram@myorg': true },
    }))
    const { ctx, out } = makeCtx('GET', '/api/connectors/plugin:telegram')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ name: 'plugin:telegram', type: 'plugin', command: 'telegram@myorg' })
  })

  it('returns not_found for an unknown plugin', async () => {
    setMockFile(require('node:path').join(require('node:os').homedir(), '.claude', 'settings.json'), '{}')
    const { ctx, out } = makeCtx('GET', '/api/connectors/plugin:nope')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('resolves a non-plugin connector from project .mcp.json, masking env values', async () => {
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({
      mcpServers: { 'my-server': { command: 'npx', args: ['a', 'b'], env: { API_KEY: 'super-secret' } } },
    }))
    const { ctx, out } = makeCtx('GET', '/api/connectors/my-server')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ name: 'my-server', scope: 'project', type: 'local', args: 'a b' })
    expect((out.body.env as Record<string, string>).API_KEY).toBe('***')
  })

  it('returns not_found when the connector is in no config file', async () => {
    const { ctx, out } = makeCtx('GET', '/api/connectors/ghost')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })
})

describe('POST /api/connectors -- add', () => {
  it('requires a name', async () => {
    const { ctx, out } = makeCtx('POST', '/api/connectors', { type: 'stdio', command: 'npx' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
    expect(out.body.field).toBe('name')
  })

  it('rejects a name that sanitizes to empty', async () => {
    const { ctx, out } = makeCtx('POST', '/api/connectors', { name: '!!!', type: 'stdio', command: 'npx' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
  })

  it('requires a url or command', async () => {
    const { ctx, out } = makeCtx('POST', '/api/connectors', { name: 'my-tool', type: 'stdio' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
  })

  it('adds an http connector and persists the local catalog entry', async () => {
    const { ctx, out } = makeCtx('POST', '/api/connectors', { name: 'my-http', type: 'http', url: 'https://example.test' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, name: 'my-http', nameChanged: false })
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('claude mcp add --transport http'), expect.anything())
    expect(atomicWriteFileSync).toHaveBeenCalled()
  })

  it('adds a stdio connector, sanitizing the name and flagging nameChanged', async () => {
    const { ctx, out } = makeCtx('POST', '/api/connectors', { name: 'my tool!', type: 'stdio', command: 'npx', args: '-y foo' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.nameChanged).toBe(true)
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('claude mcp add'), expect.anything())
  })

  it('returns internal_error when execSync throws', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('claude CLI failed') })
    const { ctx, out } = makeCtx('POST', '/api/connectors', { name: 'my-http', type: 'http', url: 'https://example.test' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
  })
})

describe('DELETE /api/connectors/:name', () => {
  it('removes the server from every .mcp.json that has it', async () => {
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({ mcpServers: { 'to-remove': { command: 'x' }, keep: { command: 'y' } } }))
    const { ctx, out } = makeCtx('DELETE', '/api/connectors/to-remove')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, removed: 1 })
    expect(purgeFromMcpListCache).toHaveBeenCalledWith('to-remove')
  })

  it('reports removed:0 + purgedFromCache when only the cache had it', async () => {
    vi.mocked(purgeFromMcpListCache).mockReturnValue(true)
    const { ctx, out } = makeCtx('DELETE', '/api/connectors/cache-only')
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true, removed: 0, purgedFromCache: true })
  })

  it('returns not_found when the connector is nowhere', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/connectors/ghost')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })
})

describe('POST /api/connectors/:name/assign', () => {
  it('short-circuits plugin:* connectors with a note', async () => {
    const { ctx, out } = makeCtx('POST', '/api/connectors/plugin:telegram/assign', { agents: ['agent-x'] })
    await tryHandleConnectors(ctx)
    expect(out.body.ok).toBe(true)
    expect(out.body.note).toMatch(/global to every agent/)
  })

  it('returns not_found when the connector config cannot be located', async () => {
    const { ctx, out } = makeCtx('POST', '/api/connectors/ghost/assign', { agents: [] })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('writes the connector into each known target agent .mcp.json and removes it from deselected visible agents', async () => {
    vi.mocked(listAgentNames).mockReturnValue(['agent-x', 'agent-y'])
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({ mcpServers: { shared: { command: 'npx' } } }))
    setMockFile('/tmp/mock-agents/agent-y/.mcp.json', JSON.stringify({ mcpServers: { shared: { command: 'npx' } } }))
    const { ctx, out } = makeCtx('POST', '/api/connectors/shared/assign', {
      agents: ['agent-x'],
      allAgents: ['agent-x', 'agent-y'],
    })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true })
    expect(atomicWriteFileSync).toHaveBeenCalledWith('/tmp/mock-agents/agent-x/.mcp.json', expect.stringContaining('shared'))
    expect(atomicWriteFileSync).toHaveBeenCalledWith('/tmp/mock-agents/agent-y/.mcp.json', expect.stringContaining('{}'))
  })

  it('filters out unknown agent names from the target/visible lists', async () => {
    vi.mocked(listAgentNames).mockReturnValue(['agent-x'])
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({ mcpServers: { shared: { command: 'npx' } } }))
    const { ctx, out } = makeCtx('POST', '/api/connectors/shared/assign', {
      agents: ['agent-x', '../../../../tmp/evil'],
    })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true })
    expect(atomicWriteFileSync).toHaveBeenCalledTimes(1)
  })
})

// ── MCP catalog ─────────────────────────────────────────────────────────────────

describe('GET /api/mcp-catalog', () => {
  it('flags catalog entries installed via the mcp-list cache', async () => {
    vi.mocked(getMcpListCache).mockReturnValue({
      entries: [{ name: 'Local Tool', normalizedId: 'local-tool', endpoint: '', status: 'connected', source: 'local' }],
      lastRefreshed: 0,
      refreshing: false,
    })
    const { ctx, out } = makeCtx('GET', '/api/mcp-catalog')
    await tryHandleConnectors(ctx)
    const catalog = out.body as unknown as Array<Record<string, unknown>>
    const local = catalog.find(c => c.id === 'local-tool')
    expect(local).toMatchObject({ installed: true, installedSource: 'local' })
    const remote = catalog.find(c => c.id === 'remote-tool')
    expect(remote).toMatchObject({ installed: false })
  })

  it('flags catalog entries found only via a configured .mcp.json as configMatch', async () => {
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({ mcpServers: { 'remote-tool': { url: 'https://example.test/mcp' } } }))
    const { ctx, out } = makeCtx('GET', '/api/mcp-catalog')
    await tryHandleConnectors(ctx)
    const catalog = out.body as unknown as Array<Record<string, unknown>>
    const remote = catalog.find(c => c.id === 'remote-tool')
    expect(remote).toMatchObject({ installed: true, configMatch: true })
  })

  it('returns internal_error when the catalog file cannot be read', async () => {
    const { readFileSync } = await import('node:fs')
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error('disk error') })
    const { ctx, out } = makeCtx('GET', '/api/mcp-catalog')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
  })
})

describe('POST /api/mcp-catalog/:id/install', () => {
  it('installs a local-type item via the claude CLI', async () => {
    const { ctx, out } = makeCtx('POST', '/api/mcp-catalog/local-tool/install', {})
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true, message: 'Telepítve' })
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('claude mcp add --scope user'), expect.anything())
  })

  it('installs a remote-type item and appends the auth note when oauth', async () => {
    const { ctx, out } = makeCtx('POST', '/api/mcp-catalog/oauth-tool/install', {})
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true, message: 'Telepítve. Complete the OAuth flow in the browser.' })
  })

  it('returns invalid_value when a remote item has no url', async () => {
    const { readFileSync } = await import('node:fs')
    vi.mocked(readFileSync).mockImplementationOnce((p: unknown) => {
      if (String(p).endsWith('mcp-catalog.json')) {
        return JSON.stringify([{ id: 'broken-remote', type: 'remote' }])
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const { ctx, out } = makeCtx('POST', '/api/mcp-catalog/broken-remote/install', {})
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
  })
})

describe('DELETE /api/mcp-catalog/:id/uninstall', () => {
  it('uninstalls via user scope and reports success', async () => {
    const { ctx, out } = makeCtx('DELETE', '/api/mcp-catalog/local-tool/uninstall')
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true, message: 'Eltávolítva' })
  })

  it('falls back to project scope when user-scope removal fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      if (String(cmd).includes('-s user')) throw new Error('not found in user scope')
      return ''
    })
    const { ctx, out } = makeCtx('DELETE', '/api/mcp-catalog/local-tool/uninstall')
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true, message: 'Eltávolítva' })
  })

  it('purges the removed entry from the in-memory MCP list cache', async () => {
    const { ctx } = makeCtx('DELETE', '/api/mcp-catalog/local-tool/uninstall')
    await tryHandleConnectors(ctx)
    expect(purgeFromMcpListCache).toHaveBeenCalledWith('local-tool')
  })
})

// ── Vault ────────────────────────────────────────────────────────────────────

describe('GET /api/vault', () => {
  it('hides ssh-key-* entries and scopes to the caller tenant', async () => {
    vi.mocked(listSecrets).mockReturnValue([
      { id: 'ssh-key-foo', label: 'x', tenant_id: 'default', createdAt: '', updatedAt: '' },
      { id: 'api-key', label: 'x', tenant_id: 'default', createdAt: '', updatedAt: '' },
      { id: 'other-tenant-secret', label: 'x', tenant_id: 'eszter', createdAt: '', updatedAt: '' },
    ])
    const { ctx, out } = makeCtx('GET', '/api/vault', null, { role: 'agent', tenantId: 'default' })
    await tryHandleConnectors(ctx)
    const secrets = (out.body.secrets as Array<{ id: string }>).map(s => s.id)
    expect(secrets).toEqual(['api-key'])
  })

  it('admin without ?tenant sees every tenant', async () => {
    vi.mocked(listSecrets).mockReturnValue([
      { id: 'a', label: 'x', tenant_id: 'default', createdAt: '', updatedAt: '' },
      { id: 'b', label: 'x', tenant_id: 'eszter', createdAt: '', updatedAt: '' },
    ])
    const { ctx, out } = makeCtx('GET', '/api/vault', null, { role: 'admin' })
    await tryHandleConnectors(ctx)
    expect((out.body.secrets as Array<{ id: string }>).map(s => s.id)).toEqual(['a', 'b'])
  })

  // Each secret carries its grantee list as `allow` (empty = open); the fields it had stay exactly as they were.
  it('adds `allow` to every secret: the listed grantees for a restricted one, [] for an open one, the other fields unchanged', async () => {
    const restricted = { id: 'restricted', label: 'R', tenant_id: 'default', createdAt: '2026-01-01', updatedAt: '2026-01-02' }
    const open = { id: 'open', label: 'O', tenant_id: 'default', createdAt: '2026-01-03', updatedAt: '2026-01-04' }
    vi.mocked(listSecrets).mockReturnValue([restricted, open])
    vi.mocked(getAllSecretAcls).mockResolvedValue({ restricted: ['agent:agent-a', 'scope:user'] })
    const { ctx, out } = makeCtx('GET', '/api/vault', null, { role: 'admin' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({
      secrets: [
        { ...restricted, allow: ['agent:agent-a', 'scope:user'] },
        { ...open, allow: [] },
      ],
    })
  })

  it('a secret of another tenant reads as open even when the default tenant has a list for the same id', async () => {
    vi.mocked(listSecrets).mockReturnValue([
      { id: 'shared-id', label: 'x', tenant_id: 'default', createdAt: '', updatedAt: '' },
      { id: 'shared-id', label: 'y', tenant_id: 'tenant-x', createdAt: '', updatedAt: '' },
    ])
    vi.mocked(getAllSecretAcls).mockResolvedValue({ 'shared-id': ['agent:agent-a'] })
    const { ctx, out } = makeCtx('GET', '/api/vault', null, { role: 'admin' })
    await tryHandleConnectors(ctx)
    const rows = out.body.secrets as Array<{ tenant_id: string, allow: string[] }>
    expect(rows.map(r => [r.tenant_id, r.allow])).toEqual([['default', ['agent:agent-a']], ['tenant-x', []]])
  })

  it('an ssh-key entry stays hidden and never asks for or shows a list', async () => {
    vi.mocked(listSecrets).mockReturnValue([{ id: 'ssh-key-foo', label: 'x', tenant_id: 'default', createdAt: '', updatedAt: '' }])
    vi.mocked(getAllSecretAcls).mockResolvedValue({ 'ssh-key-foo': ['scope:user'] })
    const { ctx, out } = makeCtx('GET', '/api/vault', null, { role: 'admin' })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ secrets: [] })
  })

  it('an empty vault is an empty list (the list read does not break it)', async () => {
    vi.mocked(listSecrets).mockReturnValue([])
    const { ctx, out } = makeCtx('GET', '/api/vault', null, { role: 'admin' })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ secrets: [] })
  })
})

describe('POST /api/vault', () => {
  it('requires id and value', async () => {
    const { ctx, out } = makeCtx('POST', '/api/vault', { id: '', value: '' }, { role: 'agent', tenantId: 'default' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
  })

  it('a scoped caller always writes into their own tenant, ignoring a supplied tenant_id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/vault', { id: 'my-secret', label: 'My Secret', value: 'v', tenant_id: 'someone-else' }, { role: 'agent', tenantId: 'default' })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true, synced: 0 })
    expect(setSecret).toHaveBeenCalledWith('my-secret', 'My Secret', 'v', 'default')
  })

  it('admin can target an explicit tenant_id', async () => {
    const { ctx, out } = makeCtx('POST', '/api/vault', { id: 'my-secret', label: 'x', value: 'v', tenant_id: 'eszter' }, { role: 'admin' })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true, synced: 0 })
    expect(setSecret).toHaveBeenCalledWith('my-secret', 'x', 'v', 'eszter')
  })
})

describe('GET/DELETE /api/vault/:id', () => {
  it('returns not_found for an unowned secret id', async () => {
    const { ctx, out } = makeCtx('GET', '/api/vault/ghost', null, { role: 'agent', tenantId: 'default' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('returns not_found (never 403) for a cross-tenant secret id', async () => {
    vi.mocked(findSecretTenant).mockReturnValue('eszter')
    const { ctx, out } = makeCtx('GET', '/api/vault/other-tenant-secret', null, { role: 'agent', tenantId: 'default' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('returns the value for the owning tenant', async () => {
    vi.mocked(findSecretTenant).mockReturnValue('default')
    vi.mocked(getSecret).mockReturnValue('the-value')
    const { ctx, out } = makeCtx('GET', '/api/vault/my-secret', null, { role: 'agent', tenantId: 'default' })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ id: 'my-secret', value: 'the-value' })
  })

  it('deletes an owned secret and its bindings', async () => {
    vi.mocked(findSecretTenant).mockReturnValue('default')
    const { ctx, out } = makeCtx('DELETE', '/api/vault/my-secret', null, { role: 'agent', tenantId: 'default' })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true })
    expect(deleteSecret).toHaveBeenCalledWith('my-secret', 'default')
  })

  it('deleting a secret also drops its grantee list, so a re-created id does not inherit the restriction', async () => {
    vi.mocked(findSecretTenant).mockReturnValue('default')
    vi.mocked(removeSecretAcl).mockClear()
    const { ctx, out } = makeCtx('DELETE', '/api/vault/my-secret', null, { role: 'agent', tenantId: 'default' })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true })
    expect(removeSecretAcl).toHaveBeenCalledTimes(1)
    expect(removeSecretAcl).toHaveBeenCalledWith('my-secret')
  })

  // A secret id is unique per (id, tenant), the grantee list lives under the default tenant: deleting
  // ANOTHER tenant's secret of the same id must not open the default tenant's restricted secret.
  it('deleting another tenant\'s secret of the same id leaves the default tenant\'s grantee list alone', async () => {
    vi.mocked(findSecretTenant).mockReturnValue('tenant-x')
    vi.mocked(removeSecretAcl).mockClear()
    const { ctx, out } = makeCtx('DELETE', '/api/vault/shared-id', null, { role: 'admin' })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true })
    expect(deleteSecret).toHaveBeenCalledWith('shared-id', 'tenant-x')
    expect(removeSecretAcl).not.toHaveBeenCalled()
  })

  it('a delete that is refused (cross-tenant id) leaves the grantee list alone', async () => {
    vi.mocked(findSecretTenant).mockReturnValue('tenant-x')
    vi.mocked(removeSecretAcl).mockClear()
    const { ctx, out } = makeCtx('DELETE', '/api/vault/other-tenant-secret', null, { role: 'agent', tenantId: 'default' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect(removeSecretAcl).not.toHaveBeenCalled()
  })

  it('does not shadow the ssh-servers/ssh-keys/bindings/sync/scan/import sub-routes', async () => {
    const { ctx } = makeCtx('GET', '/api/vault/ssh-servers', null, { role: 'admin' })
    const handled = await tryHandleConnectors(ctx)
    expect(handled).toBe(false)
  })
})

describe('Vault bindings', () => {
  it('GET returns the current bindings', async () => {
    vi.mocked(getBindings).mockResolvedValue([{ vaultSecretId: 'a', envVar: 'X', targets: [] }])
    const { ctx, out } = makeCtx('GET', '/api/vault/bindings')
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ bindings: [{ vaultSecretId: 'a', envVar: 'X', targets: [] }] })
  })

  it('POST requires vaultSecretId and envVar', async () => {
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', { vaultSecretId: '', envVar: '' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
  })

  it('POST resolves targets by serverName when no explicit targets are given', async () => {
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({ mcpServers: { 'my-server': { command: 'x' } } }))
    vi.mocked(syncSecret).mockResolvedValue({ updated: 1, errors: [] })
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', { vaultSecretId: 'sec', envVar: 'X', serverName: 'my-server' })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true, synced: 1, errors: [] })
    expect(addBinding).toHaveBeenCalledWith({
      vaultSecretId: 'sec', envVar: 'X', targets: [{ mcpFilePath: '/tmp/mock-root/.mcp.json', serverName: 'my-server' }],
    })
  })

  it('DELETE returns not_found when the binding does not exist', async () => {
    vi.mocked(removeBinding).mockResolvedValue(false)
    const { ctx, out } = makeCtx('DELETE', '/api/vault/bindings/sec/X')
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('DELETE returns ok:true when removed', async () => {
    vi.mocked(removeBinding).mockResolvedValue(true)
    const { ctx, out } = makeCtx('DELETE', '/api/vault/bindings/sec/X')
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true })
  })
})

// The per-secret grantee list (vault_secret_acl): an empty list keeps the old behaviour byte for byte, a
// non-empty one lets only the listed agents and scopes receive the secret.
describe('POST /api/vault/bindings with a secret allowlist', () => {
  const PROJECT_MCP = '/tmp/mock-root/.mcp.json'
  const AGENT_A_MCP = '/tmp/mock-agents/agent-a/.mcp.json'
  const AGENT_B_MCP = '/tmp/mock-agents/agent-b/.mcp.json'
  const body = (targets: Array<{ mcpFilePath: string, serverName: string }>) =>
    ({ vaultSecretId: 'sec', envVar: 'X', targets })

  function seedDiscovery(): void {
    vi.mocked(listAgentNames).mockReturnValue(['agent-a', 'agent-b'])
    for (const p of [PROJECT_MCP, AGENT_A_MCP, AGENT_B_MCP]) {
      setMockFile(p, JSON.stringify({ mcpServers: { srv: { command: 'x' } } }))
    }
  }

  it('an empty list: explicit targets all go through and the answer has the old shape (no skipped)', async () => {
    vi.mocked(syncSecret).mockResolvedValue({ updated: 2, errors: [] })
    const targets = [{ mcpFilePath: PROJECT_MCP, serverName: 'srv' }, { mcpFilePath: AGENT_B_MCP, serverName: 'srv' }]
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', body(targets))
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, synced: 2, errors: [] })
    expect(addBinding).toHaveBeenCalledWith({ vaultSecretId: 'sec', envVar: 'X', targets })
  })

  it('a list that names the target: 200 and the binding is written', async () => {
    vi.mocked(getSecretAcl).mockResolvedValue(['agent:agent-a'])
    const targets = [{ mcpFilePath: AGENT_A_MCP, serverName: 'srv' }]
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', body(targets))
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect(addBinding).toHaveBeenCalledWith({ vaultSecretId: 'sec', envVar: 'X', targets })
    expect(syncSecret).toHaveBeenCalledWith('sec')
  })

  it('an explicit target outside the list: 403 agent_not_allowed and NOTHING is written (no row, no sync, no file)', async () => {
    vi.mocked(getSecretAcl).mockResolvedValue(['agent:agent-a'])
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', body([{ mcpFilePath: AGENT_B_MCP, serverName: 'srv' }]))
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(403)
    expect(out.body).toMatchObject({ error: 'agent_not_allowed', field: 'targets' })
    expect(addBinding).not.toHaveBeenCalled()
    expect(syncSecret).not.toHaveBeenCalled()
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('one denied target among allowed explicit ones refuses the whole request', async () => {
    vi.mocked(getSecretAcl).mockResolvedValue(['agent:agent-a'])
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', body([
      { mcpFilePath: AGENT_A_MCP, serverName: 'srv' },
      { mcpFilePath: AGENT_B_MCP, serverName: 'srv' },
    ]))
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(403)
    expect(addBinding).not.toHaveBeenCalled()
  })

  it('a target of no known grantee (unknown path) is refused by a non-empty list', async () => {
    vi.mocked(getSecretAcl).mockResolvedValue(['agent:agent-a'])
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', body([{ mcpFilePath: '/somewhere/else/.mcp.json', serverName: 'srv' }]))
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(403)
    expect(addBinding).not.toHaveBeenCalled()
  })

  it('discovery by serverName: the denied files are filtered out and named in skipped', async () => {
    seedDiscovery()
    vi.mocked(getSecretAcl).mockResolvedValue(['agent:agent-a'])
    vi.mocked(syncSecret).mockResolvedValue({ updated: 1, errors: [] })
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', { vaultSecretId: 'sec', envVar: 'X', serverName: 'srv' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, synced: 1, errors: [], skipped: ['scope:project', 'agent:agent-b'] })
    expect(addBinding).toHaveBeenCalledWith({ vaultSecretId: 'sec', envVar: 'X', targets: [{ mcpFilePath: AGENT_A_MCP, serverName: 'srv' }] })
  })

  it('discovery by serverName with an empty list binds every file found, no skipped (the old behaviour)', async () => {
    seedDiscovery()
    vi.mocked(syncSecret).mockResolvedValue({ updated: 3, errors: [] })
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', { vaultSecretId: 'sec', envVar: 'X', serverName: 'srv' })
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true, synced: 3, errors: [] })
    const call = vi.mocked(addBinding).mock.calls[0][0]
    expect(call.targets.map(t => t.mcpFilePath)).toEqual([PROJECT_MCP, AGENT_A_MCP, AGENT_B_MCP])
  })

  it('discovery that finds files but all are denied: 403 agent_not_allowed (field serverName), nothing written', async () => {
    seedDiscovery()
    vi.mocked(getSecretAcl).mockResolvedValue(['agent:agent-z'])
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', { vaultSecretId: 'sec', envVar: 'X', serverName: 'srv' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(403)
    expect(out.body).toMatchObject({ error: 'agent_not_allowed', field: 'serverName' })
    expect(addBinding).not.toHaveBeenCalled()
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('discovery that finds nothing stays the old 400 invalid_value, with a list or without', async () => {
    vi.mocked(getSecretAcl).mockResolvedValue(['agent:agent-a'])
    const { ctx, out } = makeCtx('POST', '/api/vault/bindings', { vaultSecretId: 'sec', envVar: 'X', serverName: 'no-such-server' })
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'serverName' })
  })

  it('logs the refusal with the id and the grantee, never a value, and marks it as the acl path', async () => {
    vi.mocked(getSecretAcl).mockResolvedValue(['agent:agent-a'])
    const { ctx } = makeCtx('POST', '/api/vault/bindings', body([{ mcpFilePath: AGENT_B_MCP, serverName: 'srv' }]))
    await tryHandleConnectors(ctx)
    const warn = vi.mocked(logger.warn).mock.calls.find(c => (c[0] as { event?: string }).event === 'vault-binding-refused')
    expect(warn).toBeDefined()
    expect(warn![0]).toMatchObject({ vaultSecretId: 'sec', grantee: 'agent:agent-b', via: 'acl', refusedCount: 1 })
    expect(JSON.stringify(warn)).not.toMatch(/value|secret-value/i)
  })
})

describe('GET/PUT /api/vault/:id/acl', () => {
  const asAdmin = { role: 'admin' } as const

  beforeEach(() => {
    vi.mocked(findSecretTenant).mockReturnValue('default')
    vi.mocked(listAgentNames).mockReturnValue(['agent-a', 'agent-b'])
  })

  it('GET returns the stored list', async () => {
    vi.mocked(getSecretAcl).mockResolvedValue(['agent:agent-a'])
    const { ctx, out } = makeCtx('GET', '/api/vault/sec/acl', null, asAdmin)
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ allow: ['agent:agent-a'] })
  })

  it('PUT replaces the list with agents, the main agent and the three scopes', async () => {
    const allow = ['agent:agent-a', 'agent:main-a', 'scope:project', 'scope:user', 'scope:external']
    vi.mocked(getSecretAcl).mockResolvedValue(allow)
    const { ctx, out } = makeCtx('PUT', '/api/vault/sec/acl', { allow }, asAdmin)
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect(setSecretAcl).toHaveBeenCalledWith('sec', allow)
    expect(out.body).toEqual({ allow })
  })

  it('PUT with an empty array opens the secret', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/vault/sec/acl', { allow: [] }, asAdmin)
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(200)
    expect(setSecretAcl).toHaveBeenCalledWith('sec', [])
  })

  it.each([
    ['an entry that is not a grantee', ['root']],
    ['a scope that does not exist', ['scope:everyone']],
    ['an agent that does not exist', ['agent:ghost']],
    ['an agent id with a path in it', ['agent:../agent-a']],
    ['a non-string entry', [42]],
    ['allow that is not an array', 'agent:agent-a'],
    ['allow that is missing', undefined],
  ])('PUT with %s: 400 invalid_value on allow, nothing stored', async (_name, allow) => {
    const { ctx, out } = makeCtx('PUT', '/api/vault/sec/acl', { allow }, asAdmin)
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'allow' })
    expect(setSecretAcl).not.toHaveBeenCalled()
  })

  it('PUT with 51 entries is a 400, with 50 it is accepted (the cap is 50)', async () => {
    const many = (n: number) => Array.from({ length: n }, () => 'scope:user')
    const over = makeCtx('PUT', '/api/vault/sec/acl', { allow: many(51) }, asAdmin)
    await tryHandleConnectors(over.ctx)
    expect(over.out.status).toBe(400)
    expect(setSecretAcl).not.toHaveBeenCalled()
    const edge = makeCtx('PUT', '/api/vault/sec/acl', { allow: many(50) }, asAdmin)
    await tryHandleConnectors(edge.ctx)
    expect(edge.out.status).toBe(200)
  })

  it('PUT with a body that is not a JSON object: 400 parse_error', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/vault/sec/acl', '["agent:agent-a"]', asAdmin)
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('parse_error')
    expect(setSecretAcl).not.toHaveBeenCalled()
  })

  it('a caller that is not an admin gets 403 on GET and PUT, even for an id that does not exist (no id oracle)', async () => {
    vi.mocked(findSecretTenant).mockReturnValue(null)
    for (const method of ['GET', 'PUT'] as const) {
      const { ctx, out } = makeCtx(method, '/api/vault/ghost/acl', method === 'PUT' ? { allow: [] } : null, { role: 'agent', tenantId: 'default' })
      await tryHandleConnectors(ctx)
      expect(out.status, method).toBe(403)
      expect(out.body.error).toBe('forbidden')
    }
    expect(setSecretAcl).not.toHaveBeenCalled()
  })

  it('an unknown secret is a 404 for an admin', async () => {
    vi.mocked(findSecretTenant).mockReturnValue(null)
    const { ctx, out } = makeCtx('GET', '/api/vault/ghost/acl', null, asAdmin)
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('not_found')
  })

  it('a secret of another tenant is refused: the list is kept under the default tenant only', async () => {
    vi.mocked(findSecretTenant).mockReturnValue('tenant-x')
    const { ctx, out } = makeCtx('PUT', '/api/vault/sec/acl', { allow: ['scope:user'] }, asAdmin)
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(out.body).toMatchObject({ error: 'invalid_value', field: 'id' })
    expect(setSecretAcl).not.toHaveBeenCalled()
  })

  it('an SSH private key id has no list', async () => {
    const { ctx, out } = makeCtx('PUT', '/api/vault/ssh-key-abc/acl', { allow: ['scope:user'] }, asAdmin)
    await tryHandleConnectors(ctx)
    expect(out.status).toBe(400)
    expect(setSecretAcl).not.toHaveBeenCalled()
  })

  it('the PUT leaves an audit line with the id and the entry count, no secret value', async () => {
    const { ctx } = makeCtx('PUT', '/api/vault/sec/acl', { allow: ['scope:user', 'agent:agent-a'] }, asAdmin)
    await tryHandleConnectors(ctx)
    const info = vi.mocked(logger.info).mock.calls.find(c => (c[0] as { event?: string }).event === 'vault-acl-set')
    expect(info).toBeDefined()
    expect(info![0]).toMatchObject({ vaultSecretId: 'sec', entries: 2 })
  })
})

describe('POST /api/vault/sync', () => {
  it('returns the sync result merged with ok:true', async () => {
    vi.mocked(syncAllBindings).mockResolvedValue({ updated: 3, errors: ['one error'] })
    const { ctx, out } = makeCtx('POST', '/api/vault/sync')
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual({ ok: true, updated: 3, errors: ['one error'] })
  })
})

describe('GET /api/vault/scan', () => {
  it('returns scanMcpConfigs() findings', async () => {
    vi.mocked(scanMcpConfigs).mockReturnValue([{ mcpFilePath: '/tmp/mock-root/.mcp.json', serverName: 's', envVar: 'X', value: 'v' } as never])
    const { ctx, out } = makeCtx('GET', '/api/vault/scan')
    await tryHandleConnectors(ctx)
    expect((out.body.findings as unknown[]).length).toBe(1)
  })
})

describe('POST /api/vault/import', () => {
  it('imports values found at the given targets and reports errors for missing ones', async () => {
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({ mcpServers: { s1: { env: { X: 'found-value' } } } }))
    const { ctx, out } = makeCtx('POST', '/api/vault/import', {
      imports: [
        { serverName: 's1', envVar: 'X', vaultId: 'v1', label: 'X for s1', createBinding: false, targets: [{ mcpFilePath: '/tmp/mock-root/.mcp.json', serverName: 's1' }] },
        { serverName: 's2', envVar: 'Y', vaultId: 'v2', label: 'Y for s2', createBinding: false, targets: [{ mcpFilePath: '/tmp/mock-root/.mcp.json', serverName: 's2' }] },
      ],
    })
    await tryHandleConnectors(ctx)
    expect(out.body.imported).toBe(1)
    expect(setSecret).toHaveBeenCalledWith('v1', 'X for s1', 'found-value')
    expect((out.body.errors as string[]).length).toBe(1)
  })

  it('creates a binding and syncs it when createBinding is true', async () => {
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({ mcpServers: { s1: { env: { X: 'v' } } } }))
    vi.mocked(syncSecret).mockResolvedValue({ updated: 1, errors: [] })
    const { ctx, out } = makeCtx('POST', '/api/vault/import', {
      imports: [{ serverName: 's1', envVar: 'X', vaultId: 'v1', label: 'l', createBinding: true, targets: [{ mcpFilePath: '/tmp/mock-root/.mcp.json', serverName: 's1' }] }],
    })
    await tryHandleConnectors(ctx)
    expect(out.body.bound).toBe(1)
    expect(addBinding).toHaveBeenCalled()
  })
})

// ── Ollama ───────────────────────────────────────────────────────────────────

describe('GET /api/ollama/models', () => {
  it('lists non-embedding models with rounded GB sizes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        models: [
          { name: 'llama3', size: 4_300_000_000, details: { parameter_size: '8B' } },
          { name: 'nomic-embed-text', size: 100_000_000 },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, out } = makeCtx('GET', '/api/ollama/models')
    await tryHandleConnectors(ctx)
    const models = out.body as unknown as Array<Record<string, unknown>>
    expect(models).toEqual([{ name: 'llama3', size: '4 GB', params: '8B' }])
    vi.unstubAllGlobals()
  })

  it('returns an empty array when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const { ctx, out } = makeCtx('GET', '/api/ollama/models')
    await tryHandleConnectors(ctx)
    expect(out.body).toEqual([])
    vi.unstubAllGlobals()
  })
})

describe('tryHandleConnectors -- unrelated paths', () => {
  it('returns false for a path it does not own', async () => {
    const { ctx } = makeCtx('GET', '/api/something-else')
    const handled = await tryHandleConnectors(ctx)
    expect(handled).toBe(false)
  })
})
