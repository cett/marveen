// A failing log line, audit row or notice must never change the RBAC mode. The mode is decided and stored
// first; the bookkeeping after it is best effort. The case that matters: a tightening (shadow -> enforce)
// or a read error while the logger throws must still end in enforce, never keep an older shadow in force.
//
// ISOLATION: initDatabase(':memory:') only. A shadow row in the shared store would loosen the live gate.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
}))

const sink = vi.hoisted(() => ({ down: false }))
vi.mock('../logger.js', () => {
  const log = () => {
    if (sink.down) throw new Error('log sink down')
  }
  return { logger: { info: log, warn: log, error: log, debug: log } }
})

import { initDatabase, setSystemConfig, logConfigChange } from '../db.js'
import { db } from '../db/connection.js'
import {
  getRbacMode,
  describeRbacMode,
  refreshRbacMode,
  loadRbacMode,
  startRbacModeRefresh,
  stopRbacModeRefresh,
} from '../web/rbac-mode.js'

async function storeLogged(value: string): Promise<void> {
  await setSystemConfig('RBAC_MODE', value, 'db')
  await logConfigChange('RBAC_MODE', value === 'shadow' ? 'enforce' : 'shadow', value, 'dashboard')
}

async function shadowInForce(): Promise<void> {
  await storeLogged('shadow')
  expect(await refreshRbacMode(undefined)).toBe('shadow')
}

beforeEach(async () => {
  sink.down = false
  initDatabase(':memory:')
  stopRbacModeRefresh()
  await refreshRbacMode(undefined)
})

afterEach(() => {
  sink.down = false
  stopRbacModeRefresh()
  vi.useRealTimers()
})

describe('refreshRbacMode with a failing log sink', () => {
  it('a tightening still takes effect, and the call does not throw', async () => {
    await shadowInForce()
    await storeLogged('enforce')
    sink.down = true
    await expect(refreshRbacMode(undefined)).resolves.toBeDefined()
    expect(getRbacMode()).toBe('enforce')
  })

  it('a read error still ends in enforce, with the reason, and does not throw', async () => {
    await shadowInForce()
    db.exec('DROP TABLE system_config')
    sink.down = true
    await expect(refreshRbacMode(undefined)).resolves.toBeDefined()
    expect(getRbacMode()).toBe('enforce')
    expect(describeRbacMode().reason).toBe('read_error')
  })

  it('a row deleted by hand still ends in enforce', async () => {
    await shadowInForce()
    db.prepare("DELETE FROM system_config WHERE key = 'RBAC_MODE'").run()
    sink.down = true
    await expect(refreshRbacMode(undefined)).resolves.toBeDefined()
    expect(getRbacMode()).toBe('enforce')
  })

  it('the env brake still takes effect', async () => {
    await shadowInForce()
    sink.down = true
    await expect(refreshRbacMode('enforce')).resolves.toBeDefined()
    expect(getRbacMode()).toBe('enforce')
  })

  it('an unlogged shadow stays enforce and still gets its audit row and notice when the log line fails', async () => {
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    sink.down = true
    await expect(refreshRbacMode(undefined)).resolves.toBeDefined()
    expect(getRbacMode()).toBe('enforce')
    const audits = db.prepare("SELECT COUNT(*) AS n FROM agent_audit_log WHERE action = 'security.rbac_shadow_unlogged'").get() as { n: number }
    const notices = db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'main-agent'").get() as { n: number }
    expect(audits.n).toBe(1)
    expect(notices.n).toBe(1)
  })

  it('a legitimate loosening is applied even when the log line and the notice both fail', async () => {
    await storeLogged('shadow')
    db.exec('DROP TABLE agent_messages')
    sink.down = true
    await expect(refreshRbacMode(undefined)).resolves.toBeDefined()
    expect(getRbacMode()).toBe('shadow')
  })
})

describe('loadRbacMode with a failing log sink', () => {
  it('seeds, reads and returns the mode without throwing', async () => {
    sink.down = true
    let mode: string | undefined
    mode = await loadRbacMode('shadow')
    expect(mode).toBe('shadow')
  })

  it('a failing seed with a failing log still ends in enforce', async () => {
    db.exec('DROP TABLE system_config')
    sink.down = true
    await expect(loadRbacMode('shadow')).resolves.toBeDefined()
    expect(getRbacMode()).toBe('enforce')
  })
})

describe('the refresh timer with a failing log sink', () => {
  it('keeps running and applies a tightening and then a read error', async () => {
    vi.useFakeTimers()
    await shadowInForce()
    startRbacModeRefresh(undefined)
    sink.down = true
    await storeLogged('enforce')
    await vi.advanceTimersByTimeAsync(5000)
    expect(getRbacMode()).toBe('enforce')
    await storeLogged('shadow')
    await vi.advanceTimersByTimeAsync(5000)
    expect(getRbacMode()).toBe('shadow')
    db.exec('DROP TABLE system_config')
    await vi.advanceTimersByTimeAsync(5000)
    expect(getRbacMode()).toBe('enforce')
    expect(vi.getTimerCount()).toBe(1)
  })
})
