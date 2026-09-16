// #886 handoff-recovery round trip: context-guard-runner writes a plan-id
// marker into HANDOFF.md right before a restart (while the DB binding still
// exists); agent-process-spawn reads it back on the next launch. See
// src/web/claude-plan-handoff-marker.ts header for why this needs a file
// (not just the DB) to survive the restart's stop step.
//
// Real PROJECT_ROOT/agents/<probe> dir, mirroring hook-scope-main-refusal.test.ts
// -- agentDir() resolves through the real config, not a mock. Only ever
// touches the synthetic probe dir, never MAIN_AGENT_ID's HANDOFF.md (that
// resolves to the repo's own PROJECT_ROOT/HANDOFF.md, a real file).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { initDatabase, replaceClaudePlanRows, activatePlanForAgent, getActivePlanForAgent, deactivatePlanForAgent } from '../db.js'
import { appendActivePlanMarkerToHandoff, recoverActivePlanFromHandoff } from '../web/claude-plan-handoff-marker.js'

const PROBE = 'handoffmarker-probe'
const probeDir = join(PROJECT_ROOT, 'agents', PROBE)
const handoffPath = join(probeDir, 'HANDOFF.md')

beforeEach(() => {
  initDatabase(':memory:')
  if (existsSync(join(probeDir, 'HANDOFF.md'))) {
    throw new Error(`refusing: agents/${PROBE} looks like a live agent`)
  }
  mkdirSync(probeDir, { recursive: true })
  replaceClaudePlanRows([{ id: 'team-x', label: 'Team X', configDir: '/tmp/x', planType: 'team', channelsAllowed: true }])
})

afterEach(() => {
  rmSync(probeDir, { recursive: true, force: true })
})

describe('appendActivePlanMarkerToHandoff', () => {
  it('appends a marker line when the agent has an active plan and HANDOFF.md exists', () => {
    writeFileSync(handoffPath, '# Handoff\n\nDid some work.\n')
    activatePlanForAgent(PROBE, 'team-x', 'rotation')
    appendActivePlanMarkerToHandoff(PROBE)
    const content = readFileSync(handoffPath, 'utf-8')
    expect(content).toContain('Did some work.')
    expect(content).toContain('<!-- claude-plan-id: team-x -->')
  })

  it('replaces a stale marker rather than duplicating it', () => {
    writeFileSync(handoffPath, '# Handoff\n\n<!-- claude-plan-id: old-plan -->\n')
    activatePlanForAgent(PROBE, 'team-x', 'rotation')
    appendActivePlanMarkerToHandoff(PROBE)
    const content = readFileSync(handoffPath, 'utf-8')
    expect(content.match(/claude-plan-id:/g)).toHaveLength(1)
    expect(content).toContain('<!-- claude-plan-id: team-x -->')
  })

  it('is a no-op when the agent has no active plan binding', () => {
    writeFileSync(handoffPath, '# Handoff\n')
    appendActivePlanMarkerToHandoff(PROBE)
    expect(readFileSync(handoffPath, 'utf-8')).toBe('# Handoff\n')
  })

  it('is a no-op (does not throw) when HANDOFF.md does not exist', () => {
    activatePlanForAgent(PROBE, 'team-x', 'rotation')
    expect(() => appendActivePlanMarkerToHandoff(PROBE)).not.toThrow()
    expect(existsSync(handoffPath)).toBe(false)
  })
})

describe('recoverActivePlanFromHandoff', () => {
  it('restores the binding from a marker with source=handoff-recovery', () => {
    writeFileSync(handoffPath, '# Handoff\n\n<!-- claude-plan-id: team-x -->\n')
    recoverActivePlanFromHandoff(PROBE)
    const plan = getActivePlanForAgent(PROBE)
    expect(plan).toMatchObject({ id: 'team-x', source: 'handoff-recovery' })
  })

  it('is a no-op when HANDOFF.md has no marker', () => {
    writeFileSync(handoffPath, '# Handoff\n\nNo marker here.\n')
    recoverActivePlanFromHandoff(PROBE)
    expect(getActivePlanForAgent(PROBE)).toBeNull()
  })

  it('is a no-op (does not throw) when HANDOFF.md does not exist', () => {
    expect(() => recoverActivePlanFromHandoff(PROBE)).not.toThrow()
    expect(getActivePlanForAgent(PROBE)).toBeNull()
  })

  it('full round trip: append survives a deactivate (simulated stop), recover restores it', () => {
    writeFileSync(handoffPath, '# Handoff\n')
    activatePlanForAgent(PROBE, 'team-x', 'rotation')
    appendActivePlanMarkerToHandoff(PROBE)
    // Simulate restartAgentProcess's stop step, which runs after the marker
    // is written but before the next launch reads it back.
    deactivatePlanForAgent(PROBE)
    expect(getActivePlanForAgent(PROBE)).toBeNull()
    recoverActivePlanFromHandoff(PROBE)
    expect(getActivePlanForAgent(PROBE)).toMatchObject({ id: 'team-x', source: 'handoff-recovery' })
  })
})
