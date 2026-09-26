// Backend coverage batch-55: ensureWorkerCwd (agent-worker.ts) is the largest
// still-untested block in this file per coverage-final.json (~90 uncovered
// lines) -- it materialises the worker's isolated CLAUDE_CONFIG_DIR (symlink
// farm over ~/.claude, settings.json ownership/merge, .claude.json trust
// stamping, credential seeding) and had ZERO direct tests; only the pure
// helpers around it (buildWorkerPrompt, decidePoll, classifyWorkerPane,
// stampWorkerFirstRun, configDirKeychainService) were covered.
//
// homedir() is mocked to a temp dir (never the real ~/.claude) so these tests
// cannot read or mutate this host's actual Claude Code config -- same
// precaution as channel-coordinator-liveness-orchestration.test.ts. Module-
// level PROJECT_ROOT/DEFAULT_AGENT_MODEL constants are left real (unused by
// the branches under test); STORE_DIR is not involved here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkerCtx } from '../web/agent-worker.js'

vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }))

// clearWorkerKeychainEntry (darwin-only leg of seedWorkerCredentials) shells
// out to /usr/bin/security; force it to always miss (mirrors the real "no
// such entry" case) so the test never touches this host's actual Keychain.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => { throw new Error('no such keychain entry') }),
}))

let fakeHomeDir: string
let ctxHome: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- vi.fn()'s
// broad overload type is not callable with a fixed 0-arg signature; these are
// reassigned in beforeEach and only ever invoked/`.mockReturnValue()`d.
let mockReadOauth: any
let mockHasFleetToken: any
let mod: typeof import('../web/agent-worker.js')

beforeEach(async () => {
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'worker-cwd-realhome-'))
  ctxHome = mkdtempSync(join(tmpdir(), 'worker-cwd-ctxhome-'))
  mockReadOauth = vi.fn(() => null as string | null)
  mockHasFleetToken = vi.fn(() => false)

  vi.resetModules()
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>()
    return { ...actual, homedir: () => fakeHomeDir }
  })
  vi.doMock('../web/claude-credentials.js', () => ({
    readClaudeCodeOauthJson: () => mockReadOauth(),
  }))
  vi.doMock('../web/agent-process.js', () => ({
    capturePane: vi.fn(() => ''),
    isSessionReadyForPrompt: vi.fn(() => false),
    sendPromptToSession: vi.fn(async () => undefined),
    sessionExistsOnHost: vi.fn(() => false),
    hasFleetOauthToken: () => mockHasFleetToken(),
    FLEET_OAUTH_TOKEN_PATH: join(fakeHomeDir, 'fleet-token'),
  }))
  mod = await import('../web/agent-worker.js')
})

afterEach(() => {
  vi.doUnmock('node:os')
  vi.doUnmock('../web/claude-credentials.js')
  vi.doUnmock('../web/agent-process.js')
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(ctxHome, { recursive: true, force: true })
})

function makeCtx(): WorkerCtx {
  return {
    session: 'ensure-cwd-test-session',
    home: ctxHome,
    configDir: join(ctxHome, '.claude-config'),
    scratchDir: join(ctxHome, 'scratch'),
    chain: Promise.resolve(),
    lastStuckAlert: 0,
  }
}

describe('ensureWorkerCwd', () => {
  it('creates home, scratchDir, an empty .mcp.json, and configDir from scratch', () => {
    const ctx = makeCtx()
    mod.ensureWorkerCwd(ctx)
    expect(existsSync(ctx.home)).toBe(true)
    expect(existsSync(ctx.scratchDir)).toBe(true)
    expect(JSON.parse(readFileSync(join(ctx.home, '.mcp.json'), 'utf-8'))).toEqual({ mcpServers: {} })
    expect(existsSync(ctx.configDir)).toBe(true)
  })

  it('is idempotent: does not overwrite an existing .mcp.json', () => {
    const ctx = makeCtx()
    mkdirSync(ctx.home, { recursive: true })
    writeFileSync(join(ctx.home, '.mcp.json'), '{"mcpServers":{"kept":{}}}\n')
    mod.ensureWorkerCwd(ctx)
    expect(JSON.parse(readFileSync(join(ctx.home, '.mcp.json'), 'utf-8'))).toEqual({ mcpServers: { kept: {} } })
  })

  it('skips the whole symlink farm when the real ~/.claude does not exist', () => {
    const ctx = makeCtx()
    mod.ensureWorkerCwd(ctx)
    // configDir exists (created independently) but has no symlinked entries.
    expect(existsSync(join(ctx.configDir, 'skills'))).toBe(false)
  })

  it('symlinks every ~/.claude entry into configDir EXCEPT settings.json/CLAUDE.md/.DS_Store/.lock', () => {
    const realClaude = join(fakeHomeDir, '.claude')
    mkdirSync(realClaude, { recursive: true })
    writeFileSync(join(realClaude, 'settings.json'), '{}')
    writeFileSync(join(realClaude, 'CLAUDE.md'), '# memory')
    writeFileSync(join(realClaude, '.DS_Store'), '')
    writeFileSync(join(realClaude, '.credentials.json'), '{"token":"real"}')
    mkdirSync(join(realClaude, 'skills'))

    const ctx = makeCtx()
    mod.ensureWorkerCwd(ctx)

    expect(lstatSync(join(ctx.configDir, 'skills')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(ctx.configDir, '.credentials.json')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(ctx.configDir, 'settings.json'))).toBe(true) // written by us, not symlinked
    expect(lstatSync(join(ctx.configDir, 'settings.json')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(ctx.configDir, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(ctx.configDir, '.DS_Store'))).toBe(false)
  })

  it('replaces a stale non-symlink entry at the link path instead of leaving it stale', () => {
    const realClaude = join(fakeHomeDir, '.claude')
    mkdirSync(realClaude, { recursive: true })
    writeFileSync(join(realClaude, 'stale-entry.json'), '{"fresh":true}')

    const ctx = makeCtx()
    mkdirSync(ctx.configDir, { recursive: true })
    writeFileSync(join(ctx.configDir, 'stale-entry.json'), '{"old":true}') // regular file, not a symlink

    mod.ensureWorkerCwd(ctx)

    expect(lstatSync(join(ctx.configDir, 'stale-entry.json')).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(join(ctx.configDir, 'stale-entry.json'), 'utf-8'))).toEqual({ fresh: true })
  })

  it('with a fleet token present: unsymlinks a pre-existing .credentials.json symlink and never re-links it', () => {
    mockHasFleetToken.mockReturnValue(true)
    const realClaude = join(fakeHomeDir, '.claude')
    mkdirSync(realClaude, { recursive: true })
    writeFileSync(join(realClaude, '.credentials.json'), '{"token":"real"}')

    const ctx = makeCtx()
    mkdirSync(ctx.configDir, { recursive: true })
    symlinkSync(join(realClaude, '.credentials.json'), join(ctx.configDir, '.credentials.json'))

    mod.ensureWorkerCwd(ctx)

    expect(existsSync(join(ctx.configDir, '.credentials.json'))).toBe(false)
  })

  it('settings.json: force-disables worker channel plugins while preserving other existing keys', () => {
    const ctx = makeCtx()
    mkdirSync(ctx.configDir, { recursive: true })
    writeFileSync(join(ctx.configDir, 'settings.json'), JSON.stringify({ enabledPlugins: { telegram: true, other: true }, keepMe: 'yes' }))

    mod.ensureWorkerCwd(ctx)

    const settings = JSON.parse(readFileSync(join(ctx.configDir, 'settings.json'), 'utf-8'))
    expect(settings.enabledPlugins.telegram).toBe(false)
    expect(settings.enabledPlugins['slack-channel']).toBe(false)
    expect(settings.enabledPlugins.other).toBe(true)
    expect(settings.keepMe).toBe('yes')
    expect(settings.skipDangerousModePermissionPrompt).toBe(true)
  })

  it('settings.json: a symlinked settings.json is removed and replaced with our own file', () => {
    const realClaude = join(fakeHomeDir, '.claude')
    mkdirSync(realClaude, { recursive: true })
    writeFileSync(join(realClaude, 'settings.json'), '{"enabledPlugins":{}}')

    const ctx = makeCtx()
    mkdirSync(ctx.configDir, { recursive: true })
    symlinkSync(join(realClaude, 'settings.json'), join(ctx.configDir, 'settings.json'))

    mod.ensureWorkerCwd(ctx)

    expect(lstatSync(join(ctx.configDir, 'settings.json')).isSymbolicLink()).toBe(false)
  })

  it('settings.json: malformed JSON on disk is discarded, not thrown -- rewritten fresh', () => {
    const ctx = makeCtx()
    mkdirSync(ctx.configDir, { recursive: true })
    writeFileSync(join(ctx.configDir, 'settings.json'), '{not valid json')

    expect(() => mod.ensureWorkerCwd(ctx)).not.toThrow()
    const settings = JSON.parse(readFileSync(join(ctx.configDir, 'settings.json'), 'utf-8'))
    expect(settings.enabledPlugins.telegram).toBe(false)
  })

  it('seeds .credentials.json from the host OAuth JSON when one is available', () => {
    mockReadOauth.mockReturnValue('{"accessToken":"abc"}')
    const ctx = makeCtx()

    mod.ensureWorkerCwd(ctx)

    expect(readFileSync(join(ctx.configDir, '.credentials.json'), 'utf-8')).toBe('{"accessToken":"abc"}')
  })

  it('.claude.json: stamps trust flags for ctx.home under a fresh (missing) home .claude.json', () => {
    const ctx = makeCtx()
    mod.ensureWorkerCwd(ctx)

    const parsed = JSON.parse(readFileSync(join(ctx.configDir, '.claude.json'), 'utf-8'))
    expect(parsed.hasCompletedOnboarding).toBe(true)
    expect(parsed.projects[ctx.home].hasTrustDialogAccepted).toBe(true)
    expect(parsed.projects[ctx.home].hasCompletedProjectOnboarding).toBe(true)
  })

  it('.claude.json: merges into an existing home .claude.json, preserving other projects', () => {
    writeFileSync(join(fakeHomeDir, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: false,
      projects: { '/some/other/project': { hasTrustDialogAccepted: true } },
    }))
    const ctx = makeCtx()

    mod.ensureWorkerCwd(ctx)

    const parsed = JSON.parse(readFileSync(join(ctx.configDir, '.claude.json'), 'utf-8'))
    expect(parsed.hasCompletedOnboarding).toBe(true)
    expect(parsed.projects['/some/other/project']).toEqual({ hasTrustDialogAccepted: true })
    expect(parsed.projects[ctx.home].hasTrustDialogAccepted).toBe(true)
  })

  it('.claude.json: malformed home .claude.json is caught and logged, never thrown', () => {
    writeFileSync(join(fakeHomeDir, '.claude.json'), '{not valid json')
    const ctx = makeCtx()

    expect(() => mod.ensureWorkerCwd(ctx)).not.toThrow()
  })
})
