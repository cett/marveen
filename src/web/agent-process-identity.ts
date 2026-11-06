// Split from the former monolithic src/web/agent-process.ts (775).

import { logger } from '../logger.js'
import { notifyChannel } from '../notify.js'
import { detectPaneState, detectsExternalImportsDialog, detectsFirstRunGate, detectsModelConsentDialog, type FirstRunGateKind } from '../pane-state.js'
import { stampFableOverageConsent } from './agent-process-config.js'
import { capturePane, captureTmux, delay, isSessionReadyForPrompt, runTmux, sendPromptToSession } from './agent-process-session.js'
import { startAgentProcess } from './agent-process-spawn.js'
import { tryAcquireSessionSendLane } from './session-send-lock.js'

const SURVEY_MODAL_RX = /How is Claude doing this session/
// The rating modal is drawn at the bottom of the live screen. Only the last
// lines count, so a reply or log line that quotes the question higher up never
// makes the dismiss send a stray "0" into the prompt.
const SURVEY_LIVE_REGION_LINES = 12

export function surveyModalVisible(pane: string): boolean {
  return SURVEY_MODAL_RX.test(pane.split('\n').slice(-SURVEY_LIVE_REGION_LINES).join('\n'))
}

export async function dismissSurveyModalIfPresent(session: string, host: string | null = null): Promise<void> {
  try {
    const pane = captureTmux(host, ['capture-pane', '-t', session, '-p'])
    if (!surveyModalVisible(pane)) return
    runTmux(host, ['send-keys', '-t', session, '0'], { timeout: 5000 })
    // Modal close is one frame; settle window so the next send-keys lands in
    // the prompt input, not the now-stale modal handler.
    await delay(300)
    logger.info({ session }, 'Dismissed Claude Code session-rating modal before sending prompt')
  } catch (err) {
    logger.warn({ err, session }, 'Failed to probe/dismiss session-rating modal')
  }
}

// When a session approaches its context limit Claude Code shows a "Resume from
// summary" modal with three numbered options and footer "Enter to confirm".
// detectPaneState() reads that footer as 'unknown' (not the usual "bypass
// permissions" string), so isSessionReadyForPrompt() refuses to deliver and
// every scheduled task / inter-agent message piles up behind it. Pre-flight
// pick option 1 (Resume from summary, recommended) and Enter to confirm.
const RESUME_SUMMARY_MODAL_RX = /Resume from summary/

export async function dismissResumeSummaryModalIfPresent(session: string, host: string | null = null): Promise<void> {
  try {
    const pane = captureTmux(host, ['capture-pane', '-t', session, '-p'])
    if (!RESUME_SUMMARY_MODAL_RX.test(pane)) return
    runTmux(host, ['send-keys', '-t', session, '1'], { timeout: 5000 })
    await delay(100)
    runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    // /compact starts immediately and can run for minutes; we only need to
    // unblock the modal so detectPaneState can transition off 'unknown'.
    await delay(300)
    logger.info({ session }, 'Dismissed Claude Code resume-from-summary modal before sending prompt')
  } catch (err) {
    logger.warn({ err, session }, 'Failed to probe/dismiss resume-from-summary modal')
  }
}

// Runtime backstop for the model overage-consent dialog ("Fable 5 now uses
// usage credits" -- see detectsModelConsentDialog in pane-state.ts for the
// full anatomy and the drift root cause). The stampFableOverageConsent
// pre-seed normally prevents the dialog entirely; this handler covers the
// windows the seed cannot reach (a config root that had no oauthAccount yet,
// a future consent-key version bump). Unlike the generic dismissals above it
// must NOT send a bare Enter: the dialog's default option SWITCHES the model
// to Sonnet. It actively selects option 1 ("Continue with <configured
// model>") -- number first, then confirm, mirroring answerFirstRunGates. The
// keystrokes only ever fire when the specific dialog is visibly on screen
// (pure detector, quoted-text-proof), so this adds no blind-injection surface.
export async function dismissModelConsentDialogIfPresent(session: string, host: string | null = null): Promise<void> {
  try {
    const pane = captureTmux(host, ['capture-pane', '-t', session, '-p'])
    if (!detectsModelConsentDialog(pane)) return
    runTmux(host, ['send-keys', '-t', session, '1'], { timeout: 5000 })
    await delay(150)
    runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
    await delay(300)
    logger.info({ session }, 'Answered model usage-credit consent dialog: kept the configured model (option 1, never the switch default)')
  } catch (err) {
    logger.warn({ err, session }, 'Failed to probe/answer model usage-credit consent dialog')
  }
}

// Walk a session out of the Claude Code FIRST-RUN dialog chain (folder-trust,
// bypass-permissions acceptance, theme picker, welcome screen), answering each
// dialog exactly the way scripts/channels.sh's startup guard does for the main
// session: trust -> "1" Enter (Yes, proceed), bypass -> "2" Enter (Yes, I
// accept), theme/welcome -> Enter (accept default / continue). The login
// picker is NEVER answered -- nobody can authenticate on the operator's
// behalf -- so it is returned for the caller to alert on.
//
// Escape is deliberately NOT used anywhere here: on the trust/bypass dialogs
// Escape selects "No, exit" and quits the TUI, which is exactly the
// respawn-loop failure the channel-monitor's generic menu recovery would cause
// on these panes (hence the detectsFirstRunGate carve-out at its call site).
//
// Bounded walk: the chain is at most a handful of dialogs; each answered
// dialog gets a settle delay before the re-capture. Returns 'cleared' when at
// least one dialog was answered and none remains, 'login' when the login
// picker is (or becomes) the blocker, 'unchanged' when no gate was present.
const FIRST_RUN_ANSWER_MAX_STEPS = 6
const FIRST_RUN_ANSWER_SETTLE_MS = 1500

export async function answerFirstRunGates(
  session: string,
  host: string | null = null,
): Promise<'cleared' | 'login' | 'unchanged'> {
  let acted = false
  for (let i = 0; i < FIRST_RUN_ANSWER_MAX_STEPS; i++) {
    const pane = capturePane(session, host)
    const gate: FirstRunGateKind | null = pane != null ? detectsFirstRunGate(pane) : null
    if (gate == null) return acted ? 'cleared' : 'unchanged'
    if (gate === 'login') return 'login'
    try {
      if (gate === 'trust') {
        runTmux(host, ['send-keys', '-t', session, '1'], { timeout: 5000 })
        await delay(150)
        runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
      } else if (gate === 'bypass-permissions') {
        runTmux(host, ['send-keys', '-t', session, '2'], { timeout: 5000 })
        await delay(150)
        runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
      } else {
        // theme / welcome: Enter accepts the highlighted default and moves on.
        runTmux(host, ['send-keys', '-t', session, 'Enter'], { timeout: 5000 })
      }
    } catch (err) {
      logger.warn({ err, session, gate }, 'first-run gate: answer keystroke failed')
      return acted ? 'cleared' : 'unchanged'
    }
    acted = true
    logger.info({ session, gate, step: i }, 'first-run gate: answered dialog')
    await delay(FIRST_RUN_ANSWER_SETTLE_MS)
  }
  return acted ? 'cleared' : 'unchanged'
}

// Post-(re)start identity setup. Every freshly spawned Claude Code session is
// given `/name` so it is identifiable. (`/remote-control` was dropped: the
// operator no longer uses Remote Control, and the agent's inference-only OAuth
// token can't satisfy it anyway.) Pure helper for the exact slash commands so
// they are unit-tested; scheduleIdentitySetup wires them to tmux after a wait.
export function identitySlashCommands(displayName: string): string[] {
  return [`/name ${displayName}`]
}

// Delays mirror the observed Claude Code first-render timing: the first-run /
// resume modals appear within ~4-6s, so dismiss at 8s; the prompt input is
// reliably ready ~5s after that.
const MODAL_DISMISS_DELAY_MS = 8000
const IDENTITY_SEND_DELAY_MS = 5000

// /name gate budget. The /name keystrokes only go out into a pane that reads as
// a ready prompt; a pane that does not (a modal nobody has dismissed, a slow
// first render) is re-probed up to NAME_GATE_RETRIES more times,
// NAME_GATE_RETRY_DELAY_MS apart, and then the /name is SKIPPED. Worst case the
// gate adds 3 x 2s (+ the 250ms readiness confirm per probe) to the ~T+13s the
// /name lands at today, so it still finishes well before channel-plugin-unlock's
// T+35s probe (UNLOCK_PROBE_DELAY_MS), which is timed off the /name.
export const NAME_GATE_RETRIES = 3
export const NAME_GATE_RETRY_DELAY_MS = 2000

// One operator alert per session per episode for the external-imports dialog. A
// respawn loop would otherwise page the operator on every spawn; the entry is
// cleared as soon as a /name lands on that session again (the dialog is gone),
// so a later recurrence alerts again. Process-local, like the shared-config
// collision alert.
const importsDialogAlerted = new Set<string>()

export function resetImportsDialogAlerts(): void {
  importsDialogAlerted.clear()
}

// "Allow external CLAUDE.md file imports?" is answered by NOBODY at runtime:
// "Yes" is a trust grant for the fleet persona folder and may only come from
// the pre-seeded stamp (stampProjectTrustForDir), and Escape/Enter on the
// dialog picks the highlighted "No", which is recorded as an explicit refusal of the imports. So the system
// leaves the pane alone and tells the operator, once. The text carries the
// session name only, never pane contents.
export function alertExternalImportsDialogOnce(session: string): void {
  if (importsDialogAlerted.has(session)) return
  importsDialogAlerted.add(session)
  logger.error({ session }, 'external imports dialog unanswered: leaving the pane untouched (no keystrokes), operator action needed')
  void notifyChannel(
    `Figyelmeztetes: a(z) ${session} session egy "Allow external CLAUDE.md file imports?" dialogon all, es a rendszer NEM valaszolja meg (a Yes bizalmi engedely, csak a stamp adhatja; az Enter/Escape a No-t valasztana). A /name kimaradt, a pane valtozatlan. Ellenorizd a session projekt-bizalmi allapotat.`,
  ).catch(() => { /* notifyChannel logs internally */ })
}

export type IdentityCommandOutcome = 'sent' | 'skipped-not-ready' | 'skipped-imports-dialog'

type IdentityProbe =
  | { kind: 'sent' }
  | { kind: 'imports-dialog' }
  | { kind: 'not-ready'; state: string }

// One probe-and-maybe-send attempt for an identity slash command, as a single
// critical section under the pane send lane (fail-closed, like the modal
// dismissals: PANEWRITERS805). The lane is held only for capture + send, NOT
// across the retry wait, so a delivery is never starved by the gate.
//   - lane busy              -> not-ready ('send-lane-busy'): a delivery owns
//                               the pane right now; retry later.
//   - imports dialog visible -> never send (any key on it answers it).
//   - isSessionReadyForPrompt-> the SAME dim-ghost tolerant idle rule the
//                               delivery path uses (a fresh CC >=2.1.202 pane
//                               paints a dim placeholder that a plain
//                               detectPaneState reads as 'typing'); only then
//                               are the keystrokes sent.
// A tmux error from the send itself propagates to the caller's catch.
async function probeAndSendIdentityCommand(session: string, cmd: string, host: string | null): Promise<IdentityProbe> {
  const release = tryAcquireSessionSendLane(session, host)
  if (!release) return { kind: 'not-ready', state: 'send-lane-busy' }
  try {
    const pane = capturePane(session, host)
    if (pane != null && detectsExternalImportsDialog(pane)) return { kind: 'imports-dialog' }
    if (!(await isSessionReadyForPrompt(session, host))) {
      return { kind: 'not-ready', state: pane == null ? 'capture-failed' : detectPaneState(pane) }
    }
    runTmux(host, ['send-keys', '-t', session, cmd, 'Enter'], { timeout: 5000 })
    return { kind: 'sent' }
  } finally {
    release()
  }
}

// Gate for the post-spawn identity command: never a blind `send-keys cmd Enter`
// into a pane nobody looked at (a not-yet-recognised modal swallows the Enter
// and confirms its highlighted option). A skipped /name is cosmetic; a swallowed
// consent is not.
export async function sendIdentityCommandGuarded(
  session: string,
  cmd: string,
  host: string | null = null,
): Promise<IdentityCommandOutcome> {
  let last: IdentityProbe = { kind: 'not-ready', state: 'unprobed' }
  for (let attempt = 0; attempt <= NAME_GATE_RETRIES; attempt++) {
    if (attempt > 0) await delay(NAME_GATE_RETRY_DELAY_MS)
    last = await probeAndSendIdentityCommand(session, cmd, host)
    if (last.kind === 'sent') {
      importsDialogAlerted.delete(session)
      return 'sent'
    }
    if (last.kind === 'imports-dialog') {
      alertExternalImportsDialogOnce(session)
      return 'skipped-imports-dialog'
    }
  }
  logger.warn(
    { session, paneState: last.kind === 'not-ready' ? last.state : 'unknown', attempts: NAME_GATE_RETRIES + 1 },
    'Identity setup: pane never reached a ready prompt within the /name gate budget; /name skipped (no keystrokes sent)',
  )
  return 'skipped-not-ready'
}

// Schedule the identity setup for a freshly (re)spawned session: once it has
// had time to render, dismiss any first-run/resume modals, then send `/name`
// (through the pane-state gate above). Shared by startAgentProcess and the
// channel-monitor recovery respawns (resumeMarveenSession /
// respawnMarveenSessionFresh), which previously left the main session without
// its identity after auto-recovery. Fire-and-forget; all errors are
// swallowed/logged so a missed setup never tears down the caller.
export function scheduleIdentitySetup(session: string, displayName: string, host: string | null = null): void {
  setTimeout(() => {
    void (async () => {
      try {
        await dismissSurveyModalIfPresent(session, host)
        await dismissResumeSummaryModalIfPresent(session, host)
        await dismissModelConsentDialogIfPresent(session, host)
      } catch (err) {
        logger.warn({ err, session }, 'Post-restart modal dismiss failed')
      }
      setTimeout(() => {
        void (async () => {
          try {
            for (const cmd of identitySlashCommands(displayName)) {
              const outcome = await sendIdentityCommandGuarded(session, cmd, host)
              // Skipped: already logged (warn / operator alert). Do not claim success.
              if (outcome !== 'sent') return
              await delay(1000)
            }
            logger.info({ session, displayName }, 'Set session /name')
          } catch (err) {
            logger.warn({ err, session, displayName }, 'Failed to set session /name')
          }
        })()
      }, IDENTITY_SEND_DELAY_MS)
    })()
  }, MODAL_DISMISS_DELAY_MS)
}

// How many follow-up actions (retry-Enter OR clear-and-resend)
// sendPromptToSession() is willing to fire when the post-send capture says
// the prompt is still parked in the input box. The verbatim path lands on the
// first or second extra Enter; the placeholder clear-and-resend path needs a
// little more headroom because a resend can itself occasionally park (the
// observed convergence was placeholder -> resend -> verbatim/placeholder ->
// resend -> submitted, i.e. up to ~3 cycles). Four bounds the loop well past
// the empirical worst case (which converged within 5 in a 12/12 proof) while
// still giving a logged give-up so a pathologically stuck pane does not spin
// indefinitely.
