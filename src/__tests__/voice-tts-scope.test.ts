// voice-tts-scope.ts: a fleet_agent token may speak only on its own channel, to a chat paired on it.
// Real temp directories, neutral fixture ids (agents zed / ydd, main agent mn, chats 4242 / 9999).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config.js', () => ({ MAIN_AGENT_ID: 'mn' }))
vi.mock('../web/agent-config.js', () => ({ AGENTS_BASE_DIR: '/unused-in-these-tests' }))

import { agentOwnsStateDir, resolveOwnStateDir, chatIsPaired, type ChannelBases } from '../web/voice-tts-scope.js'

let root: string
let bases: ChannelBases

const own = (id: string, provider = 'telegram') => join(bases.agentsBase, id, '.claude', 'channels', provider)

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tts-scope-')))
  bases = { agentsBase: join(root, 'agents'), channelsBase: join(root, 'home', 'channels'), mainAgentId: 'mn' }
  mkdirSync(bases.agentsBase, { recursive: true })
  mkdirSync(bases.channelsBase, { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('agentOwnsStateDir (names only)', () => {
  it("accepts an agent's own channel dir under the agents base", () => {
    expect(agentOwnsStateDir('zed', own('zed'), bases)).toBe(true)
    expect(agentOwnsStateDir('zed', own('zed') + '/', bases)).toBe(true)
  })

  it("refuses another agent's channel dir under the agents base", () => {
    expect(agentOwnsStateDir('zed', own('ydd'), bases)).toBe(false)
  })

  it('treats the global provider dir as the main agent only', () => {
    const global = join(bases.channelsBase, 'telegram')
    expect(agentOwnsStateDir('mn', global, bases)).toBe(true)
    expect(agentOwnsStateDir('zed', global, bases)).toBe(false)
  })

  it('accepts the alternative <provider>-<id> naming for exactly that agent', () => {
    const alt = join(bases.channelsBase, 'telegram-zed')
    expect(agentOwnsStateDir('zed', alt, bases)).toBe(true)
    expect(agentOwnsStateDir('ydd', alt, bases)).toBe(false)
    expect(agentOwnsStateDir('mn', alt, bases)).toBe(false)
  })

  it('does not confuse an id that is the tail of another id', () => {
    expect(agentOwnsStateDir('ed', join(bases.channelsBase, 'telegram-zed'), bases)).toBe(false)
    expect(agentOwnsStateDir('ed', own('zed'), bases)).toBe(false)
  })

  it('refuses traversal, a dir outside both bases and a malformed agent id', () => {
    expect(agentOwnsStateDir('zed', join(bases.agentsBase, 'zed', '..', 'ydd', '.claude', 'channels', 'telegram'), bases)).toBe(false)
    expect(agentOwnsStateDir('zed', join(root, 'elsewhere'), bases)).toBe(false)
    expect(agentOwnsStateDir('../zed', own('zed'), bases)).toBe(false)
    expect(agentOwnsStateDir('', own('zed'), bases)).toBe(false)
  })
})

describe('resolveOwnStateDir (names, where they really point, and what is handed back)', () => {
  it('hands back the real path of a directory of its own', () => {
    mkdirSync(own('zed'), { recursive: true })
    expect(resolveOwnStateDir('zed', own('zed'), bases)).toBe(own('zed'))
  })

  it('refuses an own-named path that is a symlink to another agent\'s channel', () => {
    mkdirSync(own('ydd'), { recursive: true })
    mkdirSync(join(bases.agentsBase, 'zed', '.claude', 'channels'), { recursive: true })
    symlinkSync(own('ydd'), own('zed'))
    // the name alone is fooled, the real path is not
    expect(agentOwnsStateDir('zed', own('zed'), bases)).toBe(true)
    expect(resolveOwnStateDir('zed', own('zed'), bases)).toBeNull()
  })

  it('refuses a path that does not exist', () => {
    expect(resolveOwnStateDir('zed', own('zed'), bases)).toBeNull()
  })

  it('refuses a directory whose .env or access.json is itself a symlink', () => {
    for (const name of ['.env', 'access.json']) {
      mkdirSync(own('zed'), { recursive: true })
      const elsewhere = join(root, 'elsewhere-' + name.replace('.', ''))
      writeFileSync(elsewhere, '{}')
      symlinkSync(elsewhere, join(own('zed'), name))
      expect(resolveOwnStateDir('zed', own('zed'), bases), name).toBeNull()
      rmSync(own('zed'), { recursive: true, force: true })
    }
  })

  it('accepts a directory without an access.json (the chat check then refuses everything)', () => {
    mkdirSync(own('zed'), { recursive: true })
    writeFileSync(join(own('zed'), '.env'), 'X=1')
    expect(resolveOwnStateDir('zed', own('zed'), bases)).toBe(own('zed'))
    expect(chatIsPaired(own('zed'), '4242')).toBe(false)
  })
})

describe('chatIsPaired', () => {
  const write = (dir: string, content: string) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'access.json'), content)
  }

  it('accepts a chat in allowFrom, as a string or a number', () => {
    write(own('zed'), JSON.stringify({ allowFrom: ['4242', 7] }))
    expect(chatIsPaired(own('zed'), '4242')).toBe(true)
    expect(chatIsPaired(own('zed'), '7')).toBe(true)
  })

  it('refuses a chat that is not in allowFrom', () => {
    write(own('zed'), JSON.stringify({ allowFrom: ['4242'] }))
    expect(chatIsPaired(own('zed'), '9999')).toBe(false)
    expect(chatIsPaired(own('zed'), '424')).toBe(false)
  })

  it('fails closed on a missing file, bad JSON, no allowFrom or a non-array allowFrom', () => {
    expect(chatIsPaired(own('zed'), '4242')).toBe(false)
    write(own('zed'), '{not json')
    expect(chatIsPaired(own('zed'), '4242')).toBe(false)
    write(own('zed'), JSON.stringify({ other: ['4242'] }))
    expect(chatIsPaired(own('zed'), '4242')).toBe(false)
    write(own('zed'), JSON.stringify({ allowFrom: '4242' }))
    expect(chatIsPaired(own('zed'), '4242')).toBe(false)
  })
})
