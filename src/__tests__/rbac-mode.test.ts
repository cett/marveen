// The live RBAC mode (web/rbac-mode.ts): strict value parsing, fail-closed reads, the env file that can
// only tighten, the journal match for shadow, the idempotent boot seed and the refresh timer.
//
// ISOLATION: every case runs against initDatabase(':memory:'). A row RBAC_MODE=shadow written to the
// shared store/claudeclaw.db would loosen the LIVE gate, so nothing here may touch that file.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'main-agent',
}))

import { initDatabase, getSystemConfig, setSystemConfig, logConfigChange } from '../db.js'
import { db } from '../db/connection.js'
import { logger } from '../logger.js'
import {
  parseRbacMode,
  getRbacMode,
  describeRbacMode,
  refreshRbacMode,
  loadRbacMode,
  startRbacModeRefresh,
  stopRbacModeRefresh,
} from '../web/rbac-mode.js'

interface JournalRow { old_value: string | null; new_value: string | null; actor: string }

function journal(): JournalRow[] {
  return db
    .prepare("SELECT old_value, new_value, actor FROM config_change_log WHERE key = 'RBAC_MODE' ORDER BY id")
    .all() as JournalRow[]
}

// A stored value together with the Settings-page journal row that makes shadow believable.
async function storeLogged(value: string): Promise<void> {
  await setSystemConfig('RBAC_MODE', value, 'db')
  await logConfigChange('RBAC_MODE', 'enforce', value, 'dashboard')
}

function unloggedAudits(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM agent_audit_log WHERE action = 'security.rbac_shadow_unlogged'").get() as { n: number }
  ).n
}

function mainAgentNotices(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'main-agent'").get() as { n: number }).n
}

beforeEach(async () => {
  initDatabase(':memory:')
  stopRbacModeRefresh()
  // The cache is module state: bring it to a known place (no row = enforce) before every case.
  await refreshRbacMode(undefined)
})

afterEach(() => {
  stopRbacModeRefresh()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('parseRbacMode', () => {
  it.each(['shadow', 'SHADOW', ' Shadow ', '\tshadow\n'])('%j is shadow', (v) => {
    expect(parseRbacMode(v)).toBe('shadow')
  })

  it.each(['enforce', 'shadwo', '', '   ', 'off', 'false', '0', 'shadow2', 'no-shadow'])('%j is enforce', (v) => {
    expect(parseRbacMode(v)).toBe('enforce')
  })

  it.each([undefined, null, 0, 1, true, {}, ['shadow']])('the non-string %j is enforce', (v) => {
    expect(parseRbacMode(v)).toBe('enforce')
  })
})

describe('reading the stored mode', () => {
  it('is enforce when there is no row', async () => {
    expect(await refreshRbacMode(undefined)).toBe('enforce')
    expect(getRbacMode()).toBe('enforce')
  })

  it('is shadow for a stored shadow that the journal confirms', async () => {
    await storeLogged('shadow')
    expect(await refreshRbacMode(undefined)).toBe('shadow')
    expect(getRbacMode()).toBe('shadow')
  })

  it('reads the stored value strictly: a padded, upper-case shadow still counts, a misspelling never does', async () => {
    await storeLogged(' SHADOW ')
    expect(await refreshRbacMode(undefined)).toBe('shadow')
    for (const bad of ['shadwo', '', 'off', 'shadow-ish']) {
      await setSystemConfig('RBAC_MODE', bad, 'db')
      await logConfigChange('RBAC_MODE', 'shadow', bad, 'dashboard')
      expect(await refreshRbacMode(undefined)).toBe('enforce')
    }
  })

  it('is enforce for a stored enforce', async () => {
    await storeLogged('enforce')
    expect(await refreshRbacMode(undefined)).toBe('enforce')
  })

  it('drops back to enforce when the row goes away', async () => {
    await storeLogged('shadow')
    expect(await refreshRbacMode(undefined)).toBe('shadow')
    db.prepare("DELETE FROM system_config WHERE key = 'RBAC_MODE'").run()
    expect(await refreshRbacMode(undefined)).toBe('enforce')
  })

  it('does not keep the last known shadow when the read fails', async () => {
    await storeLogged('shadow')
    expect(await refreshRbacMode(undefined)).toBe('shadow')
    db.exec('DROP TABLE system_config')
    expect(await refreshRbacMode(undefined)).toBe('enforce')
    expect(getRbacMode()).toBe('enforce')
  })

  it('is enforce when the journal table cannot be read', async () => {
    await storeLogged('shadow')
    expect(await refreshRbacMode(undefined)).toBe('shadow')
    db.exec('DROP TABLE config_change_log')
    expect(await refreshRbacMode(undefined)).toBe('enforce')
  })
})

describe('the env file can only tighten', () => {
  it('an env enforce wins over a stored, journalled shadow', async () => {
    await storeLogged('shadow')
    expect(await refreshRbacMode('enforce')).toBe('enforce')
  })

  it('an env shadow does not loosen a stored enforce', async () => {
    await storeLogged('enforce')
    expect(await refreshRbacMode('shadow')).toBe('enforce')
  })

  it('an env shadow does not loosen a missing row', async () => {
    expect(await refreshRbacMode('shadow')).toBe('enforce')
  })

  it('an env shadow next to a journalled stored shadow changes nothing: the stored value decides', async () => {
    await storeLogged('shadow')
    expect(await refreshRbacMode('shadow')).toBe('shadow')
  })

  it('the emergency brake lifts again when the env value is removed', async () => {
    await storeLogged('shadow')
    expect(await refreshRbacMode('enforce')).toBe('enforce')
    expect(await refreshRbacMode(undefined)).toBe('shadow')
  })
})

describe('the journal must agree with a stored shadow', () => {
  it('a shadow nobody journalled is enforce, with one audit row and one notice', async () => {
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    expect(await refreshRbacMode(undefined)).toBe('enforce')
    expect(unloggedAudits()).toBe(1)
    expect(mainAgentNotices()).toBe(1)
  })

  it('does not repeat the alarm on every refresh', async () => {
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    await refreshRbacMode(undefined)
    await refreshRbacMode(undefined)
    await refreshRbacMode(undefined)
    expect(unloggedAudits()).toBe(1)
    expect(mainAgentNotices()).toBe(1)
  })

  it('a shadow whose newest journal row says enforce is enforce', async () => {
    await logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'dashboard')
    await logConfigChange('RBAC_MODE', 'shadow', 'enforce', 'dashboard')
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    expect(await refreshRbacMode(undefined)).toBe('enforce')
  })

  it('a shadow whose newest journal row says shadow is shadow, however old the older rows are', async () => {
    await logConfigChange('RBAC_MODE', 'shadow', 'enforce', 'dashboard')
    await logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'dashboard')
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    expect(await refreshRbacMode(undefined)).toBe('shadow')
  })

  it('a journal for another key does not vouch for RBAC_MODE', async () => {
    await logConfigChange('SOMETHING_ELSE', 'a', 'shadow', 'dashboard')
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    expect(await refreshRbacMode(undefined)).toBe('enforce')
  })

  it('an alarmed state can alarm again after it was cleared', async () => {
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    await refreshRbacMode(undefined)
    expect(unloggedAudits()).toBe(1)
    // The journal catches up: not an alarm any more.
    await logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'dashboard')
    expect(await refreshRbacMode(undefined)).toBe('shadow')
    // A later journalled tightening that the row does not follow is a new episode.
    await logConfigChange('RBAC_MODE', 'shadow', 'enforce', 'dashboard')
    expect(await refreshRbacMode(undefined)).toBe('enforce')
    expect(unloggedAudits()).toBe(2)
  })
})

describe('loadRbacMode: the one-time, idempotent boot seed', () => {
  it('no env value and no row: an explicit enforce row and a journal row', async () => {
    expect(await loadRbacMode(undefined)).toBe('enforce')
    const row = getSystemConfig('RBAC_MODE')
    expect(row?.value).toBe('enforce')
    expect(row?.source).toBe('migrated_from_env')
    expect(journal()).toEqual([{ old_value: null, new_value: 'enforce', actor: 'system:migration' }])
  })

  it('env shadow and no row: a shadow row, journalled, and the gate follows it', async () => {
    expect(await loadRbacMode('shadow')).toBe('shadow')
    expect(getSystemConfig('RBAC_MODE')?.value).toBe('shadow')
    expect(journal()).toEqual([{ old_value: 'shadow', new_value: 'shadow', actor: 'system:migration' }])
    expect(unloggedAudits()).toBe(0)
  })

  it('env enforce and no row: an enforce row', async () => {
    expect(await loadRbacMode('enforce')).toBe('enforce')
    expect(getSystemConfig('RBAC_MODE')?.value).toBe('enforce')
  })

  it('never overwrites an existing row', async () => {
    await storeLogged('enforce')
    const before = getSystemConfig('RBAC_MODE')
    expect(await loadRbacMode('shadow')).toBe('enforce')
    expect(getSystemConfig('RBAC_MODE')).toEqual(before)
    expect(journal()).toHaveLength(1)
  })

  it('keeps an operator-set shadow and does not re-seed it', async () => {
    await storeLogged('shadow')
    expect(await loadRbacMode(undefined)).toBe('shadow')
    expect(getSystemConfig('RBAC_MODE')?.source).toBe('db')
    expect(journal()).toHaveLength(1)
  })

  it('a second run changes nothing', async () => {
    await loadRbacMode('shadow')
    const row = getSystemConfig('RBAC_MODE')
    const first = journal()
    expect(await loadRbacMode('shadow')).toBe('shadow')
    expect(getSystemConfig('RBAC_MODE')).toEqual(row)
    expect(journal()).toEqual(first)
  })

  it('logs that an env shadow is ignored once the row exists, and not on the seeding boot', async () => {
    const warn = vi.spyOn(logger, 'warn')
    await loadRbacMode('shadow')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('ignored'))).toBe(false)
    await storeLogged('enforce')
    await loadRbacMode('shadow')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('env RBAC_MODE=shadow ignored'))).toBe(true)
  })

  it('stays enforce when the seed itself fails', async () => {
    db.exec('DROP TABLE system_config')
    expect(await loadRbacMode('shadow')).toBe('enforce')
  })
})

describe('the refresh timer', () => {
  it('picks up a hand-edited row within the refresh window, without a restart', async () => {
    vi.useFakeTimers()
    await storeLogged('enforce')
    await refreshRbacMode(undefined)
    startRbacModeRefresh(undefined)
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    await logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'dashboard')
    expect(getRbacMode()).toBe('enforce')
    await vi.advanceTimersByTimeAsync(5000)
    expect(getRbacMode()).toBe('shadow')
    await setSystemConfig('RBAC_MODE', 'enforce', 'db')
    await vi.advanceTimersByTimeAsync(5000)
    expect(getRbacMode()).toBe('enforce')
  })

  it('falls back to enforce on a failed re-read instead of keeping shadow', async () => {
    vi.useFakeTimers()
    await storeLogged('shadow')
    await refreshRbacMode(undefined)
    startRbacModeRefresh(undefined)
    expect(getRbacMode()).toBe('shadow')
    db.exec('DROP TABLE system_config')
    await vi.advanceTimersByTimeAsync(5000)
    expect(getRbacMode()).toBe('enforce')
  })

  it('is unref\'d, so it never keeps the process alive', () => {
    const spy = vi.spyOn(globalThis, 'setInterval')
    startRbacModeRefresh(undefined)
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(false)
  })

  it('a second start replaces the first instead of stacking timers', () => {
    vi.useFakeTimers()
    startRbacModeRefresh(undefined)
    startRbacModeRefresh(undefined)
    expect(vi.getTimerCount()).toBe(1)
    stopRbacModeRefresh()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('describeRbacMode: the live mode next to what is stored', () => {
  it('no row: enforce, nothing stored, no reason', async () => {
    await refreshRbacMode(undefined)
    expect(describeRbacMode()).toEqual({ effective: 'enforce', stored: null, reason: null })
  })

  it('a journalled shadow: shadow in force, nothing to explain', async () => {
    await storeLogged('shadow')
    await refreshRbacMode(undefined)
    expect(describeRbacMode()).toEqual({ effective: 'shadow', stored: 'shadow', reason: null })
  })

  it('a stored enforce: nothing to explain', async () => {
    await storeLogged('enforce')
    await refreshRbacMode(undefined)
    expect(describeRbacMode()).toEqual({ effective: 'enforce', stored: 'enforce', reason: null })
  })

  it('an unlogged shadow: enforce in force, stored shadow, reason unlogged_shadow', async () => {
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    await refreshRbacMode(undefined)
    expect(describeRbacMode()).toEqual({ effective: 'enforce', stored: 'shadow', reason: 'unlogged_shadow' })
  })

  it('the env brake over a journalled shadow: reason env_enforce', async () => {
    await storeLogged('shadow')
    await refreshRbacMode('enforce')
    expect(describeRbacMode()).toEqual({ effective: 'enforce', stored: 'shadow', reason: 'env_enforce' })
  })

  it('an unreadable row: enforce, reason read_error, stored unknown', async () => {
    await storeLogged('shadow')
    await refreshRbacMode(undefined)
    db.exec('DROP TABLE system_config')
    await refreshRbacMode(undefined)
    expect(describeRbacMode()).toEqual({ effective: 'enforce', stored: null, reason: 'read_error' })
  })

  it('the reason goes away once the row is fixed', async () => {
    await setSystemConfig('RBAC_MODE', 'shadow', 'db')
    await refreshRbacMode(undefined)
    expect(describeRbacMode().reason).toBe('unlogged_shadow')
    await setSystemConfig('RBAC_MODE', 'enforce', 'db')
    await refreshRbacMode(undefined)
    expect(describeRbacMode()).toEqual({ effective: 'enforce', stored: 'enforce', reason: null })
  })
})

describe('every switch to shadow is announced', () => {
  it('a journalled shadow picked up by a refresh notifies the main agent once, not on every refresh', async () => {
    expect(mainAgentNotices()).toBe(0)
    await storeLogged('shadow')
    await refreshRbacMode(undefined)
    expect(mainAgentNotices()).toBe(1)
    await refreshRbacMode(undefined)
    await refreshRbacMode(undefined)
    expect(mainAgentNotices()).toBe(1)
  })

  it('a hand-written pair of rows (value and journal) is announced too, through the timer', async () => {
    vi.useFakeTimers()
    startRbacModeRefresh(undefined)
    await storeLogged('shadow')
    await vi.advanceTimersByTimeAsync(5000)
    expect(getRbacMode()).toBe('shadow')
    expect(mainAgentNotices()).toBe(1)
  })

  it('tightening, and an unlogged shadow that stays enforce, send no shadow notice', async () => {
    await storeLogged('shadow')
    await refreshRbacMode(undefined)
    const before = mainAgentNotices()
    await setSystemConfig('RBAC_MODE', 'enforce', 'db')
    await refreshRbacMode(undefined)
    expect(mainAgentNotices()).toBe(before)
  })

  it('the boot seed from an env shadow is announced', async () => {
    await loadRbacMode('shadow')
    expect(mainAgentNotices()).toBe(1)
  })
})
