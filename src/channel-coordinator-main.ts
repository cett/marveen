// The coordinator body. The launched entry is channel-coordinator.ts (the bootstrap): it loads the system_config
// snapshot on a PostgreSQL install, then imports this module and runs main(). Nothing else imports this file.
// It is not imported statically by the bootstrap, because config.ts evaluates its overrides at import time.
// marveen-channel-coordinator: standalone Telegram inbound BACKFILL poller.
//
// WHY THIS EXISTS (hybrid model -- Szabi 2026-06-02)
// The native Telegram channel plugin runs getUpdates INSIDE the Marveen TUI and
// stays the PRIMARY inbound path (it gives the "typing..." indicator, low
// latency, and native reply-semantics for free). But the plugin's ~hourly
// disconnects / TUI freezes leave inbound messages stranded server-side.
//
// This coordinator is a SILENT BACKFILL safety-net: while the native channel is
// UP it does NOTHING (no getUpdates, so no 409, native owns inbound). Only when
// the native is observed DOWN (process gone, or alive-but-wedged per a stale
// keepalive) does it poll getUpdates, write to store/claudeclaw.db
// (incoming_events), and hand off to Marveen via the existing agent_messages
// queue + message-router (which delivers it as channel-inbound -- reply-
// expected, body untrusted).
//
// NO DOUBLE-DELIVERY: on entering a backfill window it seeds poll_offset to the
// current server high-water (probeHighWater), so it only delivers messages that
// arrive DURING the outage and confirms them; the detection-window backlog
// (<= high-water) is left for the native to deliver when it recovers (it polls
// from its own older offset). It yields the instant the native returns -- on a
// 409 OR a liveness flip -- and re-checks liveness BEFORE handing off a batch,
// discarding it if the native just recovered. Bias: under-deliver, since the
// native + typing is the better UX and Telegram holds unconfirmed updates 24h.
//
// Lifecycle: launchd (com.<SERVICE_ID>.channel-coordinator) with KeepAlive. SIGTERM
// drains, persists offset, exits cleanly.

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { logger } from './logger.js'
import { PROJECT_ROOT, MAIN_AGENT_ID, CHANNEL_PROVIDER, BOT_NAME } from './config.js'
import { getUpdates, probeHighWater, mapUpdate, TelegramApiError } from './channel-coordinator/telegram-client.js'
import { probeNativeChannelDown } from './channel-coordinator/liveness.js'
import {
  insertIncomingEvent,
  createHandoffMessage,
  markEventDelivered,
  markEventFailed,
  getEventsNeedingHandoff,
  getOffset,
  setOffset,
  type InsertResult,
} from './channel-coordinator/ingest.js'
import { bootCoordinatorDb, closeCoordinatorDb } from './channel-coordinator/boot.js'
import { loadSenderAccess, isSenderAllowed } from './channel-coordinator/sender-gate.js'

const SOURCE = 'telegram'
const LONGPOLL_TIMEOUT_SEC = 30
const POLL_LIMIT = 100

// The native main-agent channels session + its provider. The coordinator only
// backfills for THIS session's channel.
const SESSION = `${MAIN_AGENT_ID}-channels`
const PROVIDER = CHANNEL_PROVIDER

// State-machine tick / liveness-probe cadence while IDLE.
const TICK_MS = 5000
// Enter BACKFILLING only after the native reads DOWN this many consecutive
// probes -- a single transient process-tree race or a restart blip must not
// flip us into polling (which could 409 the recovering native).
const DOWN_DEBOUNCE = 2

// Transient-error backoff (5xx / network) while BACKFILLING.
const BACKOFF_BASE_MS = 1000
const BACKOFF_CAP_MS = 60_000

// 409-cooldown: a 409 from getUpdates is AUTHORITATIVE proof the native poller
// is alive (it holds the token's getUpdates slot), even when the liveness probe
// reads DOWN -- which happens when the native bun poller is reparented (not a
// child of the resolved claude pid) and bot.pid is absent, so hasChannelPluginAlive
// false-negatives. Without this, the coordinator flapped ~every 13s (DOWN ->
// backfill -> 409 -> yield -> DOWN ...), 342x in 2.3h, churning the token with
// 409s (2026-06-03 incident). On a 409 we briefly refuse to re-enter BACKFILLING,
// overriding the flaky probe. If the native genuinely goes down, getUpdates
// SUCCEEDS (no 409) so no cooldown is set and normal backfill resumes.
//
// COOLDOWN LENGTH -- the real root-cause fix is the detached-claude reap
// (channel-poller-reap.ts), which removes the orphan that made the probe
// false-negative in the first place. With the probe accurate, this cooldown is
// only belt-and-suspenders against a TRANSIENT blip (e.g. a process-tree race
// while the native itself respawns). So we keep it SHORT: long enough to absorb
// such a transient and break any residual flap (flap period was ~13.5s), but
// short enough that a GENUINE native death is re-covered quickly. A long
// suppression would be a self-inflicted coverage gap -- this coordinator exists
// precisely to cover multi-minute native-down windows, and during the cooldown
// it backfills nothing. (No message LOSS even at the upper bound: native's
// recovery resumes getUpdates from its persisted offset, and Telegram retains
// updates ~24h; the cooldown only delays low-latency coverage.)
const NATIVE_409_COOLDOWN_MS = 90 * 1000

// The coordinator keeps its OWN state dir, separate from the plugin's
// ~/.claude/channels/telegram. Sharing it would let the plugin's orphan-PID
// watchdog SIGTERM our process (it kills "stale" pids in its bot.pid).
const STATE_DIR = process.env['COORDINATOR_STATE_DIR'] ?? join(homedir(), '.claude', 'channels', 'telegram-coordinator')
const PID_FILE = join(STATE_DIR, 'coordinator.pid')

type State = 'idle' | 'backfilling'
let state: State = 'idle'
let downStreak = 0
let stopping = false
// Epoch-ms until which a recent 409 has confirmed the native poller is up; while
// in this window we suppress BACKFILLING regardless of the liveness probe.
let nativeConfirmedUpUntil = 0

// Pure: are we inside the post-409 "native confirmed up" cooldown?
export function inNative409Cooldown(confirmedUpUntilMs: number, nowMs: number): boolean {
  return nowMs < confirmedUpUntilMs
}

// ---- token --------------------------------------------------------------

// Read the bot token from the coordinator's own STATE_DIR/.env (chmod 0600),
// falling back to the process env for local dev. NEVER log the token.
function readToken(): string {
  const fromEnv = process.env['TELEGRAM_BOT_TOKEN']
  if (fromEnv) return fromEnv
  const envPath = join(STATE_DIR, '.env')
  try {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      if (trimmed.slice(0, eq).trim() === 'TELEGRAM_BOT_TOKEN') {
        let v = trimmed.slice(eq + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        return v
      }
    }
  } catch { /* no .env -- fall through to error */ }
  throw new Error(`TELEGRAM_BOT_TOKEN not found (checked env + ${envPath})`)
}

// ---- single-instance lock ------------------------------------------------

// Two pollers on one token = guaranteed 409. Refuse to start if another live
// coordinator already holds the pid file. Stale pid (process gone) is reclaimed.
function acquireSingleInstanceLock(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  if (existsSync(PID_FILE)) {
    const prev = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)
    if (Number.isInteger(prev) && prev > 0 && prev !== process.pid) {
      let alive = false
      try { process.kill(prev, 0); alive = true } catch { alive = false }
      if (alive) {
        logger.error({ prev }, 'channel-coordinator: another live instance holds the pid lock, exiting')
        process.exit(1)
      }
      logger.warn({ stalePid: prev }, 'channel-coordinator: reclaiming stale pid file')
    }
  }
  writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 })
}

export function releaseLock(): void {
  try {
    if (existsSync(PID_FILE) && readFileSync(PID_FILE, 'utf-8').trim() === String(process.pid)) unlinkSync(PID_FILE)
  } catch { /* best effort */ }
}

// ---- alerting ------------------------------------------------------------

// Best-effort Telegram alert to the owner via the existing notify.sh (which
// uses the project's own token+chat). Used for fatal (401) only -- a 409 here
// is the EXPECTED "native is back" signal, not an error worth alerting.
function sendAlert(message: string): void {
  const script = join(PROJECT_ROOT, 'scripts', 'notify.sh')
  execFile('/bin/bash', [script, message], { timeout: 10_000 }, (err) => {
    if (err) logger.warn({ err }, 'channel-coordinator: notify.sh alert failed')
  })
}

// ---- handoff content -----------------------------------------------------

// Neutralize any <channel ...> / </channel> the user typed, so their text can
// never break out of the channel frame we wrap it in below. (The message-router
// also scrubs untrusted/trusted-peer tags, but not <channel>.)
export function neutralizeChannelTags(text: string): string {
  return text.replace(/<\s*\/?\s*channel\b[^>]*>/gi, '[stripped-tag]')
}

// Mirror the native plugin's <channel ...> block so the message-router can
// deliver it as channel-inbound and Marveen replies exactly as she would to a
// native message (reply with chat_id), while the body stays untrusted.
export function buildHandoffContent(ev: {
  kind: string
  chat_id: number | null
  user_id: number | null
  username: string | null
  message_id: number | null
  content: string
  tg_date: number | null
  meta?: Record<string, unknown>
}): string {
  const ts = ev.tg_date ? new Date(ev.tg_date * 1000).toISOString() : ''
  const voiceMeta = ev.meta?.voice as { file_id?: string } | undefined
  const voiceFileId = voiceMeta?.file_id ?? ''
  const attrs = [
    `source="telegram"`,
    ev.chat_id != null ? `chat_id="${ev.chat_id}"` : '',
    ev.message_id != null ? `message_id="${ev.message_id}"` : '',
    ev.username ? `user="${neutralizeChannelTags(ev.username).replace(/"/g, '')}"` : '',
    ev.user_id != null ? `user_id="${ev.user_id}"` : '',
    ts ? `ts="${ts}"` : '',
    ev.kind !== 'message' ? `kind="${ev.kind}"` : '',
    voiceFileId ? `attachment_kind="voice"` : '',
    voiceFileId ? `attachment_file_id="${voiceFileId}"` : '',
  ].filter(Boolean).join(' ')
  const body = neutralizeChannelTags(ev.content || '(empty message)')
  return `<channel ${attrs}>\n${body}\n</channel>`
}

// ---- backoff -------------------------------------------------------------

// Exponential backoff with full jitter, capped. Math.random is fine here --
// this is a long-lived Node process, not a (replayable) workflow script.
export function transientBackoffMs(attempt: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return Math.floor(Math.random() * ceiling)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ---- batch processing ----------------------------------------------------

// Process one getUpdates batch. For each update: normalize, dedup-insert, and
// (if newly inserted) hand off to Marveen. Returns the highest update_id seen
// so the caller can advance the offset AFTER the whole batch is durable.
// Exported for tests.
// How many times the insert of the SAME update may fail before it is given up (a transient error clears in one or two polls; the
// backoff in the loop spaces the attempts), and the state processBatch leaves for the loop. Exported for tests.
export const POISON_INSERT_FAILURES = 10
// An update is given up only when it has failed that many times AND for at least this long AND the database answers a read. The
// count alone is seconds under the capped backoff: a few minutes of database outage would reach it and lose a REAL message.
const POISON_MIN_AGE_MS_DEFAULT = 10 * 60 * 1000
let poisonMinAgeMs = POISON_MIN_AGE_MS_DEFAULT
const insertFailures = new Map<number, number>()
const firstFailureAt = new Map<number, number>()
let batchStoppedOnFailure = false
// Consecutive batches that stopped at a failed insert: the backoff of the loop grows with THIS, not with the poll-error counter
// (a getUpdates that succeeds resets that one, and a stopped batch always follows a successful getUpdates).
let insertFailStreak = 0
/** true when the last processBatch stopped at a failed insert: the loop waits before it asks for the same updates again. */
export function lastBatchStoppedOnFailure(): boolean { return batchStoppedOnFailure }
/** the attempt number the loop's backoff uses after a batch that stopped at a failed insert (0 after a batch that did not). */
export function insertFailStreakValue(): number { return insertFailStreak }
export function setPoisonMinAgeForTests(ms: number): void { poisonMinAgeMs = ms }
export function resetInsertFailuresForTests(): void {
  insertFailures.clear(); firstFailureAt.clear(); batchStoppedOnFailure = false; insertFailStreak = 0; poisonMinAgeMs = POISON_MIN_AGE_MS_DEFAULT
}

/** true when the database answers a read: a failing insert is then about the DATA, not an outage. */
async function databaseAnswers(): Promise<boolean> {
  try { await getOffset(SOURCE); return true } catch { return false }
}

export async function processBatch(updates: { update_id: number }[]): Promise<number | null> {
  // The highest update id that is DURABLE: stored, or deduplicated, or one that is not stored on purpose (an unhandled kind). The
  // caller moves the offset to it, and Telegram never sends an update below the offset again, so an update whose insert FAILED
  // must stay above it. A handoff failure is different: its event is stored and the replay hands it off.
  batchStoppedOnFailure = false
  let maxUpdateId: number | null = null
  const settled = (id: number): void => { maxUpdateId = maxUpdateId == null ? id : Math.max(maxUpdateId, id) }
  // default-deny: the access list of the native plugin, read once per batch (null = unreadable = nothing passes)
  const access = loadSenderAccess()
  let dropped = 0
  for (const raw of updates) {
    const ev = mapUpdate(raw as Parameters<typeof mapUpdate>[0])
    if (!ev) { settled(raw.update_id); continue } // unhandled update kind: offset still advances past it
    // a sender outside the list: nothing is stored, nothing is handed off, nothing is sent back (no pairing reply); the offset
    // still advances past it, so the update is not asked for again
    if (!isSenderAllowed(access, ev)) { dropped++; settled(raw.update_id); continue }

    let ins: InsertResult
    try {
      ins = await insertIncomingEvent(SOURCE, ev)
    } catch (err) {
      // STOP: the update is not stored, so the offset must not pass it (nor anything after it, the batch is in order). The
      // next poll asks Telegram for it again, and the dedupe key makes a replay of the ones already stored harmless.
      const failures = (insertFailures.get(ev.update_id) ?? 0) + 1
      insertFailures.set(ev.update_id, failures)
      const now = Date.now()
      if (!firstFailureAt.has(ev.update_id)) firstFailureAt.set(ev.update_id, now)
      const failingForMs = now - (firstFailureAt.get(ev.update_id) ?? now)
      // A failure that does not go away (a value the database refuses, every time) would hold the offset, and every update
      // behind it, for ever, so it is given up, LOUDLY (an alert, the id in the log), so the queue can move on. Three conditions,
      // all of them: the count, the age of the first failure (a database outage of a few minutes must not eat a real message),
      // and a read that SUCCEEDS now (the database answers, so the refusal is about this update's data and not an outage).
      if (failures >= POISON_INSERT_FAILURES && failingForMs >= poisonMinAgeMs && await databaseAnswers()) {
        insertFailures.delete(ev.update_id)
        firstFailureAt.delete(ev.update_id)
        logger.error({ err, update_id: ev.update_id, failures, failingForMs }, 'channel-coordinator: insertIncomingEvent failed again and again while the database answers; this update is given up so the queue can move on')
        sendAlert(`${BOT_NAME} channel-coordinator: update ${ev.update_id} could not be stored after ${failures} attempts over ${Math.round(failingForMs / 1000)} s and was given up.`)
        settled(raw.update_id)
        continue
      }
      logger.error({ err, update_id: ev.update_id, failures, failingForMs }, 'channel-coordinator: insertIncomingEvent failed; the batch stops, the offset stays below this update')
      batchStoppedOnFailure = true
      break
    }
    insertFailures.delete(ev.update_id)
    firstFailureAt.delete(ev.update_id)
    settled(raw.update_id)
    if (!ins.inserted || ins.eventId == null) continue // dedup: already handed off

    try {
      const agentMessageId = await createHandoffMessage(buildHandoffContent(ev))
      await markEventDelivered(ins.eventId, agentMessageId)
      logger.info({ update_id: ev.update_id, chat_id: ev.chat_id, kind: ev.kind, agentMessageId }, 'channel-coordinator: backfilled to main agent')
    } catch (err) {
      logger.error({ err, eventId: ins.eventId }, 'channel-coordinator: handoff failed; event left pending for replay')
    }
  }
  // The backoff counter of the loop: one more for a batch that stopped at a failed insert, back to zero for one that did not.
  insertFailStreak = batchStoppedOnFailure ? insertFailStreak + 1 : 0
  // the count only: no id, no name, no text of a sender that was not let in
  if (dropped > 0) logger.warn({ dropped }, 'channel-coordinator: dropped updates from senders outside the access list')
  return maxUpdateId
}

// ---- reconcile (no-message-loss replay) ----------------------------------

// Re-hand-off events the message-router abandoned (agent_message failed after
// its 1h retry window) or that were never handed off (crash between insert and
// handoff). This is the invariant the whole decoupling exists for: a frozen
// main agent DELAYS a message, never LOSES it. Runs every tick in ALL states,
// because a message backfilled during a past window can still be abandoned by
// the router later while we sit idle. Idempotent: in-flight handoffs are
// excluded by getEventsNeedingHandoff, and a re-handoff creates a fresh
// agent_message rather than duplicating the source event.
// Exported for tests.
export async function reconcilePending(): Promise<void> {
  let events
  try {
    events = await getEventsNeedingHandoff(SOURCE)
  } catch (err) {
    logger.error({ err }, 'channel-coordinator: reconcile query failed')
    return
  }
  if (events.length === 0) return
  // The same gate for what is already stored (events ingested before the gate, or a list that changed since). An UNREADABLE list
  // is not a verdict on the senders: nothing is handed off and nothing is marked, the events wait for a readable list.
  const access = loadSenderAccess()
  if (access === null) return
  for (const ev of events) {
    if (!isSenderAllowed(access, ev)) {
      try {
        await markEventFailed(ev.id, 'sender not allowed')
      } catch (err) {
        logger.error({ err, eventId: ev.id }, 'channel-coordinator: could not mark a not-allowed stored event; it stays pending')
      }
      continue
    }
    try {
      let parsedMeta: Record<string, unknown> = {}
      try { if (ev.meta) parsedMeta = JSON.parse(ev.meta) as Record<string, unknown> } catch {}
      const agentMessageId = await createHandoffMessage(buildHandoffContent({
        kind: ev.kind,
        chat_id: ev.chat_id,
        user_id: ev.user_id,
        username: ev.username,
        message_id: ev.message_id,
        content: ev.content ?? '',
        tg_date: ev.tg_date,
        meta: parsedMeta,
      }))
      await markEventDelivered(ev.id, agentMessageId)
      logger.warn({ update_id: ev.update_id, eventId: ev.id, agentMessageId }, 'channel-coordinator: re-queued abandoned/stranded inbound message')
    } catch (err) {
      logger.error({ err, eventId: ev.id }, 'channel-coordinator: reconcile re-handoff failed; will retry next cycle')
    }
  }
}

// ---- fatal --------------------------------------------------------------

async function fatalExit(err: TelegramApiError): Promise<never> {
  logger.error({ msg: err.message }, 'channel-coordinator: fatal error, exiting')
  sendAlert(`${BOT_NAME} channel-coordinator FATAL: ${err.message}. Inbound backfill leallt amig nem javitod.`)
  await sleep(1500) // let notify.sh fire before exit
  process.exit(1)
}

// ---- main loop (IDLE <-> BACKFILLING state machine) ----------------------

async function runLoop(token: string): Promise<void> {
  let transientAttempt = 0
  while (!stopping) {
    // No-message-loss replay runs every tick, regardless of state.
    await reconcilePending()

    if (state === 'idle') {
      // Watch the native channel. Debounce DOWN readings so a momentary blip
      // (process-tree race, restart) does not flip us into polling. A recent
      // 409 overrides a DOWN reading: it proved the native poller is up, so we
      // distrust the (flaky) liveness probe until the cooldown expires.
      const down = probeNativeChannelDown(SESSION, PROVIDER) && !inNative409Cooldown(nativeConfirmedUpUntil, Date.now())
      downStreak = down ? downStreak + 1 : 0
      if (downStreak >= DOWN_DEBOUNCE) {
        try {
          // Seed poll_offset to the current high-water so we only deliver
          // messages that arrive DURING the outage; the detection-window
          // backlog (<= hw) is left for the native to deliver on recovery.
          const hw = await probeHighWater(token)
          if (hw != null) await setOffset(SOURCE, hw)
          state = 'backfilling'
          transientAttempt = 0
          logger.warn({ session: SESSION, seededHighWater: hw }, 'channel-coordinator: native channel DOWN, entering BACKFILLING')
        } catch (err) {
          if (err instanceof TelegramApiError && err.kind === 'fatal') { await fatalExit(err) }
          // A 409 on the seed means the native is in fact polling -> stay idle
          // AND start the cooldown so a flaky DOWN probe can't immediately retry.
          if (err instanceof TelegramApiError && err.kind === 'conflict') {
            nativeConfirmedUpUntil = Date.now() + NATIVE_409_COOLDOWN_MS
            logger.info({ cooldownMs: NATIVE_409_COOLDOWN_MS }, 'channel-coordinator: high-water seed 409 -- native is polling, cooldown set, staying idle')
            downStreak = 0
          } else {
            logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'channel-coordinator: high-water seed failed, retrying next tick')
          }
        }
      }
      await sleep(TICK_MS)
      continue
    }

    // state === 'backfilling'
    // Yield the instant the native is back -- it owns inbound + the typing
    // indicator. Re-check before every poll.
    if (!probeNativeChannelDown(SESSION, PROVIDER)) {
      logger.info('channel-coordinator: native channel back UP, yielding to native (-> idle)')
      state = 'idle'; downStreak = 0
      continue
    }

    let updates: { update_id: number }[]
    try {
      updates = await getUpdates(token, (await getOffset(SOURCE)) + 1, LONGPOLL_TIMEOUT_SEC, POLL_LIMIT)
      transientAttempt = 0
    } catch (err) {
      if (stopping) break
      if (err instanceof TelegramApiError && err.kind === 'fatal') { await fatalExit(err) }
      // 409 during backfill = the native grabbed the slot back. This is the
      // EXPECTED end-of-window signal, not an error: yield immediately, no
      // storm machinery, no tight loop. Set the cooldown -- the 409 proves the
      // native is up, so suppress re-entry even if the liveness probe keeps
      // reading DOWN (reparented poller / missing bot.pid false-negative).
      if (err instanceof TelegramApiError && err.kind === 'conflict') {
        nativeConfirmedUpUntil = Date.now() + NATIVE_409_COOLDOWN_MS
        logger.info({ cooldownMs: NATIVE_409_COOLDOWN_MS }, 'channel-coordinator: 409 during backfill -- native owns the slot again, cooldown set, yielding (-> idle)')
        state = 'idle'; downStreak = 0
        continue
      }
      if (err instanceof TelegramApiError && err.kind === 'rate_limit') {
        await sleep((err.retryAfterSec ?? 5) * 1000)
        continue
      }
      // transient (5xx / network / unexpected): exponential backoff, stay in backfilling
      await sleep(transientBackoffMs(Math.min(++transientAttempt, 6)))
      continue
    }

    if (updates.length === 0) continue // long-poll timed out; re-loop re-checks liveness

    // YIELD-BEFORE-HANDOFF: re-check the native did not just recover. If it did,
    // DISCARD this batch (do NOT hand off, do NOT advance the offset) and yield
    // -- the native will deliver these from its own offset. This closes the
    // recovery-overlap double-delivery window.
    if (!probeNativeChannelDown(SESSION, PROVIDER)) {
      logger.info({ batch: updates.length }, 'channel-coordinator: native recovered mid-batch, discarding + yielding (native will deliver)')
      state = 'idle'; downStreak = 0
      continue
    }

    const maxUpdateId = await processBatch(updates)
    // Persist offset ONLY after the batch is durable + handed off.
    if (maxUpdateId != null) await setOffset(SOURCE, maxUpdateId)
    // A batch that stopped at a failed insert asks Telegram for the same updates on the next poll, which answers at once: wait
    // first (the same backoff as a transient poll error), or a database that is down becomes a tight loop.
    // The attempt number is the insert-failure streak, NOT transientAttempt: a successful getUpdates (which precedes every such
    // batch) resets that one to 0, so it would never grow and the backoff would stay at its first step.
    if (lastBatchStoppedOnFailure()) await sleep(transientBackoffMs(Math.min(insertFailStreakValue(), 6)))
  }
}

// ---- bootstrap -----------------------------------------------------------

function installSignalHandlers(): void {
  const onSignal = (sig: string) => {
    if (stopping) return
    stopping = true
    logger.info({ sig }, 'channel-coordinator: shutting down')
    setTimeout(() => {
      releaseLock()
      // the pool ends (PostgreSQL) or the file closes (SQLite) before the exit; a failing close must not keep the unit alive
      void closeCoordinatorDb()
        .catch((err: unknown) => logger.warn({ err }, 'channel-coordinator: database close failed during shutdown'))
        .finally(() => process.exit(0))
    }, 3000)
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))
}

export async function main(): Promise<void> {
  const token = readToken()
  acquireSingleInstanceLock()
  await bootCoordinatorDb()
  installSignalHandlers()
  logger.info({ stateDir: STATE_DIR, session: SESSION, provider: PROVIDER }, 'channel-coordinator: started in BACKFILL mode (idle while native is up)')
  await runLoop(token)
  releaseLock()
  await closeCoordinatorDb()
}
