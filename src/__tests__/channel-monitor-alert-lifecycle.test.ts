import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  stepStuckRestartLadder,
  createStuckLadder,
  mainInputBoxProvenEmpty,
  decideStuckInputRestart,
  carryOutageAcrossRecreate,
  decideMarveenRecoveryReport,
  hardRestartStageAlertText,
  type StuckRestartLadder,
  type StuckRestartObservation,
} from '../web/channel-monitor.js'
import { detectsUsageLimit } from '../model-fallback.js'
import { idleConsideringDimGhost } from '../pane-state.js'

// Alert lifecycle of the main-channel recovery paths: every alert that opens
// must be able to close, a counter resets only on evidence, and a message
// reports what happened rather than what was about to be tried.

const __dirname = dirname(fileURLToPath(import.meta.url))

// The source with every whole-line comment dropped, so a commented-out
// statement cannot satisfy a pin. (The TypeScript compiler API is not
// available to the test runner: typescript 7 ships no JS API.)
const raw = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
const code = raw
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
  .join('\n')

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1
}

// Body of one top-level function declaration in the comment-free view.
function fnBody(name: string): string {
  const start = code.search(new RegExp('(?:async )?function ' + name + '\\('))
  expect(start, name + ' not found').toBeGreaterThanOrEqual(0)
  const end = code.indexOf('\n}\n', start)
  expect(end, name + ' closing brace not found').toBeGreaterThan(start)
  return code.slice(start, end)
}

const T0 = 10_000_000
const ladder = (over: Partial<StuckRestartLadder> = {}): StuckRestartLadder => ({
  count: 0, alertOpen: false, claudePid: 100, pidSeenAt: T0, ...over,
})
const obs = (over: Partial<StuckRestartObservation> = {}): StuckRestartObservation => ({
  parked: true, boxProvenEmpty: false, claudePid: 100, now: T0 + 60_000, lastSelfRespawnAt: 0, ...over,
})

describe('stepStuckRestartLadder: reset only on evidence (busy / unreadable keep the cap)', () => {
  it('a readable idle pane with an empty box resets the count', () => {
    const s = stepStuckRestartLadder(ladder({ count: 2 }), obs({ parked: false, boxProvenEmpty: true }))
    expect(s.next.count).toBe(0)
  })

  it('a busy tick (not parked, box not proven empty) leaves the count alone', () => {
    const s = stepStuckRestartLadder(ladder({ count: 2 }), obs({ parked: false, boxProvenEmpty: false }))
    expect(s.next.count).toBe(2)
  })

  it('an unreadable tick (capture and pid both null) changes nothing', () => {
    const prev = ladder({ count: 3, alertOpen: true })
    const s = stepStuckRestartLadder(prev, obs({ parked: false, boxProvenEmpty: false, claudePid: null }))
    expect(s.next).toEqual(prev)
    expect(s.sendResolved).toBe(false)
  })

  it('a still-parked tick never resets, even if boxProvenEmpty were set', () => {
    const s = stepStuckRestartLadder(ladder({ count: 1 }), obs({ parked: true, boxProvenEmpty: true }))
    expect(s.next.count).toBe(1)
  })

  it('regression: a busy tick right after the cap does not re-arm the ladder', () => {
    // Cap reached and alerted (count ticked past the cap). On the unfixed code
    // the busy tick reset the count to 0 and the ladder restarted.
    const capped = ladder({ count: 4, alertOpen: true })
    const s = stepStuckRestartLadder(capped, obs({ parked: false, boxProvenEmpty: false }))
    expect(decideStuckInputRestart(true, 4, 4, T0 + 10 * 60_000, 0, s.next.count, 5 * 60_000, 3)).toBe('skip')
  })
})

const SEP = '─'.repeat(80)
const FOOTER = ['  Opus 5 · ctx 406k/1.0M · 41%', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents']
const IDLE_PANE = ['  ⎿  … tool output …', '', SEP, '❯ ', SEP, ...FOOTER].join('\n')
const TYPING_PANE = ['  ⎿  … tool output …', '', SEP, '❯ a draft somebody typed', SEP, ...FOOTER].join('\n')
const BUSY_PANE = ['  ⎿  … tool output …', '', '✳ Forming… (52s · ↓ 6.1k tokens)', '', SEP, '❯ ', SEP, ...FOOTER].join('\n')

describe('mainInputBoxProvenEmpty', () => {
  it('a readable idle pane with an empty box is evidence', () => {
    expect(mainInputBoxProvenEmpty(IDLE_PANE, null)).toBe(true)
  })

  it('an unreadable capture is no evidence', () => {
    expect(mainInputBoxProvenEmpty(null, null)).toBe(false)
    expect(mainInputBoxProvenEmpty(null, IDLE_PANE)).toBe(false)
  })

  it('a busy pane is no evidence', () => {
    expect(mainInputBoxProvenEmpty(BUSY_PANE, null)).toBe(false)
    expect(mainInputBoxProvenEmpty(BUSY_PANE, IDLE_PANE)).toBe(false)
  })

  it('real typed text is no evidence', () => {
    expect(mainInputBoxProvenEmpty(TYPING_PANE, TYPING_PANE)).toBe(false)
    expect(mainInputBoxProvenEmpty(TYPING_PANE, null)).toBe(false)
  })

  it('a dim placeholder in an empty box counts as empty (dim-stripped view is idle)', () => {
    expect(mainInputBoxProvenEmpty(TYPING_PANE, IDLE_PANE)).toBe(true)
  })

  it('a blank capture (unknown state) is no evidence', () => {
    expect(mainInputBoxProvenEmpty('', null)).toBe(false)
  })
})

// A plan usage-limit wall: the prompt under the banner is idle with an empty
// box, so the readiness rule alone calls it ready. It must not reset the ladder
// or close the alert.
const WALL_PANE = [SEP, '❯ ', SEP, '  ⚠ You hit your session limit · resets 5:50pm', ...FOOTER].join('\n')

describe('mainInputBoxProvenEmpty: a usage-limit wall is no evidence', () => {
  // A capped ladder with the cap alert open, driven by one tick on `pane`.
  const tickOnPane = (pane: string) => {
    const l = createStuckLadder()
    for (let i = 0; i < 3; i++) l.noteRestart()
    l.noteCapAlert()
    const step = l.observe(obs({ parked: false, boxProvenEmpty: mainInputBoxProvenEmpty(pane, null) }))
    return { l, step }
  }

  it('precondition: the wall pane reads idle and the detector sees the wall', () => {
    expect(idleConsideringDimGhost(WALL_PANE, null)).toBe(true)
    expect(detectsUsageLimit(WALL_PANE)).toBe(true)
  })

  it('the wall capture is not evidence', () => {
    expect(mainInputBoxProvenEmpty(WALL_PANE, null)).toBe(false)
  })

  it('a dim-stripped idle view does not turn a wall into evidence', () => {
    expect(mainInputBoxProvenEmpty(WALL_PANE, IDLE_PANE)).toBe(false)
  })

  it('a tick on the wall keeps the count and the open cap alert', () => {
    const { l, step } = tickOnPane(WALL_PANE)
    expect(step.sendResolved).toBe(false)
    expect(step.next.alertOpen).toBe(true)
    expect(l.count()).toBe(4)
    expect(decideStuckInputRestart(true, 4, 4, T0 + 10 * 60_000, 0, l.count(), 5 * 60_000, 3)).toBe('skip')
  })

  it('positive control: a normal idle pane still resets the count and closes the alert', () => {
    const { l, step } = tickOnPane(IDLE_PANE)
    expect(step.sendResolved).toBe(true)
    expect(step.next.alertOpen).toBe(false)
    expect(l.count()).toBe(0)
  })

  it('the wall lifted (banner gone, same prompt) is evidence again', () => {
    const lifted = WALL_PANE.split('\n').filter((line) => !line.includes('session limit')).join('\n')
    expect(detectsUsageLimit(lifted)).toBe(false)
    expect(mainInputBoxProvenEmpty(lifted, null)).toBe(true)
  })

  it('limit words in scrollback far above the box do not block evidence', () => {
    const scrollback = ['● You hit your session limit · resets 5:50pm', ...Array(12).fill(''), SEP, '❯ ', SEP, ...FOOTER].join('\n')
    expect(detectsUsageLimit(scrollback)).toBe(false)
    expect(mainInputBoxProvenEmpty(scrollback, null)).toBe(true)
  })
})

describe('stepStuckRestartLadder: closing the cap alert', () => {
  it('an open alert is closed once the box is proven empty', () => {
    const s = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }), obs({ parked: false, boxProvenEmpty: true }))
    expect(s.sendResolved).toBe(true)
    expect(s.next.alertOpen).toBe(false)
  })

  it('the closing message goes out only once', () => {
    const first = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }), obs({ parked: false, boxProvenEmpty: true }))
    const second = stepStuckRestartLadder(first.next, obs({ parked: false, boxProvenEmpty: true, now: T0 + 120_000 }))
    expect(second.sendResolved).toBe(false)
  })

  it('no closing message when no alert was open', () => {
    const s = stepStuckRestartLadder(ladder({ count: 1 }), obs({ parked: false, boxProvenEmpty: true }))
    expect(s.sendResolved).toBe(false)
  })

  it('a busy tick does not close an open alert', () => {
    const s = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }), obs({ parked: false, boxProvenEmpty: false }))
    expect(s.sendResolved).toBe(false)
    expect(s.next.alertOpen).toBe(true)
  })
})

describe('stepStuckRestartLadder: manual claude replacement gets a fresh ladder', () => {
  it('a new pid with no monitor respawn since the old pid was seen resets the count', () => {
    const s = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }), obs({ claudePid: 200, lastSelfRespawnAt: T0 - 1 }))
    expect(s.manualReplacement).toBe(true)
    expect(s.next.count).toBe(0)
    expect(s.next.claudePid).toBe(200)
    // A fresh ladder may restart again once the rate limit allows it.
    expect(decideStuckInputRestart(true, 4, 4, T0 + 10 * 60_000, 0, s.next.count, 5 * 60_000, 3)).toBe('restart')
  })

  it('the alert stays open across a manual replacement until the box is proven empty', () => {
    const s = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }), obs({ claudePid: 200 }))
    expect(s.next.alertOpen).toBe(true)
    expect(s.sendResolved).toBe(false)
  })

  it('a new pid produced by the monitor itself keeps the cap', () => {
    const s = stepStuckRestartLadder(ladder({ count: 3 }), obs({ claudePid: 200, lastSelfRespawnAt: T0 + 30_000 }))
    expect(s.manualReplacement).toBe(false)
    expect(s.next.count).toBe(3)
    expect(s.next.claudePid).toBe(200)
  })

  it('a --continue resume the monitor has only started (stamp not yet written) keeps the cap', () => {
    // The monitor marks a resume right before its respawn-pane; the shared
    // stamp follows seconds later. A tick in between sees the new pid with
    // only the mark moved, and the swap is still ours.
    const s = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }),
      obs({ parked: false, claudePid: 200, lastSelfRespawnAt: T0 + 10_000 }))
    expect(s.manualReplacement).toBe(false)
    expect(s.next.count).toBe(4)
    expect(decideStuckInputRestart(true, 4, 4, T0 + 10 * 60_000, 0, s.next.count, 5 * 60_000, 3)).toBe('skip')
  })

  it('the first readable pid is only recorded, never treated as a replacement', () => {
    const s = stepStuckRestartLadder(ladder({ count: 2, claudePid: null, pidSeenAt: 0 }), obs({ claudePid: 300 }))
    expect(s.manualReplacement).toBe(false)
    expect(s.next.count).toBe(2)
    expect(s.next.claudePid).toBe(300)
    expect(s.next.pidSeenAt).toBe(T0 + 60_000)
  })

  it('an unreadable pid keeps the last known one, so a later swap is still detected', () => {
    const blind = stepStuckRestartLadder(ladder({ count: 4 }), obs({ claudePid: null }))
    expect(blind.next.claudePid).toBe(100)
    expect(blind.next.pidSeenAt).toBe(T0)
    const swapped = stepStuckRestartLadder(blind.next, obs({ claudePid: 200, now: T0 + 120_000 }))
    expect(swapped.manualReplacement).toBe(true)
    expect(swapped.next.count).toBe(0)
  })

  it('the step result carries no fragment-record verdict', () => {
    const s = stepStuckRestartLadder(ladder({ count: 1 }), obs({ parked: true, claudePid: 200 }))
    expect(Object.keys(s).sort()).toEqual(['manualReplacement', 'next', 'sendResolved'])
  })

  it('a same-pid tick refreshes pidSeenAt, so a self-respawn that changed nothing is not "own" forever', () => {
    // A --continue resume whose respawn threw: the mark moved, the pid did not.
    const markOnly = T0 + 5_000
    const same = stepStuckRestartLadder(ladder({ count: 4, alertOpen: true }), obs({ claudePid: 100, lastSelfRespawnAt: markOnly }))
    expect(same.manualReplacement).toBe(false)
    expect(same.next.pidSeenAt).toBe(T0 + 60_000)
    // A later swap with no newer self-respawn is a manual one.
    const swapped = stepStuckRestartLadder(same.next, obs({ claudePid: 200, now: T0 + 120_000, lastSelfRespawnAt: markOnly }))
    expect(swapped.manualReplacement).toBe(true)
    expect(swapped.next.count).toBe(0)
  })

  it('the same pid is no replacement', () => {
    const s = stepStuckRestartLadder(ladder({ count: 4 }), obs())
    expect(s.manualReplacement).toBe(false)
    expect(s.next.count).toBe(4)
  })
})

describe('createStuckLadder: the only way to change the ladder state', () => {
  const idle = (now: number, over: Partial<StuckRestartObservation> = {}): StuckRestartObservation =>
    obs({ parked: false, boxProvenEmpty: true, now, ...over })
  const busy = (now: number, over: Partial<StuckRestartObservation> = {}): StuckRestartObservation =>
    obs({ parked: false, boxProvenEmpty: false, now, ...over })

  it('exposes only its transitions, no writable state', () => {
    expect(Object.keys(createStuckLadder()).sort()).toEqual(['count', 'noteCapAlert', 'noteRestart', 'observe'])
  })

  it('starts empty: count 0 and no open alert, so the first idle tick sends nothing', () => {
    const l = createStuckLadder()
    expect(l.count()).toBe(0)
    const s = l.observe(idle(T0))
    expect(s.sendResolved).toBe(false)
    expect(s.prev).toEqual({ count: 0, alertOpen: false, claudePid: null, pidSeenAt: 0 })
  })

  it('a successful restart counts, a busy tick keeps it, proven-empty evidence resets it', () => {
    const l = createStuckLadder()
    l.noteRestart()
    l.noteRestart()
    expect(l.count()).toBe(2)
    l.observe(busy(T0))
    expect(l.count()).toBe(2)
    l.observe(idle(T0 + 60_000))
    expect(l.count()).toBe(0)
  })

  it('the cap alert ticks past the cap, stays open through busy ticks and closes once on evidence', () => {
    const l = createStuckLadder()
    for (let i = 0; i < 3; i++) l.noteRestart()
    l.noteCapAlert()
    expect(l.count()).toBe(4)
    expect(l.observe(busy(T0)).sendResolved).toBe(false)
    expect(l.count()).toBe(4)
    expect(l.observe(idle(T0 + 60_000)).sendResolved).toBe(true)
    expect(l.observe(idle(T0 + 120_000)).sendResolved).toBe(false)
  })

  it('a restart after a manual re-arm keeps the open alert until the box is proven empty', () => {
    const l = createStuckLadder()
    l.observe(busy(T0, { claudePid: 100 }))
    for (let i = 0; i < 3; i++) l.noteRestart()
    l.noteCapAlert()
    // Replaced by hand: a fresh ladder, but the alert stays open.
    l.observe(busy(T0 + 60_000, { claudePid: 200, lastSelfRespawnAt: 0 }))
    expect(l.count()).toBe(0)
    l.noteRestart()
    expect(l.count()).toBe(1)
    expect(l.observe(idle(T0 + 120_000, { claudePid: 300, lastSelfRespawnAt: T0 + 90_000 })).sendResolved).toBe(true)
  })

  it('cap, manual replacement on a non-idle tick, then an idle tick closes the alert at count 0', () => {
    // The operator restarts by hand, as the cap alert asks: the booting pane is
    // not idle yet, so the count drops to 0 with the alert still open, and the
    // first idle empty-box tick must still send the closing message.
    const l = createStuckLadder()
    l.observe(obs({ parked: true, claudePid: 100, now: T0 }))
    for (let i = 0; i < 3; i++) l.noteRestart()
    l.noteCapAlert()
    const swap = l.observe(busy(T0 + 60_000, { claudePid: 200, lastSelfRespawnAt: 0 }))
    expect(swap.manualReplacement).toBe(true)
    expect(l.count()).toBe(0)
    expect(swap.sendResolved).toBe(false)
    expect(l.observe(idle(T0 + 120_000, { claudePid: 200, lastSelfRespawnAt: 0 })).sendResolved).toBe(true)
  })

  // The cap is reached; the monitor's mark is from its last own restart, before
  // the pid was last seen. Then the main claude is replaced.
  const capped = (): ReturnType<typeof createStuckLadder> => {
    const l = createStuckLadder()
    for (let i = 0; i < 3; i++) l.noteRestart()
    l.noteCapAlert()
    l.observe(obs({ parked: true, claudePid: 100, now: T0, lastSelfRespawnAt: T0 - 300_000 }))
    return l
  }

  it('a restart from a dashboard route after the cap gives a fresh ladder (the mark did not move)', () => {
    const l = capped()
    const s = l.observe(busy(T0 + 60_000, { claudePid: 200, lastSelfRespawnAt: T0 - 300_000 }))
    expect(s.manualReplacement).toBe(true)
    expect(l.count()).toBe(0)
    expect(decideStuckInputRestart(true, 4, 4, T0 + 10 * 60_000, 0, l.count(), 5 * 60_000, 3)).toBe('restart')
  })

  it("the monitor's own restart after the cap keeps the cap (the mark moved)", () => {
    const l = capped()
    const s = l.observe(busy(T0 + 60_000, { claudePid: 200, lastSelfRespawnAt: T0 + 30_000 }))
    expect(s.manualReplacement).toBe(false)
    expect(l.count()).toBe(4)
    expect(decideStuckInputRestart(true, 4, 4, T0 + 10 * 60_000, 0, l.count(), 5 * 60_000, 3)).toBe('skip')
  })

  it('observe reports the state before the tick and keeps the step result', () => {
    const l = createStuckLadder()
    l.observe(busy(T0, { claudePid: 100 }))
    l.noteRestart()
    const s = l.observe(busy(T0 + 60_000, { claudePid: 200, lastSelfRespawnAt: 0 }))
    expect(s.manualReplacement).toBe(true)
    expect(s.prev).toEqual({ count: 1, alertOpen: false, claudePid: 100, pidSeenAt: T0 })
    expect(l.count()).toBe(0)
    expect(l.observe(busy(T0 + 120_000, { claudePid: 200 })).prev.claudePid).toBe(200)
  })

  it('two ladders do not share state', () => {
    const a = createStuckLadder()
    const b = createStuckLadder()
    a.noteCapAlert()
    expect(b.count()).toBe(0)
    expect(b.observe(idle(T0)).sendResolved).toBe(false)
  })
})

// The call sites cannot be unit-tested without a tmux, so they are pinned on
// the comment-free, literal-free view of the source: the ladder is the only
// place the restart count lives, and every monitor-initiated respawn marks
// itself so the ladder can tell a manual replacement apart.
describe('wiring of the lifecycle helpers (source pins)', () => {
  it('the restart count lives only in the ladder closure', () => {
    expect(code).not.toContain('stuckRestartCount')
    expect(count(code, 'const stuckLadder = createStuckLadder()')).toBe(1)
  })

  it('maybeRestartWedgedMainChannel ticks the ladder with the evidence rule before deciding', () => {
    const body = fnBody('maybeRestartWedgedMainChannel')
    expect(count(body, 'stuckLadder.observe(')).toBe(1)
    expect(body).toContain('boxProvenEmpty: mainInputBoxProvenEmpty(plain, dimStripped)')
    // The dim-stripped view is read only when the plain capture reads 'typing'.
    expect(body).toContain("const dimStripped = plain != null && detectPaneState(plain) === 'typing' ? captureParkedInputView(MAIN_CHANNELS_SESSION) : null")
    expect(body).toContain('lastSelfRespawnAt: monitorMainRespawnAt')
    expect(body.indexOf('stuckLadder.observe(')).toBeLessThan(body.indexOf('decideStuckInputRestart('))
    // The closing message follows the step, and the early return for a cleared box comes after both.
    expect(body.indexOf('step.sendResolved')).toBeGreaterThan(body.indexOf('stuckLadder.observe('))
    expect(body.indexOf('if (!parked) return')).toBeGreaterThan(body.indexOf('step.sendResolved'))
    expect(body).toContain('stuckLadder.count()')
    expect(count(body, 'stuckLadder.noteCapAlert()')).toBe(1)
    expect(count(body, 'stuckLadder.noteRestart()')).toBe(1)
  })

  it('a non-parked tick whose capture failed skips the pid read', () => {
    const body = fnBody('maybeRestartWedgedMainChannel')
    expect(body).toContain('claudePid: parked || plain != null ? getClaudePidForSession(MAIN_CHANNELS_SESSION) : null')
  })

  it('the ladder restart marks its own respawn right after the call', () => {
    const body = fnBody('maybeRestartWedgedMainChannel')
    expect(body.indexOf('hardRestartMarveenChannels()')).toBeLessThan(body.indexOf('monitorMainRespawnAt = lastStuckRestartAt'))
  })

  it('every monitor-initiated respawn marks monitorMainRespawnAt (resume, stage 4, keep-alive, recreate)', () => {
    // 1 declaration + 5 marks: resume, ladder restart, stage 4, keep-alive, recreate.
    expect(count(code, 'monitorMainRespawnAt = ')).toBe(6)
    expect(fnBody('resumeMarveenSession')).toContain('if (opts.byMonitor) monitorMainRespawnAt = Date.now()')
    expect(fnBody('handleMarveenDown')).toContain('await resumeMarveenSession({ byMonitor: true })')
    expect(fnBody('checkMainKeepaliveStaleness')).toContain('monitorMainRespawnAt = Date.now()')
  })

  it('the resume marks BEFORE its respawn-pane (the shared stamp is written seconds later)', () => {
    const body = fnBody('resumeMarveenSession')
    expect(body.indexOf('if (opts.byMonitor) monitorMainRespawnAt = Date.now()')).toBeLessThan(body.indexOf("'respawn-pane'"))
  })

  it('other callers of the resume do not mark (a restart from them is a replacement)', () => {
    const watcher = readFileSync(join(__dirname, '..', 'web', 'stuck-tool-call-watcher.ts'), 'utf-8')
    expect(watcher).toContain('await resumeMarveenSession()')
    expect(watcher).not.toContain('byMonitor')
  })

  it('stage 4 reports the result AFTER the hard restart returned', () => {
    const body = fnBody('handleMarveenDown')
    const call = body.indexOf('const r = hardRestartMarveenChannels()')
    expect(call).toBeGreaterThan(0)
    expect(body.indexOf('hardRestartStageAlertText(')).toBeGreaterThan(call)
    expect(body).not.toContain('Session resume nem segitett. Hard restart')
    expect(count(body, 'hardRestartMarveenChannels()')).toBe(1)
  })

  it('the recreate carries the open outage over BEFORE it forgets the cascade state', () => {
    const start = code.indexOf('createMainChannelsSession() ===')
    expect(start).toBeGreaterThan(0)
    const tail = code.slice(start, start + 600)
    expect(tail.indexOf('marveenRecreatedOutage = carryOutageAcrossRecreate(marveenDownState, marveenRecreatedOutage)')).toBeGreaterThan(0)
    expect(tail.indexOf('carryOutageAcrossRecreate(')).toBeLessThan(tail.indexOf('marveenDownState = null'))
  })

  it('the closing message comes from the report rule and clears both pieces of state', () => {
    const body = fnBody('handleMarveenUp')
    expect(body).toContain('decideMarveenRecoveryReport(marveenDownState, marveenRecreatedOutage, Date.now())')
    expect(body).toContain('if (report.notify)')
    expect(body).toContain('marveenDownState = null')
    expect(body).toContain('marveenRecreatedOutage = null')
  })
})

describe('carryOutageAcrossRecreate', () => {
  it('nothing open and nothing carried stays null', () => {
    expect(carryOutageAcrossRecreate(null, null)).toBeNull()
  })

  it('an open state is carried with its start and stage', () => {
    expect(carryOutageAcrossRecreate({ downSince: T0, stage: 'gave_up' }, null)).toEqual({ downSince: T0, stage: 'gave_up' })
  })

  it('a second recreate keeps the earliest start', () => {
    const carried = { downSince: T0, stage: 'resume' as const }
    expect(carryOutageAcrossRecreate({ downSince: T0 + 500_000, stage: 'soft' }, carried)).toEqual({ downSince: T0, stage: 'soft' })
  })

  it('a recreate with no open state keeps what was already carried', () => {
    const carried = { downSince: T0, stage: 'hard' as const }
    expect(carryOutageAcrossRecreate(null, carried)).toBe(carried)
  })
})

describe('decideMarveenRecoveryReport', () => {
  it('nothing open -> no report', () => {
    expect(decideMarveenRecoveryReport(null, null, T0)).toBeNull()
  })

  it('regression: an outage carried across a recreate is reported with its full duration', () => {
    const r = decideMarveenRecoveryReport(null, { downSince: T0, stage: 'gave_up' }, T0 + 900_000)
    expect(r).toEqual({ downedForSec: 900, stage: 'recreated', notify: true })
  })

  it('a carried outage plus a fresh cascade state counts from the earliest start', () => {
    const r = decideMarveenRecoveryReport({ downSince: T0 + 600_000, stage: 'soft' }, { downSince: T0, stage: 'resume' }, T0 + 660_000)
    expect(r?.downedForSec).toBe(660)
    expect(r?.stage).toBe('recreated')
    expect(r?.notify).toBe(true)
  })

  it('a disruptive fresh stage after the recreate is named as such', () => {
    const r = decideMarveenRecoveryReport({ downSince: T0 + 600_000, stage: 'hard' }, { downSince: T0, stage: 'soft' }, T0 + 700_000)
    expect(r?.stage).toBe('hard')
  })

  it('without a recreate the existing rule holds: short soft blips stay quiet', () => {
    expect(decideMarveenRecoveryReport({ downSince: T0, stage: 'soft' }, null, T0 + 60_000)?.notify).toBe(false)
    expect(decideMarveenRecoveryReport({ downSince: T0, stage: 'save' }, null, T0 + 60_000)?.notify).toBe(false)
    expect(decideMarveenRecoveryReport({ downSince: T0, stage: 'save' }, null, T0 + 180_000)?.notify).toBe(true)
    // A long blip is reported under its own stage, not as a recreate.
    expect(decideMarveenRecoveryReport({ downSince: T0, stage: 'soft' }, null, T0 + 600_000))
      .toEqual({ downedForSec: 600, stage: 'soft', notify: true })
    expect(decideMarveenRecoveryReport({ downSince: T0, stage: 'resume' }, null, T0 + 10_000)?.notify).toBe(true)
  })

  it('regression: a recreate-closed outage under 180s is still reported', () => {
    // A recreate needs only ~120s of confirmed suspicion, so this is reachable.
    expect(decideMarveenRecoveryReport(null, { downSince: T0, stage: 'soft' }, T0 + 30_000))
      .toEqual({ downedForSec: 30, stage: 'recreated', notify: true })
    expect(decideMarveenRecoveryReport({ downSince: T0 + 10_000, stage: 'soft' }, { downSince: T0, stage: 'soft' }, T0 + 40_000)?.notify).toBe(true)
  })

})

describe('stage-4 hard restart message reflects the result', () => {
  it('success says the restart was started', () => {
    const t = hardRestartStageAlertText('launchctl', 'main-session', { ok: true })
    expect(t).toContain('elinditva')
    expect(t).toContain('main-session')
    expect(t).not.toContain('nem sikerult')
  })

  it('failure carries the error', () => {
    const t = hardRestartStageAlertText('systemctl', 'main-session', { ok: false, error: 'tmux respawn-pane failed' })
    expect(t).toContain('sem sikerult')
    expect(t).toContain('tmux respawn-pane failed')
  })

  it('failure without an error text still reads as a failure', () => {
    expect(hardRestartStageAlertText('systemctl', 's', { ok: false })).toContain('ismeretlen hiba')
  })

})
