// Split from the former monolithic src/web/agent-process.ts (775).

import { channelStateDir, readChannelToken } from '../channel-provider.js'
import { CHANNEL_PROVIDER } from '../config.js'
import { logger } from '../logger.js'
import { notifyChannel } from '../notify.js'
import { decideSubmitFollowup, detectPaneState, detectsPastePlaceholder, idleConsideringDimGhost, paneLooksIdle, paneShowsContextSaturation, parkedClearSequence, parkedInputRowCount, parkedInputText, shouldClearTruncatedPreamble, stripGhostSuggestion } from '../pane-state.js'
import { makeLazyBinResolver } from '../platform.js'
import { agentDir, readAgentChannelProvider, readAgentRemoteHost } from './agent-config.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { tryAcquireSessionSendLane, type SendLockMode, withSessionSendLock } from './session-send-lock.js'
import { buildTmuxInvocation, classifyRunState, classifyRunStateFromExit, ensureControlDir, sessionInList, type AgentRunState } from './ssh-tmux.js'
import { parseTelegramToken } from './telegram.js'
import { execFileSync, execSync } from 'node:child_process'
import { join } from 'node:path'
import { resolveAgentProvider } from './agent-process-config.js'
import { dismissModelConsentDialogIfPresent, dismissResumeSummaryModalIfPresent, dismissSurveyModalIfPresent } from './agent-process-identity.js'

export const tmuxBin = makeLazyBinResolver('tmux')
export const claudeBin = makeLazyBinResolver('claude')

// Shared async pacing helper. Replaces the blocking synchronous `/bin/sleep`
// (execFileSync) pauses in the tmux-driving injection hot-path so a pacing wait
// no longer parks the libuv event loop (the dashboard-accepts-TCP-but-never-
// services-HTTP-under-load starvation). Never throws.
export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}


// Pure: compute the enabledPlugins map for a sub-agent so that exactly its own
// channel plugin is enabled and every other channel plugin is disabled.
// Non-channel plugins in `existing` are preserved untouched.
//
// `explicitProvider` MUST be the agent's EXPLICIT per-agent channelProvider
// (readAgentChannelProvider), or null when unset -- NOT the resolved provider.
// resolveAgentProvider() defaults an agent with no channelProvider to the global
// CHANNEL_PROVIDER (telegram), and a legacy-token fallback then marks it
// hasChannel -- so EVERY channel-less sub-agent (boni/deeper/iris/zara/samu) is
// launched with --channels plugin:telegram and would keep the dup poller. Keying
// on the EXPLICIT provider means a channel-less agent (null) disables all three;
// only an agent that genuinely declares its channel (e.g. slacker=slack) keeps
// its own plugin.
export function agentSessionName(name: string): string {
  return `agent-${name}`
}

/**
 * POSIX single-quote a value for safe interpolation into a shell command STRING (card b7fa5281).
 *
 * The agent launch is a shell string tmux runs (`new-session -d -s <s> <cmd>`), and the model id --
 * which the operator controls via the dashboard -- was interpolated as `'${model}'`. Single-quoting
 * made a `:` safe but not a `'`: `x'; curl ... | sh; echo '` closed the quote and injected a command.
 * Wrapping in single quotes with each embedded `'` rewritten as `'\''` makes ANY value a single inert
 * shell word. This is defence #2 at the sink; the model-id allowlist (model-id.ts) is defence #1.
 */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// All tmux operations route through these two wrappers so the local-vs-remote
// (ssh) decision and the quoting live in ONE place (ssh-tmux.ts). host=null is
// byte-identical to the prior direct local tmux call. Remote calls get a larger
// default timeout because an ssh round-trip (handshake + remote exec) is slower
// than a local fork; ServerAlive/ConnectTimeout in SSH_OPTS bound a dead host.
export function runTmux(host: string | null, tmuxArgs: string[], opts: { timeout?: number } = {}): void {
  // Ensure the private ControlMaster socket dir exists before ANY remote ssh
  // call (idempotent, ~free). Without this a watcher-first remote call after a
  // marveen restart would lose connection multiplexing and re-handshake each tick.
  if (host) ensureControlDir()
  const inv = buildTmuxInvocation(host, tmuxBin(), tmuxArgs)
  // stdio: capture the child's stderr into the thrown error instead of letting
  // execFileSync's default inherit it to the parent stderr. A restarting agent
  // makes tmux emit `can't find session: agent-X` / `no server running`; without
  // this those leaked as ~450 bare (non-pino) lines into store/dashboard.log.
  // Callers that care read err.stderr via logger.warn({ err }).
  execFileSync(inv.file, inv.args, { timeout: opts.timeout ?? (host ? 8000 : 3000), stdio: ['ignore', 'ignore', 'pipe'] })
}

export function captureTmux(host: string | null, tmuxArgs: string[], opts: { timeout?: number } = {}): string {
  if (host) ensureControlDir()
  const inv = buildTmuxInvocation(host, tmuxBin(), tmuxArgs)
  // stdout piped (we return it); stderr piped too so tmux's `can't find session`
  // noise lands in err.stderr on failure rather than the parent stderr / dashboard.log.
  return execFileSync(inv.file, inv.args, { timeout: opts.timeout ?? (host ? 8000 : 3000), encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

// Tri-state run state. For a remote agent a failed list-sessions query is
// 'unreachable' (the session is almost certainly still alive on the laptop --
// an SSH drop must never read as 'stopped', which would trigger a wrong
// auto-restart or a duplicate start). See classifyRunState.
export function agentRunState(name: string): AgentRunState {
  const host = readAgentRemoteHost(name)
  try {
    const out = captureTmux(host, ['list-sessions', '-F', '#{session_name}'])
    return classifyRunState(out, agentSessionName(name), host != null)
  } catch (err) {
    // tmux list-sessions exits non-zero ("no server running") when there are
    // zero sessions -- on a REACHABLE remote that means 'stopped', not
    // 'unreachable'. Only a true ssh transport failure (exit 255 / killed)
    // is unreachable. The exit status carries that distinction.
    const status = (err && typeof err === 'object' && 'status' in err)
      ? (err as { status?: number | null }).status
      : undefined
    return classifyRunStateFromExit(status, host != null)
  }
}

export function isAgentRunning(name: string): boolean {
  return agentRunState(name) === 'running'
}

// Host-aware "does this tmux session exist" check, shared by the message router
// and schedule runner. For a remote agent the list-sessions query runs on the
// laptop over ssh; an ssh failure returns false (the loop retries next tick),
// matching the local "session not found" semantics.
export function sessionExistsOnHost(host: string | null, session: string): boolean {
  try {
    return sessionInList(captureTmux(host, ['list-sessions', '-F', '#{session_name}']), session)
  } catch {
    return false
  }
}

export function getAgentRunningSince(name: string): number | null {
  try {
    const host = readAgentRemoteHost(name)
    const out = captureTmux(host, ['display-message', '-p', '-t', agentSessionName(name), '#{session_created}']).trim()
    const ts = parseInt(out, 10)
    return Number.isFinite(ts) ? ts : null
  } catch {
    return null
  }
}


export function agentHasChannel(name: string): boolean {
  const agentProvider = resolveAgentProvider(name)
  const dir = agentDir(name)
  const agentChannelDir = channelStateDir(agentProvider, dir)
  const token = readChannelToken(agentProvider, join(agentChannelDir, '.env'))
  if (token) return true
  if (agentProvider === 'telegram') return !!parseTelegramToken(name)
  return false
}

// Remote agent launch (ssh). Starts a DETACHED tmux session on the laptop so
// the claude process is a child of the laptop's tmux server -- NOT of sshd --
// and therefore survives any ssh disconnect; an outage only pauses the orchestrator's
// ability to message/observe it. Launch-only + channel-less: the laptop's own
// ~/.claude login and the remote workdir's CLAUDE.md drive behaviour, so none of
// the local channel/token/vault/settings scaffolding applies. Has its own
// tri-state start guard: it refuses on 'unreachable' so a brief outage never
// spawns a duplicate session.
const SUBMIT_RETRY_MAX_ATTEMPTS = 4
// Wait between sending an Enter and re-capturing the pane. Long enough
// for tmux to flush the keystroke into the Claude Code TUI and for
// the TUI to either transition to busy (turn started) or stay idle
// with the parked text (still stuck). Empirically 300ms is past the
// frame-render gap detectPaneState already guards against.
const SUBMIT_RETRY_POLL_MS = 300

// Pre-flight wait-until-idle gate (root-cause fix for the busy-stuck class).
// Before streaming chunks we poll the pane and wait for it to return to the
// 'idle' state. Sending while the target is mid-turn (footer `esc to
// interrupt`) is the condition the stuck-input incidents correlated with: the
// typed text + trailing Enter can be parked in the input box (verbatim or as a
// `[Pasted text #N]` stub) and only "land" much later, so a delegated prompt
// sits unsubmitted until a human presses Enter. Waiting for idle removes that
// condition for EVERY caller of sendPromptToSession (router, scheduler,
// channel-monitor, /login, worker) rather than relying on each caller to gate
// itself -- and it closes the check->send TOCTOU gap where a caller's own
// readiness check passed but the agent started a turn before the bytes landed.
//
// Budget: poll every PANE_IDLE_POLL_MS up to PANE_IDLE_WAIT_TIMEOUT_MS total.
// The timeout is generous on purpose -- it must NOT truncate a legitimately
// long turn into a premature "give up and send anyway". 12s comfortably spans
// the inter-turn gaps and short tool-calls we observe between a turn's visible
// completion and the input box settling, while still bounding the wait so a
// genuinely long-running turn does not block the 5s router / 60s scheduler tick
// indefinitely. On timeout we proceed best-effort: the existing post-send
// retry loop (decideSubmitFollowup) remains the backstop, and a hard-busy
// session that never idles must still receive its prompt eventually.
const PANE_IDLE_WAIT_TIMEOUT_MS = 12_000
const PANE_IDLE_POLL_MS = 300

// Block until the session's pane looks idle, or the budget elapses. Returns
// true if idle was observed, false on timeout-still-busy (caller proceeds
// best-effort). Reuses the shared paneLooksIdle predicate -- the SAME rule the
// readiness check and the auto-restart idle-guard use -- so the busy regex is
// never re-inlined here. A capture failure is treated as "not yet idle" and we
// keep polling within the budget (a transient tmux hiccup should not be read as
// idle and let us blast a prompt into a busy pane).
export async function waitForPaneIdle(
  session: string,
  host: string | null = null,
  timeoutMs: number = PANE_IDLE_WAIT_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pane = capturePane(session, host)
    if (pane != null && paneLooksIdle(pane)) return true
    if (Date.now() >= deadline) return false
    await delay(PANE_IDLE_POLL_MS)
  }
}

// Pre-flight buffer clear, used when shouldClearTruncatedPreamble flags a stale
// preamble. This used to send a single Ctrl-U, which is a no-op whenever the
// cursor sits at offset 0 of the buffer -- the normal state for text that
// arrived via send-keys (see parkedClearSequence). A failed pre-flight clear is
// worse than none: the prompt about to be typed is APPENDED to the stale text
// instead of replacing it, which is how a box accumulates tick after tick until
// nothing can be submitted at all. Keys are sent by name (no `-l` literal flag)
// so tmux interprets them as control sequences.
export async function clearInputBuffer(session: string, host: string | null = null): Promise<void> {
  try {
    const pane = capturePane(session, host)
    for (const key of parkedClearSequence(pane != null ? parkedInputRowCount(pane) : 0)) {
      runTmux(host, ['send-keys', '-t', session, key], { timeout: 5000 })
    }
    // Settle briefly so the next send-keys lands in the freshly cleared
    // buffer rather than racing the clear.
    await delay(100)
  } catch (err) {
    logger.warn({ err, session }, 'Failed to clear pane input buffer before send')
  }
}

// How many Ctrl-C presses the placeholder-discard will attempt before giving
// up. Empirically a single Ctrl-C discards a `[Pasted text #N]` stub (and
// expanded verbatim text) and returns to the empty prompt; the extra presses
// cover a frame race where the first one was eaten mid-render.
const PLACEHOLDER_DISCARD_MAX = 3
// Settle window after a Ctrl-C so the next capture reflects the cleared box.
const PLACEHOLDER_DISCARD_SETTLE_MS = 450

// Discard a `[Pasted text #N]` placeholder (or the verbatim text it expands
// into) from the input box with Ctrl-C, then confirm the box no longer holds
// the placeholder. Ctrl-U is deliberately NOT used: it is proven NOT to clear
// a paste placeholder, and on a multi-row verbatim buffer it only clears the
// row the cursor sits on. Ctrl-C is the only key that reliably empties the box.
//
// SAFETY: Ctrl-C on an EMPTY Claude Code box quits the TUI, and on a BUSY pane
// it interrupts the live turn. This helper must therefore only ever be called
// when a placeholder is CONFIRMED present (box non-empty, not busy) -- which
// detectsPastePlaceholder guarantees at the call site. We re-check before each
// press and stop the instant the placeholder is gone, so we never press Ctrl-C
// into an already-empty box. Returns true if the placeholder was cleared.
async function discardPlaceholderBuffer(session: string, host: string | null = null): Promise<boolean> {
  for (let i = 0; i < PLACEHOLDER_DISCARD_MAX; i++) {
    const pane = capturePane(session, host)
    // Stop pressing once the stub is gone -- a further Ctrl-C on an empty box
    // would quit the TUI.
    if (pane != null && !detectsPastePlaceholder(pane)) return true
    try {
      runTmux(host, ['send-keys', '-t', session, 'C-c'], { timeout: 5000 })
    } catch (err) {
      logger.warn({ err, session }, 'discardPlaceholderBuffer: Ctrl-C send failed')
      return false
    }
    await delay(PLACEHOLDER_DISCARD_SETTLE_MS)
  }
  const finalPane = capturePane(session, host)
  return finalPane != null && !detectsPastePlaceholder(finalPane)
}

// Send text to a tmux session as if typed at the prompt.
// Uses execFileSync so callers can pass raw text -- tmux send-keys -l treats
// the argument as literal characters, bypassing shell quoting entirely.
//
// Pre-flight: if the live input box already shows a stale preamble from
// a previous wrapped message that never fully landed (shouldClearTrun-
// catedPreamble), Ctrl-U the buffer first so a fresh prompt is not
// concatenated onto the stale trust-marker. Skipping this guard would
// let an UNTRUSTED payload sit behind a stale TEAM MEMBER NOTICE
// preamble and read as if it came from a trusted peer.
//
// Post-flight: bracketed-paste detection and frame-level races in the
// Claude Code TUI occasionally swallow the trailing Enter, leaving the
// fully written prompt parked in the input box (either as a [Pasted
// text #N] placeholder or as verbatim text under an idle footer). We
// re-sample the pane after the initial Enter and, if shouldRetrySubmit
// still reports stuck, send up to SUBMIT_RETRY_MAX_ATTEMPTS extra
// Enters. The retry budget bounds the loop so a pathologically stuck
// pane gives up rather than spinning.
export async function sendPromptToSession(
  session: string,
  text: string,
  host: string | null = null,
  opts: { waitForIdle?: boolean; onBusyTimeout?: 'send' | 'abort'; idleTimeoutMs?: number; lockMode?: SendLockMode } = {},
): Promise<'sent' | 'aborted-busy' | 'skipped-locked'> {
  const lockMode: SendLockMode = opts.lockMode ?? 'deliver'
  // PANEWRITERS805: the three modal dismissals are probe+act keystroke writers
  // that ran BEFORE the lane lock -- so they could press Escape/Enter into a
  // pane mid-delivery (an Enter on the model-consent dialog confirms its
  // DEFAULT, the FABLEFALL1 model switch). They must stay BEFORE the idle gate
  // (a modal keeps the pane non-idle, so dismiss-after-wait would always time
  // out), so they get their own fail-closed acquire instead of moving into the
  // emit span. Skipping on a busy lane is safe: if a modal is really up, the
  // idle gate below times out and the emit still queues behind the holder.
  // 'held' callers already own the lane -- acquiring again would deadlock.
  if (lockMode === 'held') {
    await dismissSurveyModalIfPresent(session, host)
    await dismissResumeSummaryModalIfPresent(session, host)
    await dismissModelConsentDialogIfPresent(session, host)
  } else {
    const releaseDismissLane = tryAcquireSessionSendLane(session, host)
    if (releaseDismissLane) {
      try {
        await dismissSurveyModalIfPresent(session, host)
        await dismissResumeSummaryModalIfPresent(session, host)
        await dismissModelConsentDialogIfPresent(session, host)
      } finally {
        releaseDismissLane()
      }
    } else {
      logger.info({ session }, 'sendPromptToSession: modal dismissals skipped -- a delivery holds this pane send lane (fail-closed); emit will queue behind it')
    }
  }

  // Pre-flight wait-until-idle (root-cause gate). Placed here -- inside
  // sendPromptToSession, AFTER the modal dismissals (a modal keeps the pane
  // non-idle, so we must clear it first or the wait would always time out) and
  // BEFORE the truncated-preamble check + chunk-send -- so EVERY caller is
  // protected by default and the live input box we inspect/clear below reflects
  // a settled, idle pane. On timeout we fall through and send anyway: a session
  // that never idles must still receive its prompt, and the post-send retry
  // loop is the backstop. host is threaded so a remote agent's pane is polled
  // over ssh.
  //
  // opts.waitForIdle defaults to true (the gate is ON for every caller). The
  // forceSend scheduled-task path opts OUT (waitForIdle:false): forceSend is
  // documented to skip the busy-state check so a task does NOT pile up retries
  // against a session that stays busy for hours (the overnight 275-retry loop).
  // Eating the 12s idle wait here would defeat that contract -- the whole point
  // of forceSend is to inject regardless and let Claude Code queue it.
  // opts.onBusyTimeout selects what a timed-out idle wait means. The default
  // 'send' keeps the historical contract (a session that never idles must
  // still receive its prompt eventually -- router/scheduler messages MUST
  // deliver). 'abort' is for OPTIONAL prompts (the inbox-nudge watcher): a
  // nudge typed into a busy pane would park in the input box, and a parked
  // multi-row line on the MAIN channels session has no automatic recovery --
  // better to send nothing and let the caller retry on its own cadence.
  // opts.idleTimeoutMs lets such callers use a short budget instead of the
  // default 12s (they already confirmed idleness moments ago).
  const waitForIdle = opts.waitForIdle !== false
  if (waitForIdle && !(await waitForPaneIdle(session, host, opts.idleTimeoutMs))) {
    if (opts.onBusyTimeout === 'abort') {
      logger.info({ session }, 'sendPromptToSession: pane busy past idle budget; aborting per caller policy (no keystrokes sent)')
      return 'aborted-busy'
    }
    logger.warn({ session }, 'sendPromptToSession: pane still busy after wait-until-idle budget; sending best-effort')
  }

  // DELIVLOCK805: everything from here to `return 'sent'` EMITS keystrokes into
  // the pane (preamble-clear, chunk stream, submit-retry loop). Two writers
  // interleaving this span splice foreign text into one framed message, so it
  // is the per-session critical section. Held under a per-pane in-process mutex
  // (session-send-lock): normal delivery is fail-open (a stuck holder must not
  // silence the fleet); a `recover` caller skips instead of racing a live send.
  const emitToPane = async (): Promise<'sent'> => {
  // Pre-flight buffer-clear when a stale preamble is detected. Reading
  // the pane is best-effort: a capture failure here means we cannot
  // prove the buffer is clean, but proceeding without the clear is no
  // worse than the pre-fix status quo.
  try {
    const preCapture = captureTmux(host, ['capture-pane', '-t', session, '-p'])
    if (shouldClearTruncatedPreamble(preCapture)) {
      logger.info({ session }, 'Cleared stale preamble from input buffer before sending prompt')
      await clearInputBuffer(session, host)
    }
  } catch (err) {
    logger.warn({ err, session }, 'Pre-send capture-pane failed; skipping truncated-preamble check')
  }

  const oneLine = text.replace(/\r?\n/g, ' ')
  const CHUNK = 80
  // Stream oneLine into the pane as CHUNK-sized literal send-keys writes,
  // followed by a submitting Enter. Extracted as a closure so the
  // clear-and-resend recovery path below can replay the EXACT same byte
  // stream after a Ctrl-C, rather than duplicating the dash-slide logic.
  //
  // tmux send-keys doesn't support `--` option-terminator, so a chunk that
  // starts with '-' parses as a flag ("command send-keys: unknown flag -s"
  // on Hungarian suffixes like -szal/-vel/-ban). Slide the boundary up to a
  // few chars past any '-' that lands at the start of the next chunk. Capped
  // so a long run of dashes doesn't inflate one chunk past the paste-detector
  // threshold; if the cap is reached, prepend a space to the chunk instead.
  const MAX_SLIDE = 8
  const sendChunks = async (): Promise<void> => {
    let i = 0
    while (i < oneLine.length) {
      let end = Math.min(i + CHUNK, oneLine.length)
      let slide = 0
      while (end < oneLine.length && oneLine[end] === '-' && slide < MAX_SLIDE) {
        end++; slide++
      }
      let chunk = oneLine.slice(i, end)
      if (chunk.startsWith('-')) chunk = ' ' + chunk
      runTmux(host, ['send-keys', '-t', session, '-l', chunk], { timeout: 5000 })
      i = end
      if (i < oneLine.length) await delay(30)
    }
    runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
  }
  await sendChunks()

  // Post-send retry loop. The payload hint is the first chunk of oneLine
  // (truncated to a safe length) so the verbatim-stuck path has something
  // recognisable to substring-match against without leaking the whole
  // prompt body into log lines should the give-up branch fire.
  //
  // Two stuck modes, two recoveries (see decideSubmitFollowup):
  //   - VERBATIM text parked under an idle footer -> a plain Enter submits it
  //     ('retry-enter').
  //   - A `[Pasted text #N]` placeholder -> a plain Enter does NOT submit it
  //     (proven: Enter only expands the stub to still-parked verbatim text,
  //     and once the text spans multiple visual rows a plain Enter inserts a
  //     newline rather than submitting). The placeholder forms when several
  //     chunks coalesce into one >~700-char PTY read under tmux-server
  //     contention, tripping the TUI's bracketed-paste detector. The only
  //     reliable fix is to Ctrl-C the buffer empty and re-send the chunks
  //     ('clear-and-resend'). The same Ctrl-C path also clears an expanded
  //     multi-row verbatim buffer that a plain Enter cannot submit, so a
  //     resend that itself parks is re-cleared and retried until it lands.
  const payloadHint = oneLine.slice(0, Math.min(oneLine.length, 96))
  for (let attempt = 0; ; attempt++) {
    await delay(SUBMIT_RETRY_POLL_MS)
    const pane = capturePane(session, host)
    const action = decideSubmitFollowup(pane, payloadHint, attempt, SUBMIT_RETRY_MAX_ATTEMPTS)
    if (action === 'done') break
    if (action === 'give-up') {
      logger.warn({ session, attempt }, 'sendPromptToSession: prompt still parked after retries')
      break
    }
    if (action === 'clear-and-resend') {
      // Placeholder confirmed in the pane (box non-empty, not busy), so the
      // Ctrl-C in discardPlaceholderBuffer is safe. Clear it, then replay the
      // chunk stream. The loop re-samples on the next iteration and will keep
      // recovering (or give up at the budget) if the resend itself parks.
      logger.info({ session, attempt }, 'sendPromptToSession: paste placeholder detected; clearing and re-sending')
      if (!(await discardPlaceholderBuffer(session, host))) {
        logger.warn({ session, attempt }, 'sendPromptToSession: failed to clear paste placeholder before resend')
      }
      try {
        await sendChunks()
      } catch (err) {
        logger.warn({ err, session, attempt }, 'Clear-and-resend chunk replay failed')
        break
      }
      continue
    }
    // action === 'retry-enter'
    try {
      runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    } catch (err) {
      logger.warn({ err, session, attempt }, 'Retry-Enter send failed')
      break
    }
  }
    return 'sent'
  }

  // 'held': the caller already owns this pane's lane (e.g. the stuck-input
  // recovery clears + re-injects as ONE recover-mode critical section). Re-
  // acquiring the same lane here would deadlock against ourselves, so emit
  // directly.
  if (lockMode === 'held') {
    return emitToPane()
  }

  const lockResult = await withSessionSendLock(session, host, lockMode, emitToPane)
  if (!lockResult.ran) {
    // recover mode + lane busy: a delivery is mid-flight into this pane. Do NOT
    // race it (we would clear or submit the wrong buffer). Skip this round and
    // say so out loud -- a skip nobody logs is not a skip.
    logger.info({ session }, 'sendPromptToSession: pane delivery in progress; recover-mode send skipped this round')
    return 'skipped-locked'
  }
  if (lockResult.failedOpen) {
    // Fail-open: the wait budget elapsed against a stuck holder and we wrote
    // without the lock. Delivery still happened; log loudly so a wedged holder
    // is visible rather than silently degrading into re-interleaving.
    logger.warn({ session }, 'sendPromptToSession: delivery lock wait budget elapsed; sent WITHOUT the per-pane lock (fail-open) -- a holder may be wedged')
  }
  return 'sent'
}

// How long to wait between the two capture samples when the first one
// looks idle. The Claude Code UI renders the "idle footer without `esc
// to interrupt`" line for ~1 frame after a turn submits before the
// spinner lands; a quarter-second settle window is well past that.
const PANE_READY_CONFIRM_DELAY_MS = 250

// Send a bare Enter to a session. Used by the stuck-input watcher to
// re-submit a prompt whose trailing Enter was swallowed on the channel-
// notification path (where the plugin, not sendPromptToSession, delivered
// the text, so the post-send retry budget never ran). Best-effort: a
// tmux failure is logged and swallowed so the watcher loop keeps going.
export function sendEnterToSession(session: string, host: string | null = null): boolean {
  try {
    runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    return true
  } catch (err) {
    logger.warn({ err, session }, 'sendEnterToSession: failed to send recovery Enter')
    return false
  }
}

// Capture a pane snapshot with an execSync timeout. Null on any error so
// the caller can treat "capture failed" as "not ready".
export function capturePane(session: string, host: string | null = null): string | null {
  try {
    return captureTmux(host, ['capture-pane', '-t', session, '-p'])
  } catch {
    return null
  }
}

// Capture a pane for STUCK-INPUT detection, with the editor's dim "ghost
// suggestion" autocomplete removed. Captures WITH colour (`-e`) and strips the
// SGR-2 (dim) ghost + all ANSI, so a hint shown in an empty input box is never
// mistaken for a genuinely parked input. Every auto-submitting recovery path
// (channel-monitor recoverStuckInputForSession, stuck-input-watcher
// bareEnterRecovery) MUST read the pane through THIS, not plain capturePane --
// otherwise the dim ghost reads as real text and gets re-typed + Enter-
// submitted (phantom prompt-injection, 2026-06-26). Returns null on capture
// failure (treated as "nothing parked"), matching capturePane's contract.
export function captureParkedInputView(session: string, host: string | null = null): string | null {
  try {
    return stripGhostSuggestion(captureTmux(host, ['capture-pane', '-t', session, '-e', '-p']))
  } catch {
    return null
  }
}

// Check if a Claude Code tmux session is ready to accept a new prompt.
//
// The detection has two layers, both needed to close the frame-level
// false-positive that let PR1+PR2's smoke test fire a prompt into a pane
// that was actually mid-thinking:
//
//   1. detectPaneState() looks for a set of turn-scoped busy signals
//      (spinner glyph labels paired with the runtime tail, token-count
//      pattern, and the footer's `esc to interrupt` marker) so even the
//      single frame where the footer lacks `· esc to interrupt` is
//      classified busy by the spinner that is already rendered above
//      the input box.
//
//   2. Double-sample confirmation: if the first capture looks idle, we
//      sleep 250ms and re-capture. Only agreement from both samples
//      returns true. Cost on the ready path: ~250ms sleep plus a second
//      tmux capture-pane round-trip (typically tens of ms). Busy pass
//      through layer 1 and return immediately without the delay.
//
// A saturated pane ("100% context used") is refused up front: it can present
// as perfectly idle, so without this a new prompt would be dispatched into a
// session that cannot act on it. We only log/audit the refusal here; recovery
// is the context-guard runner's saturation net (fresh restart -- see
// src/web/context-guard-runner.ts), so this predicate stays a pure,
// dependency-free readiness check. NOTE the refusal is part of a deadlock by
// design: Claude Code's auto-compact only runs when a new turn starts, and
// this refusal is exactly what prevents a new turn -- so a saturated session
// never self-heals and MUST be restarted from outside.
export async function isSessionReadyForPrompt(session: string, host: string | null = null): Promise<boolean> {
  // Dim-ghost tolerant idle read: CC >=2.1.202 paints a dim placeholder into
  // the empty input box, which a plain capture reads as parked text. Only when
  // the plain view says 'typing' do we pay for the second (-e, dim-stripped)
  // capture to decide whether anything REAL is parked (see
  // idleConsideringDimGhost / captureParkedInputView).
  const idleOrGhost = (plain: string): boolean =>
    idleConsideringDimGhost(plain, detectPaneState(plain) === 'typing' ? captureParkedInputView(session, host) : null)
  const first = capturePane(session, host)
  if (first == null) return false
  if (paneShowsContextSaturation(first)) {
    logger.warn({ session }, 'dispatch: refusing prompt — session shows context saturation (100% context)')
    return false
  }
  if (!idleOrGhost(first)) return false

  await delay(PANE_READY_CONFIRM_DELAY_MS)

  const second = capturePane(session, host)
  if (second == null) return false
  if (paneShowsContextSaturation(second)) {
    logger.warn({ session }, 'dispatch: refusing prompt — session shows context saturation (100% context)')
    return false
  }
  return idleOrGhost(second)
}

// How long to wait between the two parked-input captures when deciding whether
// the input box is STUCK (stale) vs being actively typed. Identical parked text
// across this gap means nobody is typing -> it is a stranded artifact.
const PARKED_STABLE_CONFIRM_MS = 2000
// Settle after a batch of clearing keystrokes so the next capture reflects the
// emptied box.
const PARKED_CLEAR_SETTLE_MS = 300
// How often to re-capture while working through parkedClearSequence(): often
// enough that a box which empties early stops right away, rarely enough that the
// settle delay is not paid per keystroke.
const PARKED_CLEAR_RECHECK_EVERY = 8
// A parked input that resists clearing must NOT be retried on every router tick:
// each attempt awaits ~PARKED_STABLE_CONFIRM_MS on the settle
// delay, so a permanently-stuck box would otherwise starve the loop, stall the HTTP server
// (health probes read 000) and drive the watchdog into a dashboard restart loop.
// Retry the SAME stuck text at most once per this window, per session.
const UNWEDGE_COOLDOWN_MS = 30_000
// Escalate to the operator (NOTIFY only -- a Telegram message, never a
// keystroke) once per stuck episode after this many consecutive confirmed-stuck
// detections (~one per UNWEDGE_COOLDOWN_MS). The main agent escalates sooner
// because its box is NEVER auto-cleared (the parked line may be a real reply),
// so escalation is the only recovery; a sub-agent escalates only after the
// auto-clear has genuinely failed several times.
const SUBAGENT_PARKED_ESCALATE_AFTER = 6  // ~3min for a sub-agent whose auto-clear keeps failing
// MAINBOXPARK816: two-stage escalation for the (never-cleared) main box. Each
// fails increment costs one UNWEDGE_COOLDOWN_MS round, so 6 = ~3 min visible to
// the heartbeat, 12 = ~6 min -> the owner's phone as the FINAL stage (double
// the first threshold, per the spec).
export const MAIN_PARKED_HEARTBEAT_AFTER = 6
export const MAIN_PARKED_OWNER_AFTER = 12

// Pure decision, exported for tests: which escalation stage applies. 'owner'
// fires once per episode (ownerNotified latches via the record's escalated
// flag); afterwards the state stays 'heartbeat'-visible until the box clears.
export function decideMainParkedEscalation(
  fails: number,
  ownerNotified: boolean,
): 'none' | 'heartbeat' | 'owner' {
  if (fails >= MAIN_PARKED_OWNER_AFTER && !ownerNotified) return 'owner'
  if (fails >= MAIN_PARKED_HEARTBEAT_AFTER) return 'heartbeat'
  return 'none'
}

// MAINBOXPARK816 stage-1 surface: the heartbeat round (same process) reads this
// and puts the fact into its prompt -- deliberately NOT the inter-agent queue,
// because a message queued to the main agent would strand behind the very
// parked text it reports. Returns null when there is no FRESH parked episode
// (last attempt older than two cooldown windows = the box cleared or the
// router stopped observing it).
export function getMainParkedState(nowMs: number = Date.now()):
  | { preview: string; fails: number; approxMinutes: number }
  | null {
  const rec = unwedgeAttempts.get('local:' + MAIN_CHANNELS_SESSION)
  if (!rec || rec.fails < MAIN_PARKED_HEARTBEAT_AFTER) return null
  if (nowMs - rec.last > 2 * UNWEDGE_COOLDOWN_MS + PARKED_STABLE_CONFIRM_MS) return null
  return {
    preview: rec.sig.slice(0, 80),
    fails: rec.fails,
    approxMinutes: Math.round((rec.fails * UNWEDGE_COOLDOWN_MS) / 60000),
  }
}
// Per-session record of the last un-wedge attempt: when, on what text, how many
// consecutive attempts failed to empty the box, and whether we already notified
// the operator for this exact stuck text (one-shot; resets when sig/clears).
const unwedgeAttempts = new Map<string, { last: number; sig: string; fails: number; escalated: boolean }>()

// Un-wedge a session whose input box holds STALE parked text: a non-submitted
// line (e.g. a weak local model that typed its heartbeat reply into the box
// instead of ending the turn). Parked text makes isSessionReadyForPrompt()
// false forever, so every inbound message strands as pending and the channel
// goes silent with no recovery. Acts ONLY when the pane is 'typing' (idle WITH
// parked text -- never 'busy'/processing) AND the text is unchanged across a
// short settle, so input a human or agent is actively typing is never clobbered.
// Returns true if it cleared something (caller should retry delivery next tick).
export async function clearStaleParkedInput(session: string, host: string | null = null): Promise<boolean> {
  const a = capturePane(session, host)
  if (a == null || detectPaneState(a) !== 'typing') return false
  // DIM-GUARD (2026-06-30, Szabi insight): extract the parked TEXT from the
  // dim-stripped (-e) view. Ghost/phantom frames -- stale captures, placeholder
  // hints, a persona fragment left by a send-keys delivery (the "Koszi a halakat."
  // false-positive) -- render DIM (SGR-2 faint) and are stripped by
  // captureParkedInputView, so they read as NO parked text and are never treated
  // as a wedge (no clear, no escalate). Only a REAL typed line (normal intensity)
  // survives the strip. Falls back to the plain capture only if the -e capture
  // fails (rare), preserving prior behaviour in that edge case.
  const parked = parkedInputText(captureParkedInputView(session, host) ?? a)
  if (!parked) return false

  // Cooldown guard FIRST, before any blocking sleep: if the same parked text was
  // attempted within the cooldown window, bail in microseconds. This is what
  // keeps a stubborn box from starving the event loop on every router tick --
  // the root cause of the dashboard crash-loop (constant ~2s blocking sleeps ->
  // HTTP 000 -> watchdog restart -> re-wedge on the same persisted input).
  const key = (host ?? 'local') + ':' + session
  const nowMs = Date.now()
  const prev = unwedgeAttempts.get(key)
  if (prev && prev.sig === parked && nowMs - prev.last < UNWEDGE_COOLDOWN_MS) return false

  await delay(PARKED_STABLE_CONFIRM_MS)
  const b = capturePane(session, host)
  // Changed (someone is typing) or already cleared -> leave it alone, and do not
  // record an attempt (this was never a stuck box). Compare on the SAME dim-
  // stripped view as the initial extraction so a dim ghost can't flip the result.
  if (b == null || detectPaneState(b) !== 'typing' || parkedInputText(captureParkedInputView(session, host) ?? b) !== parked) return false

  // The main agent's input box is NEVER auto-cleared (a parked line could be a
  // real reply -- the 2026-06-30 "Balogh" near-miss). That stays absolute.
  //
  // MAINBOXPARK816 (2026-08-16): the total MUTE is gone, because its premise
  // aged out. The 2026-06-30 mute existed for dim ghost-frame noise -- but the
  // dim-guard above now strips ghosts BEFORE this branch, so a line that gets
  // here is normal-intensity, 2s-stable, REAL text. And a parked main box is
  // exactly the state that silences the channel UNSUPERVISED: every sub-agent
  // gets an auto-heal for this, only the main agent got silence. Two-stage
  // escalation, never a keystroke:
  //   stage 1 (fails >= MAIN_PARKED_HEARTBEAT_AFTER, ~3 min): WARN log + the
  //     state is exposed via getMainParkedState() so the heartbeat round's
  //     prompt carries it (same process; NOT the inter-agent queue -- an alert
  //     queued to the main agent would strand BEHIND the very text it reports).
  //   stage 2 (fails >= MAIN_PARKED_OWNER_AFTER, ~6 min, one-shot/episode):
  //     notifyChannel direct to the owner (pure HTTP, does not touch the box)
  //     with the CONCRETE manual fix -- a message actionable in seconds, not
  //     "something is wrong".
  if (session === MAIN_CHANNELS_SESSION) {
    const fails = (prev && prev.sig === parked ? prev.fails : 0) + 1
    let escalated = !!(prev && prev.sig === parked && prev.escalated)
    const stage = decideMainParkedEscalation(fails, escalated)
    if (stage === 'owner') {
      const preview = parked.slice(0, 80).replace(/[<>&]/g, ' ')
      notifyChannel(
        `🚨 A fo agens (${session}) input-mezojeben ~${Math.round((fails * UNWEDGE_COOLDOWN_MS) / 60000)} perce all egy parkolt sor, ` +
        `es emiatt a csatorna nem dolgoz fel bejovo uzenetet. KEZI FELOLDAS (par masodperc): ` +
        `tmux attach -t ${session}, majd Ctrl-C es utana Ctrl-U (a sor torlese), vegul kilepes: Ctrl-B d. ` +
        `A parkolt sor eleje: "${preview}"`,
      ).catch(() => { /* notify is best-effort */ })
      escalated = true
      logger.warn({ session, parked: parked.slice(0, 60), fails }, 'message-router: main-agent parked input -- owner notified with manual fix (box untouched)')
    } else if (stage === 'heartbeat') {
      logger.warn({ session, parked: parked.slice(0, 60), fails }, 'message-router: main-agent parked input -- persisting; visible to the heartbeat round (box untouched)')
    } else {
      logger.debug({ session, parked: parked.slice(0, 60), fails }, 'message-router: main-agent parked input -- left untouched')
    }
    unwedgeAttempts.set(key, { last: nowMs, sig: parked, fails, escalated })
    return false
  }

  // Forward deletion, budgeted by the visible row count -- see the rationale and
  // the 2026-08-01 measurement above parkedClearSequence(). The cursor sits at
  // offset 0 of the buffer, so the previous Ctrl-U rounds were no-ops and the
  // single C-a + C-k escalation could only ever strip ONE line off a multi-line
  // box. Re-check every few keystrokes so a box that empties early stops
  // immediately instead of spending the whole budget.
  const sequence = parkedClearSequence(parkedInputRowCount(a))
  for (let i = 0; i < sequence.length; i++) {
    runTmux(host, ['send-keys', '-t', session, sequence[i]], { timeout: 5000 })
    if (i % PARKED_CLEAR_RECHECK_EVERY === PARKED_CLEAR_RECHECK_EVERY - 1) {
      await delay(PARKED_CLEAR_SETTLE_MS)
      const after = capturePane(session, host)
      if (after == null || detectPaneState(after) !== 'typing') break
    }
  }
  await delay(PARKED_CLEAR_SETTLE_MS)

  // Verify the box is ACTUALLY empty before claiming success: only then is the
  // pending message safe to deliver next tick. Otherwise record the failure so
  // the cooldown guard above backs us off instead of hammering every tick.
  const final = capturePane(session, host)
  const stillStuck = final != null && detectPaneState(final) === 'typing' && parkedInputText(final) === parked
  if (stillStuck) {
    const fails = (prev && prev.sig === parked ? prev.fails : 0) + 1
    let escalated = !!(prev && prev.sig === parked && prev.escalated)
    // A sub-agent box that resists the Ctrl-U clear this many times is genuinely
    // wedged (not the usual junk heartbeat line the auto-clear handles) -- surface
    // it to the operator ONCE so it cannot stall silently like the 1h main-agent
    // incident did behind a lone WARN.
    if (!escalated && fails >= SUBAGENT_PARKED_ESCALATE_AFTER) {
      const preview = parked.slice(0, 80).replace(/[<>&]/g, ' ')
      notifyChannel(
        `⚠️ Egy sub-agent (${session}) input-mezojebe beragadt egy parkolt sor, ` +
        `az auto-tisztitas ${fails}x sikertelen -- lehet kezi beavatkozas kell. Reszlet: "${preview}"`,
      ).catch(() => { /* notify is best-effort */ })
      escalated = true
      logger.warn({ session, parked: parked.slice(0, 60), fails }, 'message-router: sub-agent parked input resisted clearing -- escalated to operator')
    }
    unwedgeAttempts.set(key, { last: nowMs, sig: parked, fails, escalated })
    logger.warn({ session, parked: parked.slice(0, 60), fails }, 'message-router: parked input resisted clearing, backing off')
    return false
  }
  unwedgeAttempts.set(key, { last: nowMs, sig: parked, fails: 0, escalated: false })
  logger.warn({ session, parked: parked.slice(0, 60) }, 'message-router: cleared stale parked input (channel un-wedge)')
  return true
}
