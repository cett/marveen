// channel-credentials.ts: the server-side record of a channel's bot token and paired chats (the vault
// token, the DB chat list, the adopt step and the drift check). Real in-memory DB, real files in a temp
// dir; only the vault (a Map) and the channel directory layout are replaced.
//
// The negative controls are the point: each "does not widen" test fails on the code before this change,
// where the server read .env / access.json at send time.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, linkSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TMP = vi.hoisted(() => ({ dir: '' }))
const vault = vi.hoisted(() => new Map<string, string>())

vi.mock('../web/vault.js', () => ({
  getSecret: (id: string) => vault.get(id) ?? null,
  setSecret: (id: string, _label: string, value: string) => { vault.set(id, value) },
  deleteSecret: (id: string) => vault.delete(id),
}))
vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...actual,
    // the real layout: a sub-agent's channel lives inside its own directory, the main agent's under a channels base
    channelStateDir: (_provider: string, agentDir?: string) => (agentDir ? join(agentDir, '.claude', 'channels', 'telegram') : join(TMP.dir, 'MAIN-AGENT', 'channels', 'telegram')),
  }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...actual, agentDir: (name: string) => join(TMP.dir, name), listAgentNames: () => ['zed', 'amy'] }
})

import { initDatabase, getDb, listAdoptedChats, getChannelCredentialBaseline } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import {
  accessEntries,
  adoptChannel,
  adoptedDeliveryChat,
  channelTokenSecretId,
  checkChannelDrift,
  chatsFromAccessConfig,
  classifyDrift,
  forgetChannel,
  getChannelBotToken,
  parseEnvBotToken,
  resetChannelAfterSetup,
  serverMaySendTo,
  listUnadoptedChannelAgents,
  tokenHash,
  chatsHash,
} from '../web/channel-credentials.js'

const TOKEN_ZED = '111111111:ZED-token-aaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_AMY = '222222222:AMY-token-bbbbbbbbbbbbbbbbbbbbbbbbbbb'
const FOREIGN = '999999999:FOREIGN-token-ccccccccccccccccccccccc'

function chanDir(agent: string): string {
  return agent === MAIN_AGENT_ID ? join(TMP.dir, 'MAIN-AGENT', 'channels', 'telegram') : join(TMP.dir, agent, '.claude', 'channels', 'telegram')
}
function writeChannel(agent: string, token: string, access: object): void {
  mkdirSync(chanDir(agent), { recursive: true })
  writeFileSync(join(chanDir(agent), '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`)
  writeFileSync(join(chanDir(agent), 'access.json'), JSON.stringify(access))
}
const nowSec = () => Math.floor(Date.now() / 1000)

beforeAll(() => {
  initDatabase(':memory:')
  TMP.dir = mkdtempSync(join(tmpdir(), 'chan-cred-'))
})
afterAll(() => { rmSync(TMP.dir, { recursive: true, force: true }) })
beforeEach(() => {
  vault.clear()
  getDb().exec('DELETE FROM channel_allowed_chats; DELETE FROM channel_credential_baseline; DELETE FROM token_usage_shadow')
  rmSync(TMP.dir, { recursive: true, force: true })
  mkdirSync(TMP.dir, { recursive: true })
})

describe('pure helpers', () => {
  it('parseEnvBotToken takes a single quoted or bare assignment, and nothing ambiguous', () => {
    expect(parseEnvBotToken(`TELEGRAM_BOT_TOKEN=${TOKEN_ZED}\n`)).toBe(TOKEN_ZED)
    expect(parseEnvBotToken(`TELEGRAM_BOT_TOKEN="${TOKEN_ZED}"\n`)).toBe(TOKEN_ZED)
    expect(parseEnvBotToken('OTHER=1\n')).toBeNull()
    expect(parseEnvBotToken('TELEGRAM_BOT_TOKEN=not-a-token\n')).toBeNull()
    // two assignments: which one wins depends on the reader, so neither is trusted
    expect(parseEnvBotToken(`TELEGRAM_BOT_TOKEN=${TOKEN_ZED}\nTELEGRAM_BOT_TOKEN=${FOREIGN}\n`)).toBeNull()
  })

  it('chatsFromAccessConfig lists the DMs first, then the groups, drops junk and duplicates', () => {
    expect(chatsFromAccessConfig({ allowFrom: ['42', 7, ' 42 ', 'x', '1;2'], groups: { '-100123': {}, '-100123 ': {} } }))
      .toEqual(['42', '7', '-100123'])
    expect(chatsFromAccessConfig(null)).toEqual([])
    expect(chatsFromAccessConfig({ allowFrom: 'nope' })).toEqual([])
  })

  it('the drift hash covers entries the chat list drops, and ignores order', () => {
    const base = accessEntries({ allowFrom: ['42', '7'] })
    expect(chatsHash(base)).toBe(chatsHash(accessEntries({ allowFrom: ['7', '42'] })))
    expect(chatsHash(base)).not.toBe(chatsHash(accessEntries({ allowFrom: ['42', '7', 'junk'] })))
    expect(chatsHash(base)).not.toBe(chatsHash(accessEntries({ allowFrom: ['42', '7'], groups: { '-1': {} } })))
  })

  it('classifyDrift names the part that differs', () => {
    const baseline = { token_sha256: tokenHash(TOKEN_ZED), allow_sha256: chatsHash(accessEntries({ allowFrom: ['42'] })) }
    const same = { token: TOKEN_ZED, entries: accessEntries({ allowFrom: ['42'] }) }
    expect(classifyDrift(baseline, same)).toBe('ok')
    expect(classifyDrift(baseline, { ...same, token: FOREIGN })).toBe('token')
    expect(classifyDrift(baseline, { ...same, token: null })).toBe('token')
    expect(classifyDrift(baseline, { ...same, entries: accessEntries({ allowFrom: ['42', '666'] }) })).toBe('access')
    expect(classifyDrift(baseline, { token: FOREIGN, entries: [] })).toBe('both')
  })
})

describe('before anything is adopted', () => {
  it('the server has no token and no chat for the agent (default-deny)', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    expect(getChannelBotToken('zed')).toBeNull()
    expect(await serverMaySendTo('zed', '42')).toBe(false)
    expect(await adoptedDeliveryChat('zed')).toBeNull()
  })

  it('an invalid agent id never reaches the vault or the DB', async () => {
    expect(getChannelBotToken('../zed')).toBeNull()
    expect(await serverMaySendTo('../zed', '42')).toBe(false)
  })

  it('lists the agents that have a channel on disk but no adoption', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    expect(await listUnadoptedChannelAgents()).toEqual(['zed'])
    await adoptChannel('zed', 'owner')
    expect(await listUnadoptedChannelAgents()).toEqual([])
  })
})

describe('adoptChannel', () => {
  it('records the token in the vault, the chats and the baseline', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42', '7'], groups: { '-100999': {} } })
    const r = await adoptChannel('zed', 'owner')
    expect(r).toEqual({ ok: true, agentId: 'zed', chats: ['42', '7', '-100999'], replacedToken: false, botId: '111111111' })
    expect(vault.get(channelTokenSecretId('zed'))).toBe(TOKEN_ZED)
    expect(getChannelBotToken('zed')).toBe(TOKEN_ZED)
    expect(await listAdoptedChats('zed', 'telegram')).toEqual(['42', '7', '-100999'])
    expect(await adoptedDeliveryChat('zed')).toBe('42')
    expect(await serverMaySendTo('zed', '7')).toBe(true)
    expect(await serverMaySendTo('zed', '8')).toBe(false)
    expect(await getChannelCredentialBaseline('zed', 'telegram')).toMatchObject({ adopted_by: 'owner', drift_state: 'ok' })
  })

  it('adopts the main agent from the main agent channel', async () => {
    writeChannel(MAIN_AGENT_ID, TOKEN_ZED, { allowFrom: ['1'] })
    expect(await adoptChannel(MAIN_AGENT_ID, 'owner')).toMatchObject({ ok: true, chats: ['1'] })
    expect(vault.get(`channel-token:${MAIN_AGENT_ID}`)).toBe(TOKEN_ZED)
  })

  it('an empty pairing is a valid adoption: the server then sends nowhere', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: [] })
    expect(await adoptChannel('zed', 'owner')).toMatchObject({ ok: true, chats: [] })
    expect(getChannelBotToken('zed')).toBe(TOKEN_ZED)
    expect(await serverMaySendTo('zed', '42')).toBe(false)
  })

  it('re-adopting replaces the list and resets the drift state', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    await adoptChannel('zed', 'owner')
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42', '43'] })
    expect(await checkChannelDrift('zed', nowSec(), async () => true)).toBe('access')
    await adoptChannel('zed', 'owner')
    expect(await listAdoptedChats('zed', 'telegram')).toEqual(['42', '43'])
    expect(await getChannelCredentialBaseline('zed', 'telegram')).toMatchObject({ drift_state: 'ok', drift_since: null })
  })

  it('refuses an agent whose .env carries another agent\'s bot (one bot, one agent)', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    writeChannel('amy', TOKEN_ZED, { allowFrom: ['43'] })
    expect((await adoptChannel('zed', 'owner')).ok).toBe(true)
    expect(await adoptChannel('amy', 'owner')).toEqual({ ok: false, reason: 'token_in_use' })
    expect(getChannelBotToken('amy')).toBeNull()
  })

  it('refuses a .env that is a symlink, a missing file, or with two token lines', async () => {
    mkdirSync(chanDir('zed'), { recursive: true })
    writeFileSync(join(TMP.dir, 'elsewhere.env'), `TELEGRAM_BOT_TOKEN=${FOREIGN}\n`)
    symlinkSync(join(TMP.dir, 'elsewhere.env'), join(chanDir('zed'), '.env'))
    writeFileSync(join(chanDir('zed'), 'access.json'), '{"allowFrom":["42"]}')
    expect(await adoptChannel('zed', 'owner')).toEqual({ ok: false, reason: 'unreadable' })
    expect(await adoptChannel('amy', 'owner')).toEqual({ ok: false, reason: 'unreadable' })

    writeChannel('amy', TOKEN_AMY, { allowFrom: [] })
    writeFileSync(join(chanDir('amy'), '.env'), `TELEGRAM_BOT_TOKEN=${TOKEN_AMY}\nTELEGRAM_BOT_TOKEN=${FOREIGN}\n`)
    expect(await adoptChannel('amy', 'owner')).toEqual({ ok: false, reason: 'no_token' })
    expect(vault.size).toBe(0)
  })

  it('refuses a channel directory that is a symlink into another agent\'s tree, and a hard-linked .env', async () => {
    writeChannel('amy', TOKEN_AMY, { allowFrom: ['43'] })
    // zed's channel dir is a link to amy's: reading it would adopt amy's bot as zed's
    mkdirSync(join(TMP.dir, 'zed', '.claude', 'channels'), { recursive: true })
    symlinkSync(chanDir('amy'), chanDir('zed'))
    expect(await adoptChannel('zed', 'owner')).toEqual({ ok: false, reason: 'unreadable' })
    expect(vault.size).toBe(0)

    // same for a link higher up (zed's .claude dir)
    rmSync(join(TMP.dir, 'zed'), { recursive: true })
    mkdirSync(join(TMP.dir, 'zed'), { recursive: true })
    symlinkSync(join(TMP.dir, 'amy', '.claude'), join(TMP.dir, 'zed', '.claude'))
    expect(await adoptChannel('zed', 'owner')).toEqual({ ok: false, reason: 'unreadable' })

    // a second name for amy's .env inside zed's own directory
    rmSync(join(TMP.dir, 'zed'), { recursive: true })
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    rmSync(join(chanDir('zed'), '.env'))
    linkSync(join(chanDir('amy'), '.env'), join(chanDir('zed'), '.env'))
    expect(await adoptChannel('zed', 'owner')).toEqual({ ok: false, reason: 'unreadable' })
    expect(vault.size).toBe(0)
  })

  it('returns the bot id (the public part of the token) so the owner can see whose bot was adopted', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: [] })
    expect(await adoptChannel('zed', 'owner')).toMatchObject({ ok: true, botId: '111111111' })
  })

  it('refuses an oversized access.json and a FIFO in its place, without blocking', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    writeFileSync(join(chanDir('zed'), 'access.json'), JSON.stringify({ allowFrom: ['42'], pad: 'x'.repeat(100_000) }))
    expect(await adoptChannel('zed', 'owner')).toEqual({ ok: false, reason: 'unreadable' })

    rmSync(join(chanDir('zed'), 'access.json'))
    execFileSync('mkfifo', [join(chanDir('zed'), 'access.json')])
    expect(await adoptChannel('zed', 'owner')).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('rejects an invalid agent id', async () => {
    expect(await adoptChannel('../x', 'owner')).toEqual({ ok: false, reason: 'invalid_agent' })
  })
})

describe('negative control: the files an agent can write do not move what the server uses', () => {
  it('a forged access.json does not widen the chats the server may send to', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    await adoptChannel('zed', 'owner')
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['666', '42'] })

    expect(await serverMaySendTo('zed', '666')).toBe(false)
    expect(await adoptedDeliveryChat('zed')).toBe('42')
    expect(await listAdoptedChats('zed', 'telegram')).toEqual(['42'])
    expect(await checkChannelDrift('zed', nowSec(), async () => true)).toBe('access')
  })

  it('a foreign token in .env is not used by the server, and is alarmed', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    await adoptChannel('zed', 'owner')
    writeChannel('zed', FOREIGN, { allowFrom: ['42'] })

    expect(getChannelBotToken('zed')).toBe(TOKEN_ZED)
    expect(await checkChannelDrift('zed', nowSec(), async () => true)).toBe('token')
  })

  it('a deleted or unreadable file is drift too, and the server value stays', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    await adoptChannel('zed', 'owner')
    rmSync(chanDir('zed'), { recursive: true })

    expect(await checkChannelDrift('zed', nowSec(), async () => true)).toBe('unreadable')
    expect(getChannelBotToken('zed')).toBe(TOKEN_ZED)
    expect(await serverMaySendTo('zed', '42')).toBe(true)
  })
})

describe('checkChannelDrift', () => {
  it('is quiet while nothing differs and for an agent with no record', async () => {
    const send = vi.fn(async (_text: string) => true)
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    await adoptChannel('zed', 'owner')
    expect(await checkChannelDrift('zed', nowSec(), send)).toBe('ok')
    expect(await checkChannelDrift('amy', nowSec(), send)).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it('a pairing the plugin appended is drift too (the owner re-adopts after a new pairing)', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    await adoptChannel('zed', 'owner')
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42', '43'] })
    expect(await checkChannelDrift('zed', nowSec(), async () => true)).toBe('access')
  })

  it('alarms once per episode: the owner is told and the shadow counter moves, a repeat is silent', async () => {
    const send = vi.fn(async (_text: string) => true)
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    await adoptChannel('zed', 'owner')
    writeChannel('zed', FOREIGN, { allowFrom: ['42'] })

    const t0 = nowSec()
    await checkChannelDrift('zed', t0, send)
    await checkChannelDrift('zed', t0 + 300, send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(String(send.mock.calls[0][0])).toContain('zed')
    expect(String(send.mock.calls[0][0])).not.toContain(FOREIGN)
    expect(String(send.mock.calls[0][0])).not.toContain(TOKEN_ZED)
    const rows = getDb().prepare("SELECT category, caller, target, count FROM token_usage_shadow WHERE category = 'channel_credential_drift'").all()
    expect(rows).toEqual([{ category: 'channel_credential_drift', caller: 'zed', target: 'token', count: 1 }])
    expect(await getChannelCredentialBaseline('zed', 'telegram')).toMatchObject({ drift_state: 'token', drift_since: t0 })

    // restored: back to ok; a new deviation is a new episode and alarms again
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    expect(await checkChannelDrift('zed', t0 + 600, send)).toBe('ok')
    expect(await getChannelCredentialBaseline('zed', 'telegram')).toMatchObject({ drift_state: 'ok', drift_since: null })
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42', '1'] })
    await checkChannelDrift('zed', t0 + 900, send)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('an alarm that cannot be delivered does not throw and is not retried every sweep', async () => {
    const send = vi.fn(async (_text: string): Promise<boolean> => { throw new Error('channel down') })
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    await adoptChannel('zed', 'owner')
    writeChannel('zed', TOKEN_ZED, { allowFrom: [] })
    expect(await checkChannelDrift('zed', nowSec(), send)).toBe('access')
    await checkChannelDrift('zed', nowSec() + 300, send)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('resetChannelAfterSetup / forgetChannel', () => {
  it('a new setup drops the adopted chats and baseline and stores the new token', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    await adoptChannel('zed', 'owner')
    await resetChannelAfterSetup('zed', TOKEN_AMY)
    expect(getChannelBotToken('zed')).toBe(TOKEN_AMY)
    expect(await listAdoptedChats('zed', 'telegram')).toEqual([])
    expect(await getChannelCredentialBaseline('zed', 'telegram')).toBeNull()
    expect(await serverMaySendTo('zed', '42')).toBe(false)
  })

  it('forgetting a channel removes the token and the record, so a new agent of that name inherits nothing', async () => {
    writeChannel('zed', TOKEN_ZED, { allowFrom: ['42'] })
    await adoptChannel('zed', 'owner')
    await forgetChannel('zed')
    expect(getChannelBotToken('zed')).toBeNull()
    expect(await serverMaySendTo('zed', '42')).toBe(false)
    expect(await getChannelCredentialBaseline('zed', 'telegram')).toBeNull()
    expect(readFileSync(join(chanDir('zed'), '.env'), 'utf8')).toContain(TOKEN_ZED) // the agent's own files are not touched
  })
})
