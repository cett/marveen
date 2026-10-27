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
function storeLogged(value: string): void {
  setSystemConfig('RBAC_MODE', value, 'db')
  logConfigChange('RBAC_MODE', 'enforce', value, 'dashboard')
}

function unloggedAudits(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM agent_audit_log WHERE action = 'security.rbac_shadow_unlogged'").get() as { n: number }
  ).n
}

function mainAgentNotices(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent = 'main-agent'").get() as { n: number }).n
}

beforeEach(() => {
  initDatabase(':memory:')
  stopRbacModeRefresh()
  // The cache is module state: bring it to a known place (no row = enforce) before every case.
  refreshRbacMode(undefined)
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
  it('is enforce when there is no row', () => {
    expect(refreshRbacMode(undefined)).toBe('enforce')
    expect(getRbacMode()).toBe('enforce')
  })

  it('is shadow for a stored shadow that the journal confirms', () => {
    storeLogged('shadow')
    expect(refreshRbacMode(undefined)).toBe('shadow')
    expect(getRbacMode()).toBe('shadow')
  })

  it('reads the stored value strictly: a padded, upper-case shadow still counts, a misspelling never does', () => {
    storeLogged(' SHADOW ')
    expect(refreshRbacMode(undefined)).toBe('shadow')
    for (const bad of ['shadwo', '', 'off', 'shadow-ish']) {
      setSystemConfig('RBAC_MODE', bad, 'db')
      logConfigChange('RBAC_MODE', 'shadow', bad, 'dashboard')
      expect(refreshRbacMode(undefined)).toBe('enforce')
    }
  })

  it('is enforce for a stored enforce', () => {
    storeLogged('enforce')
    expect(refreshRbacMode(undefined)).toBe('enforce')
  })

  it('drops back to enforce when the row goes away', () => {
    storeLogged('shadow')
    expect(refreshRbacMode(undefined)).toBe('shadow')
    db.prepare("DELETE FROM system_config WHERE key = 'RBAC_MODE'").run()
    expect(refreshRbacMode(undefined)).toBe('enforce')
  })

  it('does not keep the last known shadow when the read fails', () => {
    storeLogged('shadow')
    expect(refreshRbacMode(undefined)).toBe('shadow')
    db.exec('DROP TABLE system_config')
    expect(refreshRbacMode(undefined)).toBe('enforce')
    expect(getRbacMode()).toBe('enforce')
  })

  it('is enforce when the journal table cannot be read', () => {
    storeLogged('shadow')
    expect(refreshRbacMode(undefined)).toBe('shadow')
    db.exec('DROP TABLE config_change_log')
    expect(refreshRbacMode(undefined)).toBe('enforce')
  })
})

describe('the env file can only tighten', () => {
  it('an env enforce wins over a stored, journalled shadow', () => {
    storeLogged('shadow')
    expect(refreshRbacMode('enforce')).toBe('enforce')
  })

  it('an env shadow does not loosen a stored enforce', () => {
    storeLogged('enforce')
    expect(refreshRbacMode('shadow')).toBe('enforce')
  })

  it('an env shadow does not loosen a missing row', () => {
    expect(refreshRbacMode('shadow')).toBe('enforce')
  })

  it('an env shadow next to a journalled stored shadow changes nothing: the stored value decides', () => {
    storeLogged('shadow')
    expect(refreshRbacMode('shadow')).toBe('shadow')
  })

  it('the emergency brake lifts again when the env value is removed', () => {
    storeLogged('shadow')
    expect(refreshRbacMode('enforce')).toBe('enforce')
    expect(refreshRbacMode(undefined)).toBe('shadow')
  })
})

describe('the journal must agree with a stored shadow', () => {
  it('a shadow nobody journalled is enforce, with one audit row and one notice', () => {
    setSystemConfig('RBAC_MODE', 'shadow', 'db')
    expect(refreshRbacMode(undefined)).toBe('enforce')
    expect(unloggedAudits()).toBe(1)
    expect(mainAgentNotices()).toBe(1)
  })

  it('does not repeat the alarm on every refresh', () => {
    setSystemConfig('RBAC_MODE', 'shadow', 'db')
    refreshRbacMode(undefined)
    refreshRbacMode(undefined)
    refreshRbacMode(undefined)
    expect(unloggedAudits()).toBe(1)
    expect(mainAgentNotices()).toBe(1)
  })

  it('a shadow whose newest journal row says enforce is enforce', () => {
    logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'dashboard')
    logConfigChange('RBAC_MODE', 'shadow', 'enforce', 'dashboard')
    setSystemConfig('RBAC_MODE', 'shadow', 'db')
    expect(refreshRbacMode(undefined)).toBe('enforce')
  })

  it('a shadow whose newest journal row says shadow is shadow, however old the older rows are', () => {
    logConfigChange('RBAC_MODE', 'shadow', 'enforce', 'dashboard')
    logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'dashboard')
    setSystemConfig('RBAC_MODE', 'shadow', 'db')
    expect(refreshRbacMode(undefined)).toBe('shadow')
  })

  it('a journal for another key does not vouch for RBAC_MODE', () => {
    logConfigChange('SOMETHING_ELSE', 'a', 'shadow', 'dashboard')
    setSystemConfig('RBAC_MODE', 'shadow', 'db')
    expect(refreshRbacMode(undefined)).toBe('enforce')
  })

  it('an alarmed state can alarm again after it was cleared', () => {
    setSystemConfig('RBAC_MODE', 'shadow', 'db')
    refreshRbacMode(undefined)
    expect(unloggedAudits()).toBe(1)
    // The journal catches up: not an alarm any more.
    logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'dashboard')
    expect(refreshRbacMode(undefined)).toBe('shadow')
    // A later journalled tightening that the row does not follow is a new episode.
    logConfigChange('RBAC_MODE', 'shadow', 'enforce', 'dashboard')
    expect(refreshRbacMode(undefined)).toBe('enforce')
    expect(unloggedAudits()).toBe(2)
  })
})

describe('loadRbacMode: the one-time, idempotent boot seed', () => {
  it('no env value and no row: an explicit enforce row and a journal row', () => {
    expect(loadRbacMode(undefined)).toBe('enforce')
    const row = getSystemConfig('RBAC_MODE')
    expect(row?.value).toBe('enforce')
    expect(row?.source).toBe('migrated_from_env')
    expect(journal()).toEqual([{ old_value: null, new_value: 'enforce', actor: 'system:migration' }])
  })

  it('env shadow and no row: a shadow row, journalled, and the gate follows it', () => {
    expect(loadRbacMode('shadow')).toBe('shadow')
    expect(getSystemConfig('RBAC_MODE')?.value).toBe('shadow')
    expect(journal()).toEqual([{ old_value: 'shadow', new_value: 'shadow', actor: 'system:migration' }])
    expect(unloggedAudits()).toBe(0)
  })

  it('env enforce and no row: an enforce row', () => {
    expect(loadRbacMode('enforce')).toBe('enforce')
    expect(getSystemConfig('RBAC_MODE')?.value).toBe('enforce')
  })

  it('never overwrites an existing row', () => {
    storeLogged('enforce')
    const before = getSystemConfig('RBAC_MODE')
    expect(loadRbacMode('shadow')).toBe('enforce')
    expect(getSystemConfig('RBAC_MODE')).toEqual(before)
    expect(journal()).toHaveLength(1)
  })

  it('keeps an operator-set shadow and does not re-seed it', () => {
    storeLogged('shadow')
    expect(loadRbacMode(undefined)).toBe('shadow')
    expect(getSystemConfig('RBAC_MODE')?.source).toBe('db')
    expect(journal()).toHaveLength(1)
  })

  it('a second run changes nothing', () => {
    loadRbacMode('shadow')
    const row = getSystemConfig('RBAC_MODE')
    const first = journal()
    expect(loadRbacMode('shadow')).toBe('shadow')
    expect(getSystemConfig('RBAC_MODE')).toEqual(row)
    expect(journal()).toEqual(first)
  })

  it('logs that an env shadow is ignored once the row exists, and not on the seeding boot', () => {
    const warn = vi.spyOn(logger, 'warn')
    loadRbacMode('shadow')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('ignored'))).toBe(false)
    storeLogged('enforce')
    loadRbacMode('shadow')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('env RBAC_MODE=shadow ignored'))).toBe(true)
  })

  it('stays enforce when the seed itself fails', () => {
    db.exec('DROP TABLE system_config')
    expect(loadRbacMode('shadow')).toBe('enforce')
  })
})

describe('the refresh timer', () => {
  it('picks up a hand-edited row within the refresh window, without a restart', () => {
    vi.useFakeTimers()
    storeLogged('enforce')
    refreshRbacMode(undefined)
    startRbacModeRefresh(undefined)
    setSystemConfig('RBAC_MODE', 'shadow', 'db')
    logConfigChange('RBAC_MODE', 'enforce', 'shadow', 'dashboard')
    expect(getRbacMode()).toBe('enforce')
    vi.advanceTimersByTime(5000)
    expect(getRbacMode()).toBe('shadow')
    setSystemConfig('RBAC_MODE', 'enforce', 'db')
    vi.advanceTimersByTime(5000)
    expect(getRbacMode()).toBe('enforce')
  })

  it('falls back to enforce on a failed re-read instead of keeping shadow', () => {
    vi.useFakeTimers()
    storeLogged('shadow')
    refreshRbacMode(undefined)
    startRbacModeRefresh(undefined)
    expect(getRbacMode()).toBe('shadow')
    db.exec('DROP TABLE system_config')
    vi.advanceTimersByTime(5000)
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
