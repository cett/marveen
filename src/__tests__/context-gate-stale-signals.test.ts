// Regression: the context-restart gate stayed shut for hours on signals that no
// longer described live work.
//
//   - an unanswered inbound in the conversation ledger never went stale, so an
//     agent whose channel logging had stopped read "open question" forever;
//   - the blocking streak (firstBlockedAt) survived an agent restart, so a fresh
//     session inherited the old session's block clock;
//   - the context measurement took the newest transcript even when it belonged
//     to a PREVIOUS session, so a freshly restarted agent looked 400k+ deep;
//   - status reports / completion reports an agent had sent stayed 'delivered'
//     for good and were counted as dispatched work still awaiting a result.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  initDatabase,
  createAgentMessage,
  markMessageDelivered,
  getDispatchedPendingStats,
  hasOpenInboundQuestion,
  getDb,
} from '../db.js'
import { streakBelongsToPreviousSession, SESSION_START_TOLERANCE_MS } from '../context-restart-gate.js'
import { readContextTokensFromProjectDir } from '../web/active-model.js'

beforeAll(() => { initDatabase(':memory:') })

const uniq = (p: string) => `${p}-${Date.now()}-${Math.floor(performance.now() * 1000)}`
const HOUR_MS = 3_600_000
const CUTOFF_MS = 2 * HOUR_MS

function addMessage(from: string, to: string, content: string, opts: { ageSeconds?: number; deliver?: boolean } = {}): number {
  const m = createAgentMessage(from, to, content)
  if (opts.deliver !== false) markMessageDelivered(m.id)
  if (opts.ageSeconds) getDb().exec(`UPDATE agent_messages SET created_at = created_at - ${opts.ageSeconds} WHERE id = ${m.id}`)
  return m.id
}

describe('getDispatchedPendingStats: only messages that await a result', () => {
  const now = () => Date.now()

  it('a delivered delegation counts', () => {
    const exec = uniq('exec')
    addMessage(exec, uniq('peer'), 'please review this')
    expect(getDispatchedPendingStats(exec, now(), CUTOFF_MS, { coordinatorAgentId: 'coord' }).count).toBe(1)
  })

  it('an executor\'s status reports TO the coordinator do not count (a burst used to block for the whole stale window)', () => {
    const exec = uniq('exec')
    for (let i = 0; i < 6; i++) addMessage(exec, 'coord', `status report ${i}`)
    expect(getDispatchedPendingStats(exec, now(), CUTOFF_MS, { coordinatorAgentId: 'coord' }).count).toBe(0)
    // Without the coordinator hint the old behaviour is unchanged.
    expect(getDispatchedPendingStats(exec, now(), CUTOFF_MS).count).toBe(6)
  })

  it('the coordinator\'s own outbound is real delegation and still counts', () => {
    addMessage('coord-x', uniq('worker'), 'do the thing')
    expect(getDispatchedPendingStats('coord-x', now(), CUTOFF_MS, { coordinatorAgentId: 'coord-x' }).count).toBe(1)
  })

  it('completion reports never count, whoever they go to', () => {
    const exec = uniq('exec')
    addMessage(exec, uniq('peer'), '[Eredmény] msg_id:5 status:done\n\nall good')
    expect(getDispatchedPendingStats(exec, now(), CUTOFF_MS, { coordinatorAgentId: 'coord' }).count).toBe(0)
    expect(getDispatchedPendingStats(exec, now(), CUTOFF_MS).count).toBe(0)
  })

  it('the exclusions hold for the stale side too (an old report is not "stale work")', () => {
    const exec = uniq('exec')
    addMessage(exec, 'coord', 'old report', { ageSeconds: 5 * 3600 })
    addMessage(exec, uniq('peer'), 'old delegation', { ageSeconds: 5 * 3600 })
    const stats = getDispatchedPendingStats(exec, now(), CUTOFF_MS, { coordinatorAgentId: 'coord' })
    expect(stats.count).toBe(0)
    expect(stats.hasStale).toBe(true) // only the delegation
    const onlyReport = uniq('exec')
    addMessage(onlyReport, 'coord', 'old report', { ageSeconds: 5 * 3600 })
    expect(getDispatchedPendingStats(onlyReport, now(), CUTOFF_MS, { coordinatorAgentId: 'coord' }).hasStale).toBe(false)
  })
})

describe('hasOpenInboundQuestion: a stale inbound is not live work', () => {
  const nowSec = () => Math.floor(Date.now() / 1000)
  function ledger(agent: string, direction: 'in' | 'out', createdAt: number): void {
    getDb().prepare(
      'INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(agent, 'chat', direction, String(Math.random()), 'x', createdAt)
  }
  const opts = () => ({ nowMs: Date.now(), staleCutoffMs: CUTOFF_MS })

  it('a recent unanswered inbound is open', () => {
    const a = uniq('q')
    ledger(a, 'in', nowSec() - 60)
    expect(hasOpenInboundQuestion(a, opts())).toBe(true)
  })

  it('an unanswered inbound older than the cutoff no longer blocks (logging stopped months ago)', () => {
    const a = uniq('q')
    ledger(a, 'in', nowSec() - 100 * 24 * 3600)
    expect(hasOpenInboundQuestion(a, opts())).toBe(false)
    // Legacy call shape (no cutoff): the old behaviour, untouched.
    expect(hasOpenInboundQuestion(a)).toBe(true)
  })

  it('just inside the cutoff still blocks, at the cutoff it does not', () => {
    const inside = uniq('q')
    ledger(inside, 'in', nowSec() - (CUTOFF_MS / 1000) + 30)
    expect(hasOpenInboundQuestion(inside, opts())).toBe(true)
    const edge = uniq('q')
    ledger(edge, 'in', nowSec() - (CUTOFF_MS / 1000) - 1)
    expect(hasOpenInboundQuestion(edge, opts())).toBe(false)
  })

  it('an answered inbound is closed either way', () => {
    const a = uniq('q')
    ledger(a, 'in', nowSec() - 120)
    ledger(a, 'out', nowSec() - 60)
    expect(hasOpenInboundQuestion(a, opts())).toBe(false)
  })
})

describe('streakBelongsToPreviousSession', () => {
  const start = 10_000_000

  it('a streak that began before the current session started belongs to the old one', () => {
    expect(streakBelongsToPreviousSession(start - 3 * HOUR_MS, start)).toBe(true)
  })

  it('a streak inside the current session is kept', () => {
    expect(streakBelongsToPreviousSession(start + 5 * 60_000, start)).toBe(false)
  })

  it('process-age jitter around the start does not flap the streak', () => {
    expect(streakBelongsToPreviousSession(start - SESSION_START_TOLERANCE_MS + 1, start)).toBe(false)
    expect(streakBelongsToPreviousSession(start - SESSION_START_TOLERANCE_MS - 1, start)).toBe(true)
  })

  it('no streak or an unknown session start means "cannot tell": keep', () => {
    expect(streakBelongsToPreviousSession(null, start)).toBe(false)
    expect(streakBelongsToPreviousSession(start - HOUR_MS, null)).toBe(false)
  })
})

describe('readContextTokensFromProjectDir: pinned to the active session', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'ctx-active-session-')) })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  const USAGE = JSON.stringify({ message: { usage: { input_tokens: 400_000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0 } } })

  function transcript(name: string, mtimeMs: number): { configDir: string; workDir: string } {
    const configDir = join(tmp, '.claude')
    const workDir = join(tmp, 'work')
    const dir = join(configDir, 'projects', workDir.replace(/[/.]/g, '-'))
    mkdirSync(dir, { recursive: true })
    const f = join(dir, name)
    writeFileSync(f, USAGE)
    utimesSync(f, mtimeMs / 1000, mtimeMs / 1000)
    return { configDir, workDir }
  }

  it('a transcript from before the session started is the previous session: 0, not its 410k', () => {
    const sessionStart = Date.now() - 10 * 60_000
    const { configDir, workDir } = transcript('old.jsonl', sessionStart - 60 * 60_000)
    expect(readContextTokensFromProjectDir(workDir, configDir, { sessionStartMs: sessionStart })).toBe(0)
  })

  it('a transcript written after the session started is measured as before', () => {
    const sessionStart = Date.now() - 10 * 60_000
    const { configDir, workDir } = transcript('live.jsonl', sessionStart + 60_000)
    expect(readContextTokensFromProjectDir(workDir, configDir, { sessionStartMs: sessionStart })).toBe(410_000)
  })

  it('without a session start the newest transcript is used (unchanged behaviour)', () => {
    const { configDir, workDir } = transcript('old.jsonl', Date.now() - 60 * 60_000)
    expect(readContextTokensFromProjectDir(workDir, configDir)).toBe(410_000)
  })

  it('a missing projects dir stays null (fail-closed, misconfigured config root), even with a session start', () => {
    expect(readContextTokensFromProjectDir(join(tmp, 'miss'), join(tmp, 'nope'), { sessionStartMs: Date.now() })).toBeNull()
  })
})
