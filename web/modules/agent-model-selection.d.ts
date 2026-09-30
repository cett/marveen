export interface AgentModelView {
  model?: string | null
  activeModel?: string | null
  fallback?: { primary?: string; current: string; downgradedAt?: number } | null
}

export function selectorModelFor(agent: AgentModelView): string
export function fallbackModelOf(agent: AgentModelView): string | null
export function isNoopModelSave(agent: AgentModelView, selected: string): boolean
