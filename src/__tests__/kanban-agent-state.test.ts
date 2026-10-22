// Live state of the assignee agent on the card detail: the pure choice of agent and state
// (web/modules/kanban-agent-state.js), the words for every state in both languages, and the panel
// wiring (string-grep contract, like the other kanban UI tests). The state itself is the one
// /api/agents/activity reports; its tests are with that route.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { liveAgentIdForAssignee, agentLiveState, AGENT_LIVE_STATES } from '../../web/modules/kanban-agent-state.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

describe('liveAgentIdForAssignee', () => {
  it('the bot entry is the main agent, an agent entry is itself', () => {
    expect(liveAgentIdForAssignee({ name: 'Orin', type: 'bot' }, 'orin')).toBe('orin')
    expect(liveAgentIdForAssignee({ name: 'dex', type: 'agent', displayName: 'Dex' }, 'orin')).toBe('dex')
  })

  it('a person, an unregistered assignee and no assignee have no agent state', () => {
    expect(liveAgentIdForAssignee({ name: 'Gabor', type: 'owner' }, 'orin')).toBeNull()
    expect(liveAgentIdForAssignee(undefined, 'orin')).toBeNull()
    expect(liveAgentIdForAssignee(null, 'orin')).toBeNull()
    expect(liveAgentIdForAssignee({ name: 'x', type: 'other' }, 'orin')).toBeNull()
  })

  it('a bot entry with no known main agent id gives nothing instead of a wrong name', () => {
    expect(liveAgentIdForAssignee({ name: 'Orin', type: 'bot' }, '')).toBeNull()
    expect(liveAgentIdForAssignee({ name: 'Orin', type: 'bot' }, undefined)).toBeNull()
  })
})

describe('agentLiveState', () => {
  const entries = [
    { name: 'orin', isMain: true, running: true, state: 'working', mode: null, tail: [] },
    { name: 'dex', isMain: false, running: false, state: 'stopped', mode: null, tail: [] },
    { name: 'zara', isMain: false, running: true, state: 'unreachable', mode: null, tail: [] },
    { name: 'odd', isMain: false, running: true, state: 'stalled', mode: null, tail: [] },
    { name: 'nostate', isMain: false, running: true },
  ]

  it('reads the state of the named agent, ignoring case', () => {
    expect(agentLiveState(entries, 'orin')).toBe('working')
    expect(agentLiveState(entries, 'DEX')).toBe('stopped')
    expect(agentLiveState(entries, 'zara')).toBe('unreachable')
  })

  it('no reading is null, never a guess: agent not in the list, no state, not a list', () => {
    expect(agentLiveState(entries, 'ghost')).toBeNull()
    expect(agentLiveState(entries, 'nostate')).toBeNull()
    expect(agentLiveState({ error: 'x' }, 'orin')).toBeNull()
    expect(agentLiveState(null, 'orin')).toBeNull()
    expect(agentLiveState(entries, '')).toBeNull()
    expect(agentLiveState(entries, null)).toBeNull()
  })

  it('a state the page has no word for reads as unknown, not as itself', () => {
    expect(agentLiveState(entries, 'odd')).toBe('unknown')
  })
})

describe('the panel', () => {
  it('has a word in both languages for every state the page knows, and the heading and the tooltip', () => {
    for (const lang of ['en', 'hu']) {
      const src = read(`web/lang/${lang}.js`)
      for (const state of AGENT_LIVE_STATES) expect(src, `${lang} ${state}`).toContain(`'kanban.agent_state.${state}'`)
      expect(src).toContain("'kanban.agent_state.tooltip'")
      expect(src).toContain("'kanban.meta.agent_state'")
    }
  })

  it('every state the page knows has a dot colour', () => {
    const css = read('web/css/features/kanban-detail.css')
    for (const state of AGENT_LIVE_STATES) expect(css, state).toContain(`.agent-live-dot--${state}`)
  })

  it('reads /api/agents/activity, stays hidden without a reading, and stops polling with the modal', () => {
    const js = read('web/modules/kanban.js')
    expect(js).toContain("fetch('/api/agents/activity')")
    expect(js).toContain('id="metaAgentStateItem" hidden')
    expect(js).toContain("cardDetailOverlay.classList.contains('active')")
    expect(js).toContain('clearInterval(agentLiveTimer)')
  })

  it('claims no more than the activity route knows: the states are the ones it reports, no stalled', () => {
    expect([...AGENT_LIVE_STATES].sort()).toEqual(['dead', 'error', 'idle', 'stopped', 'unknown', 'unreachable', 'working'])
    const route = read('src/web/pane-liveness.ts')
    for (const state of ['stopped', 'dead', 'working', 'idle', 'unknown', 'error']) expect(route).toContain(`'${state}'`)
  })

  it('the tooltip says the state is not tied to this card', () => {
    expect(read('web/lang/en.js')).toMatch(/not tied to this card/)
  })
})
