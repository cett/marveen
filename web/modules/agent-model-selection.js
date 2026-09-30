// Pure helpers for the agent detail model <select> (no DOM access, so they can
// be unit-tested). While the model-fallback runner has an agent downgraded the
// API reports the operator's configured model X in `model` and the overlay in
// `fallback` ({ primary, current: Y, downgradedAt }); the agent really runs Y.
// The selector must keep showing X: if it showed Y, an untouched Save would
// PUT Y, which the server reads as an operator change and answers by
// overwriting the config and dropping the overlay.

const DEFAULT_SELECTOR_MODEL = 'claude-opus-4-8[1m]'

/**
 * @param {{ model?: string|null, activeModel?: string|null, fallback?: { current: string }|null }} agent
 * @returns {string} the value the model <select> should hold
 */
export function selectorModelFor(agent) {
  if (agent.fallback) return agent.model || DEFAULT_SELECTOR_MODEL
  return agent.activeModel || agent.model || DEFAULT_SELECTOR_MODEL
}

/**
 * @param {{ fallback?: { current: string }|null }} agent
 * @returns {string|null} the model the agent is temporarily running on, or null
 */
export function fallbackModelOf(agent) {
  return agent.fallback ? agent.fallback.current : null
}

/**
 * True when Save would change nothing: the agent is on a fallback and the
 * selector still holds the configured model. No PUT and no restart then.
 * @param {{ model?: string|null, fallback?: { current: string }|null }} agent
 * @param {string} selected
 */
export function isNoopModelSave(agent, selected) {
  return !!agent.fallback && !!agent.model && selected === agent.model
}
