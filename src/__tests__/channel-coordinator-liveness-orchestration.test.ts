// Coverage for the two orchestration functions in
// src/channel-coordinator/liveness.ts that were still untested after the
// previous liveness pass (which covered getClaudePidForSession,
// readRespawnStampMs, readKeepaliveAgeMs): probeChannelPluginLiveness (the
// tri-state ps-snapshot-plus-bot.pid liveness probe) and probeNativeChannelDown
// (the full "should the coordinator backfill?" wiring). decideHasPluginAlive
// and decideNativeChannelDown -- the pure decision cores both delegate to --
// already have their own coverage elsewhere.
//
// PROJECT_ROOT and STORE_DIR are module-level consts baked in at import time
// (RESPAWN_STAMP_FILE/KEEPALIVE_FILE derive from STORE_DIR), so both are
// redirected to temp dirs via resetModules + dynamic re-import. agentDir is
// also mocked to a temp dir: every call below passes an explicit agentName,
// so the bot.pid lookup never falls through to the real, provider-default
// (homedir-based) channel state dir -- this machine has a live production
// bot.pid there, which would make the tests read (and depend on) real host
// process state.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), debug: vi.fn() } }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) }
})

const AGENT = 'probe-agent'

let storeDir: string
let agentChannelDir: string
let mod: typeof import('../channel-coordinator/liveness.js')

beforeEach(async () => {
  storeDir = mkdtempSync(join(tmpdir(), 'liveness-orch-store-'))
  agentChannelDir = mkdtempSync(join(tmpdir(), 'liveness-orch-agentdir-'))
  vi.resetModules()
  vi.doMock('../config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../config.js')>()
    return { ...actual, STORE_DIR: storeDir }
  })
  vi.doMock('../web/agent-config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../web/agent-config.js')>()
    return { ...actual, agentDir: () => agentChannelDir }
  })
  const { execFileSync } = await import('node:child_process')
  vi.mocked(execFileSync).mockReset()
  mod = await import('../channel-coordinator/liveness.js')
})

afterEach(() => {
  vi.doUnmock('../config.js')
  vi.doUnmock('../web/agent-config.js')
  rmSync(storeDir, { recursive: true, force: true })
  rmSync(agentChannelDir, { recursive: true, force: true })
})

// pid ppid command, mimicking `ps -axww -o pid,ppid,command` (header row first).
function psTree(lines: string[]): string {
  return ['  PID  PPID COMMAND', ...lines].join('\n')
}

async function mockPsAxww(output: string) {
  const { execFileSync } = await import('node:child_process')
  vi.mocked(execFileSync).mockImplementation(((cmd: string, args?: readonly string[]) => {
    const a = (args ?? []) as string[]
    if (a.includes('-axww')) return output as unknown as Buffer
    throw new Error('unexpected execFileSync in probeChannelPluginLiveness test: ' + JSON.stringify(a))
  }) as typeof execFileSync)
}

async function mockFullProbe(snapshot: string) {
  const { execFileSync } = await import('node:child_process')
  vi.mocked(execFileSync).mockImplementation(((cmd: string, args?: readonly string[]) => {
    const a = (args ?? []) as string[]
    if (a.includes('list-panes')) return '100\n' as unknown as Buffer
    if (a[0] === '-p') return 'claude\n' as unknown as Buffer
    if (a.includes('-axww')) return snapshot as unknown as Buffer
    throw new Error('unexpected execFileSync args: ' + JSON.stringify(a))
  }) as typeof execFileSync)
}

describe('probeChannelPluginLiveness', () => {
  it('alive: the ps -axww tree has a matching poller under claudePid', async () => {
    await mockPsAxww(psTree([
      '  100     1 claude --channels plugin:telegram',
      '  101   100 bun run --cwd /plugins/telegram start',
    ]))
    expect(mod.probeChannelPluginLiveness(100, 'telegram', AGENT)).toBe('alive')
  })

  it('down: the tree has no matching poller anywhere under claudePid', async () => {
    await mockPsAxww(psTree(['  100     1 claude --channels plugin:telegram']))
    expect(mod.probeChannelPluginLiveness(100, 'telegram', AGENT)).toBe('down')
  })

  it('unknown: the ps snapshot fails even after the retry', async () => {
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('ps timed out') })
    expect(mod.probeChannelPluginLiveness(100, 'telegram', AGENT)).toBe('unknown')
    expect(vi.mocked(execFileSync)).toHaveBeenCalledTimes(2) // fast-path + one retry
  })

  it('unknown: the state-dir lookup fails (agentDir throws for an unresolvable agent)', async () => {
    await mockPsAxww(psTree(['  100     1 claude --channels plugin:telegram']))
    vi.doMock('../web/agent-config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../web/agent-config.js')>()
      return { ...actual, agentDir: () => { throw new Error('unresolvable agent') } }
    })
    vi.resetModules()
    vi.doMock('../config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../config.js')>()
      return { ...actual, STORE_DIR: storeDir }
    })
    const brokenMod = await import('../channel-coordinator/liveness.js')
    expect(brokenMod.probeChannelPluginLiveness(100, 'telegram', 'ghost-agent')).toBe('unknown')
  })
})

describe('probeNativeChannelDown', () => {
  it('down: no claude process attached to the session (tmux has no such pane)', async () => {
    const { execFileSync } = await import('node:child_process')
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('no such session') })
    expect(mod.probeNativeChannelDown('main-channels', 'telegram', AGENT)).toBe(true)
  })

  it('down: claude process alive but no plugin poller under it', async () => {
    await mockFullProbe(psTree(['  100     1 claude --channels plugin:telegram']))
    expect(mod.probeNativeChannelDown('main-channels', 'telegram', AGENT)).toBe(true)
  })

  it('up: claude process alive, plugin poller under it, keepalive not stale (missing file)', async () => {
    await mockFullProbe(psTree([
      '  100     1 claude --channels plugin:telegram',
      '  101   100 bun run --cwd /plugins/telegram start',
    ]))
    expect(mod.probeNativeChannelDown('main-channels', 'telegram', AGENT)).toBe(false)
  })

  it('down: keepalive file present but stale past the threshold', async () => {
    const keepaliveFile = join(storeDir, '.channel-keepalive')
    writeFileSync(keepaliveFile, String(Math.floor(Date.now() / 1000)))
    const stalePast = new Date(Date.now() - (mod.KEEPALIVE_STALE_MS + 60_000))
    utimesSync(keepaliveFile, stalePast, stalePast)
    await mockFullProbe(psTree([
      '  100     1 claude --channels plugin:telegram',
      '  101   100 bun run --cwd /plugins/telegram start',
    ]))
    expect(mod.probeNativeChannelDown('main-channels', 'telegram', AGENT)).toBe(true)
  })
})
