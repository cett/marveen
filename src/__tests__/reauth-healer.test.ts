import { describe, it, expect, vi } from 'vitest'

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, APP_TZ: 'UTC', RESPAWN_ENABLED: false }
})
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import {
  decideReauthAction,
  NO_REAUTH_STATE,
  isQuietHour,
  localHour,
  buildEscalationMessage,
  buildQuietSummaryMessage,
  routeEscalation,
  flushQuietSummary,
  startReauthHealer,
  type ReauthHealerState,
  type QuietSuppressedEntry,
} from '../web/reauth-healer.js'

const T = { threshold: 3, cooldownMs: 30 * 60 * 1000 }
const base = (over: Partial<Parameters<typeof decideReauthAction>[0]> = {}) => ({
  isDeadToken: true,
  sessionAlive: true,
  isMain: false,
  canInteractiveLogin: true,
  prev: NO_REAUTH_STATE,
  nowMs: 1_000_000,
  ...over,
})

// Autonomous re-auth healer decision (Adam stability-fix #1). Conservative:
// false-positive avoidance is the priority since the action injects /login.
describe('decideReauthAction', () => {
  it('clean token resets the spell, no action', () => {
    const d = decideReauthAction(base({ isDeadToken: false, prev: { consecutiveDead: 2, lastActionAtMs: 5 } }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.escalate).toBe(false)
    expect(d.next).toEqual(NO_REAUTH_STATE)
  })

  it('dead session-gone resets the spell (capture-null treated as not-applicable)', () => {
    const d = decideReauthAction(base({ sessionAlive: false, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.escalate).toBe(false)
    expect(d.next.consecutiveDead).toBe(0)
  })

  it('debounces: 1st and 2nd dead probes do not act', () => {
    const p1 = decideReauthAction(base({ prev: NO_REAUTH_STATE }), T)
    expect(p1.escalate).toBe(false)
    expect(p1.next.consecutiveDead).toBe(1)
    const p2 = decideReauthAction(base({ prev: p1.next }), T)
    expect(p2.escalate).toBe(false)
    expect(p2.next.consecutiveDead).toBe(2)
  })

  it('3rd consecutive dead probe escalates + send-keys (sub-agent)', () => {
    const d = decideReauthAction(base({ prev: { consecutiveDead: 2, lastActionAtMs: null }, nowMs: 2_000_000 }), T)
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(true)
    expect(d.next.lastActionAtMs).toBe(2_000_000)
    expect(d.next.consecutiveDead).toBe(3)
  })

  it('main agent at threshold escalates but does NOT send-keys', () => {
    const d = decideReauthAction(base({ isMain: true, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(false)
  })

  it('headless host at threshold escalates but does NOT send-keys (cascade guard)', () => {
    // A headless Linux fleet host: /login would fail AND rotate the shared OAuth
    // token into a fleet-wide 401 cascade, so escalate-only even for a sub-agent.
    const d = decideReauthAction(base({ canInteractiveLogin: false, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(false)
  })

  it('cooldown: still-dead within 30min does not re-fire', () => {
    const lastActionAtMs = 1_000_000
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 5, lastActionAtMs },
      nowMs: lastActionAtMs + 10 * 60 * 1000, // 10 min later
    }), T)
    expect(d.escalate).toBe(false)
    expect(d.sendKeys).toBe(false)
    expect(d.next.lastActionAtMs).toBe(lastActionAtMs) // unchanged
    expect(d.next.consecutiveDead).toBe(6) // keeps counting
  })

  it('cooldown: re-fires after 30min if still dead (does not forget)', () => {
    const lastActionAtMs = 1_000_000
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 12, lastActionAtMs },
      nowMs: lastActionAtMs + 31 * 60 * 1000,
    }), T)
    expect(d.escalate).toBe(true)
    expect(d.next.lastActionAtMs).toBe(lastActionAtMs + 31 * 60 * 1000)
  })

  it('a heal between dead spells lets the next spell alert immediately', () => {
    // dead x3 -> alert
    const a = decideReauthAction(base({ prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(a.escalate).toBe(true)
    // healed -> reset
    const b = decideReauthAction(base({ isDeadToken: false, prev: a.next }), T)
    expect(b.next).toEqual(NO_REAUTH_STATE)
    // dead again x3 from fresh -> alerts again (lastActionAtMs was reset)
    let s: ReauthHealerState = b.next
    let last = { escalate: false } as { escalate: boolean }
    for (let i = 0; i < 3; i++) { const r = decideReauthAction(base({ prev: s, nowMs: 9_000_000 }), T); s = r.next; last = r }
    expect(last.escalate).toBe(true)
  })
})

// 2026-07-16 first-run gate (bootcamp): the "Select login method" picker /
// browser sign-in screen is NOT a dead token. A /login send-keys there is
// actively harmful (Enter accepts a login method -> browser OAuth on a VALID
// credential); the heal is a sub-agent restart, which re-seeds the flag.
describe('decideReauthAction: first-run gate', () => {
  const gated = { consecutiveDead: 2, lastActionAtMs: null } as ReauthHealerState

  it('suppresses /login send-keys and restarts instead (sub-agent, at threshold)', () => {
    const d = decideReauthAction(base({ isFirstRunGate: true, prev: gated }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.restartAgent).toBe(true)
    expect(d.escalate).toBe(true)
  })

  it('restart works headless too (canInteractiveLogin false)', () => {
    const d = decideReauthAction(base({ isFirstRunGate: true, canInteractiveLogin: false, prev: gated }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.restartAgent).toBe(true)
  })

  it('main agent: never restarted, never send-keys -- escalate-only', () => {
    const d = decideReauthAction(base({ isFirstRunGate: true, isMain: true, prev: gated }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.restartAgent).toBe(false)
    expect(d.restartMain).toBe(false)
    expect(d.escalate).toBe(true)
  })

  it('a genuine 401 (not first-run gate) keeps the legacy behavior: send-keys, no restart', () => {
    const d = decideReauthAction(base({ prev: gated }), T)
    expect(d.sendKeys).toBe(true)
    expect(d.restartAgent).toBe(false)
  })

  it('below threshold: no restart', () => {
    const d = decideReauthAction(base({ isFirstRunGate: true, prev: NO_REAUTH_STATE }), T)
    expect(d.restartAgent).toBe(false)
    expect(d.escalate).toBe(false)
  })
})

// GAP 2a (PLAN.md, 2026-07-23 marveen-channels silent outage): once GAP 1 lands,
// a dead main-agent token is a legitimate restart target (fresh process either
// picks the still-good fleet token back up, or the token is quarantined by the
// escalate branch first) -- decideReauthAction gains restartMain, gated at the
// exact same fireNow threshold as escalate, for the main agent only, and never
// on the first-run gate (see the "escalate-only" test above, extended with
// restartMain === false).
describe('decideReauthAction: restartMain (main agent dead-token restart)', () => {
  it('3rd consecutive dead probe fires restartMain for the main agent (not first-run gate)', () => {
    const d = decideReauthAction(base({ isMain: true, prev: { consecutiveDead: 2, lastActionAtMs: null }, nowMs: 2_000_000 }), T)
    expect(d.escalate).toBe(true)
    expect(d.restartMain).toBe(true)
    expect(d.sendKeys).toBe(false)
    expect(d.restartAgent).toBe(false)
  })

  it('debounces: below threshold, restartMain stays false', () => {
    const p1 = decideReauthAction(base({ isMain: true, prev: NO_REAUTH_STATE }), T)
    expect(p1.restartMain).toBe(false)
    const p2 = decideReauthAction(base({ isMain: true, prev: p1.next }), T)
    expect(p2.restartMain).toBe(false)
  })

  it('sub-agent never gets restartMain, even at threshold', () => {
    const d = decideReauthAction(base({ isMain: false, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.restartMain).toBe(false)
  })

  it('cooldown: still-dead within 30min does not re-fire restartMain', () => {
    const lastActionAtMs = 1_000_000
    const d = decideReauthAction(base({
      isMain: true,
      prev: { consecutiveDead: 5, lastActionAtMs },
      nowMs: lastActionAtMs + 10 * 60 * 1000, // 10 min later
    }), T)
    expect(d.restartMain).toBe(false)
    expect(d.escalate).toBe(false)
  })

  it('cooldown: restartMain re-fires after 30min if still dead (mirrors escalate)', () => {
    const lastActionAtMs = 1_000_000
    const d = decideReauthAction(base({
      isMain: true,
      prev: { consecutiveDead: 12, lastActionAtMs },
      nowMs: lastActionAtMs + 31 * 60 * 1000,
    }), T)
    expect(d.restartMain).toBe(true)
    expect(d.escalate).toBe(true)
  })
})

describe('isQuietHour', () => {
  it('is quiet at the start boundary (23) and through midnight', () => {
    expect(isQuietHour(23)).toBe(true)
    expect(isQuietHour(0)).toBe(true)
    expect(isQuietHour(5)).toBe(true)
  })

  it('is NOT quiet at the end boundary (6, exclusive) and during the day', () => {
    expect(isQuietHour(6)).toBe(false)
    expect(isQuietHour(12)).toBe(false)
    expect(isQuietHour(22)).toBe(false)
  })
})

describe('localHour', () => {
  it('reads the wall-clock hour in the configured zone (mocked to UTC)', () => {
    // 2026-01-01T14:30:00Z -> hour 14 in UTC.
    expect(localHour(Date.parse('2026-01-01T14:30:00Z'))).toBe(14)
  })

  it('wraps correctly around midnight UTC', () => {
    expect(localHour(Date.parse('2026-01-01T00:05:00Z'))).toBe(0)
    expect(localHour(Date.parse('2026-01-01T23:55:00Z'))).toBe(23)
  })
})

describe('buildEscalationMessage', () => {
  it('computes the elapsed minutes from the probe count and interval', () => {
    // 3 probes * 3 min/probe = 9 min.
    const msg = buildEscalationMessage('zack', 'dead token (401)', 3)
    expect(msg).toContain('zack')
    expect(msg).toContain('dead token (401)')
    expect(msg).toContain('~9 perce')
  })

  it('scales for a re-alert with a much higher probe count', () => {
    const msg = buildEscalationMessage('boo', '401', 30)
    expect(msg).toContain('~90 perce')
  })
})

describe('buildQuietSummaryMessage', () => {
  it('lists every still-dead entry with its own elapsed time', () => {
    const entries: QuietSuppressedEntry[] = [
      { session: 's1', label: 'zack', reason: '401', consecutiveDead: 3 },
      { session: 's2', label: 'boo', reason: 'token expired', consecutiveDead: 6 },
    ]
    const msg = buildQuietSummaryMessage(entries)
    expect(msg).toContain('zack')
    expect(msg).toContain('~9 perce')
    expect(msg).toContain('boo')
    expect(msg).toContain('token expired')
    expect(msg).toContain('~18 perce')
  })

  it('still returns the header+footer for an empty list', () => {
    const msg = buildQuietSummaryMessage([])
    expect(msg).toContain('Reggeli token-összegzés')
    expect(msg).toContain('Bejelentkezés')
  })
})

describe('routeEscalation', () => {
  const entry: QuietSuppressedEntry = { session: 's1', label: 'zack', reason: '401', consecutiveDead: 3 }

  it('notifies immediately outside quiet hours, without touching the suppressed map', () => {
    const notify = vi.fn()
    const suppressed = new Map<string, QuietSuppressedEntry>()
    routeEscalation(entry, false, notify, suppressed)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain('zack')
    expect(suppressed.size).toBe(0)
  })

  it('queues for the morning summary during quiet hours, without notifying', () => {
    const notify = vi.fn()
    const suppressed = new Map<string, QuietSuppressedEntry>()
    routeEscalation(entry, true, notify, suppressed)
    expect(notify).not.toHaveBeenCalled()
    expect(suppressed.get('s1')).toEqual(entry)
  })
})

describe('flushQuietSummary', () => {
  it('is a no-op while still quiet, even with suppressed entries', () => {
    const notify = vi.fn()
    const stampAlert = vi.fn()
    const suppressed = new Map<string, QuietSuppressedEntry>([
      ['s1', { session: 's1', label: 'zack', reason: '401', consecutiveDead: 3 }],
    ])
    flushQuietSummary(true, () => 3, notify, stampAlert, suppressed)
    expect(notify).not.toHaveBeenCalled()
    expect(suppressed.size).toBe(1)
  })

  it('is a no-op once quiet hours end if nothing was suppressed', () => {
    const notify = vi.fn()
    flushQuietSummary(false, () => 0, notify, vi.fn(), new Map())
    expect(notify).not.toHaveBeenCalled()
  })

  it('sends one summary for entries still dead, drops healed ones silently, clears the map', () => {
    const notify = vi.fn()
    const stampAlert = vi.fn()
    const suppressed = new Map<string, QuietSuppressedEntry>([
      ['s1', { session: 's1', label: 'zack', reason: '401', consecutiveDead: 3 }],
      ['s2', { session: 's2', label: 'boo', reason: '401', consecutiveDead: 3 }],
    ])
    // s1 is still dead (recount 5), s2 healed overnight (recount 0).
    const stillDeadCount = (session: string) => (session === 's1' ? 5 : 0)
    flushQuietSummary(false, stillDeadCount, notify, stampAlert, suppressed)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toContain('zack')
    expect(notify.mock.calls[0][0]).not.toContain('boo')
    expect(stampAlert).toHaveBeenCalledTimes(1)
    expect(stampAlert).toHaveBeenCalledWith('s1')
    expect(suppressed.size).toBe(0)
  })

  it('sends nothing and stamps nothing when every suppressed agent healed overnight', () => {
    const notify = vi.fn()
    const stampAlert = vi.fn()
    const suppressed = new Map<string, QuietSuppressedEntry>([
      ['s1', { session: 's1', label: 'zack', reason: '401', consecutiveDead: 3 }],
    ])
    flushQuietSummary(false, () => 0, notify, stampAlert, suppressed)
    expect(notify).not.toHaveBeenCalled()
    expect(stampAlert).not.toHaveBeenCalled()
  })
})

describe('startReauthHealer', () => {
  it('is disabled on a non-production host (RESPAWN_ENABLED false): returns null, schedules nothing', () => {
    // The module-level mock above fixes RESPAWN_ENABLED to false for this file.
    const result = startReauthHealer()
    expect(result).toBeNull()
  })
})
