export const AGENT_LIVE_STATES: Set<string>

export function liveAgentIdForAssignee(
  assignee: { name?: string; type?: string; displayName?: string } | null | undefined,
  mainAgentId: string | null | undefined,
): string | null

export function agentLiveState(entries: unknown, agentId: string | null | undefined): string | null
