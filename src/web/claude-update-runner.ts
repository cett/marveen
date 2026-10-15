import { logger } from '../logger.js'
import { MAIN_AGENT_ID } from '../config.js'
import { getEffectiveSettingValue } from '../settings-store.js'
import { paneLooksIdle } from '../pane-state.js'
import { listAgentNames, readAgentRemoteHost } from './agent-config.js'
import { agentRunState, agentSessionName, capturePane, captureTmux, restartAgentProcess } from './agent-process.js'
import { MAIN_CHANNELS_SESSION } from './main-agent.js'
import { mainChannelsSessionExists } from './channel-monitor.js'
import { restartMainChannelsSession } from './auto-restart-runner.js'
import { rolloutStep, type RolloutDeps, type RolloutTarget } from './claude-update.js'

// Drives the idle-only, staggered restart that follows a Claude Code update (see
// claude-update.ts for the why and the pure step logic). A 60s tick that does
// nothing at all unless scripts/claude-update.sh recorded a real version change.

const INITIAL_DELAY_MS = 75_000
const INTERVAL_MS = 60_000

const sessionOf = (t: RolloutTarget): string => (t.isMain ? MAIN_CHANNELS_SESSION : agentSessionName(t.name))

export function buildRolloutDeps(): RolloutDeps {
  return {
    nowMs: () => Date.now(),
    autoRestartEnabled: () => getEffectiveSettingValue('CLAUDE_UPDATE_AUTO_RESTART') === '1',
    targets: () => {
      const out: RolloutTarget[] = []
      for (const name of listAgentNames()) {
        // A remote agent runs the laptop's own install, not this host's; the update did not touch it.
        if (readAgentRemoteHost(name) != null) continue
        if (agentRunState(name) !== 'running') continue
        out.push({ name, isMain: false })
      }
      if (mainChannelsSessionExists()) out.push({ name: MAIN_AGENT_ID, isMain: true })
      return out
    },
    sessionCreatedSec: (t) => {
      try {
        const ts = parseInt(captureTmux(null, ['display-message', '-p', '-t', sessionOf(t), '#{session_created}']).trim(), 10)
        return Number.isFinite(ts) ? ts : null
      } catch {
        return null
      }
    },
    isIdle: (t) => {
      const pane = capturePane(sessionOf(t), null)
      return pane != null && paneLooksIdle(pane)
    },
    restart: (t) => {
      if (t.isMain) { restartMainChannelsSession(); return }
      // --continue: the conversation resumes on the new build.
      const r = restartAgentProcess(t.name, { fresh: false })
      if (!r.ok) throw new Error(r.hint || r.error || 'restart failed')
    },
  }
}

export function startClaudeUpdateRolloutRunner(): NodeJS.Timeout {
  const deps = buildRolloutDeps()
  function tick() {
    try { rolloutStep(deps) } catch (err) { logger.warn({ err }, 'claude-update: rollout tick failed') }
  }
  setTimeout(tick, INITIAL_DELAY_MS)
  return setInterval(tick, INTERVAL_MS)
}
