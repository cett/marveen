// Live state of a card's assignee agent, for the card detail.
//
// A reduced form of a live agent status: the state /api/agents/activity already reports for the agent
// (working / idle / dead / stopped / unreachable ...). Nothing says which card an agent is working on, so
// there is no "busy on another card" and no "stalled" here. Pure functions: no DOM, no fetch.

export const AGENT_LIVE_STATES = new Set(['working', 'idle', 'dead', 'stopped', 'unreachable', 'unknown', 'error'])

/**
 * The /api/agents/activity name an assignee list entry stands for, or null for a person, an unregistered
 * name and no assignee. The bot entry is the main agent, whose name in the activity list is its agent id.
 */
export function liveAgentIdForAssignee(assignee, mainAgentId) {
  if (!assignee) return null
  if (assignee.type === 'bot') return mainAgentId || null
  if (assignee.type === 'agent') return assignee.name || null
  return null
}

/**
 * The state of one agent in an /api/agents/activity answer, or null when there is no reading (not a list,
 * the agent is not in it, no state). A state the page has no word for reads as 'unknown'.
 */
export function agentLiveState(entries, agentId) {
  if (!Array.isArray(entries) || !agentId) return null
  const want = String(agentId).toLowerCase()
  const mine = entries.find((e) => e && String(e.name).toLowerCase() === want)
  if (!mine || typeof mine.state !== 'string') return null
  return AGENT_LIVE_STATES.has(mine.state) ? mine.state : 'unknown'
}
