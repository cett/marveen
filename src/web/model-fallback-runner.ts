import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { hardRestartMarveenChannels } from './channel-monitor.js'
import {
  listAgentNames,
  readAgentRemoteHost,
  readAgentModelConfigured,
  resolveModelId,
  DEFAULT_MODEL,
  readMainModelConfigured,
} from './agent-config.js'
import {
  agentRunState,
  agentSessionName,
  restartAgentProcess,
  capturePane,
} from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { paneLooksIdle } from '../pane-state.js'
import { readModelFallbackConfig } from './model-fallback-store.js'
import {
  detectsUsageLimit,
  detectsModelUnavailable,
  decideModelAction,
  ladderFromPrimary,
  DEFAULT_SWITCH_COOLDOWN_MS,
} from '../model-fallback.js'
import {
  getFallbackOverride,
  setFallbackOverride,
  clearFallbackOverride,
  type FallbackOverride,
} from './model-fallback-state.js'

// Drives the model-fallback-on-limit feature (see src/model-fallback.ts for the
// why and the pure decision logic). Mirrors the auto-restart runner: a 60s
// sweep, offset from the other watchers so tmux calls do not pile onto one tick.
//
// Per agent each tick: capture the pane, detect a plan usage-limit banner, ask
// the pure decision function what to do, and -- only when the pane is idle --
// pin the agent to the fallback model and respawn the session (keeping the
// conversation) so the new model takes effect. A revert climbs back to the
// agent's OWN primary once it has been limit-free past the configured window.
//
// The operator's model config (.env MAIN_AGENT_MODEL / agent-config.json) is
// never written here. A downgrade is a persistent overlay in
// model-fallback-state.ts that the model resolvers consult first, so it
// survives a dashboard restart (the revert still fires) and the operator's
// choice stays intact as the revert target.

const INITIAL_DELAY_MS = 50_000
const INTERVAL_MS = 60_000

// agent name -> when we last switched it in EITHER direction (ms). In-memory
// on purpose: it only has to bridge the respawn settle time of a revert, which
// leaves no overlay behind. A downgrade's own timestamp is persistent (the
// overlay's downgradedAt), so the cooldown holds across a dashboard restart too.
const lastSwitchAt = new Map<string, number>()

// Require this many consecutive sweeps detecting model-unavailable before
// acting. Prevents false positives from a quoted error phrase in the box
// interior leaking into the bottom-15 fallback region on a headless pane.
const MODEL_UNAVAILABLE_MIN_CONSECUTIVE = 2
const modelUnavailableStreak = new Map<string, number>()

export function modelUnavailableStreakFor(name: string): number {
  return modelUnavailableStreak.get(name) ?? 0
}

// The model the OPERATOR configured for this agent, ignoring any fallback
// downgrade. For main: .env MAIN_AGENT_MODEL > .claude/settings.json .model,
// same precedence as scripts/channels.sh's resolve_main_model() -- see
// readMainModelRaw()'s doc comment in agent-config.ts. Falls back to
// DEFAULT_MODEL when neither source has a value.
function configuredModelFor(name: string): string {
  if (name === MAIN_AGENT_ID) return resolveModelId(readMainModelConfigured() || DEFAULT_MODEL)
  return readAgentModelConfigured(name)
}

function sessionFor(name: string): string {
  return name === MAIN_AGENT_ID ? MAIN_CHANNELS_SESSION : agentSessionName(name)
}

function restartFor(name: string): void {
  if (name === MAIN_AGENT_ID) {
    // A fresh main relaunch re-resolves the model in channels.sh: the fallback
    // overlay (model-fallback-state.json) first, then .env, then settings.json.
    // channels.sh always starts fresh for main, so a conversation is not
    // preserved here -- the model swap is what matters.
    //
    // Was a hardcoded `/bin/launchctl kickstart` (macOS-only), so on Linux the
    // usage-limit fallback could never actually swap main's model: it threw
    // ENOENT into the caller's catch. hardRestartMarveenChannels() keeps the
    // launchd path for macOS installs and its Linux respawn-pane path re-resolves
    // the model the same way.
    const res = hardRestartMarveenChannels()
    if (!res.ok) throw new Error(res.error ?? 'main channels hard restart failed')
  } else {
    // 'continue' (fresh: false) re-spawns with --continue so the conversation
    // survives the model swap.
    restartAgentProcess(name, { fresh: false })
  }
}

function checkAgent(name: string, nowMs: number, revertAfterMs: number, chain: string[]): void {
  // Sub-agents must be up; the main session is launchd-managed (always present).
  if (name !== MAIN_AGENT_ID && agentRunState(name) !== 'running') return

  const session = sessionFor(name)
  const host = name === MAIN_AGENT_ID ? null : readAgentRemoteHost(name)
  const pane = capturePane(session, host)
  if (pane == null) {
    // Pane unreadable: reset streak so two detections must be consecutive captures.
    modelUnavailableStreak.delete(name)
    return
  }

  const usageLimitDetected = detectsUsageLimit(pane)
  const rawModelUnavailable = detectsModelUnavailable(pane)
  const prevStreak = modelUnavailableStreak.get(name) ?? 0
  const newStreak = rawModelUnavailable ? prevStreak + 1 : 0
  modelUnavailableStreak.set(name, newStreak)
  if (newStreak >= MODEL_UNAVAILABLE_MIN_CONSECUTIVE) {
    logger.info({ name, streak: newStreak }, 'model-fallback: model-unavailable confirmed by consecutive detection')
  }
  const limitDetected = usageLimitDetected || (newStreak >= MODEL_UNAVAILABLE_MIN_CONSECUTIVE)
  // The operator's model is the agent's primary. The overlay (when present) is
  // what it actually runs on right now.
  const primary = configuredModelFor(name)
  let override = getFallbackOverride(name)
  if (override && override.current === primary) {
    // The operator has since set the very model the overlay pins: nothing left
    // to revert, just drop the stale overlay.
    clearFallbackOverride(name)
    override = null
  }
  const currentModel = override?.current ?? primary
  const lastSwitch = Math.max(override?.downgradedAt ?? 0, lastSwitchAt.get(name) ?? 0)
  const action = decideModelAction({
    limitDetected,
    currentModel,
    // Per-agent ladder: starts at THIS agent's primary, so a revert lands on it
    // (not on the fleet-global chain[0]) and a downgrade never climbs.
    chain: ladderFromPrimary(primary, chain),
    downgradedAt: override?.downgradedAt ?? null,
    now: nowMs,
    revertAfterMs,
    lastSwitchAt: lastSwitch || null,
    cooldownMs: DEFAULT_SWITCH_COOLDOWN_MS,
  })
  if (action.kind === 'none') return

  // Downgrade may run on a limit-paused pane (which reads idle); revert must not
  // cut a live turn. Both go through restart, so require idle for both.
  if (!paneLooksIdle(pane)) {
    logger.info({ name, action: action.kind }, 'model-fallback: action due but pane busy, deferring')
    return
  }

  const previous: FallbackOverride | null = override
  try {
    if (action.kind === 'downgrade') {
      setFallbackOverride(name, { primary, current: action.model, downgradedAt: nowMs })
    } else {
      clearFallbackOverride(name)
    }
    restartFor(name)
    lastSwitchAt.set(name, nowMs)
    modelUnavailableStreak.delete(name)
    logger.info(
      { name, from: currentModel, to: action.model, primary, action: action.kind },
      'model-fallback: switched model',
    )
  } catch (err) {
    // The respawn did not happen: put the overlay back the way it was so the
    // next (re)start does not silently land on a model the runner never applied.
    try {
      if (previous) setFallbackOverride(name, previous)
      else clearFallbackOverride(name)
    } catch (rollbackErr) {
      logger.warn({ err: rollbackErr, name }, 'model-fallback: overlay rollback failed')
    }
    logger.warn({ err, name }, 'model-fallback: switch failed')
  }
}

export function startModelFallbackRunner(): NodeJS.Timeout {
  function sweep() {
    const cfg = readModelFallbackConfig()
    if (!cfg.enabled) {
      if (lastSwitchAt.size > 0) lastSwitchAt.clear() // re-seed cleanly if re-enabled
      if (modelUnavailableStreak.size > 0) modelUnavailableStreak.clear()
      return
    }
    const now = Date.now()
    const revertAfterMs = cfg.revertAfterMinutes * 60_000
    try { checkAgent(MAIN_AGENT_ID, now, revertAfterMs, cfg.chain) }
    catch (err) { logger.debug({ err }, 'model-fallback: main check error') }
    for (const name of listAgentNames()) {
      try { checkAgent(name, now, revertAfterMs, cfg.chain) }
      catch (err) { logger.debug({ err, agent: name }, 'model-fallback: agent check error') }
    }
  }
  setTimeout(sweep, INITIAL_DELAY_MS)
  return setInterval(sweep, INTERVAL_MS)
}
