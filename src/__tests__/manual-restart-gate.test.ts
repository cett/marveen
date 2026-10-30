// The manual restart routes refuse to cut a running turn: three pane samples, all idle, or a 409 conflict with a
// reason (busy | no_pane). These tests pin the decision, the sampler (with its pane/command readings injected), the
// force parsing and the refusal body, and that the gate stays out of every internal restart path.

import { describe, it, expect, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  MANUAL_RESTART_INTERVAL_MS,
  MANUAL_RESTART_SAMPLES,
  decideManualRestart,
  gateManualRestart,
  restartRefusal,
  wantsForceRestart,
} from '../web/manual-restart-gate.js'
import { detectPaneState } from '../pane-state.js'

const SEP = '─'.repeat(40)
const IDLE_PANE = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
const BUSY_PANE = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')
const SHELL_PANE = 'user@host ~ % '

describe('fixtures are what they claim to be', () => {
  it('idle, busy and bare-shell panes classify as expected', () => {
    expect(detectPaneState(IDLE_PANE)).toBe('idle')
    expect(detectPaneState(BUSY_PANE)).toBe('busy')
    expect(detectPaneState(SHELL_PANE)).not.toBe('idle')
  })
})

describe('decideManualRestart', () => {
  it('allows only when every sample is idle', () => {
    expect(decideManualRestart([true, true, true])).toEqual({ allow: true, reason: 'idle' })
  })

  it('refuses busy when any sample is busy, even the last one', () => {
    expect(decideManualRestart([false, true, true])).toEqual({ allow: false, reason: 'busy' })
    expect(decideManualRestart([true, true, false])).toEqual({ allow: false, reason: 'busy' })
  })

  it('refuses an unreadable pane (fail-closed) and reports it before busy', () => {
    expect(decideManualRestart([true, null, true])).toEqual({ allow: false, reason: 'no_pane' })
    expect(decideManualRestart([false, null, true])).toEqual({ allow: false, reason: 'no_pane' })
  })

  it('a wrong sample count is no reading and refuses', () => {
    expect(decideManualRestart([])).toEqual({ allow: false, reason: 'no_pane' })
    expect(decideManualRestart([true, true])).toEqual({ allow: false, reason: 'no_pane' })
    expect(decideManualRestart([true, true, true, true])).toEqual({ allow: false, reason: 'no_pane' })
  })

  it('pins the sampling shape: three samples, 1200 ms apart', () => {
    expect(MANUAL_RESTART_SAMPLES).toBe(3)
    expect(MANUAL_RESTART_INTERVAL_MS).toBe(1200)
  })
})

describe('wantsForceRestart', () => {
  it('is a force only for an explicit boolean true in a JSON object', () => {
    expect(wantsForceRestart('{"force":true}')).toBe(true)
    expect(wantsForceRestart(Buffer.from('{"force": true, "fresh": true}'))).toBe(true)
  })

  it('an empty body (the dashboard button), {}, a string, a number or garbage is not a force', () => {
    for (const body of ['', '   ', '{}', '{"force":"true"}', '{"force":1}', '{"force":false}', 'null', '[true]', 'force', '{"force":true']) {
      expect(wantsForceRestart(body)).toBe(false)
    }
    expect(wantsForceRestart(Buffer.alloc(0))).toBe(false)
  })
})

describe('restartRefusal', () => {
  it('uses the existing conflict token with a machine-readable reason and tells how to force', () => {
    const busy = restartRefusal({ allow: false, reason: 'busy' }, '/api/marveen/restart')
    expect(busy.error).toBe('conflict')
    expect(busy.reason).toBe('busy')
    expect(busy.hint).toContain('POST /api/marveen/restart')
    expect(busy.hint).toContain('{"force": true}')
    const noPane = restartRefusal({ allow: false, reason: 'no_pane' }, '/api/agents/x/restart')
    expect(noPane.reason).toBe('no_pane')
    expect(noPane.hint).toContain('could not be read')
  })
})

describe('gateManualRestart', () => {
  const noSleep = vi.fn().mockResolvedValue(undefined)

  function deps(panes: Array<string | null>, command: string | null = 'claude.exe', exists = true) {
    let i = 0
    return {
      sleep: noSleep,
      sessionExists: () => exists,
      capture: () => panes[Math.min(i++, panes.length - 1)],
      command: () => command,
    }
  }

  it('a session that does not exist has no turn to cut: allowed without sampling', async () => {
    const capture = vi.fn()
    const v = await gateManualRestart('agent-x', null, { ...deps([]), sessionExists: () => false, capture })
    expect(v).toEqual({ allow: true, reason: 'no-session' })
    expect(capture).not.toHaveBeenCalled()
  })

  it('three idle samples with a sleep between each pair allow the restart', async () => {
    noSleep.mockClear()
    const v = await gateManualRestart('agent-x', null, deps([IDLE_PANE]))
    expect(v).toEqual({ allow: true, reason: 'idle' })
    expect(noSleep).toHaveBeenCalledTimes(2)
    expect(noSleep).toHaveBeenCalledWith(MANUAL_RESTART_INTERVAL_MS)
  })

  // The sleep is the whole point of sampling "over time": the sleep that is not awaited makes the three captures
  // happen back to back, so one glance is taken three times. A sleep stub that resolves at once (noSleep above)
  // cannot see that; these two use a sleep that really takes a macrotask.
  it('waits for each sleep to finish before the next capture: capture, sleep, capture, sleep, capture', async () => {
    const events: string[] = []
    const v = await gateManualRestart('agent-x', null, {
      sessionExists: () => true,
      command: () => 'claude.exe',
      capture: () => { events.push('capture'); return IDLE_PANE },
      sleep: async (ms: number) => {
        events.push(`sleep-start:${ms}`)
        await new Promise((r) => setTimeout(r, 5))
        events.push('sleep-end')
      },
    })
    expect(v).toEqual({ allow: true, reason: 'idle' })
    expect(events).toEqual([
      'capture',
      `sleep-start:${MANUAL_RESTART_INTERVAL_MS}`, 'sleep-end', 'capture',
      `sleep-start:${MANUAL_RESTART_INTERVAL_MS}`, 'sleep-end', 'capture',
    ])
  })

  it('a pane that only settles after the interval has passed is read after the wait, not before it', async () => {
    // Fake clock: a sleep advances it when it FINISHES. The pane shows idle only once the wait for that sample
    // is over (sample i is due at i * interval). A gate that does not wait reads the pane too early: busy.
    let clock = 0
    let sample = 0
    const v = await gateManualRestart('agent-x', null, {
      sessionExists: () => true,
      command: () => 'claude.exe',
      sleep: async (ms: number) => {
        await new Promise((r) => setTimeout(r, 5))
        clock += ms
      },
      capture: () => (clock >= sample++ * MANUAL_RESTART_INTERVAL_MS ? IDLE_PANE : BUSY_PANE),
    })
    expect(v).toEqual({ allow: true, reason: 'idle' })
    expect(clock).toBe((MANUAL_RESTART_SAMPLES - 1) * MANUAL_RESTART_INTERVAL_MS)
  })

  it('a pane that is busy at the start refuses', async () => {
    expect(await gateManualRestart('agent-x', null, deps([BUSY_PANE]))).toEqual({ allow: false, reason: 'busy' })
  })

  it('a pane that turns busy on the LAST sample still refuses (one look is not enough)', async () => {
    expect(await gateManualRestart('agent-x', null, deps([IDLE_PANE, IDLE_PANE, BUSY_PANE]))).toEqual({ allow: false, reason: 'busy' })
  })

  it('an existing session whose pane cannot be read is refused as no_pane', async () => {
    expect(await gateManualRestart('agent-x', null, deps([null]))).toEqual({ allow: false, reason: 'no_pane' })
    expect(await gateManualRestart('agent-x', null, deps([IDLE_PANE, null, IDLE_PANE]))).toEqual({ allow: false, reason: 'no_pane' })
  })

  it('parked typed input is not idle: refused (the stuck-input case needs an explicit force)', async () => {
    const typing = ['', SEP, '❯ draft of the next prompt', SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')
    expect(await gateManualRestart('agent-x', null, deps([typing]))).toEqual({ allow: false, reason: 'busy' })
  })

  it('a bare shell (CLI exited) has nothing to cut: restart allowed without waiting for the other samples', async () => {
    noSleep.mockClear()
    const v = await gateManualRestart('agent-x', null, deps([SHELL_PANE], 'zsh'))
    expect(v).toEqual({ allow: true, reason: 'dead-shell' })
    expect(noSleep).not.toHaveBeenCalled()
  })

  it('a shell reading never overrides a pane that shows work', async () => {
    expect(await gateManualRestart('agent-x', null, deps([BUSY_PANE], 'bash'))).toEqual({ allow: false, reason: 'busy' })
  })

  it('an unreadable foreground command never turns a non-idle pane into a restart', async () => {
    expect(await gateManualRestart('agent-x', null, deps([SHELL_PANE], null))).toEqual({ allow: false, reason: 'busy' })
  })
})

// The gate belongs to the HTTP routes. context-guard, the channel watchdog, auto-restart, model fallback and startup
// reconciliation call the restart helpers directly, and a wedged agent shows a busy pane forever: if one of them
// imported the gate, the recovery would stall on exactly the agent it exists to recover.
describe('the gate is route-only', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
  }
  const SRC = join(__dirname, '..')

  it('only src/web/routes/ files (and the gate itself) import the manual-restart gate', () => {
    const importers = walk(SRC)
      .filter((f) => !f.includes('__tests__'))
      .filter((f) => /manual-restart-gate/.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(SRC, f))
      .filter((f) => f !== join('web', 'manual-restart-gate.ts'))
      .sort()
    expect(importers).toEqual([
      join('web', 'routes', 'agents-process.ts'),
      join('web', 'routes', 'federation.ts'),
      join('web', 'routes', 'marveen.ts'),
    ])
  })

  it('the restart helpers themselves stay gate-free', () => {
    for (const rel of [join('web', 'channel-monitor.ts'), join('web', 'agent-process-spawn.ts')]) {
      expect(readFileSync(join(SRC, rel), 'utf-8')).not.toMatch(/gateManualRestart|manual-restart-gate/)
    }
  })

  it('the internal restart callers reach the helpers without going through a route', () => {
    for (const rel of ['context-guard-runner.ts', 'channel-monitor.ts', 'auto-restart-runner.ts', 'model-fallback-runner.ts', 'startup-reconciliation.ts']) {
      const text = readFileSync(join(SRC, 'web', rel), 'utf-8')
      expect(text).not.toMatch(/\/api\/(marveen|agents\/[^'"`]*)\/restart/)
      expect(text).not.toMatch(/gateManualRestart/)
    }
  })
})
