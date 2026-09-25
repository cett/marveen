// Coverage for two previously-untested pieces of src/web/schedule-runner.ts:
// resolveBoundChatId (reads the agent's own telegram access.json to find its
// bound chat, replacing the old "chat_id: 0" sentinel that broke delivery --
// see the header comment above it in the source) and resolveTaskTarget (where
// a scheduled task's prompt gets delivered: which tmux session, on which
// host). chatIdFromAccessConfig, the pure core resolveBoundChatId delegates
// to, already has its own coverage in schedule-runner-autostart.test.ts.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockChannelStateDir = vi.hoisted(() => vi.fn())
const mockReadAgentRemoteHost = vi.hoisted(() => vi.fn())

vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return { ...actual, channelStateDir: mockChannelStateDir }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return { ...actual, readAgentRemoteHost: mockReadAgentRemoteHost }
})

import { resolveBoundChatId, resolveTaskTarget } from '../web/schedule-runner.js'
import { MAIN_AGENT_ID } from '../config.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'

describe('resolveBoundChatId', () => {
  function withAccessJson(content: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'bound-chat-'))
    mockChannelStateDir.mockReturnValue(dir)
    if (content !== undefined) writeFileSync(join(dir, 'access.json'), JSON.stringify(content))
    return dir
  }

  it('resolves the first DM allowlist entry', () => {
    const dir = withAccessJson({ allowFrom: ['555000111'], groups: {} })
    expect(resolveBoundChatId('some-agent')).toBe('555000111')
    rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to the first group when allowFrom is empty', () => {
    const dir = withAccessJson({ allowFrom: [], groups: { '-100999888': {} } })
    expect(resolveBoundChatId('some-agent')).toBe('-100999888')
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null when access.json does not exist', () => {
    const dir = withAccessJson(undefined)
    expect(resolveBoundChatId('some-agent')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null for an unparsable access.json rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bound-chat-'))
    mockChannelStateDir.mockReturnValue(dir)
    writeFileSync(join(dir, 'access.json'), '{not json')
    expect(() => resolveBoundChatId('some-agent')).not.toThrow()
    expect(resolveBoundChatId('some-agent')).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the bound chat for the MAIN_AGENT_ID via the no-agentDir channelStateDir overload', () => {
    const dir = withAccessJson({ allowFrom: ['777000111'], groups: {} })
    expect(resolveBoundChatId(MAIN_AGENT_ID)).toBe('777000111')
    expect(mockChannelStateDir).toHaveBeenCalledWith('telegram')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('resolveTaskTarget', () => {
  it('main agent: targets MAIN_CHANNELS_SESSION, local (host null)', () => {
    expect(resolveTaskTarget({ targetSession: undefined }, MAIN_AGENT_ID)).toEqual({
      session: MAIN_CHANNELS_SESSION,
      host: null,
    })
    expect(mockReadAgentRemoteHost).not.toHaveBeenCalled()
  })

  it('sub-agent: derives agent-<name>, resolving a remote host', () => {
    mockReadAgentRemoteHost.mockReturnValue('laptop.local')
    expect(resolveTaskTarget({ targetSession: undefined }, 'worker-one')).toEqual({
      session: 'agent-worker-one',
      host: 'laptop.local',
    })
  })

  it('sub-agent: local host resolves to null', () => {
    mockReadAgentRemoteHost.mockReturnValue(null)
    expect(resolveTaskTarget({ targetSession: undefined }, 'worker-two')).toEqual({
      session: 'agent-worker-two',
      host: null,
    })
  })

  it('a targetSession override always stays local, even for a remote sub-agent', () => {
    mockReadAgentRemoteHost.mockReturnValue('laptop.local')
    expect(resolveTaskTarget({ targetSession: 'custom-session' }, 'worker-one')).toEqual({
      session: 'custom-session',
      host: null,
    })
    expect(mockReadAgentRemoteHost).not.toHaveBeenCalled()
  })
})
