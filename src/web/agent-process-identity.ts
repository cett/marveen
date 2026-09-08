// Split from the former monolithic src/web/agent-process.ts (775).

import { logger } from '../logger.js'
import { detectPaneState, detectsFirstRunGate, detectsModelConsentDialog, type FirstRunGateKind } from '../pane-state.js'
import { stampFableOverageConsent } from './agent-process-config.js'
import { capturePane, captureTmux, delay, isSessionReadyForPrompt, runTmux, sendPromptToSession } from './agent-process-session.js'
import { startAgentProcess } from './agent-process-spawn.js'

const SURVEY_MODAL_RX = /How is Claude doing this session/

export async function dismissSurveyModalIfPresent(session: string, host: string | null = null): Promise<void> {
  try {
    const pane = captureTmux(host, ['capture-pane', '-t', session, '-p'])
    if (!SURVEY_MODAL_RX.test(pane)) return
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

// Schedule the identity setup for a freshly (re)spawned session: once it has
// had time to render, dismiss any first-run/resume modals, then send `/name`.
// Shared by startAgentProcess and the channel-monitor recovery respawns
// (resumeMarveenSession / respawnMarveenSessionFresh), which previously left the
// main session without its identity after auto-recovery. Fire-and-forget; all
// errors are swallowed/logged so a missed setup never tears down the caller.
export async function scheduleIdentitySetup(session: string, displayName: string, host: string | null = null): Promise<void> {
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
              runTmux(host, ['send-keys', '-t', session, cmd, 'Enter'], { timeout: 5000 })
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
