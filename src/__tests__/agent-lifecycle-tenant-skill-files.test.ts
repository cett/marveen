import { describe, it, expect, vi, beforeEach } from 'vitest'

// Tenant skill files follow the agent's process lifecycle: generated before the session launches
// (start), deleted once it is gone (stop). Only the wiring is tested here; the generate/remove
// behavior itself is covered in skill-tenant-files-mode.test.ts.

const { order, running } = vi.hoisted(() => ({ order: [] as string[], running: { value: false } }))

vi.mock('../web/skill-regen.js', () => ({
  generateTenantSkillFilesForAgent: vi.fn((n: string) => { order.push(`generate:${n}`); return { written: 0, skipped: 0, errors: 0 } }),
  removeGeneratedTenantSkillFilesForAgent: vi.fn((n: string) => { order.push(`remove:${n}`); return { removed: 0, kept: 0, errors: 0 } }),
}))
vi.mock('../web/agent-process-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process-session.js')>()
  return {
    ...actual,
    isAgentRunning: vi.fn(() => running.value),
    runTmux: vi.fn(() => { order.push('tmux'); return '' }),
    agentSessionName: vi.fn((n: string) => `agent-${n}`),
    // startAgentProcess resolves the binaries lazily; without this the test depends on `claude`/`tmux`
    // being installed on the host (CI has no claude -> 'Required binary not found on PATH').
    claudeBin: vi.fn(() => '/usr/local/bin/claude'),
    tmuxBin: vi.fn(() => '/usr/local/bin/tmux'),
  }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    agentDir: vi.fn(() => '/tmp'),
    readAgentRemoteConfig: vi.fn(() => ({})),
    readAgentRemoteHost: vi.fn(() => null),
    readAgentMemoryIsolation: vi.fn(() => false),
  }
})
vi.mock('../web/claude-plan-handoff-marker.js', () => ({
  recoverActivePlanFromHandoff: vi.fn(() => { order.push('after-generate-marker'); throw new Error('stop here') }),
}))
vi.mock('../web/claude-credentials-guard.js', () => ({ renameSharedCredentialsIfSafe: vi.fn() }))
vi.mock('../web/agent-process-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process-config.js')>()
  return { ...actual, ensureSharedClaudeOnboarded: vi.fn() }
})
vi.mock('../web/channel-poller-reap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/channel-poller-reap.js')>()
  return { ...actual, reapChannelOrphans: vi.fn() }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn() }
})
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, deactivatePlanForAgent: vi.fn() }
})
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { startAgentProcess, stopAgentProcess } from '../web/agent-process-spawn.js'
import * as regen from '../web/skill-regen.js'
import { readAgentRemoteHost } from '../web/agent-config.js'

beforeEach(() => { order.length = 0; running.value = false; vi.clearAllMocks() })

describe('agent lifecycle and tenant skill files', () => {
  it('start generates the tenant skill files before anything else launches', () => {
    expect(() => startAgentProcess('agent-a')).toThrow('stop here')
    expect(order[0]).toBe('generate:agent-a')
    expect(order).toEqual(['generate:agent-a', 'after-generate-marker'])
  })

  it('start of an already running agent generates nothing', () => {
    running.value = true
    expect(startAgentProcess('agent-a')).toMatchObject({ ok: false, error: 'conflict' })
    expect(regen.generateTenantSkillFilesForAgent).not.toHaveBeenCalled()
  })

  it('a failing generation does not block the start', () => {
    vi.mocked(regen.generateTenantSkillFilesForAgent).mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => startAgentProcess('agent-a')).toThrow('stop here')   // got past the generation
  })

  it('stop removes the generated tenant skill files after the session is killed', () => {
    running.value = true
    expect(stopAgentProcess('agent-a')).toEqual({ ok: true })
    expect(order).toEqual(['tmux', 'remove:agent-a'])
  })

  it('stop of a remote agent leaves the local skills directory alone (its files live on the laptop)', () => {
    running.value = true
    vi.mocked(readAgentRemoteHost).mockReturnValue('laptop')
    try {
      expect(stopAgentProcess('agent-a')).toEqual({ ok: true })
      expect(regen.removeGeneratedTenantSkillFilesForAgent).not.toHaveBeenCalled()
    } finally {
      vi.mocked(readAgentRemoteHost).mockReturnValue(null)
    }
  })

  it('a failing removal does not fail the stop, and a stop that did nothing removes nothing', () => {
    running.value = true
    vi.mocked(regen.removeGeneratedTenantSkillFilesForAgent).mockImplementationOnce(() => { throw new Error('busy') })
    expect(stopAgentProcess('agent-a').ok).toBe(true)
    running.value = false
    vi.mocked(regen.removeGeneratedTenantSkillFilesForAgent).mockClear()
    expect(stopAgentProcess('agent-a')).toMatchObject({ ok: false, error: 'conflict' })
    expect(regen.removeGeneratedTenantSkillFilesForAgent).not.toHaveBeenCalled()
  })
})
