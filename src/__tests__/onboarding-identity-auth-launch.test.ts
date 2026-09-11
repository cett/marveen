import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

// Covers the three write-endpoints of the first-run onboarding wizard
// (identity / claude-auth / launch) plus the status probe -- previously only
// identitySavePlan (the pure decision core) and one launch error case had
// coverage. A REAL sandboxed directory (not a mocked fs) stands in for
// PROJECT_ROOT/STORE_DIR, same technique as auto-restart-store.test.ts: the
// onboarding module computes ENV_FILE/HOME_CREDENTIALS/FLEET_TOKEN_FILE as
// module-level consts from PROJECT_ROOT/STORE_DIR ONCE at import time, so the
// sandbox path itself must stay fixed for the whole file (vi.hoisted, created
// before the mocked config.js module is first imported) -- only the *files
// inside it* are reset between tests.
const { SANDBOX } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path')
  return { SANDBOX: mkdtempSync(join(tmpdir(), 'onboarding-full-test-')) }
})

const mocks = vi.hoisted(() => ({
  sessionExistsOnHost: vi.fn().mockReturnValue(false),
  hardRestart: vi.fn().mockReturnValue({ ok: true }),
  mainChannelsSessionExists: vi.fn().mockReturnValue(false),
  createMainChannelsSession: vi.fn().mockReturnValue('started'),
  liveProbeAuth: vi.fn().mockResolvedValue('ok'),
  stampTokenVerified: vi.fn(),
  readChannelToken: vi.fn().mockReturnValue(null),
  channelStateDir: vi.fn().mockReturnValue('/tmp/onboarding-full-test-no-such-dir'),
  execFileSync: vi.fn().mockImplementation(() => { throw new Error('not found') }),
  userInfo: vi.fn().mockReturnValue({ username: 'testuser' }),
  homedir: vi.fn().mockReturnValue('/tmp/onboarding-full-test-no-such-home'),
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: SANDBOX,
  STORE_DIR: SANDBOX,
  OWNER_NAME: 'test',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>()
  return { ...orig, userInfo: mocks.userInfo, homedir: mocks.homedir }
})

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>()
  return { ...orig, execFileSync: mocks.execFileSync }
})

vi.mock('../web/claude-credentials-guard.js', () => ({
  liveProbeAuth: mocks.liveProbeAuth,
  stampTokenVerified: mocks.stampTokenVerified,
}))
vi.mock('../web/agent-process.js', () => ({ sessionExistsOnHost: mocks.sessionExistsOnHost }))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: mocks.hardRestart,
  mainChannelsSessionExists: mocks.mainChannelsSessionExists,
  createMainChannelsSession: mocks.createMainChannelsSession,
}))
vi.mock('../channel-provider.js', () => ({
  channelStateDir: mocks.channelStateDir,
  readChannelToken: mocks.readChannelToken,
}))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'marveen-channels' }))

const { tryHandleOnboarding } = await import('../web/routes/onboarding.js')

function makeCtx(method: string, path: string, body?: object): { ctx: RouteContext; out: { status: number; body: any } } {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
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
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

function resetSandbox(): void {
  for (const f of readdirSync(SANDBOX)) unlinkSync(join(SANDBOX, f))
}

beforeEach(() => {
  mkdirSync(SANDBOX, { recursive: true })
  resetSandbox()
  mocks.sessionExistsOnHost.mockReturnValue(false)
  mocks.hardRestart.mockReturnValue({ ok: true })
  mocks.mainChannelsSessionExists.mockReturnValue(false)
  mocks.createMainChannelsSession.mockReturnValue('started')
  mocks.liveProbeAuth.mockResolvedValue('ok')
  mocks.stampTokenVerified.mockClear()
  mocks.hardRestart.mockClear()
  mocks.createMainChannelsSession.mockClear()
  mocks.readChannelToken.mockReturnValue(null)
  mocks.channelStateDir.mockReturnValue('/tmp/onboarding-full-test-no-such-dir')
  mocks.execFileSync.mockImplementation(() => { throw new Error('not found') })
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

describe('GET /api/onboarding/status', () => {
  it('reports a fully unconfigured install (needsOnboarding true, defaults)', async () => {
    const { ctx, out } = makeCtx('GET', '/api/onboarding/status')
    const handled = await tryHandleOnboarding(ctx)
    expect(handled).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({
      identityConfirmed: false,
      currentAgentName: 'Marveen',
      currentOwnerName: '',
      claudeAuthPresent: false,
      agentsRunning: false,
      channelConfigured: false,
      paired: false,
      needsOnboarding: true,
    })
  })

  it('reports a fully configured install (needsOnboarding false)', async () => {
    writeFileSync(join(SANDBOX, '.env'), 'BOT_NAME=Acme\nOWNER_NAME=Owner\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-xyz\nIDENTITY_CONFIRMED=1\n')
    mocks.sessionExistsOnHost.mockReturnValue(true)
    mocks.readChannelToken.mockReturnValue('some-token')
    writeFileSync(join(SANDBOX, 'access.json'), JSON.stringify({ allowFrom: ['12345'] }))
    mocks.channelStateDir.mockReturnValue(SANDBOX)

    const { ctx, out } = makeCtx('GET', '/api/onboarding/status')
    await tryHandleOnboarding(ctx)
    expect(out.body).toMatchObject({
      identityConfirmed: true,
      currentAgentName: 'Acme',
      currentOwnerName: 'Owner',
      claudeAuthPresent: true,
      agentsRunning: true,
      channelConfigured: true,
      paired: true,
      needsOnboarding: false,
    })
  })

  it('treats a group-only access.json as paired too', async () => {
    writeFileSync(join(SANDBOX, 'access.json'), JSON.stringify({ groups: { g1: {} } }))
    mocks.channelStateDir.mockReturnValue(SANDBOX)
    const { ctx, out } = makeCtx('GET', '/api/onboarding/status')
    await tryHandleOnboarding(ctx)
    expect(out.body.paired).toBe(true)
  })
})

describe('POST /api/onboarding/identity', () => {
  it('rejects when agentName or ownerName missing', async () => {
    const { ctx, out } = makeCtx('POST', '/api/onboarding/identity', { agentName: '', ownerName: 'Owner' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
  })

  it('rejects a too-long or malformed name', async () => {
    const { ctx, out } = makeCtx('POST', '/api/onboarding/identity', { agentName: 'a'.repeat(41), ownerName: 'Owner' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('invalid_value')
    expect(out.body.reason).toBe('bad-name')
  })

  it('rejects a name containing a newline', async () => {
    const { ctx, out } = makeCtx('POST', '/api/onboarding/identity', { agentName: 'a\nb', ownerName: 'Owner' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(400)
    expect(out.body.reason).toBe('bad-name')
  })

  it('saves identity without restarting when the fleet is not running', async () => {
    mocks.sessionExistsOnHost.mockReturnValue(false)
    const { ctx, out } = makeCtx('POST', '/api/onboarding/identity', { agentName: 'Acme', ownerName: 'Owner' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, botNameUpdated: true, restarted: false })
    expect(out.body.restartNeeded).toBeUndefined()

    const env = readFileSync(join(SANDBOX, '.env'), 'utf-8')
    expect(env).toContain('OWNER_NAME=Owner')
    expect(env).toContain('BOT_NAME=Acme')
    expect(env).toContain('BRAND_NAME=Acme')
    expect(env).toContain('IDENTITY_CONFIRMED=1')
  })

  it('restarts the channels session for a mid-setup rename with the fleet already up', async () => {
    mocks.sessionExistsOnHost.mockReturnValue(true)
    const { ctx, out } = makeCtx('POST', '/api/onboarding/identity', { agentName: 'Acme', ownerName: 'Owner' })
    await tryHandleOnboarding(ctx)
    expect(mocks.hardRestart).toHaveBeenCalledTimes(1)
    expect(out.body).toMatchObject({ ok: true, restarted: true })
  })

  it('reports restartNeeded (no implicit bounce) on an already-configured running install', async () => {
    writeFileSync(join(SANDBOX, '.env'), 'BOT_NAME=OldName\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-xyz\n')
    mocks.sessionExistsOnHost.mockReturnValue(true)
    mocks.readChannelToken.mockReturnValue('tok')
    writeFileSync(join(SANDBOX, 'access.json'), JSON.stringify({ allowFrom: ['1'] }))
    mocks.channelStateDir.mockReturnValue(SANDBOX)

    const { ctx, out } = makeCtx('POST', '/api/onboarding/identity', { agentName: 'NewName', ownerName: 'Owner' })
    await tryHandleOnboarding(ctx)
    expect(mocks.hardRestart).not.toHaveBeenCalled()
    expect(out.body).toMatchObject({ ok: true, restarted: false, restartNeeded: true })
  })

  it('renames the agent/owner name inside CLAUDE.md and SOUL.md persona files', async () => {
    writeFileSync(join(SANDBOX, '.env'), 'BOT_NAME=OldBot\nOWNER_NAME=OldOwner\n')
    writeFileSync(join(SANDBOX, 'CLAUDE.md'), 'You are OldBot, assistant to OldOwner.')
    writeFileSync(join(SANDBOX, 'SOUL.md'), 'OldBot soul doc.')

    const { ctx } = makeCtx('POST', '/api/onboarding/identity', { agentName: 'NewBot', ownerName: 'NewOwner' })
    await tryHandleOnboarding(ctx)

    expect(readFileSync(join(SANDBOX, 'CLAUDE.md'), 'utf-8')).toBe('You are NewBot, assistant to NewOwner.')
    expect(readFileSync(join(SANDBOX, 'SOUL.md'), 'utf-8')).toBe('NewBot soul doc.')
  })

  it('is a no-op on persona files that do not exist', async () => {
    const { ctx, out } = makeCtx('POST', '/api/onboarding/identity', { agentName: 'Acme', ownerName: 'Owner' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(200)
    expect(existsSync(join(SANDBOX, 'CLAUDE.md'))).toBe(false)
  })

  it('returns 500 when the .env write fails', async () => {
    rmSync(SANDBOX, { recursive: true, force: true })
    const { ctx, out } = makeCtx('POST', '/api/onboarding/identity', { agentName: 'Acme', ownerName: 'Owner' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toBe('internal_error')
    expect(out.body.reason).toBe('write-failed')
    mkdirSync(SANDBOX, { recursive: true })
  })
})

describe('POST /api/onboarding/claude-auth', () => {
  it('rejects when neither token nor apiKey is given', async () => {
    const { ctx, out } = makeCtx('POST', '/api/onboarding/claude-auth', {})
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('required')
  })

  it('rejects a malformed setup token', async () => {
    const { ctx, out } = makeCtx('POST', '/api/onboarding/claude-auth', { token: 'not-a-token' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(400)
    expect(out.body.reason).toBe('bad-token')
  })

  it('rejects a malformed API key', async () => {
    const { ctx, out } = makeCtx('POST', '/api/onboarding/claude-auth', { apiKey: 'nope' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(400)
    expect(out.body.reason).toBe('bad-key')
  })

  it('rejects and persists nothing when the live probe rejects the token', async () => {
    mocks.liveProbeAuth.mockResolvedValue('auth-rejected')
    const { ctx, out } = makeCtx('POST', '/api/onboarding/claude-auth', { token: 'sk-ant-oat-abc' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(400)
    expect(out.body.reason).toBe('verify-failed')
    expect(out.body.verified).toBe(false)
    expect(existsSync(join(SANDBOX, '.env'))).toBe(false)
  })

  it('persists a live-verified token, stamps it, and restarts a session that had no prior auth', async () => {
    mocks.liveProbeAuth.mockResolvedValue('ok')
    mocks.sessionExistsOnHost.mockReturnValue(true)
    const { ctx, out } = makeCtx('POST', '/api/onboarding/claude-auth', { token: 'sk-ant-oat-abc' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, verified: true, restarted: true })
    expect(mocks.stampTokenVerified).toHaveBeenCalledWith('sk-ant-oat-abc')
    expect(mocks.hardRestart).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(SANDBOX, '.env'), 'utf-8')).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-abc')
    expect(readFileSync(join(SANDBOX, '.claude-oauth-token'), 'utf-8')).toBe('sk-ant-oat-abc')
  })

  it('does not restart when auth was already present before the save', async () => {
    writeFileSync(join(SANDBOX, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-existing\n')
    mocks.sessionExistsOnHost.mockReturnValue(true)
    const { ctx, out } = makeCtx('POST', '/api/onboarding/claude-auth', { token: 'sk-ant-oat-new' })
    await tryHandleOnboarding(ctx)
    expect(out.body.restarted).toBe(false)
    expect(mocks.hardRestart).not.toHaveBeenCalled()
  })

  it('accepts an inconclusive probe as unverified but still persists', async () => {
    mocks.liveProbeAuth.mockResolvedValue('unknown')
    const { ctx, out } = makeCtx('POST', '/api/onboarding/claude-auth', { token: 'sk-ant-oat-abc' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(200)
    expect(out.body.verified).toBe(false)
    expect(mocks.stampTokenVerified).not.toHaveBeenCalled()
  })

  it('persists an API key without stamping a token', async () => {
    const { ctx, out } = makeCtx('POST', '/api/onboarding/claude-auth', { apiKey: 'sk-ant-apikey123' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(200)
    expect(readFileSync(join(SANDBOX, '.env'), 'utf-8')).toContain('ANTHROPIC_API_KEY=sk-ant-apikey123')
    expect(mocks.stampTokenVerified).not.toHaveBeenCalled()
  })

  it('returns 500 when persisting the auth fails', async () => {
    rmSync(SANDBOX, { recursive: true, force: true })
    const { ctx, out } = makeCtx('POST', '/api/onboarding/claude-auth', { token: 'sk-ant-oat-abc' })
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(500)
    expect(out.body.reason).toBe('write-failed')
    mkdirSync(SANDBOX, { recursive: true })
  })
})

describe('POST /api/onboarding/launch', () => {
  it('is idempotent when the fleet is already running', async () => {
    mocks.sessionExistsOnHost.mockReturnValue(true)
    const { ctx, out } = makeCtx('POST', '/api/onboarding/launch')
    await tryHandleOnboarding(ctx)
    expect(out.body).toEqual({ ok: true, alreadyRunning: true })
    expect(mocks.hardRestart).not.toHaveBeenCalled()
  })

  it('rejects a launch attempt with no Claude auth configured yet', async () => {
    mocks.sessionExistsOnHost.mockReturnValue(false)
    const { ctx, out } = makeCtx('POST', '/api/onboarding/launch')
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('conflict')
  })

  it('creates the channels session from scratch when it does not exist yet', async () => {
    writeFileSync(join(SANDBOX, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-abc\n')
    mocks.sessionExistsOnHost.mockReturnValue(false)
    mocks.mainChannelsSessionExists.mockReturnValue(false)
    mocks.createMainChannelsSession.mockReturnValue('started')
    const { ctx, out } = makeCtx('POST', '/api/onboarding/launch')
    await tryHandleOnboarding(ctx)
    expect(out.body).toEqual({ ok: true, starting: true })
    expect(mocks.hardRestart).not.toHaveBeenCalled()
  })

  it('reports a broken install when channels.sh cannot be launched', async () => {
    writeFileSync(join(SANDBOX, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-abc\n')
    mocks.mainChannelsSessionExists.mockReturnValue(false)
    mocks.createMainChannelsSession.mockReturnValue('script-missing')
    const { ctx, out } = makeCtx('POST', '/api/onboarding/launch')
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(500)
    expect(out.body.reason).toBe('channels-script-missing')
  })

  it('respawns a wedged existing session', async () => {
    writeFileSync(join(SANDBOX, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-abc\n')
    mocks.mainChannelsSessionExists.mockReturnValue(true)
    mocks.hardRestart.mockReturnValue({ ok: true })
    const { ctx, out } = makeCtx('POST', '/api/onboarding/launch')
    await tryHandleOnboarding(ctx)
    expect(mocks.hardRestart).toHaveBeenCalledTimes(1)
    expect(out.body).toEqual({ ok: true, started: true })
  })

  it('surfaces a launch-failed error when respawning an existing session fails', async () => {
    writeFileSync(join(SANDBOX, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-abc\n')
    mocks.mainChannelsSessionExists.mockReturnValue(true)
    mocks.hardRestart.mockReturnValue({ ok: false, error: 'boom' })
    const { ctx, out } = makeCtx('POST', '/api/onboarding/launch')
    await tryHandleOnboarding(ctx)
    expect(out.status).toBe(500)
    expect(out.body.reason).toBe('launch-failed')
  })
})

describe('unrelated paths', () => {
  it('falls through (returns false) for a path this module does not own', async () => {
    const { ctx } = makeCtx('GET', '/api/something-else')
    const handled = await tryHandleOnboarding(ctx)
    expect(handled).toBe(false)
  })
})
