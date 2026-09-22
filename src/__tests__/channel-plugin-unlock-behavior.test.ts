import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { execFileSyncMock, tryAcquireSessionSendLaneMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  tryAcquireSessionSendLaneMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))
vi.mock('../platform.js', () => ({ resolveFromPath: () => '/usr/local/bin/tmux' }))
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../web/session-send-lock.js', () => ({ tryAcquireSessionSendLane: tryAcquireSessionSendLaneMock }))

import {
  schedulePluginUnlockAfterRespawn,
  clearPluginAbsent,
  wasPluginConfirmedAbsent,
} from '../web/channel-plugin-unlock.js'

const TMUX = '/usr/local/bin/tmux'
const PROVIDER = 'telegram' as any
const SESSION = 'main-channels'
const IDLE_PANE_WITH_PROVIDER = 'header line\nbypass permissions on\nplugin:telegram:telegram - Connected\n'
const IDLE_PANE_NO_PROVIDER = 'header line\nbypass permissions on\ngoogle-workspace - Connected\n'
const NOT_IDLE_PANE = 'Resume from summary\nbypass permissions on\n'

function exitError(code: number): Error & { status: number } {
  const err = new Error(`exit ${code}`) as Error & { status: number }
  err.status = code
  return err
}

/** Wires execFileSync to a scripted flow: list-panes -> pgrep -> capture-pane
 * (readiness) -> [send-keys/mcp, sleep, capture-pane (provider check), ...]. */
function scriptExec(opts: {
  claudePid?: number | 'fail'
  bunPresent?: boolean
  readinessPane?: string
  providerPane?: string | 'throw'
}): void {
  execFileSyncMock.mockReset()
  let capturePaneCalls = 0
  execFileSyncMock.mockImplementation((bin: string, args: string[]) => {
    if (bin === TMUX && args[0] === 'list-panes') {
      if (opts.claudePid === 'fail') throw new Error('no such session')
      return `${opts.claudePid ?? 1234}\n`
    }
    if (bin === '/usr/bin/pgrep') {
      if (opts.bunPresent) return 'bun 999\n'
      throw exitError(1)
    }
    if (bin === TMUX && args[0] === 'capture-pane') {
      capturePaneCalls++
      // 1st capture is the readiness check (isSessionReadyForUnlock); the 2nd
      // (only reached once ready) is sendUnlockKeystrokes' provider-slug check.
      if (capturePaneCalls === 1) return opts.readinessPane ?? IDLE_PANE_WITH_PROVIDER
      if (opts.providerPane === 'throw') throw new Error('capture failed')
      return opts.providerPane ?? opts.readinessPane ?? IDLE_PANE_WITH_PROVIDER
    }
    if (bin === TMUX && (args[0] === 'send-keys')) return ''
    if (bin === '/bin/sleep') return ''
    return ''
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  tryAcquireSessionSendLaneMock.mockReset().mockReturnValue(vi.fn())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('clearPluginAbsent / wasPluginConfirmedAbsent', () => {
  it('reports not-confirmed-absent for a session never marked', () => {
    expect(wasPluginConfirmedAbsent('never-marked-session', 60_000)).toBe(false)
  })

  it('clearing an unmarked session is a no-op', () => {
    expect(() => clearPluginAbsent('never-marked-session')).not.toThrow()
  })
})

describe('schedulePluginUnlockAfterRespawn -- probe outcomes', () => {
  it('does nothing before the initial delay elapses', async () => {
    scriptExec({ bunPresent: true })
    schedulePluginUnlockAfterRespawn(SESSION, PROVIDER)
    await vi.advanceTimersByTimeAsync(1000)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('no-ops when the bun child is already present (plugin healthy)', async () => {
    scriptExec({ bunPresent: true })
    schedulePluginUnlockAfterRespawn(SESSION, PROVIDER)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(execFileSyncMock).toHaveBeenCalledWith('/usr/bin/pgrep', expect.arrayContaining(['-P', '1234', 'bun']), expect.anything())
    // Healthy path never touches the send lane or sends keystrokes.
    expect(tryAcquireSessionSendLaneMock).not.toHaveBeenCalled()
  })

  it('gives up quietly when the session has no resolvable claude pid', async () => {
    scriptExec({ claudePid: 'fail' })
    schedulePluginUnlockAfterRespawn(SESSION, PROVIDER)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(tryAcquireSessionSendLaneMock).not.toHaveBeenCalled()
  })

  it('retries when the pane is not idle yet, then proceeds once it is', async () => {
    scriptExec({ bunPresent: false, readinessPane: NOT_IDLE_PANE })
    schedulePluginUnlockAfterRespawn(SESSION, PROVIDER)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(tryAcquireSessionSendLaneMock).not.toHaveBeenCalled()

    // Second attempt: pane is now idle with the provider present.
    scriptExec({ bunPresent: false, readinessPane: IDLE_PANE_WITH_PROVIDER, providerPane: IDLE_PANE_WITH_PROVIDER })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(tryAcquireSessionSendLaneMock).toHaveBeenCalledWith(SESSION, null)
  })

  it('gives up after exhausting retries when the pane never goes idle', async () => {
    scriptExec({ bunPresent: false, readinessPane: NOT_IDLE_PANE })
    schedulePluginUnlockAfterRespawn(SESSION, PROVIDER)
    await vi.advanceTimersByTimeAsync(35_000)   // initial attempt
    await vi.advanceTimersByTimeAsync(15_000)   // retry 1
    await vi.advanceTimersByTimeAsync(15_000)   // retry 2 (last)
    await vi.advanceTimersByTimeAsync(15_000)   // would-be retry 3: none scheduled
    expect(tryAcquireSessionSendLaneMock).not.toHaveBeenCalled()
  })

  it('retries when the send lane is busy, then proceeds once it frees up', async () => {
    scriptExec({ bunPresent: false, readinessPane: IDLE_PANE_WITH_PROVIDER, providerPane: IDLE_PANE_WITH_PROVIDER })
    tryAcquireSessionSendLaneMock.mockReturnValueOnce(null)
    schedulePluginUnlockAfterRespawn(SESSION, PROVIDER)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(execFileSyncMock).not.toHaveBeenCalledWith(TMUX, expect.arrayContaining(['/mcp']), expect.anything())

    const release = vi.fn()
    tryAcquireSessionSendLaneMock.mockReturnValueOnce(release)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(execFileSyncMock).toHaveBeenCalledWith(TMUX, ['send-keys', '-t', SESSION, '/mcp', 'Enter'], expect.anything())
    await vi.runAllTimersAsync()
    expect(release).toHaveBeenCalled()
  })

  it('sends the full /mcp unlock sequence and releases the lane when the provider is present', async () => {
    scriptExec({ bunPresent: false, readinessPane: IDLE_PANE_WITH_PROVIDER, providerPane: IDLE_PANE_WITH_PROVIDER })
    schedulePluginUnlockAfterRespawn(SESSION, PROVIDER)
    await vi.advanceTimersByTimeAsync(35_000)
    await vi.runAllTimersAsync()

    const sendKeysCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === TMUX && c[1][0] === 'send-keys')
    const keys = sendKeysCalls.map((c) => c[1][3])
    expect(keys).toEqual(['/mcp', 'Up', 'Enter', 'Enter', 'Escape', 'Escape'])
    expect(tryAcquireSessionSendLaneMock).toHaveBeenCalledWith(SESSION, null)
  })

  it('aborts with Escape and marks the plugin absent when the provider is not in the /mcp list', async () => {
    scriptExec({ bunPresent: false, readinessPane: IDLE_PANE_WITH_PROVIDER, providerPane: IDLE_PANE_NO_PROVIDER })
    schedulePluginUnlockAfterRespawn(SESSION, PROVIDER)
    await vi.advanceTimersByTimeAsync(35_000)
    await vi.runAllTimersAsync()

    const sendKeysCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === TMUX && c[1][0] === 'send-keys')
    const keys = sendKeysCalls.map((c) => c[1][3])
    expect(keys).toEqual(['/mcp', 'Escape'])
    expect(wasPluginConfirmedAbsent(SESSION, 60_000)).toBe(true)
  })

  it('aborts with Escape when the post-open capture-pane throws', async () => {
    scriptExec({ bunPresent: false, readinessPane: IDLE_PANE_WITH_PROVIDER, providerPane: 'throw' })
    schedulePluginUnlockAfterRespawn(SESSION, PROVIDER)
    await vi.advanceTimersByTimeAsync(35_000)
    await vi.runAllTimersAsync()

    const sendKeysCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === TMUX && c[1][0] === 'send-keys')
    expect(sendKeysCalls.map((c) => c[1][3])).toEqual(['/mcp', 'Escape'])
  })

  it('clears a prior absent mark once bun is observed healthy again', async () => {
    scriptExec({ bunPresent: false, readinessPane: IDLE_PANE_WITH_PROVIDER, providerPane: IDLE_PANE_NO_PROVIDER })
    schedulePluginUnlockAfterRespawn(SESSION, PROVIDER)
    await vi.advanceTimersByTimeAsync(35_000)
    await vi.runAllTimersAsync()
    expect(wasPluginConfirmedAbsent(SESSION, 60_000)).toBe(true)

    scriptExec({ bunPresent: true })
    schedulePluginUnlockAfterRespawn(SESSION, PROVIDER)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(wasPluginConfirmedAbsent(SESSION, 60_000)).toBe(false)
  })
})
