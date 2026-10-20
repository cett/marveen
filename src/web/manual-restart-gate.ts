// Busy gate for the MANUAL restart routes (POST /api/marveen/restart, POST /api/agents/:name/restart,
// POST /api/federation/apply).
//
// The scheduled restart already refuses a busy pane (auto-restart-runner), but the manual routes used to restart
// with no check at all, so a click or a coordinator's API call could cut a running turn. Principle: never cut live
// work; when the pane cannot be read, refuse (fail-closed). A session that does not exist, or whose CLI has exited
// and left a bare shell, has no turn to cut, so restarting it stays allowed (that is the recovery).
//
// The gate lives in the HTTP routes ONLY. The internal restart paths (context-guard, channel watchdog, auto-restart,
// model fallback, startup reconciliation) call hardRestartMarveenChannels / restartAgentProcess directly and must
// never be held up by it: a wedged agent shows a busy pane forever, and those paths exist to recover exactly that.
//
// The decision comes from the pane's observed state, not the clock: several samples must agree.

import { paneLooksIdle } from '../pane-state.js'
import { capturePane, paneCurrentCommand, sessionExistsOnHost } from './agent-process-session.js'
import { activityState } from './pane-liveness.js'

export const MANUAL_RESTART_SAMPLES = 3
export const MANUAL_RESTART_INTERVAL_MS = 1200

export type ManualRestartVerdict =
  | { allow: true; reason: 'no-session' | 'dead-shell' | 'idle' }
  | { allow: false; reason: 'busy' | 'no_pane' }

/**
 * One sample per capture: true = idle, false = busy, null = pane unreadable.
 * Pure. Every sample must be idle; a single unreadable sample refuses first (no_pane), then a busy one (busy).
 * A wrong number of samples is no reading at all and refuses.
 */
export function decideManualRestart(samples: ReadonlyArray<boolean | null>): ManualRestartVerdict {
  if (samples.length !== MANUAL_RESTART_SAMPLES) return { allow: false, reason: 'no_pane' }
  if (samples.some((s) => s === null)) return { allow: false, reason: 'no_pane' }
  if (samples.some((s) => s === false)) return { allow: false, reason: 'busy' }
  return { allow: true, reason: 'idle' }
}

/**
 * True only for an explicit {"force": true} body. The dashboard button sends no body, so it never forces.
 * A malformed body, a string "true" or a missing field is not a force.
 */
export function wantsForceRestart(body: Buffer | string): boolean {
  try {
    const text = typeof body === 'string' ? body : body.toString('utf-8')
    if (text.trim() === '') return false
    const parsed = JSON.parse(text) as { force?: unknown } | null
    return parsed !== null && typeof parsed === 'object' && parsed.force === true
  } catch {
    return false
  }
}

/**
 * The 409 body of a refused restart: the existing `conflict` token plus a machine-readable `reason`
 * (`busy` | `no_pane`) and a hint that says how to force. A stuck agent can show a busy pane and never make
 * progress; without an explicit override the gate would refuse every manual recovery.
 */
export function restartRefusal(
  verdict: Extract<ManualRestartVerdict, { allow: false }>,
  route: string,
): { error: 'conflict'; reason: 'busy' | 'no_pane'; hint: string } {
  const why = verdict.reason === 'busy' ? 'the pane is busy' : 'the pane could not be read'
  return {
    error: 'conflict',
    reason: verdict.reason,
    hint: `Restart refused: ${why}. To restart anyway (this cuts the running turn), send POST ${route} with the JSON body {"force": true}.`,
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface RestartGateDeps {
  sleep?: (ms: number) => Promise<void>
  sessionExists?: (host: string | null, session: string) => boolean
  capture?: (session: string, host: string | null) => string | null
  command?: (session: string, host: string | null) => string | null
}

/**
 * Samples the session's pane MANUAL_RESTART_SAMPLES times, spaced by MANUAL_RESTART_INTERVAL_MS, then decides.
 * No session, or a bare shell with no working pane (the CLI exited), is allowed without sampling.
 * The foreground-command reading never overrides the pane text: a pane that shows work refuses either way.
 */
export async function gateManualRestart(
  session: string,
  host: string | null = null,
  deps: RestartGateDeps = {},
): Promise<ManualRestartVerdict> {
  const sleep = deps.sleep ?? defaultSleep
  const sessionExists = deps.sessionExists ?? sessionExistsOnHost
  const capture = deps.capture ?? capturePane
  const command = deps.command ?? paneCurrentCommand

  if (!sessionExists(host, session)) return { allow: true, reason: 'no-session' }

  const samples: Array<boolean | null> = []
  for (let i = 0; i < MANUAL_RESTART_SAMPLES; i++) {
    if (i > 0) await sleep(MANUAL_RESTART_INTERVAL_MS)
    const pane = capture(session, host)
    samples.push(pane == null ? null : paneLooksIdle(pane))
    if (i === 0 && pane != null && samples[0] === false
      && activityState({ running: true, pane, paneCommand: command(session, host) }) === 'dead') {
      // A shell prompt is not an idle Claude pane, so it reads "busy" above. The CLI is gone and nothing runs.
      // activityState lets a pane that still shows work outrank the foreground-command reading.
      return { allow: true, reason: 'dead-shell' }
    }
  }
  return decideManualRestart(samples)
}
