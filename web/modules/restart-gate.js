// Client side of the server's manual-restart busy gate. The restart routes answer 409
// { error: 'conflict', reason: 'busy' | 'no_pane' } instead of cutting a running turn. A stuck agent can read busy
// for good, so the caller asks the operator a second time and only then sends { force: true }. No DOM access here,
// so it can be unit-tested with an injected fetch and confirm.

/**
 * @param {number} status HTTP status of the first attempt
 * @param {{ error?: string, reason?: string }|null} data parsed JSON body ({} when it was not JSON)
 * @returns {'busy'|'no_pane'|null} the refusal reason, or null when this is any other answer (never a force)
 */
export function restartRefusalReason(status, data) {
  if (status !== 409 || !data || data.error !== 'conflict') return null
  return data.reason === 'busy' || data.reason === 'no_pane' ? data.reason : null
}

/**
 * POST to a gated restart route. First attempt sends no force. On a busy / no_pane refusal the operator is asked a
 * second time (worded for the reason); a "no" starts nothing and returns { cancelled: true }. Any other failure is
 * returned as is and is never retried with a force.
 *
 * @param {string} url
 * @param {{ fetchFn: typeof fetch, confirmFn: (msg: string) => boolean, tFn: (key: string) => string, plainBody?: string }} deps
 * @returns {Promise<{ res: Response, data: any, cancelled: boolean }>}
 */
export async function postGatedRestart(url, { fetchFn, confirmFn, tFn, plainBody }) {
  const headers = { 'Content-Type': 'application/json' }
  const first = plainBody === undefined ? { method: 'POST' } : { method: 'POST', headers, body: plainBody }
  let res = await fetchFn(url, first)
  let data = await res.json().catch(() => ({}))
  const reason = res.ok ? null : restartRefusalReason(res.status, data)
  if (!reason) return { res, data, cancelled: false }
  const key = reason === 'busy' ? 'agents.confirm.restart_force_busy' : 'agents.confirm.restart_force_no_pane'
  if (!confirmFn(tFn(key))) return { res, data, cancelled: true }
  res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify({ force: true }) })
  data = await res.json().catch(() => ({}))
  return { res, data, cancelled: false }
}
