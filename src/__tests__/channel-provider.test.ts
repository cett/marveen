import { describe, it, expect, vi, afterAll, afterEach } from 'vitest'
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
  generateSlackAppManifest,
  getSlackAppSetupInstructions,
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

  it('splitMessage respects the 2000 char discord limit', () => {
    const p = getProvider('discord')
    const chunks = p.splitMessage('A '.repeat(1500))
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000)
  })
})

// Backend coverage batch-57: the network-shaped send/validate paths (fetch
// wrapped) plus the small pure helpers (manifest, get*, googlechat/teams
// identity formatters) that batch-56 left uncovered.

function sequenceFetch(responses: Array<{ ok?: boolean; status?: number; json?: unknown; text?: string }>): typeof fetch {
  let i = 0
  return (async () => {
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json ?? {},
      text: async () => r.text ?? '',
    } as Response
  }) as typeof fetch
}

describe('telegram sendPhoto', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'telegram-photo-test-'))
  const photoPath = join(tmpDir, 'photo.png')
  writeFileSync(photoPath, Buffer.from([0, 1, 2, 3]))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

  afterEach(() => vi.unstubAllGlobals())

  it('builds a multipart request and resolves on an ok response', async () => {
    const fetchMock = vi.fn(sequenceFetch([{ ok: true }]))
    vi.stubGlobal('fetch', fetchMock)
    const p = getProvider('telegram')
    await p.sendPhoto('tok', '123', photoPath, 'caption')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bottok/sendPhoto',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('throws with the response status and body on a non-ok response', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ ok: false, status: 400, text: 'Bad Request' }]))
    const p = getProvider('telegram')
    await expect(p.sendPhoto('tok', '123', photoPath, 'caption')).rejects.toThrow(/Telegram sendPhoto 400/)
  })

  it('still throws with the status when reading the error body itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => { throw new Error('body read failed') },
    } as unknown as Response)))
    const p = getProvider('telegram')
    await expect(p.sendPhoto('tok', '123', photoPath, 'caption')).rejects.toThrow(/Telegram sendPhoto 502/)
  })
})

describe('telegram validateToken', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns ok with the bot username on a valid token', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ json: { ok: true, result: { username: 'mybot', id: 1 } } }]))
    const p = getProvider('telegram')
    await expect(p.validateToken('tok')).resolves.toEqual({ ok: true, botName: 'mybot' })
  })

  it('returns invalid_value when the API reports not ok', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ json: { ok: false } }]))
    const p = getProvider('telegram')
    const r = await p.validateToken('tok')
    expect(r).toEqual({ ok: false, error: 'invalid_value', hint: 'Invalid bot token' })
  })

  it('returns internal_error when the request throws', async () => {
    vi.stubGlobal('fetch', (async () => { throw new Error('network down') }) as unknown as typeof fetch)
    const p = getProvider('telegram')
    const r = await p.validateToken('tok')
    expect(r).toEqual({ ok: false, error: 'internal_error', hint: 'Failed to connect to Telegram API' })
  })
})

describe('slack sendMessage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('resolves when the HTTP response and the Slack payload are both ok', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ json: { ok: true } }]))
    const p = getProvider('slack')
    await expect(p.sendMessage('xoxb-1', 'C123', 'hi')).resolves.toBeUndefined()
  })

  it('throws on a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ ok: false, status: 500 }]))
    const p = getProvider('slack')
    await expect(p.sendMessage('xoxb-1', 'C123', 'hi')).rejects.toThrow(/Slack API HTTP 500/)
  })

  it('throws on an ok HTTP response with a Slack-level error', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ json: { ok: false, error: 'channel_not_found' } }]))
    const p = getProvider('slack')
    await expect(p.sendMessage('xoxb-1', 'C123', 'hi')).rejects.toThrow(/channel_not_found/)
  })
})

describe('slack sendPhoto', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'slack-photo-test-'))
  const photoPath = join(tmpDir, 'photo.png')
  writeFileSync(photoPath, Buffer.from([0, 1, 2, 3]))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))
  afterEach(() => vi.unstubAllGlobals())

  it('walks getUploadURL -> upload -> completeUpload on success', async () => {
    const fetchMock = vi.fn(sequenceFetch([
      { json: { ok: true, upload_url: 'https://upload.example/x', file_id: 'F1' } }, // getUploadURLExternal
      {}, // the raw upload PUT/POST
      { json: { ok: true } }, // completeUploadExternal
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const p = getProvider('slack')
    await p.sendPhoto('xoxb-1', 'C123', photoPath, 'caption')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('throws when getUploadURLExternal does not return an upload_url', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ json: { ok: false, error: 'invalid_auth' } }]))
    const p = getProvider('slack')
    await expect(p.sendPhoto('xoxb-1', 'C123', photoPath, 'caption')).rejects.toThrow(/invalid_auth/)
  })

  it('falls back to "unknown error" when getUploadURLExternal fails without an error field', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ json: { ok: false } }]))
    const p = getProvider('slack')
    await expect(p.sendPhoto('xoxb-1', 'C123', photoPath, 'caption')).rejects.toThrow(/unknown error/)
  })

  it('throws when completeUploadExternal reports not ok', async () => {
    vi.stubGlobal('fetch', sequenceFetch([
      { json: { ok: true, upload_url: 'https://upload.example/x', file_id: 'F1' } },
      {},
      { json: { ok: false, error: 'file_not_found' } },
    ]))
    const p = getProvider('slack')
    await expect(p.sendPhoto('xoxb-1', 'C123', photoPath, 'caption')).rejects.toThrow(/file_not_found/)
  })

  it('succeeds with an empty caption (title/initial_comment fallbacks)', async () => {
    const fetchMock = vi.fn(sequenceFetch([
      { json: { ok: true, upload_url: 'https://upload.example/x', file_id: 'F1' } },
      {},
      { json: { ok: true } },
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const p = getProvider('slack')
    await p.sendPhoto('xoxb-1', 'C123', photoPath, '')
    const completeCall = fetchMock.mock.calls[2]!
    const body = JSON.parse((completeCall[1] as RequestInit).body as string)
    expect(body.files[0].title).toBe('photo.png') // falls back to filename
    expect(body.initial_comment).toBeUndefined()
  })
})

describe('slack validateToken', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns ok with the bot user on a valid token', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ json: { ok: true, user: 'agent-a-bot' } }]))
    const p = getProvider('slack')
    await expect(p.validateToken('xoxb-1')).resolves.toEqual({ ok: true, botName: 'agent-a-bot' })
  })

  it('returns invalid_value with the Slack error hint when not ok', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ json: { ok: false, error: 'invalid_auth' } }]))
    const p = getProvider('slack')
    const r = await p.validateToken('xoxb-1')
    expect(r).toEqual({ ok: false, error: 'invalid_value', hint: 'invalid_auth' })
  })

  it('falls back to bot_id when the Slack response has no user field', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ json: { ok: true, bot_id: 'B123' } }]))
    const p = getProvider('slack')
    await expect(p.validateToken('xoxb-1')).resolves.toEqual({ ok: true, botName: 'B123' })
  })

  it('falls back to a default hint when not ok and Slack provides no error field', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ json: { ok: false } }]))
    const p = getProvider('slack')
    const r = await p.validateToken('xoxb-1')
    expect(r).toEqual({ ok: false, error: 'invalid_value', hint: 'Invalid token' })
  })

  it('returns internal_error when the request throws', async () => {
    vi.stubGlobal('fetch', (async () => { throw new Error('down') }) as unknown as typeof fetch)
    const p = getProvider('slack')
    const r = await p.validateToken('xoxb-1')
    expect(r).toEqual({ ok: false, error: 'internal_error', hint: 'Failed to connect to Slack API' })
  })
})

describe('discord sendMessage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('resolves on an ok response', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ ok: true }]))
    const p = getProvider('discord')
    await expect(p.sendMessage('bot-tok', '999', 'hi')).resolves.toBeUndefined()
  })

  it('throws with status and body text on a non-ok response', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ ok: false, status: 403, text: 'Missing Access' }]))
    const p = getProvider('discord')
    await expect(p.sendMessage('bot-tok', '999', 'hi')).rejects.toThrow(/Discord API 403/)
  })

  it('still throws with the status when reading the error body itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => { throw new Error('body read failed') },
    } as unknown as Response)))
    const p = getProvider('discord')
    await expect(p.sendMessage('bot-tok', '999', 'hi')).rejects.toThrow(/Discord API 502/)
  })
})

describe('discord sendPhoto', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'discord-photo-test-'))
  const photoPath = join(tmpDir, 'photo.png')
  writeFileSync(photoPath, Buffer.from([0, 1, 2, 3]))
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))
  afterEach(() => vi.unstubAllGlobals())

  it('builds a multipart request and resolves on an ok response', async () => {
    const fetchMock = vi.fn(sequenceFetch([{ ok: true }]))
    vi.stubGlobal('fetch', fetchMock)
    const p = getProvider('discord')
    await p.sendPhoto('bot-tok', '999', photoPath, 'caption')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/999/messages',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('throws with status and body text on a non-ok response', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ ok: false, status: 413, text: 'Payload Too Large' }]))
    const p = getProvider('discord')
    await expect(p.sendPhoto('bot-tok', '999', photoPath, 'caption')).rejects.toThrow(/Discord sendPhoto 413/)
  })

  it('still throws with the status when reading the error body itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => { throw new Error('body read failed') },
    } as unknown as Response)))
    const p = getProvider('discord')
    await expect(p.sendPhoto('bot-tok', '999', photoPath, 'caption')).rejects.toThrow(/Discord sendPhoto 502/)
  })

  it('succeeds with an empty caption (content field falls back to undefined, omitted from JSON)', async () => {
    const fetchMock = vi.fn(sequenceFetch([{ ok: true }]))
    vi.stubGlobal('fetch', fetchMock)
    const p = getProvider('discord')
    await p.sendPhoto('bot-tok', '999', photoPath, '')
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    const bodyStr = Buffer.from(options.body as Buffer).toString('utf-8')
    expect(bodyStr).not.toContain('"content"') // JSON.stringify omits keys whose value is undefined
  })
})

describe('discord validateToken', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns ok with the username on success', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ ok: true, json: { id: '1', username: 'agent-a' } }]))
    const p = getProvider('discord')
    await expect(p.validateToken('bot-tok')).resolves.toEqual({ ok: true, botName: 'agent-a' })
  })

  it('returns invalid_value when the response has no username', async () => {
    vi.stubGlobal('fetch', sequenceFetch([{ ok: false, json: {} }]))
    const p = getProvider('discord')
    const r = await p.validateToken('bot-tok')
    expect(r).toEqual({ ok: false, error: 'invalid_value', hint: 'Invalid bot token' })
  })

  it('returns internal_error when the request throws', async () => {
    vi.stubGlobal('fetch', (async () => { throw new Error('down') }) as unknown as typeof fetch)
    const p = getProvider('discord')
    const r = await p.validateToken('bot-tok')
    expect(r).toEqual({ ok: false, error: 'internal_error', hint: 'Failed to connect to Discord API' })
  })
})

describe('generateSlackAppManifest', () => {
  it('embeds the app name and the bot scopes/events lists', () => {
    const yaml = generateSlackAppManifest('AgentApp')
    expect(yaml).toContain('name: "AgentApp"')
    expect(yaml).toContain('display_name: "AgentApp"')
    expect(yaml).toContain('- chat:write')
    expect(yaml).toContain('- app_mention')
    expect(yaml).toContain('socket_mode_enabled: true')
  })

  it('strips quotes and backslashes from the app name', () => {
    const yaml = generateSlackAppManifest('Weird"\\Name')
    expect(yaml).toContain('name: "WeirdName"')
  })
})

describe('getSlackAppSetupInstructions', () => {
  it('returns a non-empty ordered list mentioning the manifest flow', () => {
    const steps = getSlackAppSetupInstructions()
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.some(s => s.includes('api.slack.com/apps'))).toBe(true)
    expect(steps.some(s => s.includes('xoxb-'))).toBe(true)
    expect(steps.some(s => s.includes('xapp-'))).toBe(true)
  })
})

describe('getChannelToken / getChannelChatId for discord, googlechat, teams', () => {
  it('reads the provider-specific token key', () => {
    expect(getChannelToken('discord', { DISCORD_BOT_TOKEN: 'disc-1' })).toBe('disc-1')
    expect(getChannelToken('googlechat', { GOOGLECHAT_PROJECT_ID: 'proj-1' })).toBe('proj-1')
    expect(getChannelToken('teams', { TEAMS_BOT_APP_ID: 'app-1' })).toBe('app-1')
  })

  it('reads the provider-specific chat-id key', () => {
    expect(getChannelChatId('discord', { DISCORD_CHANNEL_ID: 'chan-1' })).toBe('chan-1')
    expect(getChannelChatId('googlechat', { GOOGLECHAT_SPACE_ID: 'spaces/AAA' })).toBe('spaces/AAA')
    expect(getChannelChatId('teams', { TEAMS_ALLOWED_CONVERSATION_ID: 'conv-1' })).toBe('conv-1')
  })

  it('returns empty string when the provider-specific token key is missing', () => {
    expect(getChannelToken('discord', {})).toBe('')
    expect(getChannelToken('googlechat', {})).toBe('')
    expect(getChannelToken('teams', {})).toBe('')
  })

  it('returns empty string when the provider-specific chat-id key is missing', () => {
    expect(getChannelChatId('discord', {})).toBe('')
    expect(getChannelChatId('googlechat', {})).toBe('')
    expect(getChannelChatId('teams', {})).toBe('')
  })
})

describe('getProviderType for discord, googlechat, teams', () => {
  it('returns each provider when explicitly set', () => {
    expect(getProviderType('discord')).toBe('discord')
    expect(getProviderType('googlechat')).toBe('googlechat')
    expect(getProviderType('teams')).toBe('teams')
  })
})

describe('channelStateDir for discord, googlechat, teams', () => {
  it('uses the matching subdirectory for each provider', () => {
    expect(channelStateDir('discord')).toMatch(/\.claude\/channels\/discord$/)
    expect(channelStateDir('googlechat')).toMatch(/\.claude\/channels\/googlechat$/)
    expect(channelStateDir('teams')).toMatch(/\.claude\/channels\/teams$/)
  })
})

describe('googlechat/teams formatMessage and splitMessage (identity passthrough)', () => {
  it('googlechat formatMessage returns the text unchanged', () => {
    const p = getProvider('googlechat')
    expect(p.formatMessage('# Hello **world**')).toBe('# Hello **world**')
  })

  it('teams formatMessage returns the text unchanged', () => {
    const p = getProvider('teams')
    expect(p.formatMessage('# Hello **world**')).toBe('# Hello **world**')
  })

  it('googlechat splitMessage respects its own 4096 char limit', () => {
    const p = getProvider('googlechat')
    const chunks = p.splitMessage('A '.repeat(3000))
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096)
  })

  it('teams splitMessage respects its own 28000 char limit', () => {
    const p = getProvider('teams')
    const chunks = p.splitMessage('A '.repeat(20000))
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(28000)
  })
})

describe('readChannelToken: unreadable file', () => {
  it('returns null when the file exists but readFileSync throws', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'channel-provider-unreadable-'))
    try {
      // A directory path exists but readFileSync on it throws EISDIR.
      expect(readChannelToken('telegram', tmpDir)).toBeNull()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

// The VITEST guard (INSTBOT819, tested above) makes telegramHttpPost's real
// network branch unreachable under the vitest runner by design. Mock
// https.request completely (no real network call, regardless of the guard
// value) and briefly clear process.env.VITEST to exercise that branch's own
// success/failure/error logic.
describe('telegramHttpPost network branch (VITEST guard temporarily lifted, https fully mocked)', () => {
  const originalVitestFlag = process.env.VITEST

  afterEach(() => {
    process.env.VITEST = originalVitestFlag
    vi.restoreAllMocks()
  })

  function mockHttpsRequest(statusCode: number, opts?: { requestError?: Error }) {
    return vi.spyOn(https, 'request').mockImplementation(((_url: string, _options: unknown, callback: (res: unknown) => void) => {
      const req = {
        on: (event: string, handler: (err: Error) => void) => {
          if (opts?.requestError && event === 'error') handler(opts.requestError)
          return req
        },
        write: vi.fn(),
        end: vi.fn(() => {
          if (!opts?.requestError) {
            const res = { statusCode, resume: vi.fn() }
            callback(res)
          }
        }),
      }
      return req
    }) as unknown as typeof https.request)
  }

  it('resolves on a 200 response', async () => {
    mockHttpsRequest(200)
    delete process.env.VITEST
    const p = getProvider('telegram')
    await expect(p.sendMessage('123:tok', '999', 'hello')).resolves.toBeUndefined()
  })

  it('rejects on a non-200 response', async () => {
    mockHttpsRequest(500)
    delete process.env.VITEST
    const p = getProvider('telegram')
    await expect(p.sendMessage('123:tok', '999', 'hello')).rejects.toThrow(/Telegram API 500/)
  })

  it('rejects when the request itself errors', async () => {
    mockHttpsRequest(200, { requestError: new Error('ECONNRESET') })
    delete process.env.VITEST
    const p = getProvider('telegram')
    await expect(p.sendMessage('123:tok', '999', 'hello')).rejects.toThrow(/ECONNRESET/)
  })
})
