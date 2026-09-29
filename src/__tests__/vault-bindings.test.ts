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

import {
  getBindings, addBinding, removeBinding, removeBindingsForSecret,
  collectAllMcpFilePaths, scanMcpConfigs, syncSecret, unsyncBinding, syncAllBindings,
  type VaultBinding,
} from '../web/vault-bindings.js'
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
  for (const k of Object.keys(mockFsFiles)) delete mockFsFiles[k]
  for (const k of Object.keys(mockFsDirs)) delete mockFsDirs[k]
})

// ── getBindings / addBinding / removeBinding ────────────────────────────────

describe('getBindings', () => {
  it('returns an empty list when the DB has no rows', () => {
    expect(getBindings()).toEqual([])
  })

  it('returns the bindings from the DB', () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [] }])
    expect(getBindings()).toEqual([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [] }])
  })
})

describe('addBinding', () => {
  it('upserts a new binding into the DB via upsertVaultBinding', () => {
    addBinding({ vaultSecretId: 's1', envVar: 'API_KEY', targets: [] })
    expect(upsertVaultBinding).toHaveBeenCalledTimes(1)
    expect(upsertVaultBinding).toHaveBeenCalledWith('default', { vaultSecretId: 's1', envVar: 'API_KEY', targets: [] })
    expect(getBindings()).toEqual([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [] }])
  })

  it('replaces an existing binding with the same vaultSecretId + envVar', () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/a', serverName: 'x' }] }])
    addBinding({ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/b', serverName: 'y' }] })
    const bindings = getBindings()
    expect(bindings).toHaveLength(1)
    expect(bindings[0].targets).toEqual([{ mcpFilePath: '/b', serverName: 'y' }])
  })
})

describe('removeBinding', () => {
  it('returns false when no matching binding exists', () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [] }])
    expect(removeBinding('s2', 'OTHER')).toBe(false)
    expect(deleteVaultBinding).toHaveBeenCalledWith('default', 's2', 'OTHER')
  })

  it('removes the matching binding and returns true', () => {
    seedBindings([
      { vaultSecretId: 's1', envVar: 'API_KEY', targets: [] },
      { vaultSecretId: 's2', envVar: 'OTHER', targets: [] },
    ])
    expect(removeBinding('s1', 'API_KEY')).toBe(true)
    expect(getBindings()).toEqual([{ vaultSecretId: 's2', envVar: 'OTHER', targets: [] }])
  })
})

describe('removeBindingsForSecret', () => {
  it('strips the env var from every target file and unwraps the command when no vault refs remain', () => {
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

    removeBindingsForSecret('s1')

    const [path, content] = atomicWriteFileSync.mock.calls[0]
    expect(path).toBe('/mcp.json')
    const written = JSON.parse(content as string)
    expect(written.mcpServers.srv.env.API_KEY).toBeUndefined()
    expect(written.mcpServers.srv.command).toBe('orig-cmd')
    expect(written.mcpServers.srv.args).toEqual(['--flag'])
    expect(written.mcpServers.srv._vaultOriginalCommand).toBeUndefined()

    // Binding for s1 is gone, s2 untouched.
    expect(getBindings()).toEqual([{ vaultSecretId: 's2', envVar: 'OTHER', targets: [] }])
  })

  it('keeps the wrapper command when another env var still references vault:', () => {
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

    removeBindingsForSecret('s1')

    const [, content] = atomicWriteFileSync.mock.calls[0]
    const written = JSON.parse(content as string)
    expect(written.mcpServers.srv.command).toBe('/tmp/mock-root/scripts/vault-env-wrapper.sh')
  })

  it('skips a target whose server config has no env block, without throwing', () => {
    seedBindings([
      { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] },
    ])
    setMockFile('/mcp.json', JSON.stringify({ mcpServers: { srv: { command: 'x' } } }))

    expect(() => removeBindingsForSecret('s1')).not.toThrow()
    // No env block -> the per-target write is skipped. Unlike the pre-
    // migration file store, there is no separate bindings-store write to
    // fall back to, so atomicWriteFileSync is never called at all here.
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
    expect(getBindings()).toEqual([])
  })

  it('swallows a per-target failure (malformed target file) and still drops the binding', () => {
    seedBindings([
      { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/broken.json', serverName: 'srv' }] },
    ])
    setMockFile('/broken.json', '{not json')

    expect(() => removeBindingsForSecret('s1')).not.toThrow()
    expect(getBindings()).toEqual([])
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
  it('returns updated:0 when there are no bindings for the secret', () => {
    expect(syncSecret('s1')).toEqual({ updated: 0, errors: [] })
  })

  it('returns an error when the vault secret itself is missing', () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] }])
    vi.mocked(getSecret).mockReturnValue(null)
    const result = syncSecret('s1')
    expect(result.updated).toBe(0)
    expect(result.errors).toEqual(['Vault secret "s1" not found'])
  })

  it('writes the vault: reference and wraps the command on success', () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] }])
    setMockFile('/mcp.json', JSON.stringify({ mcpServers: { srv: { command: 'orig-cmd', args: ['--x'] } } }))
    vi.mocked(getSecret).mockReturnValue('the-secret-value')

    const result = syncSecret('s1')
    expect(result).toEqual({ updated: 1, errors: [] })

    const [path, content] = atomicWriteFileSync.mock.calls[0]
    expect(path).toBe('/mcp.json')
    const written = JSON.parse(content as string)
    expect(written.mcpServers.srv.env.API_KEY).toBe('vault:s1')
    expect(written.mcpServers.srv.command).toBe('/tmp/mock-root/scripts/vault-env-wrapper.sh')
    expect(written.mcpServers.srv.args).toEqual(['orig-cmd', '--x'])
  })

  it('does not wrap a remote (url-based) server, only sets env', () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] }])
    setMockFile('/mcp.json', JSON.stringify({ mcpServers: { srv: { url: 'https://example.test' } } }))
    vi.mocked(getSecret).mockReturnValue('v')

    syncSecret('s1')
    const [, content] = atomicWriteFileSync.mock.calls[0]
    const written = JSON.parse(content as string)
    expect(written.mcpServers.srv.command).toBeUndefined()
    expect(written.mcpServers.srv.env.API_KEY).toBe('vault:s1')
  })

  it('reports an error and skips when the target server is not found', () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'missing' }] }])
    setMockFile('/mcp.json', JSON.stringify({ mcpServers: {} }))
    vi.mocked(getSecret).mockReturnValue('v')

    const result = syncSecret('s1')
    expect(result.updated).toBe(0)
    expect(result.errors).toEqual(['Server "missing" not found in /mcp.json'])
  })

  it('captures a per-target write failure as an error without throwing', () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/broken.json', serverName: 'srv' }] }])
    setMockFile('/broken.json', '{not json')
    vi.mocked(getSecret).mockReturnValue('v')

    const result = syncSecret('s1')
    expect(result.updated).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/^Failed to update \/broken\.json:/)
  })
})

// ── unsyncBinding ────────────────────────────────────────────────────────────

describe('unsyncBinding', () => {
  it('removes the env var from every matching target and unwraps when safe', () => {
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

    unsyncBinding('s1', 'API_KEY')

    const [, content] = atomicWriteFileSync.mock.calls[0]
    const written = JSON.parse(content as string)
    expect(written.mcpServers.srv.env.API_KEY).toBeUndefined()
    expect(written.mcpServers.srv.command).toBe('orig-cmd')
  })

  it('does nothing when the server config has no env block', () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp.json', serverName: 'srv' }] }])
    setMockFile('/mcp.json', JSON.stringify({ mcpServers: { srv: { command: 'x' } } }))

    unsyncBinding('s1', 'API_KEY')
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('swallows a malformed target file without throwing', () => {
    seedBindings([{ vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/broken.json', serverName: 'srv' }] }])
    setMockFile('/broken.json', 'not json')

    expect(() => unsyncBinding('s1', 'API_KEY')).not.toThrow()
  })
})

// ── syncAllBindings ──────────────────────────────────────────────────────────

describe('syncAllBindings', () => {
  it('aggregates updated counts and errors across every distinct secret id', () => {
    seedBindings([
      { vaultSecretId: 's1', envVar: 'API_KEY', targets: [{ mcpFilePath: '/mcp1.json', serverName: 'srv1' }] },
      { vaultSecretId: 's2', envVar: 'OTHER_KEY', targets: [{ mcpFilePath: '/mcp2.json', serverName: 'missing' }] },
    ])
    setMockFile('/mcp1.json', JSON.stringify({ mcpServers: { srv1: { command: 'x' } } }))
    setMockFile('/mcp2.json', JSON.stringify({ mcpServers: {} }))
    vi.mocked(getSecret).mockReturnValue('v')

    const result = syncAllBindings()
    expect(result.updated).toBe(1)
    expect(result.errors).toEqual(['Server "missing" not found in /mcp2.json'])
  })

  it('returns updated:0 and no errors when there are no bindings at all', () => {
    expect(syncAllBindings()).toEqual({ updated: 0, errors: [] })
  })
})
