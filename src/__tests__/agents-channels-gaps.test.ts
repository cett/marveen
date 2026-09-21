// Gap coverage for agents-channels routes: Google Chat, Discord channelId,
// Telegram busy check, main agent paths, channel requests, error paths.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import type { RouteContext } from '../web/routes/types.js'

const { TEST_AGENT_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync, mkdirSync } = require('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os')
  const root = mkdtempSync(path.join(os.tmpdir(), 'channels-gaps-'))
  const dir = path.join(root, 'test-agent')
  mkdirSync(dir, { recursive: true })
  return { TEST_AGENT_DIR: dir }
})

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'marveen' }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: vi.fn().mockImplementation((name: string) => name === 'test-agent' ? TEST_AGENT_DIR : `/nonexistent/agents/${name}`),
    readFileOr: vi.fn().mockReturnValue('{}'),
    readAgentChannelProvider: vi.fn().mockReturnValue(null),
    writeAgentChannelProvider: vi.fn(),
    readAgentDisplayName: vi.fn().mockReturnValue('Test Agent'),
    readAgentRemoteHost: vi.fn().mockReturnValue(null),
  }
})
vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...actual,
    getProvider: vi.fn().mockReturnValue({
      validateToken: vi.fn().mockResolvedValue({ ok: false, error: 'invalid token' }),
      sendMessage: vi.fn().mockResolvedValue({ ok: true }),
    }),
    channelStateDir: vi.fn().mockReturnValue('/tmp/ch-gaps-state'),
    readChannelToken: vi.fn().mockReturnValue(null),
    generateSlackAppManifest: vi.fn().mockReturnValue({ name: 'test-app' }),
    getSlackAppSetupInstructions: vi.fn().mockReturnValue('instructions'),
    checkTelegramTokenBusy: vi.fn().mockResolvedValue({ busy: false }),
  }
})
vi.mock('../web/channel-invites.js', () => ({
  createInvite: vi.fn().mockReturnValue({ token: 'tok123', expiresAt: 0 }),
  listInvites: vi.fn().mockReturnValue([]),
  revokeInvite: vi.fn().mockReturnValue(true),
}))
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn().mockReturnValue({ ok: true }),
}))
vi.mock('../web/main-agent.js', () => ({
  isMainChannelsAgent: vi.fn().mockReturnValue(false),
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))
vi.mock('../web/telegram.js', () => ({
  readAgentTelegramConfig: vi.fn().mockReturnValue({ botUsername: 'test_bot' }),
  readMarveenTelegramConfig: vi.fn().mockReturnValue({ botUsername: 'marveen_bot' }),
  sendWelcomeMessage: vi.fn().mockResolvedValue(undefined),
  parseTelegramToken: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: vi.fn().mockReturnValue(false),
  startAgentProcess: vi.fn().mockReturnValue({ ok: true }),
  stopAgentProcess: vi.fn().mockReturnValue({ ok: true }),
  agentSessionName: vi.fn().mockImplementation((n: string) => `agent-${n}`),
  sendPromptToSession: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockReturnValue(null),
}))
vi.mock('../web/channel-mcp-reconnect.js', () => ({
  attemptChannelMcpReconnect: vi.fn().mockReturnValue({ ok: true, message: 'reconnected' }),
}))
vi.mock('../web/channel-health-monitor.js', () => ({
  getChannelHealth: vi.fn().mockReturnValue({ status: 'ok', provider: 'telegram' }),
}))
vi.mock('../web/routes/agents-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/routes/agents-helpers.js')>()
  return {
    ...actual,
    matchChannelRoute: vi.fn().mockImplementation((path: string, suffix: string) => {
      const pattern = new RegExp(`^/api/agents/([^/]+)/channels/(telegram|slack|discord|googlechat|teams)${suffix}$`)
      const match = path.match(pattern)
      if (match) return [decodeURIComponent(match[1]), match[2]]
      return null
    }),
    resolveAccessPath: vi.fn().mockReturnValue('/tmp/ch-gaps-state/access.json'),
    validateDiscordChannelId: vi.fn().mockReturnValue({ ok: true }),
    findBotTokenDuplicate: vi.fn().mockReturnValue(null),
    parseChannelProvider: vi.fn().mockImplementation((s: string) => ['telegram', 'slack', 'discord', 'googlechat', 'teams'].includes(s) ? s : null),
    VALID_PROVIDERS: new Set(['telegram', 'slack', 'discord', 'googlechat', 'teams']),
  }
})
vi.mock('../db.js', () => ({
  listPendingChannelRequests: vi.fn().mockReturnValue([
    { id: 1, channel_id: 'C123', channel_name: 'test-channel', user_id: 'U456', status: 'pending' },
  ]),
  updateChannelRequestStatus: vi.fn().mockReturnValue(true),
}))
vi.mock('../web/plugin-ids.js', () => ({
  CHANNEL_PLUGIN_IDS: { telegram: 'plugin:telegram', slack: 'plugin:slack', discord: 'plugin:discord', googlechat: 'plugin:googlechat' },
}))
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))
vi.mock('../web/sanitize.js', () => ({
  safeJoin: vi.fn((base: string, id: string) => `${base}/${id}`),
}))

import { tryHandleAgentsChannels } from '../web/routes/agents-channels.js'

function makeCtx(method: string, path: string, body?: object, headers?: Record<string, string>): {
  ctx: RouteContext; out: { status: number; body: any }
} {
  const buf = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0)
  const req = new EventEmitter() as any
  req.method = method
  req.headers = headers ?? {}
  setImmediate(() => { req.emit('data', buf); req.emit('end') })
  const out = { status: 200, body: null as any }
  const res = {
    writeHead(s: number) { out.status = s },
    end(b?: string) { try { out.body = JSON.parse(b?.toString() || 'null') } catch { out.body = b } },
  } as any
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

describe('Helper functions', () => {
  it('isManagedSettingsReady returns false when file does not exist', async () => {
    const ac = await import('../web/routes/agents-channels.js')
    expect(ac.isManagedSettingsReady()).toBe(false)
  })

  it('getManagedSettingsSudoCommand returns a non-empty string', async () => {
    const ac = await import('../web/routes/agents-channels.js')
    const cmd = ac.getManagedSettingsSudoCommand()
    expect(typeof cmd).toBe('string')
    expect(cmd.length).toBeGreaterThan(0)
    // Should contain python or powershell depending on platform
    expect(cmd).toMatch(/python|powershell/i)
  })

  it('setAgentEnabledPlugins creates settings.json with enabled plugins', async () => {
    const ac = await import('../web/routes/agents-channels.js')
    const aw = await import('../web/atomic-write.js')
    ac.setAgentEnabledPlugins('test-agent', 'telegram')
    expect(vi.mocked(aw.atomicWriteFileSync)).toHaveBeenCalled()
  })

  it('resetAgentEnabledPlugins handles missing settings.json gracefully', async () => {
    const ac = await import('../web/routes/agents-channels.js')
    // Should not throw when settings.json doesn't exist
    ac.resetAgentEnabledPlugins('test-agent')
    expect(true).toBe(true) // Just verify it doesn't throw
  })
})

describe('tryHandleAgentsChannels (gaps)', () => {
  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path')
    const claudeDir = path.join(TEST_AGENT_DIR, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: {} }))
  })

  // Google Chat setup paths (lines 249-291)
  describe('Google Chat setup', () => {
    it('POST channel setup (googlechat) for sub-agent requires all fields', async () => {
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/googlechat', {
        saKeyPath: '/path/to/sa-key.json',
        projectId: 'test-project',
        subscription: 'test-sub',
        owner: 'test@example.com',
      })
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
      expect(out.body.botName).toBe('Google Chat')
    })

    it('POST channel setup (googlechat) returns 400 when saKeyPath missing', async () => {
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/googlechat', {
        projectId: 'test-project',
        subscription: 'test-sub',
        owner: 'test@example.com',
      })
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('required')
    })

    it('POST channel setup (googlechat) for main agent returns ok', async () => {
      const { ctx, out } = makeCtx('POST', '/api/agents/marveen/channels/googlechat', {
        saKeyPath: '/path/to/sa-key.json',
        projectId: 'test-project',
        subscription: 'test-sub',
        owner: 'test@example.com',
      })
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })
  })

  // Discord setup with channelId (lines 301-304, 357-358)
  describe('Discord setup with channel ID', () => {
    it('POST channel setup (discord) with valid channelId returns ok', async () => {
      const cp = await import('../channel-provider.js')
      const mockValidate = vi.fn().mockResolvedValueOnce({ ok: true, botName: 'DiscordBot' })
      vi.mocked(cp.getProvider).mockReturnValueOnce({ validateToken: mockValidate } as any)
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/discord', {
        botToken: 'discord-token-123',
        channelId: '123456789',
      })
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })

    it('POST channel setup (discord) returns 400 when validateDiscordChannelId fails', async () => {
      const helpers = await import('../web/routes/agents-helpers.js')
      vi.mocked(helpers.validateDiscordChannelId).mockReturnValueOnce({
        ok: false,
        error: 'invalid_value',
        field: 'channelId',
        hint: 'Invalid channel ID format',
      })
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/discord', {
        botToken: 'discord-token-123',
        channelId: 'invalid-channel',
      })
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('invalid_value')
      expect(out.body.field).toBe('channelId')
    })
  })

  // Telegram token busy check (line 330)
  describe('Telegram token busy check', () => {
    it('POST channel setup (telegram) returns 409 when token is busy', async () => {
      const cp = await import('../channel-provider.js')
      const mockValidate = vi.fn().mockResolvedValueOnce({ ok: true, botName: 'TelegramBot' })
      vi.mocked(cp.getProvider).mockReturnValueOnce({ validateToken: mockValidate } as any)
      vi.mocked(cp.checkTelegramTokenBusy).mockResolvedValueOnce({
        busy: true,
        hint: 'Token is already being used by another instance',
      })
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/telegram', {
        botToken: 'bot-token-busy:abc123',
      })
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(409)
      expect(out.body.error).toBe('conflict')
    })
  })

  // Main agent restart paths (lines 374-377)
  describe('Main agent (marveen) channel setup', () => {
    it('POST channel setup (telegram) for main agent uses hardRestartMarveenChannels', async () => {
      const cp = await import('../channel-provider.js')
      const mockValidate = vi.fn().mockResolvedValueOnce({ ok: true, botName: 'MainBot' })
      vi.mocked(cp.getProvider).mockReturnValueOnce({ validateToken: mockValidate } as any)
      const { ctx, out } = makeCtx('POST', '/api/agents/marveen/channels/telegram', {
        botToken: 'marveen-bot-token:xyz',
      })
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
      expect(out.body.wasRunning).toBe(true)
    })
  })

  // POST /api/agents/:name/auth/init endpoint (lines 701-734)
  describe('Auth init endpoint', () => {
    it('POST auth init returns 404 when agent not found', async () => {
      const { ctx, out } = makeCtx('POST', '/api/agents/ghost-agent/auth/init')
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(404)
    })

    it('POST auth init returns 409 when agent not running', async () => {
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/auth/init')
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(409)
      expect(out.body.error).toBe('conflict')
    })
  })

  // Channel request approval with options (lines 669-673)
  describe('Channel request approval options', () => {
    it('POST approve channel request with requireMention=true and allowFromAll=false', async () => {
      const db = await import('../db.js')
      vi.mocked(db.listPendingChannelRequests).mockReturnValueOnce([
        { id: 1, channel_id: 'C123', channel_name: 'test-channel', user_id: 'U456', status: 'pending' },
      ])
      const config = await import('../web/agent-config.js')
      vi.mocked(config.readAgentChannelProvider).mockReturnValueOnce('slack')
      vi.mocked(config.readFileOr).mockReturnValueOnce('{}')
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channel-requests/1/approve', {
        requireMention: true,
        allowFromAll: false,
      })
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })

    it('POST approve channel request with allowFromAll=true skips user filter', async () => {
      const db = await import('../db.js')
      vi.mocked(db.listPendingChannelRequests).mockReturnValueOnce([
        { id: 2, channel_id: 'C456', channel_name: 'public-channel', user_id: undefined, status: 'pending' },
      ])
      const config = await import('../web/agent-config.js')
      vi.mocked(config.readAgentChannelProvider).mockReturnValueOnce('slack')
      vi.mocked(config.readFileOr).mockReturnValueOnce('{}')
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channel-requests/2/approve', {
        requireMention: false,
        allowFromAll: true,
      })
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })

    it('POST approve channel request returns 400 when not slack provider', async () => {
      const db = await import('../db.js')
      vi.mocked(db.listPendingChannelRequests).mockReturnValueOnce([
        { id: 4, channel_id: 'C999', channel_name: 'test', user_id: 'U999', status: 'pending' },
      ])
      const config = await import('../web/agent-config.js')
      vi.mocked(config.readAgentChannelProvider).mockReturnValueOnce('telegram')
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channel-requests/4/approve', {})
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('not_supported')
    })
  })

  // Allowed list removal (lines 589-625)
  describe('Allowed list management', () => {
    it('DELETE allowed group removes from groups dictionary', async () => {
      const config = await import('../web/agent-config.js')
      vi.mocked(config.readFileOr).mockReturnValueOnce(JSON.stringify({
        allowFrom: ['user1'],
        groups: { 'group-1': { policy: 'admin' } },
      }))
      const { ctx, out } = makeCtx('DELETE', '/api/agents/test-agent/channels/telegram/allowed/group/group-1')
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })

    it('DELETE allowed user removes from allowFrom array', async () => {
      const config = await import('../web/agent-config.js')
      vi.mocked(config.readFileOr).mockReturnValueOnce(JSON.stringify({
        allowFrom: ['user1', 'user2'],
        groups: {},
      }))
      const { ctx, out } = makeCtx('DELETE', '/api/agents/test-agent/channels/telegram/allowed/user/user1')
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })
  })

  // Invite revocation (lines 571-587)
  describe('Invite revocation', () => {
    it('DELETE invite token returns ok when token found', async () => {
      const invites = await import('../web/channel-invites.js')
      vi.mocked(invites.revokeInvite).mockReturnValueOnce(true)
      const { ctx, out } = makeCtx('DELETE', '/api/agents/test-agent/channels/telegram/invites/tok123')
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })

    it('DELETE invite token returns 404 when token not found', async () => {
      const invites = await import('../web/channel-invites.js')
      vi.mocked(invites.revokeInvite).mockReturnValueOnce(false)
      const { ctx, out } = makeCtx('DELETE', '/api/agents/test-agent/channels/telegram/invites/nonexistent')
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(404)
      expect(out.body.error).toBe('not_found')
    })
  })

  // Pending approval (lines 439-490)
  describe('Channel pending approval', () => {
    it('POST approve returns 400 when code empty', async () => {
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/telegram/approve', {
        code: '  ',
      })
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(400)
      expect(out.body.error).toBe('required')
      expect(out.body.field).toBe('code')
    })

    it('POST approve returns 404 when code not found in pending', async () => {
      const config = await import('../web/agent-config.js')
      vi.mocked(config.readFileOr).mockReturnValueOnce(JSON.stringify({ pending: {} }))
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/telegram/approve', {
        code: 'nonexistent',
      })
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(404)
      expect(out.body.error).toBe('not_found')
    })
  })

  // Invite creation and listing (lines 513-569)
  describe('Invite creation and listing', () => {
    it('POST invite create for marveen (main agent) reads bot name', async () => {
      const { ctx, out } = makeCtx('POST', '/api/agents/marveen/channels/telegram/invites')
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.token).toBeDefined()
    })

    it('GET invites list returns array for telegram', async () => {
      const { ctx, out } = makeCtx('GET', '/api/agents/test-agent/channels/telegram/invites')
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(Array.isArray(out.body)).toBe(true)
    })
  })

  // Channel request deny (lines 686-697)
  describe('Channel request denial', () => {
    it('POST deny channel request returns ok when request found', async () => {
      const db = await import('../db.js')
      vi.mocked(db.updateChannelRequestStatus).mockReturnValueOnce(true)
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channel-requests/1/deny')
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body.ok).toBe(true)
    })

    it('POST deny channel request returns 404 when request not found', async () => {
      const db = await import('../db.js')
      vi.mocked(db.updateChannelRequestStatus).mockReturnValueOnce(false)
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channel-requests/999/deny')
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(404)
      expect(out.body.error).toBe('not_found')
    })
  })

  // Dupe bot token check (lines 315-319)
  describe('Duplicate bot token detection', () => {
    it('POST channel setup returns 409 when bot token already used', async () => {
      const cp = await import('../channel-provider.js')
      const mockValidate = vi.fn().mockResolvedValueOnce({ ok: true, botName: 'Bot' })
      vi.mocked(cp.getProvider).mockReturnValueOnce({ validateToken: mockValidate } as any)
      const helpers = await import('../web/routes/agents-helpers.js')
      vi.mocked(helpers.findBotTokenDuplicate).mockReturnValueOnce('other-agent')
      const { ctx, out } = makeCtx('POST', '/api/agents/test-agent/channels/telegram', {
        botToken: 'duplicate-token:xyz',
      })
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(409)
      expect(out.body.error).toBe('conflict')
      expect(out.body.hint).toContain('other-agent')
    })
  })

  // Main agent channel requests (lines 629-635)
  describe('Main agent channel requests', () => {
    it('GET channel-requests for main agent (marveen) returns list', async () => {
      const db = await import('../db.js')
      vi.mocked(db.listPendingChannelRequests).mockReturnValueOnce([
        { id: 1, channel_id: 'C1', channel_name: 'ch1', user_id: 'U1', status: 'pending' },
      ])
      const { ctx, out } = makeCtx('GET', '/api/agents/marveen/channel-requests')
      expect(await tryHandleAgentsChannels(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(Array.isArray(out.body)).toBe(true)
    })
  })
})
