// Head-lost requeue (1267): a sub-agent's input box holds only the TAIL of an inter-agent frame the router pasted (the TUI
// dropped the leading rows). The recovery positively attributes the box to the delivery (verbatim suffix of exactly one
// fresh delivery with a ledger row), clears the box, verifies it is empty, and only then flips the ledger row
// delivered -> pending, so the router wraps the message again from the DB. This file drives the real
// recoverStuckInputForSession + the real in-memory SQLite; tmux is the only thing mocked (capture, clear, send).
//
// Privacy: neutral fixtures only (session-a, session-b, agent-a, agent-b, tenant-x, filler words).

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

const logCalls = vi.hoisted(() => ({ warn: [] as unknown[][], info: [] as unknown[][] }))
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(), error: vi.fn(),
    info: vi.fn((...a: unknown[]) => { logCalls.info.push(a) }),
    warn: vi.fn((...a: unknown[]) => { logCalls.warn.push(a) }),
  },
}))

const flip = vi.hoisted(() => ({ fail: false }))
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return {
    ...actual,
    // The real compare-and-set, unless a test makes the database throw.
    requeueDeliveredMessage: vi.fn((...a: Parameters<typeof actual.requeueDeliveredMessage>) =>
      flip.fail ? Promise.reject(new Error('db unavailable')) : actual.requeueDeliveredMessage(...a)),
  }
})

const alerts = vi.hoisted(() => ({ sent: [] as string[] }))
vi.mock('../notify.js', () => ({
  notifyChannel: vi.fn((text: string) => { alerts.sent.push(text); return Promise.resolve() }),
}))

// The fake terminal: what the capture shows, what the clear does, and what the DB said at the instant of each clear.
const term = vi.hoisted(() => ({
  pane: null as string | null,
  clearWorks: true,
  clearCalls: 0,
  onClear: null as null | (() => Promise<void>),
  sendCalls: 0,
  /** Panes handed out by the next captures, in order, before it falls back to `pane`. */
  queue: [] as Array<string | null | (() => string | null)>,
  /** After the first clear, every capture fails (null). */
  nullAfterClear: false,
}))
vi.mock('../web/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    captureParkedInputView: vi.fn(() => {
      if (term.queue.length > 0) { const next = term.queue.shift()!; return typeof next === 'function' ? next() : next }
      return term.nullAfterClear && term.clearCalls > 0 ? null : term.pane
    }),
    clearInputBuffer: vi.fn(async () => {
      term.clearCalls++
      if (term.onClear) await term.onClear()
      if (term.clearWorks) term.pane = EMPTY_PANE
    }),
    sendPromptToSession: vi.fn(() => { term.sendCalls++; return Promise.resolve() }),
  }
})

import {
  initDatabase, createAgentMessage, markMessageDelivered, markMessageDone, getAgentMessage,
} from '../db.js'
import { dbx } from '../db/facade.js'
import {
  stuckInputSignature, parkedMainInputHasRemedy, parkedMachineOriginInput, parkedInputText, type StuckInputState,
} from '../pane-state.js'
import { recordDelivery, clearDeliveries, matchDeliveryTail, _registrySize } from '../web/delivery-intent.js'
import { wrapAgentMessageForDelivery } from '../web/agent-message-wrap.js'
import { withSessionSendLock } from '../web/session-send-lock.js'
const { recoverStuckInputForSession, applyStuckRestartBusyGuard, _resetRequeueBudget } = await import('../web/channel-monitor.js')

beforeAll(() => { initDatabase(':memory:') })

const SEP = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
const EMPTY_PANE = ['', SEP, '❯ ', SEP, FOOTER].join('\n')
const REQUEUE_MSG = 'Stuck input -- head-lost inter-agent frame, cleared and requeued'
const SESSION = 'session-a'
const TO = 'agent-a'
const THRESHOLDS = { confirmMs: 0, dedupMs: 0, maxAttempts: 50 }

function boxPane(rows: string[]): string {
  const [first, ...rest] = rows
  return ['', SEP, `❯ ${first}`, ...rest.map((r) => `  ${r}`), SEP, FOOTER].join('\n')
}

/** Greedy word wrap at `width`, the way the TUI wraps the box. */
function wrap(flat: string, width = 66): string[] {
  const rows: string[] = []
  let cur = ''
  for (const w of flat.split(' ')) {
    if (cur && cur.length + 1 + w.length > width) { rows.push(cur); cur = w } else cur = cur ? `${cur} ${w}` : w
  }
  if (cur) rows.push(cur)
  return rows
}

const BODY = Array.from({ length: 80 }, (_, i) => `filler${i}`).join(' ')

interface Msg { id: number; frame: string }
/** A real ledger row, delivered, with the frame the router would have pasted (real wrapper) recorded for the session. */
async function deliver(session = SESSION, to = TO, tenant = 'default', body = BODY): Promise<Msg> {
  const m = await createAgentMessage('agent-b', to, body, null, null, tenant)
  await markMessageDelivered(m.id)
  const { prefix, wrapped } = wrapAgentMessageForDelivery('trusted-peer', 'agent-b', 'agent-b', body, m.id, null)
  const frame = prefix + wrapped
  recordDelivery(session, frame, String(m.id), { msgId: m.id, toAgent: to, tenantId: tenant })
  return { id: m.id, frame }
}

/** What the box shows when the TUI dropped the head: a word-aligned tail of the frame, wrapped into rows. */
function headLost(frame: string, keep = 330): string {
  const flat = frame.replace(/\s+/g, ' ').trim()
  const cut = flat.slice(-keep)
  const tail = cut.slice(cut.indexOf(' ') + 1)
  return boxPane(wrap(tail))
}

const state = (pane: string): StuckInputState => ({ parkedSig: stuckInputSignature(pane), firstSeenAt: 0, lastRecoverAt: null, attempts: 0 })
/** One recovery tick on an already-confirmed park (the first observation that only records the spell is skipped). */
async function tick(session = SESSION, allowPlain = true): Promise<StuckInputState> {
  return recoverStuckInputForSession(session, state(term.pane!), THRESHOLDS, allowPlain)
}

const statusOf = async (id: number) => (await getAgentMessage(id))!.status
const requeueLogs = () => logCalls.warn.filter((c) => c[1] === REQUEUE_MSG)
const auditRows = (id: number) => dbx.all<{ agent_id: string; entity: string; action: string; entity_id: string; detail: string; tenant_id: string }>(
  "SELECT agent_id, entity, action, entity_id, detail, tenant_id FROM agent_audit_log WHERE action = 'requeue' AND entity_id = ?", String(id))

beforeEach(() => {
  logCalls.warn.length = 0
  logCalls.info.length = 0
  alerts.sent.length = 0
  term.pane = null
  term.clearWorks = true
  term.clearCalls = 0
  term.onClear = null
  term.sendCalls = 0
  term.queue = []
  term.nullAfterClear = false
  flip.fail = false
  _resetRequeueBudget()
  for (const s of [SESSION, 'session-b']) clearDeliveries(s)
})

describe('the fixture is the real shape of the wedge', () => {
  it('a head-lost box has no machine marker, is multi-row, and is the unique tail of the recorded delivery', async () => {
    const m = await deliver()
    term.pane = headLost(m.frame)
    expect(parkedMachineOriginInput(term.pane)).toBe(false)
    expect(term.pane.split('\n').filter((l) => l.startsWith('  ')).length).toBeGreaterThan(1)
    expect(parkedInputText(term.pane)).not.toBeNull()
    expect(matchDeliveryTail(SESSION, parkedInputText(term.pane)!).kind).toBe('match')
  })
})

describe('the happy path', () => {
  it('clears the box, flips the ledger row back to pending, drops the record, logs and audits (id + session only)', async () => {
    const m = await deliver()
    term.pane = headLost(m.frame)
    // Order: at the instant of the clear the row is still delivered; afterwards it is pending.
    let statusAtClear = ''
    term.onClear = async () => { statusAtClear = await statusOf(m.id) }

    await tick()

    expect(term.clearCalls).toBe(1)
    expect(statusAtClear).toBe('delivered')
    expect(await statusOf(m.id)).toBe('pending')
    expect((await getAgentMessage(m.id))!.delivered_at).toBeNull()
    expect(_registrySize(SESSION)).toBe(0)
    expect(term.sendCalls).toBe(0) // the lossy scrape is never re-injected

    expect(requeueLogs()).toHaveLength(1)
    expect((requeueLogs()[0]![0] as Record<string, unknown>).msgId).toBe(m.id)

    const rows = await auditRows(m.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent_id: TO, entity: 'message', action: 'requeue', entity_id: String(m.id), tenant_id: 'default' })
    expect(JSON.parse(rows[0]!.detail)).toEqual({ session: SESSION })
    expect(alerts.sent).toHaveLength(0) // alert only on the spent budget
  })

  it('neither the log nor the audit row carries any of the message text', async () => {
    const m = await deliver()
    term.pane = headLost(m.frame)
    await tick()
    const dumped = JSON.stringify([logCalls.warn, logCalls.info, await auditRows(m.id), alerts.sent])
    expect(dumped).not.toContain('filler')
  })

  it('carries the tenant of the row: a message of another tenant is requeued under that tenant', async () => {
    // A second tenant row: the CAS carries tenant-x, which is what the delivery recorded.
    const m = await deliver(SESSION, TO, 'tenant-x')
    term.pane = headLost(m.frame)
    await tick()
    expect(await statusOf(m.id)).toBe('pending')
    expect((await auditRows(m.id))[0]!.tenant_id).toBe('tenant-x')
  })
})

describe('the race: two callers on one session', () => {
  it('two ticks racing on the same session requeue exactly once', async () => {
    const m = await deliver()
    term.pane = headLost(m.frame)
    const s = state(term.pane)
    await Promise.all([
      recoverStuckInputForSession(SESSION, s, THRESHOLDS, true),
      recoverStuckInputForSession(SESSION, s, THRESHOLDS, true),
    ])
    expect(term.clearCalls).toBe(1)
    expect(requeueLogs()).toHaveLength(1)
    expect(await auditRows(m.id)).toHaveLength(1)
    expect(await statusOf(m.id)).toBe('pending')
  })

  it('a second tick after the first, on a stale view that still shows the frame, does not requeue again', async () => {
    const m = await deliver()
    const parked = headLost(m.frame)
    term.pane = parked
    await tick()
    term.pane = parked // the screen still shows the frame (stale view)
    await tick()
    expect(requeueLogs()).toHaveLength(1)
    expect(await auditRows(m.id)).toHaveLength(1)
  })

  it('a delivery in flight holds the lane: the move is skipped fail-closed, nothing is cleared or flipped', async () => {
    const m = await deliver()
    term.pane = headLost(m.frame)
    let release!: () => void
    const held = new Promise<void>((res) => { release = res })
    const holder = withSessionSendLock(SESSION, null, 'deliver', () => held)
    await tick()
    release()
    await holder
    expect(term.clearCalls).toBe(0)
    expect(await statusOf(m.id)).toBe('delivered')
    expect(_registrySize(SESSION)).toBe(1)
    expect(logCalls.info.some((c) => String(c[1]).includes('a delivery is in flight'))).toBe(true)
  })
})

describe('the clear did not empty the box (matrix row 7)', () => {
  it('no requeue, the row stays delivered, the record stays, and the next tick retries', async () => {
    const m = await deliver()
    term.pane = headLost(m.frame)
    const parked = term.pane
    term.clearWorks = false
    await tick()
    expect(term.clearCalls).toBe(1)
    expect(await statusOf(m.id)).toBe('delivered')
    expect(_registrySize(SESSION)).toBe(1)
    expect(requeueLogs()).toHaveLength(0)
    expect(await auditRows(m.id)).toHaveLength(0)
    expect(logCalls.warn.some((c) => String(c[1]).includes('still in the box after the clear'))).toBe(true)

    term.clearWorks = true
    term.pane = parked
    await tick()
    expect(await statusOf(m.id)).toBe('pending')
  })

  it('a failed capture after the clear is treated as not empty (fail-closed)', async () => {
    const m = await deliver()
    term.pane = headLost(m.frame)
    term.nullAfterClear = true
    await tick()
    expect(term.clearCalls).toBe(1)
    expect(await statusOf(m.id)).toBe('delivered')
    expect(requeueLogs()).toHaveLength(0)
  })
})

describe('the box moved between the decision and the lock', () => {
  it('a re-check capture that shows another box clears nothing and flips nothing', async () => {
    const m = await deliver()
    const parked = headLost(m.frame)
    term.pane = parked
    const other = boxPane(['Another text that is on screen now, written after the decision was taken,', 'and which is not a tail of anything the router pasted into this session'])
    const s = state(parked)
    term.queue = [parked, other] // 1st capture: the tick's own; 2nd: the re-check under the lock
    await recoverStuckInputForSession(SESSION, s, THRESHOLDS, true)
    expect(term.clearCalls).toBe(0)
    expect(await statusOf(m.id)).toBe('delivered')
    expect(_registrySize(SESSION)).toBe(1)
    expect(logCalls.info.some((c) => String(c[1]).includes('the box changed since the decision'))).toBe(true)
  })

  it('a re-check that shows a DIFFERENT tail of the same frame (the box re-rendered) is not acted on: the signature is the decided one', async () => {
    const m = await deliver()
    const parked = headLost(m.frame, 330)
    const rerendered = headLost(m.frame, 260) // still a verbatim unique tail of the same delivery
    expect(stuckInputSignature(rerendered)).not.toBe(stuckInputSignature(parked))
    expect(matchDeliveryTail(SESSION, parkedInputText(rerendered)!).kind).toBe('match')
    term.pane = parked
    term.queue = [parked, rerendered]
    await recoverStuckInputForSession(SESSION, state(parked), THRESHOLDS, true)
    expect(term.clearCalls).toBe(0)
    expect(await statusOf(m.id)).toBe('delivered')
  })

  it('the same box, but the delivery record is gone by the re-check: not acted on (the attribution is re-proved under the lock)', async () => {
    const m = await deliver()
    const parked = headLost(m.frame)
    term.pane = parked
    term.queue = [parked, () => { clearDeliveries(SESSION); return parked }]
    await recoverStuckInputForSession(SESSION, state(parked), THRESHOLDS, true)
    expect(term.clearCalls).toBe(0)
    expect(await statusOf(m.id)).toBe('delivered')
  })

  it('the same box, but the tail now belongs to ANOTHER message id by the re-check: not acted on', async () => {
    const m = await deliver()
    const parked = headLost(m.frame)
    term.pane = parked
    // Swap the record for a twin message with another id between the decision and the re-check.
    const twin = await createAgentMessage('agent-b', TO, BODY)
    await markMessageDelivered(twin.id)
    term.queue = [parked, () => {
      clearDeliveries(SESSION)
      recordDelivery(SESSION, m.frame, String(twin.id), { msgId: twin.id, toAgent: TO, tenantId: 'default' })
      return parked
    }]
    await recoverStuckInputForSession(SESSION, state(parked), THRESHOLDS, true)
    expect(term.clearCalls).toBe(0)
    expect(await statusOf(m.id)).toBe('delivered')
    expect(await statusOf(twin.id)).toBe('delivered')
  })
})

describe('the main session', () => {
  it('a spent budget on a main-session box raises no alert: the attribution is a sub-agent feature', async () => {
    const m = await deliver(SESSION)
    term.pane = headLost(m.frame)
    await tick() // requeued once in the sub-agent session: the id is now in the budget
    // The same id, the same frame, parked in the MAIN session's box.
    recordDelivery('session-main', m.frame, String(m.id), { msgId: m.id, toAgent: TO, tenantId: 'default' })
    term.pane = headLost(m.frame)
    term.clearCalls = 0
    await tick('session-main', false)
    expect(term.clearCalls).toBe(0)
    expect(alerts.sent).toHaveLength(0)
    clearDeliveries('session-main')
  })
})

describe('the ledger flip throws after the clear', () => {
  it('is named with the message id, raises one alert, keeps the record and the row, and writes no requeue audit', async () => {
    const m = await deliver()
    term.pane = headLost(m.frame)
    flip.fail = true
    await tick()
    expect(term.clearCalls).toBe(1) // the box is already empty: this is the case that used to vanish silently
    expect(await statusOf(m.id)).toBe('delivered')
    expect(_registrySize(SESSION)).toBe(1)
    expect(requeueLogs()).toHaveLength(0)
    expect(await auditRows(m.id)).toHaveLength(0)
    const failed = logCalls.warn.filter((c) => String(c[1]).includes('cleared but the requeue failed'))
    expect(failed).toHaveLength(1)
    expect((failed[0]![0] as Record<string, unknown>).msgId).toBe(m.id)
    expect(alerts.sent).toHaveLength(1)
    expect(alerts.sent[0]).toContain(`#${m.id}`)
    expect(alerts.sent[0]).toContain(SESSION)
    expect(alerts.sent[0]).not.toContain('filler')
    // The generic "action failed" path did not swallow it.
    expect(logCalls.warn.some((c) => c[1] === 'Stuck-input recovery action failed')).toBe(false)
  })

  it('does not spend the requeue budget: the next head-lost park of the same message is requeued', async () => {
    const m = await deliver()
    const parked = headLost(m.frame)
    term.pane = parked
    flip.fail = true
    await tick()
    flip.fail = false
    term.pane = parked
    await tick()
    expect(await statusOf(m.id)).toBe('pending')
    expect(requeueLogs()).toHaveLength(1)
  })
})

describe('the ledger flip changes no row (matrix row 8, edit (e))', () => {
  it('a message that is already done is left alone and its record is KEPT', async () => {
    const m = await deliver()
    await markMessageDone(m.id, 'handled elsewhere')
    term.pane = headLost(m.frame)
    await tick()
    expect(term.clearCalls).toBe(1) // the box is emptied, the message is not resurrected
    expect(await statusOf(m.id)).toBe('done')
    expect(_registrySize(SESSION)).toBe(1)
    expect(requeueLogs()).toHaveLength(0)
    expect(await auditRows(m.id)).toHaveLength(0)
  })

  it('a wrong tenant on the record changes no row and keeps the record', async () => {
    const m = await createAgentMessage('agent-b', TO, BODY, null, null, 'default')
    await markMessageDelivered(m.id)
    const { prefix, wrapped } = wrapAgentMessageForDelivery('trusted-peer', 'agent-b', 'agent-b', BODY, m.id, null)
    recordDelivery(SESSION, prefix + wrapped, String(m.id), { msgId: m.id, toAgent: TO, tenantId: 'tenant-x' })
    term.pane = headLost(prefix + wrapped)
    await tick()
    expect(await statusOf(m.id)).toBe('delivered')
    expect(_registrySize(SESSION)).toBe(1)
  })

  it('a wrong agent on the record changes no row', async () => {
    const m = await createAgentMessage('agent-b', TO, BODY)
    await markMessageDelivered(m.id)
    const { prefix, wrapped } = wrapAgentMessageForDelivery('trusted-peer', 'agent-b', 'agent-b', BODY, m.id, null)
    recordDelivery(SESSION, prefix + wrapped, String(m.id), { msgId: m.id, toAgent: 'agent-other', tenantId: 'default' })
    term.pane = headLost(prefix + wrapped)
    await tick()
    expect(await statusOf(m.id)).toBe('delivered')
  })
})

describe('the budget: one requeue per message id (matrix row 6)', () => {
  it('a message that parks head-lost again is held, with ONE operator alert that carries no content', async () => {
    const m = await deliver()
    term.pane = headLost(m.frame)
    await tick()
    expect(await statusOf(m.id)).toBe('pending')

    // The router delivers it again; the copy parks head-lost again.
    await markMessageDelivered(m.id)
    recordDelivery(SESSION, m.frame, String(m.id), { msgId: m.id, toAgent: TO, tenantId: 'default' })
    term.pane = headLost(m.frame)
    term.clearCalls = 0
    await tick()
    await tick()
    await tick()

    expect(term.clearCalls).toBe(0)
    expect(await statusOf(m.id)).toBe('delivered')
    expect(requeueLogs()).toHaveLength(1)
    expect(alerts.sent).toHaveLength(1)
    expect(alerts.sent[0]).toContain(`#${m.id}`)
    expect(alerts.sent[0]).toContain(SESSION)
    expect(alerts.sent[0]).not.toContain('filler')
  })

  it('the memory is bounded: past 200 ids the oldest is forgotten and may be requeued once more', async () => {
    const first = await deliver()
    term.pane = headLost(first.frame)
    await tick()
    for (let i = 0; i < 200; i++) {
      clearDeliveries(SESSION)
      const m = await deliver(SESSION, TO, 'default', `${BODY} unique${i}`)
      term.pane = headLost(m.frame)
      await tick()
    }
    // `first` is the oldest of 201 and was forgotten: a new head-lost park of it is requeued again.
    clearDeliveries(SESSION)
    await markMessageDelivered(first.id)
    recordDelivery(SESSION, first.frame, String(first.id), { msgId: first.id, toAgent: TO, tenantId: 'default' })
    term.pane = headLost(first.frame)
    term.clearCalls = 0
    await tick()
    expect(term.clearCalls).toBe(1)
    expect(await statusOf(first.id)).toBe('pending')
  }, 60_000)
})

describe('what stays a hold (a human draft must never be cleared)', () => {
  const DRAFT = ['Draft text of mine, written by hand before I left for lunch,', 'and a second line of the same draft that no router ever pasted anywhere']

  async function expectHeld(pane: string, m: Msg, allowPlain = true) {
    term.pane = pane
    await tick(SESSION, allowPlain)
    expect(term.clearCalls).toBe(0)
    expect(await statusOf(m.id)).toBe('delivered')
    expect(_registrySize(SESSION)).toBe(1)
    expect(requeueLogs()).toHaveLength(0)
  }

  it('a human draft with a recent delivery in the registry', async () => {
    await expectHeld(boxPane(DRAFT), await deliver())
  })

  it('a draft that copied a piece from the MIDDLE of the frame (the loose includes() match would clear it)', async () => {
    const m = await deliver()
    const flat = m.frame.replace(/\s+/g, ' ')
    const middle = flat.slice(180, 420)
    await expectHeld(boxPane(wrap(middle.slice(middle.indexOf(' ') + 1))), m)
  })

  it('a draft that copied the PREFIX of the frame', async () => {
    const m = await deliver()
    const flat = m.frame.replace(/\s+/g, ' ')
    await expectHeld(boxPane(wrap(flat.slice(0, 330))), m)
  })

  it('the tail plus text typed after it (the box does not end where the frame ends)', async () => {
    const m = await deliver()
    const flat = m.frame.replace(/\s+/g, ' ')
    const cut = flat.slice(-330)
    await expectHeld(boxPane(wrap(`${cut.slice(cut.indexOf(' ') + 1)} and my own addition at the end of it`)), m)
  })

  it('my words typed in FRONT of the tail', async () => {
    const m = await deliver()
    const flat = m.frame.replace(/\s+/g, ' ')
    const cut = flat.slice(-330)
    await expectHeld(boxPane(wrap(`note to self: ${cut.slice(cut.indexOf(' ') + 1)}`)), m)
  })

  it('the same frame delivered twice (two ids): ambiguous, both held', async () => {
    const a = await deliver()
    const b = await deliver()
    term.pane = headLost(a.frame)
    await tick()
    expect(term.clearCalls).toBe(0)
    expect(await statusOf(a.id)).toBe('delivered')
    expect(await statusOf(b.id)).toBe('delivered')
    expect(_registrySize(SESSION)).toBe(2)
    expect(requeueLogs()).toHaveLength(0)
  })

  it('a stale delivery (older than five minutes) is not an attribution', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T10:00:00Z'))
      const m = await deliver()
      vi.setSystemTime(new Date('2026-01-01T10:05:01Z'))
      await expectHeld(headLost(m.frame), m)
    } finally { vi.useRealTimers() }
  })

  it('the MAIN session (allowPlainReinject false) is never cleared, matching delivery or not', async () => {
    const m = await deliver()
    await expectHeld(headLost(m.frame), m, false)
  })

  it('a head-lost box with NO delivery recorded at all', async () => {
    const m = await deliver()
    clearDeliveries(SESSION)
    term.pane = headLost(m.frame)
    await tick()
    expect(term.clearCalls).toBe(0)
    expect(await statusOf(m.id)).toBe('delivered')
  })

  it('a delivery recorded for ANOTHER session does not attribute this box', async () => {
    const m = await deliver('session-b')
    term.pane = headLost(m.frame)
    await tick(SESSION, true)
    expect(term.clearCalls).toBe(0)
    expect(await statusOf(m.id)).toBe('delivered')
  })
})

describe('the restart guard (main session) is unchanged: the new remedy never reaches it', () => {
  it('a head-lost box has no soft remedy on the main session and is not machine-origin, so the guard still defers it', async () => {
    const m = await deliver()
    const pane = headLost(m.frame)
    expect(parkedMainInputHasRemedy(pane)).toBe(false)
    expect(parkedMachineOriginInput(pane)).toBe(false)
    // machineOrigin false -> "possibly a human draft" -> keeps deferring, exactly as before the requeue existed.
    expect(applyStuckRestartBusyGuard('typing', 'restart', { machineOrigin: false, softRemedy: false })).toBe('skip')
  })

  it('the carve-out table is as before: machine-origin without a remedy restarts, with a remedy defers, busy always skips', () => {
    expect(applyStuckRestartBusyGuard('typing', 'restart', { machineOrigin: true, softRemedy: false })).toBe('restart')
    expect(applyStuckRestartBusyGuard('typing', 'restart', { machineOrigin: true, softRemedy: true })).toBe('skip')
    expect(applyStuckRestartBusyGuard('typing', 'alert', { machineOrigin: true, softRemedy: false })).toBe('alert')
    expect(applyStuckRestartBusyGuard('busy', 'restart', { machineOrigin: true, softRemedy: false })).toBe('skip')
    expect(applyStuckRestartBusyGuard('idle', 'restart')).toBe('restart')
  })
})

describe('wiring', () => {
  it('the router records the ledger row with the delivery, so the monitor can requeue it', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const router = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../web/message-router.ts'), 'utf-8')
    expect(router).toContain('recordDelivery(session, prefix + wrapped, String(msg.id), msg.tenant_id ? { msgId: msg.id, toAgent: msg.to_agent, tenantId: msg.tenant_id } : undefined)')
  })
})
