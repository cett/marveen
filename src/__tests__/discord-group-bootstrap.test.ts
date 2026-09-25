// Coverage for ensureDiscordChannelGroup (src/web/discord-group-bootstrap.ts),
// previously untested. It bootstraps access.json's `groups[channelId]` entry
// so a fresh discord install doesn't require a manual `/discord:access group
// add` before the bot can reply in a server channel. CHANNEL_PROVIDER /
// CHANNEL_CHAT_ID are consts baked at config.js module-eval time, and
// channelStateDir() resolves under the real homedir by default -- both are
// mocked per test (via vi.doMock + resetModules) so the function is driven
// through a real temp directory instead of touching ~/.claude/channels.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let stateDir: string

beforeEach(() => {
  vi.resetModules()
  stateDir = mkdtempSync(join(tmpdir(), 'discord-group-bootstrap-'))
  vi.doMock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }))
  vi.doMock('../channel-provider.js', () => ({ channelStateDir: () => join(stateDir, 'discord') }))
})

afterEach(() => {
  vi.doUnmock('../logger.js')
  vi.doUnmock('../channel-provider.js')
  vi.doUnmock('../config.js')
  rmSync(stateDir, { recursive: true, force: true })
})

async function load(provider: string, chatId: string) {
  vi.doMock('../config.js', () => ({ CHANNEL_PROVIDER: provider, CHANNEL_CHAT_ID: chatId }))
  const mod = await import('../web/discord-group-bootstrap.js')
  return mod.ensureDiscordChannelGroup
}

function accessPath(): string {
  return join(stateDir, 'discord', 'access.json')
}

describe('ensureDiscordChannelGroup', () => {
  it('no-ops when CHANNEL_PROVIDER is not discord', async () => {
    const ensure = await load('telegram', '12345')
    ensure()
    expect(existsSync(accessPath())).toBe(false)
  })

  it('no-ops when CHANNEL_CHAT_ID is empty', async () => {
    const ensure = await load('discord', '')
    ensure()
    expect(existsSync(accessPath())).toBe(false)
  })

  it('creates a fresh access.json with the channel group when none exists', async () => {
    const ensure = await load('discord', '999888777')
    ensure()
    expect(existsSync(accessPath())).toBe(true)
    const access = JSON.parse(readFileSync(accessPath(), 'utf-8'))
    expect(access.dmPolicy).toBe('pairing')
    expect(access.allowFrom).toEqual([])
    expect(access.groups).toEqual({ '999888777': { requireMention: false, allowFrom: [] } })
  })

  it('merges the group entry into an existing access.json, preserving other fields', async () => {
    mkdirSync(join(stateDir, 'discord'), { recursive: true })
    writeFileSync(
      accessPath(),
      JSON.stringify({
        dmPolicy: 'allowlist',
        allowFrom: ['alice'],
        groups: { '111': { requireMention: true, allowFrom: ['bob'] } },
        pending: { foo: 'bar' },
      }),
    )
    const ensure = await load('discord', '222')
    ensure()
    const access = JSON.parse(readFileSync(accessPath(), 'utf-8'))
    expect(access.dmPolicy).toBe('allowlist')
    expect(access.allowFrom).toEqual(['alice'])
    expect(access.pending).toEqual({ foo: 'bar' })
    expect(access.groups['111']).toEqual({ requireMention: true, allowFrom: ['bob'] })
    expect(access.groups['222']).toEqual({ requireMention: false, allowFrom: [] })
  })

  it('is idempotent when the group entry is already present', async () => {
    mkdirSync(join(stateDir, 'discord'), { recursive: true })
    const existing = {
      dmPolicy: 'pairing',
      allowFrom: [],
      groups: { '222': { requireMention: true, allowFrom: ['carol'] } },
      pending: {},
    }
    writeFileSync(accessPath(), JSON.stringify(existing))
    const ensure = await load('discord', '222')
    ensure()
    const access = JSON.parse(readFileSync(accessPath(), 'utf-8'))
    // Untouched -- the existing (non-default) entry is not overwritten.
    expect(access.groups['222']).toEqual({ requireMention: true, allowFrom: ['carol'] })
  })

  it('leaves a corrupt access.json alone rather than overwriting it', async () => {
    mkdirSync(join(stateDir, 'discord'), { recursive: true })
    writeFileSync(accessPath(), '{not valid json')
    const ensure = await load('discord', '333')
    ensure()
    expect(readFileSync(accessPath(), 'utf-8')).toBe('{not valid json')
  })

  it('creates the state directory when it does not exist yet', async () => {
    const ensure = await load('discord', '444')
    expect(existsSync(join(stateDir, 'discord'))).toBe(false)
    ensure()
    expect(existsSync(join(stateDir, 'discord'))).toBe(true)
    expect(existsSync(accessPath())).toBe(true)
  })
})
