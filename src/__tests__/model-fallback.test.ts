import { describe, it, expect } from 'vitest'
import {
  detectsUsageLimit,
  detectsModelUnavailable,
  nextFallbackModel,
  decideModelAction,
  ladderFromPrimary,
  DEFAULT_SWITCH_COOLDOWN_MS,
  normalizeModelFallbackConfig,
  DEFAULT_MODEL_CHAIN,
  DEFAULT_MODEL_FALLBACK,
} from '../model-fallback.js'

const CHAIN = [...DEFAULT_MODEL_CHAIN]
const PRIMARY = CHAIN[0]
const SONNET = CHAIN[1]
const HAIKU = CHAIN[2]

const BOX = '─'.repeat(80)
// Fragments assembled at runtime so this source file never holds a bare banner
// line that the live pane detector could read off a pane showing this file.
const APPROACHING = ['Approaching', 'usage limit'].join(' ')
const BANNER = ['You hit your session', 'limit · resets 5:50pm'].join(' ')

describe('detectsUsageLimit', () => {
  it('matches Claude plan usage-limit banners in the live region', () => {
    expect(detectsUsageLimit('You have reached your usage limit. Try again later.')).toBe(true)
    expect(detectsUsageLimit('5-hour limit reached ∙ resets 3pm')).toBe(true)
    expect(detectsUsageLimit('Your limit will reset at 18:00')).toBe(true)
    expect(detectsUsageLimit('/upgrade to increase your usage limit')).toBe(true)
    // "session limit" variant observed 2026-08-08 -- was missing from the original regex
    expect(detectsUsageLimit('You hit your session limit · resets 5:50pm')).toBe(true)
    expect(detectsUsageLimit('You hit the session limit')).toBe(true)
  })

  it('does NOT match a transient API 429 / generic rate limit', () => {
    expect(detectsUsageLimit('  ⎿  API Error: 429 rate_limit_error: too many requests')).toBe(false)
    expect(detectsUsageLimit('  ⎿  API Error: 429 overloaded_error: server busy, retrying')).toBe(false)
  })

  // Regression: the "Approaching usage limit" heads-up is only a warning (the
  // session keeps working) but used to count as an exhausted budget, so a healthy
  // main agent was downgraded opus -> sonnet -> haiku.
  it('does NOT match the "approaching" warning (assembled at runtime, see below)', () => {
    expect(detectsUsageLimit(APPROACHING)).toBe(false)
    expect(detectsUsageLimit('  ' + APPROACHING + ' (85% of your weekly limit)')).toBe(false)
    expect(detectsUsageLimit(['  Approaching your usage limit', BOX, '> ', BOX, '  hint'].join('\n'))).toBe(false)
  })

  it('ignores the phrase when it is only up in scrollback, not the live region', () => {
    const scrollback = ['you reached your usage limit', ...Array(40).fill('normal output line')].join('\n')
    expect(detectsUsageLimit(scrollback)).toBe(false)
  })

  it('returns false for empty / whitespace panes', () => {
    expect(detectsUsageLimit('')).toBe(false)
    expect(detectsUsageLimit('   \n  ')).toBe(false)
  })
})

describe('detectsUsageLimit: live-region narrowing (box interior, quoted text)', () => {
  it('fires on the real banner directly above the input box', () => {
    const pane = ['  earlier output', '', '  ' + BANNER, '', BOX, '> ', BOX, '  ? for shortcuts'].join('\n')
    expect(detectsUsageLimit(pane)).toBe(true)
  })

  it('does NOT fire when the phrase sits in the box interior (typed / quoted input)', () => {
    const pane = ['  status', BOX, '> see: ' + BANNER, BOX, '  ? for shortcuts'].join('\n')
    expect(detectsUsageLimit(pane)).toBe(false)
  })

  it('does NOT fire when the banner is far above the box (old transcript)', () => {
    const pane = ['  ' + BANNER, ...Array(8).fill('  later output'), BOX, '> ', BOX, '  hint'].join('\n')
    expect(detectsUsageLimit(pane)).toBe(false)
  })

  it('does NOT fire on a line that quotes the phrase (code / tool output about this feature)', () => {
    const quoted = ["  expect(detectsUsageLimit('", BANNER, "')).toBe(true)"].join('')
    const pane = ['  ' + quoted, BOX, '> ', BOX, '  hint'].join('\n')
    expect(detectsUsageLimit(pane)).toBe(false)
  })

  it('does NOT fire on a regex / alternation line', () => {
    const pane = ['  /(usage limit reached|hit your session limit)/i', BOX, '> ', BOX, '  hint'].join('\n')
    expect(detectsUsageLimit(pane)).toBe(false)
  })

  it('still fires on a banner whose wording carries an in-word apostrophe', () => {
    const pane = ["  You've reached your usage limit. Resets at 3pm", BOX, '> ', BOX, '  hint'].join('\n')
    expect(detectsUsageLimit(pane)).toBe(true)
  })

  it('headless pane (no box): falls back to the bottom 15 lines', () => {
    expect(detectsUsageLimit([...Array(5).fill('x'), BANNER].join('\n'))).toBe(true)
    expect(detectsUsageLimit([BANNER, ...Array(40).fill('x')].join('\n'))).toBe(false)
  })
})

describe('ladderFromPrimary', () => {
  it('starts at the agent primary when it is on the chain', () => {
    expect(ladderFromPrimary(SONNET, CHAIN)).toEqual([SONNET, HAIKU])
    expect(ladderFromPrimary(PRIMARY, CHAIN)).toEqual(CHAIN)
  })

  it('gives a primary that is not on the chain the top slot (never chain[0])', () => {
    expect(ladderFromPrimary('claude-opus-5-5', CHAIN)).toEqual(['claude-opus-5-5', SONNET, HAIKU])
  })

  it('a chain too short to fall back on leaves just the primary', () => {
    expect(ladderFromPrimary('m', ['only'])).toEqual(['m'])
  })
})

describe('decideModelAction: cooldown and per-agent primary', () => {
  const now = 10_000_000
  const cooldownMs = DEFAULT_SWITCH_COOLDOWN_MS

  it('suppresses a second downgrade inside the cooldown (the 60s cascade)', () => {
    expect(decideModelAction({
      limitDetected: true, currentModel: SONNET, chain: CHAIN, downgradedAt: now - 60_000,
      now, revertAfterMs: 1e9, lastSwitchAt: now - 60_000, cooldownMs,
    })).toEqual({ kind: 'none' })
  })

  it('allows the downgrade again once the cooldown has passed', () => {
    expect(decideModelAction({
      limitDetected: true, currentModel: SONNET, chain: CHAIN, downgradedAt: now - cooldownMs,
      now, revertAfterMs: 1e9, lastSwitchAt: now - cooldownMs, cooldownMs,
    })).toEqual({ kind: 'downgrade', model: HAIKU })
  })

  it('no cooldown configured -> behaves as before', () => {
    expect(decideModelAction({
      limitDetected: true, currentModel: SONNET, chain: CHAIN, downgradedAt: now - 1,
      now, revertAfterMs: 1e9, lastSwitchAt: now - 1,
    })).toEqual({ kind: 'downgrade', model: HAIKU })
  })

  it('the cooldown never blocks a revert', () => {
    expect(decideModelAction({
      limitDetected: false, currentModel: SONNET, chain: CHAIN, downgradedAt: now - 60_000,
      now, revertAfterMs: 60_000, lastSwitchAt: now - 60_000, cooldownMs,
    })).toEqual({ kind: 'revert', model: PRIMARY })
  })

  it('revert goes to the agent own primary when the ladder starts there', () => {
    const ladder = ladderFromPrimary('claude-opus-5-5', CHAIN)
    expect(decideModelAction({
      limitDetected: false, currentModel: SONNET, chain: ladder, downgradedAt: now - 60_000,
      now, revertAfterMs: 60_000,
    })).toEqual({ kind: 'revert', model: 'claude-opus-5-5' })
  })
})

describe('nextFallbackModel', () => {
  it('walks one step down the chain', () => {
    expect(nextFallbackModel(PRIMARY, CHAIN)).toBe(SONNET)
    expect(nextFallbackModel(SONNET, CHAIN)).toBe(HAIKU)
  })
  it('returns null at the bottom', () => {
    expect(nextFallbackModel(HAIKU, CHAIN)).toBeNull()
  })
  it('treats an unknown current model as the primary', () => {
    expect(nextFallbackModel('some-unknown-model', CHAIN)).toBe(SONNET)
  })
  it('returns null for a degenerate chain', () => {
    expect(nextFallbackModel(PRIMARY, [PRIMARY])).toBeNull()
    expect(nextFallbackModel(PRIMARY, [])).toBeNull()
  })
})

describe('decideModelAction', () => {
  const base = { chain: CHAIN, now: 1_000_000, revertAfterMs: 60_000 }

  it('downgrades when a limit is detected and a lower model exists', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: PRIMARY, downgradedAt: null }))
      .toEqual({ kind: 'downgrade', model: SONNET })
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: SONNET, downgradedAt: 500_000 }))
      .toEqual({ kind: 'downgrade', model: HAIKU })
  })

  it('does nothing when limited at the bottom of the chain', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: HAIKU, downgradedAt: 500_000 }))
      .toEqual({ kind: 'none' })
  })

  it('reverts to the primary after the window once limit-free', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: HAIKU, downgradedAt: 1_000_000 - 60_000 }))
      .toEqual({ kind: 'revert', model: PRIMARY })
  })

  it('does not revert before the window elapses', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: SONNET, downgradedAt: 1_000_000 - 59_999 }))
      .toEqual({ kind: 'none' })
  })

  it('does nothing when on the primary and limit-free', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: PRIMARY, downgradedAt: null }))
      .toEqual({ kind: 'none' })
  })

  it('does not re-revert when already back on the primary', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: PRIMARY, downgradedAt: 0 }))
      .toEqual({ kind: 'none' })
  })
})

describe('detectsModelUnavailable', () => {
  it('matches the "model unavailable" banner phrases', () => {
    expect(detectsModelUnavailable("There's an issue with the selected model")).toBe(true)
    expect(detectsModelUnavailable("There’s an issue with the selected model")).toBe(true)
    expect(detectsModelUnavailable('Run /model to pick a different model')).toBe(true)
  })

  it('matches only in the live region (bottom 15 lines)', () => {
    const banner = "There's an issue with the selected model"
    const scrollback = [banner, ...Array(40).fill('normal output')].join('\n')
    expect(detectsModelUnavailable(scrollback)).toBe(false)
    const live = [...Array(40).fill('normal output'), banner].join('\n')
    expect(detectsModelUnavailable(live)).toBe(true)
  })

  it('returns false for empty / whitespace panes', () => {
    expect(detectsModelUnavailable('')).toBe(false)
    expect(detectsModelUnavailable('   \n  ')).toBe(false)
  })

  it('does NOT match usage-limit or generic API errors', () => {
    expect(detectsModelUnavailable('You hit your session limit · resets 5:50pm')).toBe(false)
    expect(detectsModelUnavailable('API Error: 429 rate_limit_error')).toBe(false)
  })
})

describe('detectsModelUnavailable: box-interior exclusion', () => {
  const BOX = '─'.repeat(80)
  // Phrase fragments assembled at runtime so this source file does not contain
  // the literal detector string (which would trip the live pane detector if the
  // agent reads this file while its pane is being captured).
  const PHRASE_A = ["There", "s an issue with the selected model"].join("'")
  const PHRASE_B = 'Run /model to pick a different model'

  it('(1) no input box present -- phrase in the last line fires (headless fallback)', () => {
    const pane = [...Array(5).fill('normal output'), PHRASE_A].join('\n')
    expect(detectsModelUnavailable(pane)).toBe(true)
  })

  it('(2) no input box present -- phrase 40+ lines above the tail does NOT fire', () => {
    const pane = [PHRASE_A, ...Array(40).fill('normal output')].join('\n')
    expect(detectsModelUnavailable(pane)).toBe(false)
  })

  it('(3) phrase is inside the box interior (middle of user input area) -- does NOT fire', () => {
    const pane = [
      '  ~290k uncached',
      BOX,
      '> quoted message: ' + PHRASE_A,
      '> second line of quoted message',
      BOX,
      '  hint: bypass permissions',
    ].join('\n')
    expect(detectsModelUnavailable(pane)).toBe(false)
  })

  it('(4) phrase is in transcript 2+ lines above the upper border -- does NOT fire', () => {
    const pane = [
      PHRASE_A,
      '  normal transcript line',
      '  ~290k uncached',
      BOX,
      '> ',
      BOX,
      '  hint: bypass permissions',
    ].join('\n')
    expect(detectsModelUnavailable(pane)).toBe(false)
  })

  it('(5) phrase is the status line directly above the upper border -- fires', () => {
    const pane = [
      '  normal transcript line',
      PHRASE_A,
      BOX,
      '> ',
      BOX,
      '  hint: bypass permissions',
    ].join('\n')
    expect(detectsModelUnavailable(pane)).toBe(true)
  })

  it('(6) phrase is inside box interior (quoted inter-agent message) -- does NOT fire', () => {
    const pane = [
      '  status: ok',
      BOX,
      '  [Inter-agent]: ' + PHRASE_B,
      BOX,
      '  hint: ← for agents',
    ].join('\n')
    expect(detectsModelUnavailable(pane)).toBe(false)
  })

  it('(7) phrase is below the lower border (hint / error line) -- fires', () => {
    const pane = [
      '  status: ok',
      BOX,
      '> ',
      BOX,
      PHRASE_A,
    ].join('\n')
    expect(detectsModelUnavailable(pane)).toBe(true)
  })
})

describe('DEFAULT_MODEL_CHAIN sanity', () => {
  const RETIRED_MODELS = ['claude-opus-4-8[1m]', 'claude-opus-4.8', 'claude-opus-4-8']

  it('chain contains no known-retired model IDs', () => {
    for (const model of DEFAULT_MODEL_CHAIN) {
      expect(RETIRED_MODELS).not.toContain(model)
    }
  })

  it('chain[0] (primary / revert target) is not a retired model', () => {
    expect(RETIRED_MODELS).not.toContain(DEFAULT_MODEL_CHAIN[0])
  })
})

describe('normalizeModelFallbackConfig', () => {
  it('defaults on junk input', () => {
    expect(normalizeModelFallbackConfig(null)).toEqual(DEFAULT_MODEL_FALLBACK)
    expect(normalizeModelFallbackConfig('nope')).toEqual(DEFAULT_MODEL_FALLBACK)
    expect(normalizeModelFallbackConfig({})).toEqual(DEFAULT_MODEL_FALLBACK)
  })

  it('honors a valid override', () => {
    const cfg = normalizeModelFallbackConfig({ enabled: true, chain: ['a', 'b', 'c'], revertAfterMinutes: 120 })
    expect(cfg).toEqual({ enabled: true, chain: ['a', 'b', 'c'], revertAfterMinutes: 120 })
  })

  it('rejects a too-short chain and non-string entries', () => {
    expect(normalizeModelFallbackConfig({ chain: ['only-one'] }).chain).toEqual(DEFAULT_MODEL_FALLBACK.chain)
    expect(normalizeModelFallbackConfig({ chain: ['a', 2, '', 'b'] }).chain).toEqual(['a', 'b'])
  })

  it('rejects a non-positive revert window', () => {
    expect(normalizeModelFallbackConfig({ revertAfterMinutes: 0 }).revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
    expect(normalizeModelFallbackConfig({ revertAfterMinutes: -5 }).revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
  })
})
