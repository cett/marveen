// dashboard-settings.ts (#751 backend coverage series) had zero direct tests --
// connectors-external-paths.test.ts mocks this whole module out to isolate the
// connectors.ts route, so its real read/write/clone/update logic was never
// exercised. This file drives the real implementation directly: external
// project path add/remove, GitHub repo install/remove/update, and the
// .mcp.json env-var detection helper.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockExisting = new Set<string>()
const mockDirs = new Set<string>()
const mockFiles: Record<string, string> = {}

vi.mock('node:fs', () => ({
  existsSync: vi.fn((p: unknown) => mockExisting.has(String(p))),
  statSync: vi.fn((p: unknown) => ({ isDirectory: () => mockDirs.has(String(p)) })),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
}))

vi.mock('../web/agent-config.js', () => ({
  readFileOr: vi.fn((p: string, fallback: string) => mockFiles[p] ?? fallback),
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn((p: string, data: string) => { mockFiles[p] = data }),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/mock-root',
  STORE_DIR: '/tmp/mock-store',
}))

import { mkdirSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { readFileOr } from '../web/agent-config.js'
import { atomicWriteFileSync } from '../web/atomic-write.js'
import {
  getExternalProjectPaths,
  addExternalProjectPath,
  removeExternalProjectPath,
  getGitHubRepos,
  detectRequiredEnvVars,
  installGitHubRepo,
  removeGitHubRepo,
  updateGitHubRepo,
} from '../web/dashboard-settings.js'

const SETTINGS_PATH = '/tmp/mock-store/dashboard-settings.json'
const REPOS_DIR = '/tmp/mock-store/github-repos'

function reset() {
  mockExisting.clear()
  mockDirs.clear()
  for (const k of Object.keys(mockFiles)) delete mockFiles[k]
  vi.clearAllMocks()
}

beforeEach(reset)

describe('dashboard-settings: external project paths', () => {
  it('returns [] when no settings file exists yet', () => {
    expect(getExternalProjectPaths()).toEqual([])
  })

  it('rejects a missing or relative path with required', () => {
    expect(addExternalProjectPath('')).toEqual({ paths: [], error: 'required', field: 'path', hint: 'Absolute path required' })
    expect(addExternalProjectPath('relative/dir')).toMatchObject({ error: 'required', field: 'path' })
  })

  it('rejects a path that does not exist', () => {
    const res = addExternalProjectPath('/some/dir')
    expect(res).toMatchObject({ error: 'not_found', field: 'path' })
  })

  it('rejects a path that exists but is not a directory', () => {
    mockExisting.add('/some/file')
    const res = addExternalProjectPath('/some/file')
    expect(res).toMatchObject({ error: 'not_found', field: 'path' })
  })

  it('adds a valid directory and persists it', () => {
    mockExisting.add('/proj/a')
    mockDirs.add('/proj/a')
    const res = addExternalProjectPath('/proj/a')
    expect(res).toEqual({ paths: ['/proj/a'] })
    expect(atomicWriteFileSync).toHaveBeenCalledWith(SETTINGS_PATH, expect.stringContaining('/proj/a'))
    expect(getExternalProjectPaths()).toEqual(['/proj/a'])
  })

  it('does not duplicate an already-added path', () => {
    mockExisting.add('/proj/a')
    mockDirs.add('/proj/a')
    addExternalProjectPath('/proj/a')
    vi.clearAllMocks()
    const res = addExternalProjectPath('/proj/a')
    expect(res).toEqual({ paths: ['/proj/a'] })
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('removes a path (idempotent when absent)', () => {
    mockExisting.add('/proj/a')
    mockDirs.add('/proj/a')
    addExternalProjectPath('/proj/a')
    expect(removeExternalProjectPath('/proj/a')).toEqual([])
    expect(removeExternalProjectPath('/proj/never-added')).toEqual([])
  })
})

describe('dashboard-settings: detectRequiredEnvVars', () => {
  it('returns [] when .mcp.json does not exist', () => {
    expect(detectRequiredEnvVars('/repo')).toEqual([])
  })

  it('returns [] when .mcp.json is malformed', () => {
    mockExisting.add('/repo/.mcp.json')
    mockFiles['/repo/.mcp.json'] = '{not json'
    expect(detectRequiredEnvVars('/repo')).toEqual([])
  })

  it('collects the union of env keys across all servers', () => {
    mockExisting.add('/repo/.mcp.json')
    mockFiles['/repo/.mcp.json'] = JSON.stringify({
      mcpServers: {
        a: { env: { FOO: 'x', BAR: 'y' } },
        b: { env: { BAR: 'y', BAZ: 'z' } },
        c: {},
      },
    })
    expect(detectRequiredEnvVars('/repo').sort()).toEqual(['BAR', 'BAZ', 'FOO'])
  })
})

describe('dashboard-settings: GitHub repo install', () => {
  it('rejects an invalid GitHub URL', async () => {
    const res = await installGitHubRepo('not-a-url')
    expect(res).toEqual({ error: 'invalid_value', field: 'url', hint: 'Invalid GitHub URL' })
  })

  it('rejects when already installed', async () => {
    mockExisting.add(REPOS_DIR + '/acme--widget')
    mockFiles[SETTINGS_PATH] = JSON.stringify({ githubRepos: [{ name: 'acme--widget', url: 'x', path: 'p', installedAt: 'now' }] })
    const res = await installGitHubRepo('https://github.com/acme/widget')
    expect(res).toEqual({ error: 'conflict', hint: 'Already installed: acme--widget' })
    expect(rmSync).not.toHaveBeenCalled()
  })

  it('wipes a stale target dir not in settings, then clones fresh', async () => {
    mockExisting.add(REPOS_DIR + '/acme--widget')
    const progress: string[] = []
    const res = await installGitHubRepo('https://github.com/acme/widget.git', undefined, p => progress.push(p.stage))
    expect(rmSync).toHaveBeenCalledWith(REPOS_DIR + '/acme--widget', { recursive: true, force: true })
    expect(mkdirSync).toHaveBeenCalledWith(REPOS_DIR, { recursive: true })
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('git clone --depth 1 https://github.com/acme/widget.git'),
      expect.any(Object),
    )
    expect(progress).toEqual(['cloning', 'done'])
    expect(res).toMatchObject({ repo: { name: 'acme--widget', url: 'https://github.com/acme/widget.git' } })
    expect(getGitHubRepos()).toHaveLength(1)
    expect(getExternalProjectPaths()).toContain(REPOS_DIR + '/acme--widget')
  })

  it('cleans up and returns internal_error when the clone fails', async () => {
    vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('clone boom') })
    const res = await installGitHubRepo('https://github.com/acme/widget')
    expect(res).toEqual({ error: 'internal_error', hint: 'Clone failed' })
    expect(rmSync).toHaveBeenCalledWith(REPOS_DIR + '/acme--widget', { recursive: true, force: true })
  })

  it('runs npm install when package.json is present, and tolerates its failure', async () => {
    mockExisting.add(REPOS_DIR + '/acme--widget/package.json')
    vi.mocked(execSync).mockImplementationOnce(() => '') // git clone
    vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('npm boom') }) // npm install
    const res = await installGitHubRepo('https://github.com/acme/widget')
    expect(res).toMatchObject({ repo: { name: 'acme--widget' } })
    expect(execSync).toHaveBeenCalledTimes(2)
  })

  it('surfaces detected required env vars and stores provided envVars', async () => {
    mockExisting.add(REPOS_DIR + '/acme--widget/.mcp.json')
    mockFiles[REPOS_DIR + '/acme--widget/.mcp.json'] = JSON.stringify({ mcpServers: { a: { env: { TOKEN: 'x' } } } })
    const res = await installGitHubRepo('https://github.com/acme/widget', { TOKEN: 'vault:1' })
    expect(res).toMatchObject({ repo: { envVars: { TOKEN: 'vault:1' } }, requiredEnvVars: ['TOKEN'] })
  })

  it('does not duplicate an already-listed external project path', async () => {
    mockFiles[SETTINGS_PATH] = JSON.stringify({ externalProjectPaths: [REPOS_DIR + '/acme--widget'] })
    await installGitHubRepo('https://github.com/acme/widget')
    expect(getExternalProjectPaths().filter(p => p === REPOS_DIR + '/acme--widget')).toHaveLength(1)
  })
})

describe('dashboard-settings: removeGitHubRepo', () => {
  it('returns not_found when the repo is unknown', () => {
    expect(removeGitHubRepo('missing')).toEqual({ ok: false, error: 'not_found', hint: 'Repo not found' })
  })

  it('removes the on-disk directory and the settings entry', () => {
    mockFiles[SETTINGS_PATH] = JSON.stringify({
      githubRepos: [{ name: 'acme--widget', url: 'x', path: REPOS_DIR + '/acme--widget', installedAt: 'now' }],
      externalProjectPaths: [REPOS_DIR + '/acme--widget', '/other'],
    })
    mockExisting.add(REPOS_DIR + '/acme--widget')
    const res = removeGitHubRepo('acme--widget')
    expect(res).toEqual({ ok: true })
    expect(rmSync).toHaveBeenCalledWith(REPOS_DIR + '/acme--widget', { recursive: true, force: true })
    expect(getGitHubRepos()).toEqual([])
    expect(getExternalProjectPaths()).toEqual(['/other'])
  })

  it('skips rmSync when the directory is already gone', () => {
    mockFiles[SETTINGS_PATH] = JSON.stringify({
      githubRepos: [{ name: 'acme--widget', url: 'x', path: REPOS_DIR + '/acme--widget', installedAt: 'now' }],
    })
    const res = removeGitHubRepo('acme--widget')
    expect(res).toEqual({ ok: true })
    expect(rmSync).not.toHaveBeenCalled()
  })
})

describe('dashboard-settings: updateGitHubRepo', () => {
  it('returns not_found when the repo is unknown', () => {
    expect(updateGitHubRepo('missing')).toEqual({ ok: false, error: 'not_found', hint: 'Repo not found' })
  })

  it('returns not_found when the on-disk directory is missing', () => {
    mockFiles[SETTINGS_PATH] = JSON.stringify({ githubRepos: [{ name: 'acme--widget', url: 'x', path: REPOS_DIR + '/acme--widget', installedAt: 'now' }] })
    const res = updateGitHubRepo('acme--widget')
    expect(res).toEqual({ ok: false, error: 'not_found', hint: 'Directory missing' })
  })

  it('pulls only, when there is no package.json', () => {
    mockFiles[SETTINGS_PATH] = JSON.stringify({ githubRepos: [{ name: 'acme--widget', url: 'x', path: REPOS_DIR + '/acme--widget', installedAt: 'now' }] })
    mockExisting.add(REPOS_DIR + '/acme--widget')
    const res = updateGitHubRepo('acme--widget')
    expect(res).toEqual({ ok: true })
    expect(execSync).toHaveBeenCalledTimes(1)
    expect(execSync).toHaveBeenCalledWith('git pull --ff-only 2>&1', expect.objectContaining({ cwd: REPOS_DIR + '/acme--widget' }))
  })

  it('pulls and npm-installs when package.json is present', () => {
    mockFiles[SETTINGS_PATH] = JSON.stringify({ githubRepos: [{ name: 'acme--widget', url: 'x', path: REPOS_DIR + '/acme--widget', installedAt: 'now' }] })
    mockExisting.add(REPOS_DIR + '/acme--widget')
    mockExisting.add(REPOS_DIR + '/acme--widget/package.json')
    const res = updateGitHubRepo('acme--widget')
    expect(res).toEqual({ ok: true })
    expect(execSync).toHaveBeenCalledTimes(2)
  })

  it('returns internal_error when git pull fails', () => {
    mockFiles[SETTINGS_PATH] = JSON.stringify({ githubRepos: [{ name: 'acme--widget', url: 'x', path: REPOS_DIR + '/acme--widget', installedAt: 'now' }] })
    mockExisting.add(REPOS_DIR + '/acme--widget')
    vi.mocked(execSync).mockImplementationOnce(() => { throw new Error('pull boom') })
    const res = updateGitHubRepo('acme--widget')
    expect(res).toEqual({ ok: false, error: 'internal_error', hint: 'Update failed' })
  })
})
