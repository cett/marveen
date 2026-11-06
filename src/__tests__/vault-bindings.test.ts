// Unit tests for vault-bindings.ts (#751 coverage step 29). Previously only
// exercised indirectly via connectors-routes.test.ts, which mocks this whole
// module -- so none of its own logic (binding CRUD, MCP-file path collection,
// sensitive-value scanning, sync/unsync file rewriting) had a direct test.
//
// #985 group 7/8: the binding store itself moved from store/vault-bindings.json
// to the vault_bindings DB table -- getBindings/addBinding/removeBinding/
// removeBindingsForSecret now go through '../db/vault-bindings.js' (mocked
// below with an in-memory row array) instead of readFileSync/
// atomicWriteFileSync on BINDINGS_PATH. The target.mcpFilePath writes (the
// actual MCP config files a binding syncs secrets into) are UNCHANGED by
// that migration and still go through the mocked node:fs / atomic-write.js
// below.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockFsFiles: Record<string, string> = {}
const mockFsDirs: Record<string, string[]> = {}
function setMockFile(path: string, content: string) { mockFsFiles[path] = content }
function setMockDir(path: string, entries: string[]) { mockFsDirs[path] = entries }

vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: unknown) => String(p) in mockFsFiles || String(p) in mockFsDirs),
  readFileSync: vi.fn((p: unknown) => {
    const key = String(p)
    const val = mockFsFiles[key]
    if (val !== undefined) return val
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }),
  readdirSync: vi.fn((p: unknown) => {
    const key = String(p)
    if (key in mockFsDirs) return mockFsDirs[key]
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
  // No links in the mocked tree: every path is its own real path. The links themselves are covered with the
  // real file system in vault-bindings-symlink.test.ts.
  realpathSync: vi.fn((p: unknown) => String(p)),
  // Same for the file itself: a file in the mocked tree is a regular file, any other path does not exist.
  lstatSync: vi.fn((p: unknown) => {
    const key = String(p)
    if (key in mockFsFiles) return { isFile: () => true, isSymbolicLink: () => false, nlink: 1 }
    if (key in mockFsDirs) return { isFile: () => false, isSymbolicLink: () => false, nlink: 2 }
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }),
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/mock-root',
  STORE_DIR: '/tmp/mock-store',
}))

const atomicWriteFileSync = vi.fn((path: string, content: string) => {
  mockFsFiles[path] = content
})
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (...args: [string, string]) => atomicWriteFileSync(...args),
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: vi.fn().mockReturnValue([]),
  readFileOr: vi.fn((path: string, fallback: string) => mockFsFiles[path] ?? fallback),
  AGENTS_BASE_DIR: '/tmp/mock-agents',
}))

vi.mock('../web/vault.js', () => ({
  getSecret: vi.fn().mockReturnValue(null),
  listSecrets: vi.fn().mockReturnValue([]),
}))

vi.mock('../web/dashboard-settings.js', () => ({
  getExternalProjectPaths: vi.fn().mockReturnValue([]),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// In-memory stand-in for the vault_bindings table (#985 group 7/8). Declared
// via vi.hoisted so the vi.mock factory below (itself hoisted above imports)
// can close over it. seedBindings()/vaultBindingsDb.rows are the test-side
// handle into the same array the mocked DB functions read/write.
const vaultBindingsDb = vi.hoisted(() => ({ rows: [] as Array<{ vaultSecretId: string; envVar: string; targets: unknown[] }> }))

vi.mock('../db/vault-bindings.js', () => ({
  listVaultBindings: vi.fn(() => vaultBindingsDb.rows.map(r => ({ ...r, targets: [...r.targets] }))),
  upsertVaultBinding: vi.fn((_tenantId: string, binding: { vaultSecretId: string; envVar: string; targets: unknown[] }) => {
    const idx = vaultBindingsDb.rows.findIndex(r => r.vaultSecretId === binding.vaultSecretId && r.envVar === binding.envVar)
    if (idx >= 0) vaultBindingsDb.rows[idx] = binding
    else vaultBindingsDb.rows.push(binding)
  }),
  deleteVaultBinding: vi.fn((_tenantId: string, vaultSecretId: string, envVar: string) => {
    const before = vaultBindingsDb.rows.length
    vaultBindingsDb.rows = vaultBindingsDb.rows.filter(r => !(r.vaultSecretId === vaultSecretId && r.envVar === envVar))
    return vaultBindingsDb.rows.length !== before
  }),
  deleteVaultBindingsForSecret: vi.fn((_tenantId: string, vaultSecretId: string) => {
    const toRemove = vaultBindingsDb.rows.filter(r => r.vaultSecretId === vaultSecretId)
    vaultBindingsDb.rows = vaultBindingsDb.rows.filter(r => r.vaultSecretId !== vaultSecretId)
    return toRemove
  }),
}))

// In-memory stand-in for the vault_secret_acl table (migration 0090), keyed by secret id; the tenant
// argument is recorded so a test can pin that the web layer always asks for the 'default' tenant.
const secretAclDb = vi.hoisted(() => ({ lists: {} as Record<string, string[]>, tenants: [] as string[] }))

vi.mock('../db/vault-secret-acl.js', () => ({
  listSecretAcl: vi.fn((tenantId: string, id: string) => { secretAclDb.tenants.push(tenantId); return [...(secretAclDb.lists[id] ?? [])] }),
  replaceSecretAcl: vi.fn((tenantId: string, id: string, grantees: string[]) => { secretAclDb.tenants.push(tenantId); secretAclDb.lists[id] = [...new Set(grantees)] }),
  deleteSecretAcl: vi.fn((tenantId: string, id: string) => { secretAclDb.tenants.push(tenantId); delete secretAclDb.lists[id] }),
  listAllSecretAcls: vi.fn((tenantId: string) => { secretAclDb.tenants.push(tenantId); return { ...secretAclDb.lists } }),
}))

import {
  getBindings, addBinding, removeBinding, removeBindingsForSecret,
  collectAllMcpFilePaths, scanMcpConfigs, syncSecret, unsyncBinding, syncAllBindings,
  granteeOfMcpFile, verifiedGranteeOfMcpFile, isCanonicalMcpPath, partitionTargetsByAcl, getSecretAcl, setSecretAcl, removeSecretAcl, getAllSecretAcls,
  type VaultBinding,
} from '../web/vault-bindings.js'
import { existsSync, readFileSync, readdirSync, statSync, realpathSync, lstatSync } from 'node:fs'
import { readFileOr, listAgentNames } from '../web/agent-config.js'
import { getSecret, listSecrets } from '../web/vault.js'
import { getExternalProjectPaths } from '../web/dashboard-settings.js'
import { upsertVaultBinding, deleteVaultBinding } from '../db/vault-bindings.js'

function seedBindings(bindings: VaultBinding[]) {
  vaultBindingsDb.rows = bindings.map(b => ({ ...b, targets: [...b.targets] }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listAgentNames).mockReturnValue([])
  vi.mocked(getExternalProjectPaths).mockReturnValue([])
  vi.mocked(listSecrets).mockReturnValue([])
  vi.mocked(getSecret).mockReturnValue(null)
  vaultBindingsDb.rows = []
  secretAclDb.lists = {}
  secretAclDb.tenants = []
  for (const k of Object.keys(mockFsFiles)) delete mockFsFiles[k]
  for (const k of Object.keys(mockFsDirs)) delete mockFsDirs[k]
})

// ── getBindings / addBinding / removeBinding ────────────────────────────────

describe('getBindings', () => {
  it('returns an empty list when the DB has no rows', async () => {
    expect(await getBindings()).toEqual([])
  })

  it('returns the bindings from the DB', async () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [] }])
    expect(await getBindings()).toEqual([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [] }])
  })
})

describe('addBinding', () => {
  it('upserts a new binding into the DB via upsertVaultBinding', async () => {
    await addBinding({ vaultSecretId: 's1', envVar: 'API_KEY', targets: [] })
    expect(upsertVaultBinding).toHaveBeenCalledTimes(1)
    expect(upsertVaultBinding).toHaveBeenCalledWith('default', { vaultSecretId: 's1', envVar: 'API_KEY', targets: [] })
    expect(await getBindings()).toEqual([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [] }])
  })

  it('replaces an existing binding with the same vaultSecretId + envVar', async () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/a', serverName: 'x' }] }])
    await addBinding({ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/b', serverName: 'y' }] })
    const bindings = await getBindings()
    expect(bindings).toHaveLength(1)
    expect(bindings[0].targets).toEqual([{ mcpFilePath: '/b', serverName: 'y' }])
  })
})

describe('removeBinding', () => {
  it('returns false when no matching binding exists', async () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [] }])
    expect(await removeBinding('s2', 'OTHER')).toBe(false)
    expect(deleteVaultBinding).toHaveBeenCalledWith('default', 's2', 'OTHER')
  })

  it('removes the matching binding and returns true', async () => {
    seedBindings([
      { vaultSecretId: 's1', envVar: 'API_KEY', targets: [] },
      { vaultSecretId: 's2', envVar: 'OTHER', targets: [] },
    ])
    expect(await removeBinding('s1', 'API_KEY')).toBe(true)
    expect(await getBindings()).toEqual([{ vaultSecretId: 's2', envVar: 'OTHER', targets: [] }])
  })
})

describe('removeBindingsForSecret', () => {
  it('strips the env var from every target file and unwraps the command when no vault refs remain', async () => {
    seedBindings([
      { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] },
      { vaultSecretId: 's2', envVar: 'OTHER', targets: [] },
    ])
    setMockFile('/mcp.json', JSON.stringify({
      mcpServers: {
        srv: {
          command: '/tmp/mock-root/scripts/vault-env-wrapper.sh',
          args: ['orig-cmd', '--flag'],
          _vaultOriginalCommand: 'orig-cmd',
          _vaultOriginalArgs: ['--flag'],
          env: { API_KEY: 'vault:s1' },
        },
      },
    }))

    await removeBindingsForSecret('s1')

    const [path, content] = atomicWriteFileSync.mock.calls[0]
    expect(path).toBe('/mcp.json')
    const written = JSON.parse(content as string)
    expect(written.mcpServers.srv.env.API_KEY).toBeUndefined()
    expect(written.mcpServers.srv.command).toBe('orig-cmd')
    expect(written.mcpServers.srv.args).toEqual(['--flag'])
    expect(written.mcpServers.srv._vaultOriginalCommand).toBeUndefined()

    // Binding for s1 is gone, s2 untouched.
    expect(await getBindings()).toEqual([{ vaultSecretId: 's2', envVar: 'OTHER', targets: [] }])
  })

  it('keeps the wrapper command when another env var still references vault:', async () => {
    seedBindings([
      { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] },
    ])
    setMockFile('/mcp.json', JSON.stringify({
      mcpServers: {
        srv: {
          command: '/tmp/mock-root/scripts/vault-env-wrapper.sh',
          args: ['orig-cmd'],
          _vaultOriginalCommand: 'orig-cmd',
          env: { API_KEY: 'vault:s1', OTHER_KEY: 'vault:s2' },
        },
      },
    }))

    await removeBindingsForSecret('s1')

    const [, content] = atomicWriteFileSync.mock.calls[0]
    const written = JSON.parse(content as string)
    expect(written.mcpServers.srv.command).toBe('/tmp/mock-root/scripts/vault-env-wrapper.sh')
  })

  it('skips a target whose server config has no env block, without throwing', async () => {
    seedBindings([
      { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] },
    ])
    setMockFile('/mcp.json', JSON.stringify({ mcpServers: { srv: { command: 'x' } } }))

    await expect(removeBindingsForSecret('s1')).resolves.not.toThrow()
    // No env block -> the per-target write is skipped. Unlike the pre-
    // migration file store, there is no separate bindings-store write to
    // fall back to, so atomicWriteFileSync is never called at all here.
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
    expect(await getBindings()).toEqual([])
  })

  it('swallows a per-target failure (malformed target file) and still drops the binding', async () => {
    seedBindings([
      { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/broken.json', serverName: 'srv' }] },
    ])
    setMockFile('/broken.json', '{not json')

    await expect(removeBindingsForSecret('s1')).resolves.not.toThrow()
    expect(await getBindings()).toEqual([])
  })
})

// ── collectAllMcpFilePaths ──────────────────────────────────────────────────

describe('collectAllMcpFilePaths', () => {
  it('collects project, user, per-agent, per-agent-project, and external mcp.json files', () => {
    setMockFile('/tmp/mock-root/.mcp.json', '{}')
    // homedir() is not mocked, so derive the real path the module will look up.
    setMockFile(`${homedir()}/.claude.json`, '{}')

    vi.mocked(listAgentNames).mockReturnValue(['agent-a'])
    setMockFile('/tmp/mock-agents/agent-a/.mcp.json', '{}')
    setMockDir('/tmp/mock-agents/agent-a/projects', ['proj1'])
    setMockFile('/tmp/mock-agents/agent-a/projects/proj1/.mcp.json', '{}')

    vi.mocked(getExternalProjectPaths).mockReturnValue(['/ext/my-proj'])
    setMockFile('/ext/my-proj/.mcp.json', '{}')

    const paths = collectAllMcpFilePaths()
    const labels = paths.map(p => p.label)
    expect(labels).toContain('project')
    expect(labels).toContain('user')
    expect(labels).toContain('agent:agent-a')
    expect(labels).toContain('project:agent-a/proj1')
    expect(labels).toContain('external:my-proj')
  })

  it('omits files that do not exist and tolerates an unreadable projects dir', () => {
    vi.mocked(listAgentNames).mockReturnValue(['agent-b'])
    // No .mcp.json anywhere, no projects dir registered -> readdirSync throws.
    const paths = collectAllMcpFilePaths()
    expect(paths).toEqual([])
  })
})

// ── scanMcpConfigs ───────────────────────────────────────────────────────────

describe('scanMcpConfigs', () => {
  beforeEach(() => {
    setMockFile('/tmp/mock-root/.mcp.json', '')
    vi.mocked(listAgentNames).mockReturnValue([])
    vi.mocked(getExternalProjectPaths).mockReturnValue([])
  })

  it('flags a sensitive-looking key with a sensitive-looking value', () => {
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({
      mcpServers: { srv: { command: 'x', env: { API_KEY: 'sk-abcdefghijklmnop' } } },
    }))
    const findings = scanMcpConfigs()
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      serverName: 'srv',
      envVar: 'API_KEY',
      suggestedVaultId: 'srv-API_KEY',
      alreadyInVault: false,
    })
    expect(findings[0].maskedValue).toBe('sk-...nop')
  })

  it('skips a value that already looks like a vault reference', () => {
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({
      mcpServers: { srv: { command: 'x', env: { API_KEY: 'vault:already-bound' } } },
    }))
    expect(scanMcpConfigs()).toEqual([])
  })

  it('skips non-sensitive-looking values (bool/url/numeric/path/template)', () => {
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({
      mcpServers: {
        srv: {
          command: 'x',
          env: {
            API_FLAG: 'true',
            API_URL: 'https://example.test',
            API_PORT: '12345678',
            API_PATH: '/usr/local/bin',
            API_TEMPLATE: '${SOME_VAR}',
          },
        },
      },
    }))
    expect(scanMcpConfigs()).toEqual([])
  })

  it('skips a key that does not look sensitive', () => {
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({
      mcpServers: { srv: { command: 'x', env: { LOG_LEVEL: 'a-long-enough-value' } } },
    }))
    expect(scanMcpConfigs()).toEqual([])
  })

  it('marks a finding alreadyInVault when a matching secret value is found', () => {
    setMockFile('/tmp/mock-root/.mcp.json', JSON.stringify({
      mcpServers: { srv: { command: 'x', env: { AUTH_TOKEN: 'sk-abcdefghijklmnop' } } },
    }))
    vi.mocked(listSecrets).mockReturnValue([{ id: 'existing-id' } as never])
    vi.mocked(getSecret).mockReturnValue('sk-abcdefghijklmnop')

    const findings = scanMcpConfigs()
    expect(findings[0].alreadyInVault).toBe(true)
    expect(findings[0].existingVaultId).toBe('existing-id')
  })

  it('skips an unreadable/malformed mcp file without throwing', () => {
    setMockFile('/tmp/mock-root/.mcp.json', '{not json')
    expect(() => scanMcpConfigs()).not.toThrow()
    expect(scanMcpConfigs()).toEqual([])
  })
})

// ── syncSecret ───────────────────────────────────────────────────────────────

describe('syncSecret', () => {
  it('returns updated:0 when there are no bindings for the secret', async () => {
    expect(await syncSecret('s1')).toEqual({ updated: 0, errors: [] })
  })

  it('returns an error when the vault secret itself is missing', async () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] }])
    vi.mocked(getSecret).mockReturnValue(null)
    const result = await syncSecret('s1')
    expect(result.updated).toBe(0)
    expect(result.errors).toEqual(['Vault secret "s1" not found'])
  })

  it('writes the vault: reference and wraps the command on success', async () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] }])
    setMockFile('/mcp.json', JSON.stringify({ mcpServers: { srv: { command: 'orig-cmd', args: ['--x'] } } }))
    vi.mocked(getSecret).mockReturnValue('the-secret-value')

    const result = await syncSecret('s1')
    expect(result).toEqual({ updated: 1, errors: [] })

    const [path, content] = atomicWriteFileSync.mock.calls[0]
    expect(path).toBe('/mcp.json')
    const written = JSON.parse(content as string)
    expect(written.mcpServers.srv.env.API_KEY).toBe('vault:s1')
    expect(written.mcpServers.srv.command).toBe('/tmp/mock-root/scripts/vault-env-wrapper.sh')
    expect(written.mcpServers.srv.args).toEqual(['orig-cmd', '--x'])
  })

  it('does not wrap a remote (url-based) server, only sets env', async () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] }])
    setMockFile('/mcp.json', JSON.stringify({ mcpServers: { srv: { url: 'https://example.test' } } }))
    vi.mocked(getSecret).mockReturnValue('v')

    await syncSecret('s1')
    const [, content] = atomicWriteFileSync.mock.calls[0]
    const written = JSON.parse(content as string)
    expect(written.mcpServers.srv.command).toBeUndefined()
    expect(written.mcpServers.srv.env.API_KEY).toBe('vault:s1')
  })

  it('reports an error and skips when the target server is not found', async () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'missing' }] }])
    setMockFile('/mcp.json', JSON.stringify({ mcpServers: {} }))
    vi.mocked(getSecret).mockReturnValue('v')

    const result = await syncSecret('s1')
    expect(result.updated).toBe(0)
    expect(result.errors).toEqual(['Server "missing" not found in /mcp.json'])
  })

  it('captures a per-target write failure as an error without throwing', async () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/broken.json', serverName: 'srv' }] }])
    setMockFile('/broken.json', '{not json')
    vi.mocked(getSecret).mockReturnValue('v')

    const result = await syncSecret('s1')
    expect(result.updated).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/^Failed to update \/broken\.json:/)
  })
})

// ── unsyncBinding ────────────────────────────────────────────────────────────

describe('unsyncBinding', () => {
  it('removes the env var from every matching target and unwraps when safe', async () => {
    seedBindings([
      { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] },
      { vaultSecretId: 's1', envVar: 'OTHER', targets: [] },
    ])
    setMockFile('/mcp.json', JSON.stringify({
      mcpServers: {
        srv: {
          command: '/tmp/mock-root/scripts/vault-env-wrapper.sh',
          args: ['orig-cmd'],
          _vaultOriginalCommand: 'orig-cmd',
          env: { API_KEY: 'vault:s1' },
        },
      },
    }))

    await unsyncBinding('s1', 'API_KEY')

    const [, content] = atomicWriteFileSync.mock.calls[0]
    const written = JSON.parse(content as string)
    expect(written.mcpServers.srv.env.API_KEY).toBeUndefined()
    expect(written.mcpServers.srv.command).toBe('orig-cmd')
  })

  it('does nothing when the server config has no env block', async () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] }])
    setMockFile('/mcp.json', JSON.stringify({ mcpServers: { srv: { command: 'x' } } }))

    await unsyncBinding('s1', 'API_KEY')
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('swallows a malformed target file without throwing', async () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/broken.json', serverName: 'srv' }] }])
    setMockFile('/broken.json', 'not json')

    await expect(unsyncBinding('s1', 'API_KEY')).resolves.not.toThrow()
  })
})

// ── syncAllBindings ──────────────────────────────────────────────────────────

// -- per-secret grantee list (vault_secret_acl, migration 0090) --

describe('granteeOfMcpFile', () => {
  const home = homedir()

  it('maps the four places collectAllMcpFilePaths lists, and the external project paths', () => {
    vi.mocked(getExternalProjectPaths).mockReturnValue(['/ext/proj'])
    expect(granteeOfMcpFile('/tmp/mock-root/.mcp.json')).toBe('scope:project')
    expect(granteeOfMcpFile(`${home}/.claude.json`)).toBe('scope:user')
    expect(granteeOfMcpFile('/tmp/mock-agents/agent-a/.mcp.json')).toBe('agent:agent-a')
    expect(granteeOfMcpFile('/tmp/mock-agents/agent-a/projects/p1/.mcp.json')).toBe('agent:agent-a')
    expect(granteeOfMcpFile('/ext/proj/.mcp.json')).toBe('scope:external')
  })

  it('agrees with collectAllMcpFilePaths: every file it lists maps to a grantee, none to null', () => {
    vi.mocked(listAgentNames).mockReturnValue(['agent-a'])
    vi.mocked(getExternalProjectPaths).mockReturnValue(['/ext/proj'])
    for (const p of [
      '/tmp/mock-root/.mcp.json', `${home}/.claude.json`, '/tmp/mock-agents/agent-a/.mcp.json',
      '/tmp/mock-agents/agent-a/projects/p1/.mcp.json', '/ext/proj/.mcp.json',
    ]) setMockFile(p, '{}')
    setMockDir('/tmp/mock-agents/agent-a/projects', ['p1'])
    const listed = collectAllMcpFilePaths()
    expect(listed).toHaveLength(5)
    for (const { path } of listed) expect(granteeOfMcpFile(path), path).not.toBeNull()
  })

  it('every path the discovery lists is canonical (resolve(p) === p), so the canonical-path check never refuses a discovered file', () => {
    vi.mocked(listAgentNames).mockReturnValue(['agent-a'])
    // an external path given with a trailing slash and with a dot segment is normalised by the join
    vi.mocked(getExternalProjectPaths).mockReturnValue(['/ext/proj/', '/ext/other/../proj'])
    for (const p of [
      '/tmp/mock-root/.mcp.json', `${home}/.claude.json`, '/tmp/mock-agents/agent-a/.mcp.json',
      '/tmp/mock-agents/agent-a/projects/p1/.mcp.json', '/ext/proj/.mcp.json',
    ]) setMockFile(p, '{}')
    setMockDir('/tmp/mock-agents/agent-a/projects', ['p1'])
    const listed = collectAllMcpFilePaths()
    expect(listed.length).toBeGreaterThanOrEqual(5)
    for (const { path } of listed) {
      expect(isCanonicalMcpPath(path), path).toBe(true)
      expect(verifiedGranteeOfMcpFile(path), path).toBe(granteeOfMcpFile(path))
    }
  })

  it.each([
    ['an unknown directory', '/tmp/other/.mcp.json'],
    ['a different file name in an agent directory', '/tmp/mock-agents/agent-a/other.json'],
    ['the agents directory itself', '/tmp/mock-agents/.mcp.json'],
    ['a projects directory with no project', '/tmp/mock-agents/agent-a/projects/.mcp.json'],
    ['a file nested one level too deep', '/tmp/mock-agents/agent-a/projects/p/x/.mcp.json'],
    ['a sub directory that is not "projects"', '/tmp/mock-agents/agent-a/sub/.mcp.json'],
    ['a relative path', 'agents/agent-a/.mcp.json'],
    ['a path under the project root but not its .mcp.json', '/tmp/mock-root/sub/.mcp.json'],
    ['a name with a space', '/tmp/mock-agents/agent a/.mcp.json'],
    ['a name of 65 characters', `/tmp/mock-agents/${'a'.repeat(65)}/.mcp.json`],
    ['a directory beside the external project', '/ext/proj/sub/.mcp.json'],
  ])('is null for %s', (_name, p) => {
    vi.mocked(getExternalProjectPaths).mockReturnValue(['/ext/proj'])
    expect(granteeOfMcpFile(p)).toBeNull()
  })

  it('is null for anything that is not a usable string', () => {
    for (const v of [undefined, null, 42, {}, [], '', 'a\0b']) expect(granteeOfMcpFile(v), String(v)).toBeNull()
  })

  it('accepts a 64-character agent name (the id limit)', () => {
    expect(granteeOfMcpFile(`/tmp/mock-agents/${'a'.repeat(64)}/.mcp.json`)).toBe(`agent:${'a'.repeat(64)}`)
  })

  it('resolves ".." BEFORE it judges: agent-a/../agent-b is agent-b\'s file, never agent-a\'s', () => {
    expect(granteeOfMcpFile('/tmp/mock-agents/agent-a/../agent-b/.mcp.json')).toBe('agent:agent-b')
    expect(granteeOfMcpFile('/tmp/mock-agents/../mock-agents/agent-a/.mcp.json')).toBe('agent:agent-a')
    // out of the agents tree altogether
    expect(granteeOfMcpFile('/tmp/mock-agents/agent-a/../../etc/.mcp.json')).toBeNull()
    expect(granteeOfMcpFile('/tmp/mock-agents/agent-a/../../mock-root/.mcp.json')).toBe('scope:project')
  })

  it('compares whole path segments, not prefixes: agent-a-evil is not agent-a, a sibling tree is nobody', () => {
    expect(granteeOfMcpFile('/tmp/mock-agents/agent-a-evil/.mcp.json')).toBe('agent:agent-a-evil')
    expect(granteeOfMcpFile('/tmp/mock-agents-evil/agent-a/.mcp.json')).toBeNull()
    expect(granteeOfMcpFile('/tmp/mock-root-evil/.mcp.json')).toBeNull()
    expect(granteeOfMcpFile('/tmp/mock-root/.mcp.json/x')).toBeNull()
  })

  it('is PURE: it judges the path as written and never touches the file system', () => {
    // A link in a directory on the way is NOT followed here (that is verifiedGranteeOfMcpFile, which the list
    // checks use; see vault-bindings-symlink.test.ts). This pins the purity: no stat, no read, no readdir.
    vi.mocked(existsSync).mockClear()
    vi.mocked(readFileSync).mockClear()
    vi.mocked(readdirSync).mockClear()
    vi.mocked(statSync).mockClear()
    granteeOfMcpFile('/tmp/mock-agents/agent-a/.mcp.json')
    granteeOfMcpFile('/tmp/other/.mcp.json')
    expect(existsSync).not.toHaveBeenCalled()
    expect(readFileSync).not.toHaveBeenCalled()
    expect(readdirSync).not.toHaveBeenCalled()
    expect(statSync).not.toHaveBeenCalled()
  })
})

describe('partitionTargetsByAcl', () => {
  const A = { mcpFilePath: '/tmp/mock-agents/agent-a/.mcp.json', serverName: 's' }
  const B = { mcpFilePath: '/tmp/mock-agents/agent-b/.mcp.json', serverName: 's' }
  const U = { mcpFilePath: '/nowhere/.mcp.json', serverName: 's' }

  it('an EMPTY list allows every target, unknown paths and odd entries included (today\'s behaviour)', () => {
    const odd = { mcpFilePath: 42, serverName: 's' } as unknown as typeof A
    expect(partitionTargetsByAcl([], [A, B, U, odd])).toEqual({ allowed: [A, B, U, odd], refused: [] })
  })

  it('an EMPTY list makes no file-system call at all (the file-level link check is for a list only)', () => {
    vi.mocked(lstatSync).mockClear()
    vi.mocked(realpathSync).mockClear()
    partitionTargetsByAcl([], [A, B, U])
    expect(lstatSync).not.toHaveBeenCalled()
    expect(realpathSync).not.toHaveBeenCalled()
  })

  it('a file that cannot be looked at (not ENOENT, e.g. no permission) is refused, fail-closed', () => {
    vi.mocked(lstatSync).mockImplementationOnce(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) })
    expect(partitionTargetsByAcl(['agent:agent-a'], [A])).toEqual({ allowed: [], refused: [{ target: A, grantee: null }] })
    expect(partitionTargetsByAcl(['agent:agent-a'], [A]).allowed).toEqual([A]) // the next call is back to normal
  })

  it('a non-empty list allows the listed grantees and refuses the rest with their grantee', () => {
    expect(partitionTargetsByAcl(['agent:agent-a'], [A, B])).toEqual({
      allowed: [A], refused: [{ target: B, grantee: 'agent:agent-b' }],
    })
  })

  it('a target of no known grantee (null) is refused by a non-empty list', () => {
    expect(partitionTargetsByAcl(['agent:agent-a'], [U])).toEqual({ allowed: [], refused: [{ target: U, grantee: null }] })
  })

  it('a scope entry allows the files of that scope only', () => {
    const P = { mcpFilePath: '/tmp/mock-root/.mcp.json', serverName: 's' }
    expect(partitionTargetsByAcl(['scope:project'], [P, A]).allowed).toEqual([P])
  })

  it('refuses a target entry that is null or has no usable path, and a targets value that is not an array', () => {
    expect(partitionTargetsByAcl(['scope:user'], [null as never, {} as never]).allowed).toEqual([])
    const notArray = { length: 2 } as never
    expect(partitionTargetsByAcl(['scope:user'], notArray).allowed).toEqual([])
    expect(partitionTargetsByAcl(['scope:user'], notArray).refused).toHaveLength(1)
  })
})

describe('syncSecret with a grantee list', () => {
  const A = '/tmp/mock-agents/agent-a/.mcp.json'
  const B = '/tmp/mock-agents/agent-b/.mcp.json'
  const P = '/tmp/mock-root/.mcp.json'
  const SERVER = { mcpServers: { srv: { command: 'orig' } } }

  function seedSecret(targets: string[], envVar = 'API_KEY'): void {
    seedBindings([{ vaultSecretId: 's1', envVar, targets: targets.map(mcpFilePath => ({ mcpFilePath, serverName: 'srv' })) }])
    for (const t of targets) setMockFile(t, JSON.stringify(SERVER))
    vi.mocked(getSecret).mockReturnValue('the-secret-value')
  }
  const writtenPaths = () => atomicWriteFileSync.mock.calls.map(c => c[0])

  it('an EMPTY list is the old behaviour: every target is written, an unknown path included, no error', async () => {
    seedSecret([A, B, P, '/mcp.json'])
    expect(await syncSecret('s1')).toEqual({ updated: 4, errors: [] })
    expect(writtenPaths()).toEqual([A, B, P, '/mcp.json'])
  })

  it('a non-empty list writes only the listed grantee\'s file and reports every other target', async () => {
    secretAclDb.lists['s1'] = ['agent:agent-a']
    seedSecret([A, B, P, '/mcp.json'])
    const result = await syncSecret('s1')
    expect(result.updated).toBe(1)
    expect(result.errors).toEqual([
      'Target not allowed for secret "s1": agent:agent-b',
      'Target not allowed for secret "s1": scope:project',
      'Target not allowed for secret "s1": /mcp.json (it must be a regular file with a single name in a known place: no link, no second name, no special file)',
    ])
    expect(writtenPaths()).toEqual([A])
  })

  it('a binding row that lists a denied target directly (the fleet-transfer import writes rows with no check) is still not written', async () => {
    secretAclDb.lists['s1'] = ['agent:agent-a']
    seedSecret([B])
    const result = await syncSecret('s1')
    expect(result.updated).toBe(0)
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
    expect(result.errors).toHaveLength(1)
  })

  it('a file outside every known place is refused by a non-empty list (fail-closed)', async () => {
    secretAclDb.lists['s1'] = ['agent:agent-a', 'scope:project', 'scope:user', 'scope:external']
    seedSecret(['/mcp.json'])
    const result = await syncSecret('s1')
    expect(result.updated).toBe(0)
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('does not remove a reference an earlier sync already wrote into a denied file', async () => {
    secretAclDb.lists['s1'] = ['agent:agent-a']
    seedSecret([B])
    const before = JSON.stringify({ mcpServers: { srv: { command: 'wrapper', env: { API_KEY: 'vault:s1' } } } })
    setMockFile(B, before)
    await syncSecret('s1')
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
    expect(mockFsFiles[B]).toBe(before)
  })

  it('the secret value never appears in the result or the errors', async () => {
    secretAclDb.lists['s1'] = ['agent:agent-a']
    seedSecret([A, B, '/mcp.json'])
    const result = await syncSecret('s1')
    expect(JSON.stringify(result)).not.toContain('the-secret-value')
  })

  it('filters every binding of the secret (two env vars), and a missing secret still wins first', async () => {
    secretAclDb.lists['s1'] = ['agent:agent-a']
    seedBindings([
      { vaultSecretId: 's1', envVar: 'K1', targets: [{ mcpFilePath: A, serverName: 'srv' }, { mcpFilePath: B, serverName: 'srv' }] },
      { vaultSecretId: 's1', envVar: 'K2', targets: [{ mcpFilePath: B, serverName: 'srv' }] },
    ])
    setMockFile(A, JSON.stringify(SERVER))
    setMockFile(B, JSON.stringify(SERVER))
    vi.mocked(getSecret).mockReturnValue(null)
    expect((await syncSecret('s1')).errors).toEqual(['Vault secret "s1" not found'])
    vi.mocked(getSecret).mockReturnValue('v')
    const result = await syncSecret('s1')
    expect(result.updated).toBe(1)
    expect(result.errors).toHaveLength(2)
  })

  it('syncAllBindings carries the refusals: the list of one secret does not hide or open another', async () => {
    secretAclDb.lists['s1'] = ['agent:agent-a']
    seedBindings([
      { vaultSecretId: 's1', envVar: 'K', targets: [{ mcpFilePath: B, serverName: 'srv' }] },
      { vaultSecretId: 's2', envVar: 'K', targets: [{ mcpFilePath: B, serverName: 'srv' }] },
    ])
    setMockFile(B, JSON.stringify(SERVER))
    vi.mocked(getSecret).mockReturnValue('v')
    const result = await syncAllBindings()
    expect(result.updated).toBe(1)
    expect(result.errors).toEqual(['Target not allowed for secret "s1": agent:agent-b'])
  })
})

describe('the secret list wrappers use the default tenant', () => {
  it('set, get, remove and the all-lists read go through tenant "default"', async () => {
    await setSecretAcl('s1', ['agent:agent-a', 'agent:agent-a'])
    expect(await getSecretAcl('s1')).toEqual(['agent:agent-a'])
    expect(await getAllSecretAcls()).toEqual({ s1: ['agent:agent-a'] })
    await removeSecretAcl('s1')
    expect(await getSecretAcl('s1')).toEqual([])
    expect(new Set(secretAclDb.tenants)).toEqual(new Set(['default']))
    expect(secretAclDb.tenants.length).toBe(5)
  })
})

describe('syncAllBindings', () => {
  it('aggregates updated counts and errors across every distinct secret id', async () => {
    seedBindings([
      { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp1.json', serverName: 'srv1' }] },
      { vaultSecretId: 's2', envVar: 'OTHER_KEY', targets: [{ mcpFilePath: '/mcp2.json', serverName: 'missing' }] },
    ])
    setMockFile('/mcp1.json', JSON.stringify({ mcpServers: { srv1: { command: 'x' } } }))
    setMockFile('/mcp2.json', JSON.stringify({ mcpServers: {} }))
    vi.mocked(getSecret).mockReturnValue('v')

    const result = await syncAllBindings()
    expect(result.updated).toBe(1)
    expect(result.errors).toEqual(['Server "missing" not found in /mcp2.json'])
  })

  it('returns updated:0 and no errors when there are no bindings at all', async () => {
    expect(await syncAllBindings()).toEqual({ updated: 0, errors: [] })
  })
})
