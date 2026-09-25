import { describe, it, expect, vi, afterAll } from 'vitest'
import https from 'node:https'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getProvider,
  getProviderType,
  getChannelToken,
  getChannelChatId,
  channelStateDir,
  readChannelToken,
  type ChannelProviderType,
} from '../channel-provider.js'

describe('getProviderType', () => {
  it('returns telegram by default', () => {
    expect(getProviderType(undefined)).toBe('telegram')
    expect(getProviderType('')).toBe('telegram')
    expect(getProviderType('anything')).toBe('telegram')
  })

  it('returns slack when explicitly set', () => {
    expect(getProviderType('slack')).toBe('slack')
  })
})

describe('getProvider', () => {
  it('returns telegram provider with correct pluginId', () => {
    const p = getProvider('telegram')
    expect(p.type).toBe('telegram')
    expect(p.pluginId).toBe('telegram@claude-plugins-official')
    expect(p.envKeys).toContain('TELEGRAM_BOT_TOKEN')
    expect(p.stateDir).toBe('telegram')
  })

  it('returns slack provider with correct pluginId', () => {
    const p = getProvider('slack')
    expect(p.type).toBe('slack')
    expect(p.pluginId).toBe('slack-channel@marveen-marketplace')
    expect(p.envKeys).toContain('SLACK_BOT_TOKEN')
    expect(p.stateDir).toBe('slack')
  })
})

describe('getChannelToken', () => {
  it('reads TELEGRAM_BOT_TOKEN for telegram', () => {
    const env = { TELEGRAM_BOT_TOKEN: 'tg-tok-123' }
    expect(getChannelToken('telegram', env)).toBe('tg-tok-123')
  })

  it('reads SLACK_BOT_TOKEN for slack', () => {
    const env = { SLACK_BOT_TOKEN: 'xoxb-123' }
    expect(getChannelToken('slack', env)).toBe('xoxb-123')
  })

  it('returns empty string when key is missing', () => {
    expect(getChannelToken('telegram', {})).toBe('')
    expect(getChannelToken('slack', {})).toBe('')
  })
})

describe('getChannelChatId', () => {
  it('reads ALLOWED_CHAT_ID for telegram', () => {
    const env = { ALLOWED_CHAT_ID: '1268077055' }
    expect(getChannelChatId('telegram', env)).toBe('1268077055')
  })

  it('reads SLACK_CHANNEL_ID for slack', () => {
    const env = { SLACK_CHANNEL_ID: 'C01234ABCDE' }
    expect(getChannelChatId('slack', env)).toBe('C01234ABCDE')
  })

  it('returns empty string when key is missing', () => {
    expect(getChannelChatId('telegram', {})).toBe('')
    expect(getChannelChatId('slack', {})).toBe('')
  })
})

describe('channelStateDir', () => {
  it('uses telegram subdirectory for telegram', () => {
    const dir = channelStateDir('telegram')
    expect(dir).toMatch(/\.claude\/channels\/telegram$/)
  })

  it('uses slack subdirectory for slack', () => {
    const dir = channelStateDir('slack')
    expect(dir).toMatch(/\.claude\/channels\/slack$/)
  })

  it('uses agent dir when provided', () => {
    const dir = channelStateDir('telegram', '/tmp/agents/test-agent')
    expect(dir).toBe('/tmp/agents/test-agent/.claude/channels/telegram')
  })
})

describe('formatMessage per provider', () => {
  it('telegram: converts markdown headers to bold', () => {
    const p = getProvider('telegram')
    expect(p.formatMessage('# Hello')).toContain('<b>Hello</b>')
  })

  it('telegram: converts **bold** to HTML', () => {
    const p = getProvider('telegram')
    expect(p.formatMessage('**bold**')).toBe('<b>bold</b>')
  })

  it('slack: converts markdown headers to mrkdwn bold', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('# Hello')).toBe('*Hello*')
  })

  it('slack: converts **bold** to mrkdwn bold', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('**bold**')).toBe('*bold*')
  })

  it('slack: converts links to mrkdwn format', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('[text](https://example.com)')).toBe('<https://example.com|text>')
  })

  it('slack: converts strikethrough', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('~~deleted~~')).toBe('~deleted~')
  })

  it('slack: converts checkboxes', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('- [ ] todo')).toContain(':white_square:')
    expect(p.formatMessage('- [x] done')).toContain(':white_check_mark:')
  })
})

describe('splitMessage per provider', () => {
  it('telegram: uses 4096 char limit', () => {
    const p = getProvider('telegram')
    const text = 'A '.repeat(2500)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
    }
  })

  it('slack: uses 4000 char limit', () => {
    const p = getProvider('slack')
    const text = 'A '.repeat(2500)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000)
    }
  })
})

// MCPTOKEN807: busy-token probe -- a valid token that a webhook or another
// running install already owns must be rejected at save time with a human
// remedy, not die later as an opaque plugin -32000.
import { checkTelegramTokenBusy } from '../channel-provider.js'

function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url)
    const key = Object.keys(routes).find((k) => u.includes(k))
    const r = key ? routes[key] : {}
    return {
      status: r.status ?? 200,
      json: async () => r.body ?? {},
    } as Response
  }) as typeof fetch
}

describe('checkTelegramTokenBusy', () => {
  const TOKEN = '123456:TESTSECRETVALUE'

  it('reports webhook-bound tokens with the deleteWebhook remedy, without leaking the token', async () => {
    const r = await checkTelegramTokenBusy(TOKEN, fakeFetch({
      getWebhookInfo: { body: { ok: true, result: { url: 'https://old-install.example/hook' } } },
    }))
    expect(r.busy).toBe(true)
    expect(r.reason).toBe('webhook')
    expect(r.error).toBe('conflict')
    expect(r.hint).toContain('deleteWebhook')
    expect(r.hint).toContain('BotFather')
    expect(r.hint).not.toContain(TOKEN)
    expect(r.hint).not.toContain('TESTSECRETVALUE')
  })

  it('reports a competing poller on getUpdates 409 with the stop-or-new-bot remedy', async () => {
    const r = await checkTelegramTokenBusy(TOKEN, fakeFetch({
      getWebhookInfo: { body: { ok: true, result: { url: '' } } },
      getUpdates: { status: 409 },
    }))
    expect(r.busy).toBe(true)
    expect(r.reason).toBe('poller')
    expect(r.error).toBe('conflict')
    expect(r.hint).toContain('409')
    expect(r.hint).toContain('BotFather')
    expect(r.hint).not.toContain(TOKEN)
  })

  it('passes a free token', async () => {
    const r = await checkTelegramTokenBusy(TOKEN, fakeFetch({
      getWebhookInfo: { body: { ok: true, result: { url: '' } } },
      getUpdates: { status: 200, body: { ok: true, result: [] } },
    }))
    expect(r).toEqual({ busy: false })
  })

  it('is advisory: a probe network error lets the save through (getMe already proved connectivity)', async () => {
    const failing = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const r = await checkTelegramTokenBusy(TOKEN, failing)
    expect(r.busy).toBe(false)
  })

  // The renderer-wiring lesson (INSTNODE806): the helper being correct proves
  // nothing about the route actually calling it. Lock the wiring structurally:
  // the setup handler must call the probe, and must skip it for a re-saved
  // identical token (its own live poller reads as busy).
  it('the channel setup route wires the busy probe in, gated on a token change', () => {
    // Fork: the setup handler lives in agents-channels.ts (modular split), not agents.ts
    const src = readFileSync(join(__dirname, '..', 'web', 'routes', 'agents-channels.ts'), 'utf-8')
    expect(src).toMatch(/checkTelegramTokenBusy\(botToken\.trim\(\)\)/)
    expect(src).toMatch(/botToken\.trim\(\) !== currentToken/)
    expect(src.indexOf('checkTelegramTokenBusy(botToken')).toBeGreaterThan(src.indexOf('findBotTokenDuplicate'))
  })
})

// INSTBOT819: a real message-sending call (via any caller -- notify.ts,
// channel-monitor.ts, agent-process-spawn.ts, ...) must never hit the real
// Telegram API while vitest is running, regardless of whether that caller
// mocks channel-provider.js. process.env.VITEST is always set by the vitest
// runner itself, so this guard is unconditional under test.
describe('telegram sendMessage under vitest', () => {
  it('never opens a real network request, even with a live-looking token', async () => {
    const requestSpy = vi.spyOn(https, 'request')
    const provider = getProvider('telegram')
    await provider.sendMessage('123456:REAL-LOOKING-TOKEN', '999999', 'test message', 'HTML')
    expect(requestSpy).not.toHaveBeenCalled()
    requestSpy.mockRestore()
  })
})

describe('readChannelToken', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'channel-provider-test-'))

  function envFile(name: string, content: string): string {
    const path = join(tmpDir, name)
    writeFileSync(path, content)
    return path
  }

  it('returns null when the .env file does not exist', () => {
    expect(readChannelToken('telegram', join(tmpDir, 'does-not-exist.env'))).toBeNull()
  })

  it('reads the telegram token key', () => {
    const path = envFile('tg.env', 'TELEGRAM_BOT_TOKEN=abc123\n')
    expect(readChannelToken('telegram', path)).toBe('abc123')
  })

  it('reads the provider-specific key for slack/discord/googlechat/teams', () => {
    expect(readChannelToken('slack', envFile('slack.env', 'SLACK_BOT_TOKEN=xoxb-1\n'))).toBe('xoxb-1')
    expect(readChannelToken('discord', envFile('discord.env', 'DISCORD_BOT_TOKEN=disc-1\n'))).toBe('disc-1')
    expect(readChannelToken('googlechat', envFile('gc.env', 'GOOGLECHAT_PROJECT_ID=proj-1\n'))).toBe('proj-1')
    expect(readChannelToken('teams', envFile('teams.env', 'TEAMS_BOT_APP_ID=app-1\n'))).toBe('app-1')
  })

  it('returns null when the key is absent from the file', () => {
    const path = envFile('empty.env', 'SOME_OTHER_KEY=value\n')
    expect(readChannelToken('telegram', path)).toBeNull()
  })

  it('trims trailing whitespace from the matched value', () => {
    const path = envFile('trim.env', 'TELEGRAM_BOT_TOKEN=abc123   \n')
    expect(readChannelToken('telegram', path)).toBe('abc123')
  })

  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))
})

// Google Chat and Teams have no bot-token dashboard-send path (delivery goes
// through the plugin's own MCP tools) -- these stubs must fail loudly rather
// than silently pretending to send, and validateToken must report ok since
// there is no token to check.
describe('googlechat/teams provider stubs (no direct-send path)', () => {
  it('googlechat sendMessage rejects with an explanatory error', async () => {
    const p = getProvider('googlechat')
    await expect(p.sendMessage('tok', 'space/AAA', 'hi')).rejects.toThrow(/not supported/)
  })

  it('googlechat sendPhoto rejects with an explanatory error', async () => {
    const p = getProvider('googlechat')
    await expect(p.sendPhoto('tok', 'space/AAA', '/tmp/x.png', 'caption')).rejects.toThrow(/not supported/)
  })

  it('googlechat validateToken reports ok (no token model)', async () => {
    const p = getProvider('googlechat')
    await expect(p.validateToken('anything')).resolves.toEqual({ ok: true, botName: 'Google Chat' })
  })

  it('teams sendMessage rejects with an explanatory error', async () => {
    const p = getProvider('teams')
    await expect(p.sendMessage('tok', 'conv-1', 'hi')).rejects.toThrow(/not supported/)
  })

  it('teams sendPhoto rejects with an explanatory error', async () => {
    const p = getProvider('teams')
    await expect(p.sendPhoto('tok', 'conv-1', '/tmp/x.png', 'caption')).rejects.toThrow(/not supported/)
  })

  it('teams validateToken reports ok (no token model)', async () => {
    const p = getProvider('teams')
    await expect(p.validateToken('anything')).resolves.toEqual({ ok: true, botName: 'Microsoft Teams' })
  })
})

describe('discord formatMessage (formatForDiscord)', () => {
  it('leaves native GFM markdown untouched', () => {
    const p = getProvider('discord')
    expect(p.formatMessage('**bold** and _italic_')).toBe('**bold** and _italic_')
  })

  it('converts unchecked task-list checkboxes', () => {
    const p = getProvider('discord')
    expect(p.formatMessage('- [ ] todo')).toBe('☐ todo')
  })

  it('converts checked task-list checkboxes', () => {
    const p = getProvider('discord')
    expect(p.formatMessage('- [x] done')).toBe('☑ done')
  })
})
