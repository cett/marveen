// Unit tests for src/web/update-checker.ts beyond the existing
// update-checker-branch.test.ts (which pins trackedBranch() against the real
// checkout). This file mocks git (execFileSync) and the GitHub REST calls
// (fetch) to exercise the rest of the module: the remote-url parser, the
// release-grouping logic, and refreshUpdateStatus's branches (up to date,
// normal compare, the customised-fork 404 fallback, and error handling).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockExecFileSync = vi.fn<(bin: string, args: string[]) => string>()
vi.mock('node:child_process', () => ({
  execFileSync: (...a: unknown[]) => mockExecFileSync(...(a as [string, string[]])),
}))

vi.mock('../config.js', () => ({ PROJECT_ROOT: '/tmp/test-project' }))
vi.mock('../tool-timeouts.js', () => ({ TOOL_TIMEOUTS: { github: 10_000 } }))

import {
  currentGitHead,
  parseGitHubRemote,
  groupByRelease,
  refreshUpdateStatus,
  getUpdateStatus,
  type UpdateCommit,
} from '../web/update-checker.js'

const originalFetch = globalThis.fetch

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

function setupGit({ head, branch = 'develop', mergeBase = '' }: { head: string, branch?: string, mergeBase?: string }) {
  mockExecFileSync.mockImplementation((_bin: string, args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${head}\n`
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return `${branch}\n`
    if (args[0] === 'config') return 'https://github.com/Szotasz/marveen.git\n'
    if (args[0] === 'merge-base') return `${mergeBase}\n`
    throw new Error(`unexpected git invocation: ${args.join(' ')}`)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('currentGitHead', () => {
  it('returns the trimmed HEAD sha', () => {
    mockExecFileSync.mockReturnValue('abc123\n')
    expect(currentGitHead()).toBe('abc123')
  })

  it('returns an empty string when git fails', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo') })
    expect(currentGitHead()).toBe('')
  })
})

describe('parseGitHubRemote', () => {
  it('extracts Owner/Repo from an https remote url', () => {
    mockExecFileSync.mockReturnValue('https://github.com/Szotasz/marveen.git\n')
    expect(parseGitHubRemote()).toBe('Szotasz/marveen')
  })

  it('extracts Owner/Repo from an ssh remote url', () => {
    mockExecFileSync.mockReturnValue('git@github.com:cett/marveen.git\n')
    expect(parseGitHubRemote()).toBe('cett/marveen')
  })

  it('falls back to the default remote when the url is not a github.com remote', () => {
    mockExecFileSync.mockReturnValue('https://gitlab.com/someone/else.git\n')
    expect(parseGitHubRemote()).toBe('Szotasz/marveen')
  })

  it('falls back to the default remote when git fails', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('no remote configured') })
    expect(parseGitHubRemote()).toBe('Szotasz/marveen')
  })
})

describe('groupByRelease', () => {
  function commit(sha: string, message: string): UpdateCommit {
    return { sha, short: sha.slice(0, 7), message, author: 'a', date: '2026-01-01' }
  }

  it('buckets commits under their release tag (newest first) with a leading upcoming group', () => {
    const commits = [
      commit('c3', 'feat: new thing'), // not yet released
      commit('c2', 'chore(release): v1.2.0 -- adds new thing'),
      commit('c1', 'fix: older bug'),
    ]
    const groups = groupByRelease(commits, commits.map(c => c.message))
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ version: '', commits: [commits[0]] })
    expect(groups[1]).toMatchObject({ version: 'v1.2.0', summary: 'adds new thing', commits: [commits[2]] })
  })

  it('prefers the release-commit body summary over the subject-line summary', () => {
    const releaseCommit = commit('c2', 'chore(release): v1.3.0 -- subject summary')
    const fullMessage = 'chore(release): v1.3.0 -- subject summary\n\nBody summary line.\n\nCo-Authored-By: X <x@example.com>'
    const groups = groupByRelease([releaseCommit], [fullMessage])
    expect(groups[0].summary).toBe('Body summary line.')
  })

  it('omits the upcoming group entirely when every commit already belongs to a release', () => {
    const c = commit('c1', 'chore(release): v1.0.0')
    const groups = groupByRelease([c], [c.message])
    expect(groups).toHaveLength(1)
    expect(groups[0].version).toBe('v1.0.0')
  })

  it('returns an empty list for an empty commit list', () => {
    expect(groupByRelease([], [])).toEqual([])
  })
})

describe('refreshUpdateStatus', () => {
  it('reports an error and never calls the network when there is no git checkout', async () => {
    setupGit({ head: '' })
    globalThis.fetch = vi.fn()

    const status = await refreshUpdateStatus()

    expect(status.error).toBe('Not a git checkout')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('is up to date when local HEAD already matches the remote latest', async () => {
    setupGit({ head: 'sha123', branch: 'develop' })
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(200, { sha: 'sha123' }))

    const status = await refreshUpdateStatus()

    expect(status.behind).toBe(0)
    expect(status.commits).toEqual([])
    expect(status.latest).toBe('sha123')
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('lists commits newest-first when behind, and derives the release grouping', async () => {
    setupGit({ head: 'old-sha', branch: 'main' })
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { sha: 'new-sha' }))
      .mockResolvedValueOnce(jsonResponse(200, {
        ahead_by: 2,
        commits: [
          { sha: 'c1', commit: { message: 'fix: older bug', author: { name: 'Ann', date: '2026-01-01' } } },
          { sha: 'c2', commit: { message: 'feat: newer thing', author: { name: 'Bob', date: '2026-01-02' } } },
        ],
      }))

    const status = await refreshUpdateStatus()

    expect(status.behind).toBe(2)
    expect(status.commits.map(c => c.sha)).toEqual(['c2', 'c1'])
    expect(status.commits[0]).toMatchObject({ short: 'c2', message: 'feat: newer thing', author: 'Bob' })
    expect(status.fork).toBeUndefined()
    expect(status.releases).toBeDefined()
  })

  it('falls back to the upstream merge-base when local HEAD is a customised fork (404)', async () => {
    setupGit({ head: 'fork-sha', branch: 'develop', mergeBase: 'base-sha' })
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { sha: 'remote-latest' }))
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, {
        ahead_by: 1,
        commits: [{ sha: 'd1', commit: { message: 'chore: x', author: { name: 'A', date: 'd' } } }],
      }))

    const status = await refreshUpdateStatus()

    expect(status.fork).toBe(true)
    expect(status.behind).toBe(1)
    expect(status.commits).toHaveLength(1)
    expect(globalThis.fetch).toHaveBeenCalledTimes(3)
  })

  it('reports zero behind for a fork whose merge-base already is the upstream tip', async () => {
    setupGit({ head: 'fork-sha2', branch: 'develop', mergeBase: 'remote-latest2' })
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { sha: 'remote-latest2' }))
      .mockResolvedValueOnce(jsonResponse(404, {}))

    const status = await refreshUpdateStatus()

    expect(status.fork).toBe(true)
    expect(status.behind).toBe(0)
    // No new upstream commits: the second (base-compare) fetch is skipped entirely.
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('surfaces an explicit error when neither the raw HEAD nor the merge-base compare resolve', async () => {
    setupGit({ head: 'fork-sha3', branch: 'develop', mergeBase: 'base-sha3' })
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { sha: 'remote-latest3' }))
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(500, {}))

    const status = await refreshUpdateStatus()

    expect(status.error).toBe('Local HEAD not found on GitHub -- different fork or unpushed commits?')
  })

  it('records a non-ok commits-endpoint response as the status error', async () => {
    setupGit({ head: 'sha-x', branch: 'develop' })
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(500, {}))

    const status = await refreshUpdateStatus()

    expect(status.error).toBe('GitHub /commits/develop -> 500')
  })

  it('records a network exception as the status error', async () => {
    setupGit({ head: 'sha-y', branch: 'develop' })
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('network down'))

    const status = await refreshUpdateStatus()

    expect(status.error).toBe('network down')
  })
})

describe('getUpdateStatus', () => {
  it('overlays the live tracked branch onto the last-refreshed status', async () => {
    setupGit({ head: 'sha-z', branch: 'develop' })
    globalThis.fetch = vi.fn().mockResolvedValueOnce(jsonResponse(200, { sha: 'sha-z' }))
    await refreshUpdateStatus()

    const status = getUpdateStatus()

    expect(status.current).toBe('sha-z')
    expect(status.branch).toBe('develop')
  })
})
