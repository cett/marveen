// #886 handoff-recovery: a machine-written marker line in HANDOFF.md that
// carries an agent's active Claude Plan id across a context-guard restart.
//
// restartAgentProcess (agent-process-spawn.ts) always stops the agent
// before starting it again, and stopAgentProcess drops the agent's
// agent_active_plans row (deactivatePlanForAgent) -- so the id cannot
// survive in the DB across the gap, only in a file written before the stop.
// context-guard-runner.ts calls appendActivePlanMarkerToHandoff() right
// before triggering a restart (while the DB row still exists); startAgentProcess
// calls recoverActivePlanFromHandoff() on the next launch to restore it with
// source='handoff-recovery'.
//
// Deliberately its own small module, not exported from context-guard-runner.ts
// or agent-process-spawn.ts directly: those two already depend on each other
// through the agent-process.ts barrel (context-guard-runner imports
// restartAgentProcess from it), so a helper needed by both has to live
// somewhere neither imports the other through.
//
// v1 limitation, same as context-guard's own remote-agent skip: only the
// non-main agent path is wired (agent-process-spawn.ts's startAgentProcess).
// The main agent's restart goes through hardRestartMarveenChannels()
// (channel-monitor.ts), a separate boot path -- not covered here yet.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { agentDir } from './agent-config.js'
import { getActivePlanForAgent, activatePlanForAgent } from '../db.js'
import { logger } from '../logger.js'

const MARKER_RE = /<!-- claude-plan-id: ([A-Za-z0-9_.-]+) -->/
const MARKER_RE_GLOBAL = /\n?<!-- claude-plan-id: [A-Za-z0-9_.-]+ -->\n?/g

function handoffPathFor(name: string): string {
  const dir = name === MAIN_AGENT_ID ? PROJECT_ROOT : agentDir(name)
  return join(dir, 'HANDOFF.md')
}

// Best-effort, called right before a context-guard restart. Never throws --
// a failure here must not block the restart itself. No-op when the agent
// has no active plan binding or no HANDOFF.md was written this cycle.
export function appendActivePlanMarkerToHandoff(name: string): void {
  try {
    const plan = getActivePlanForAgent(name)
    if (!plan) return
    const path = handoffPathFor(name)
    if (!existsSync(path)) return
    const current = readFileSync(path, 'utf-8')
    const cleaned = current.replace(MARKER_RE_GLOBAL, '')
    writeFileSync(path, cleaned.replace(/\s*$/, '') + `\n\n<!-- claude-plan-id: ${plan.id} -->\n`)
  } catch (err) {
    logger.warn({ err, name }, 'handoff active-plan marker: append failed (non-fatal)')
  }
}

// Best-effort, called at agent launch. Never throws -- a failure here must
// not block the launch itself. No-op when HANDOFF.md carries no marker.
export function recoverActivePlanFromHandoff(name: string): void {
  try {
    const path = handoffPathFor(name)
    if (!existsSync(path)) return
    const match = MARKER_RE.exec(readFileSync(path, 'utf-8'))
    if (!match) return
    activatePlanForAgent(name, match[1], 'handoff-recovery')
  } catch (err) {
    logger.warn({ err, name }, 'handoff active-plan marker: recovery failed (non-fatal)')
  }
}
