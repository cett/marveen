// The dashboard's side of the restart busy gate: the first attempt sends no force, a busy / no_pane refusal asks the
// operator a second time and only a "yes" sends {"force": true}. Anything else (other 409s, 5xx, network) is never
// turned into a force.

import { describe, it, expect, vi } from 'vitest'
import { postGatedRestart, restartRefusalReason } from '../../web/modules/restart-gate.js'

function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}
const tFn = (key: string) => key

describe('restartRefusalReason', () => {
  it('names busy and no_pane on a 409 conflict, nothing else', () => {
    expect(restartRefusalReason(409, { error: 'conflict', reason: 'busy' })).toBe('busy')
    expect(restartRefusalReason(409, { error: 'conflict', reason: 'no_pane' })).toBe('no_pane')
  })

  it('any other answer is not a refusal the operator may override', () => {
    expect(restartRefusalReason(409, { error: 'conflict', reason: 'already_consumed' })).toBeNull()
    expect(restartRefusalReason(409, { error: 'conflict' })).toBeNull()
    expect(restartRefusalReason(409, { error: 'status_conflict', reason: 'busy' })).toBeNull()
    expect(restartRefusalReason(500, { error: 'conflict', reason: 'busy' })).toBeNull()
    expect(restartRefusalReason(200, { ok: true })).toBeNull()
    expect(restartRefusalReason(409, null)).toBeNull()
  })
})

describe('postGatedRestart', () => {
  it('an accepted first attempt sends no body and asks nothing', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply(200, { ok: true }))
    const confirmFn = vi.fn()
    const out = await postGatedRestart('/api/marveen/restart', { fetchFn, confirmFn, tFn })
    expect(out.res.ok).toBe(true)
    expect(out.cancelled).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledWith('/api/marveen/restart', { method: 'POST' })
    expect(confirmFn).not.toHaveBeenCalled()
  })

  it('busy: asks a worded second confirm, and a yes resends with force', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(reply(409, { error: 'conflict', reason: 'busy' }))
      .mockResolvedValueOnce(reply(200, { ok: true }))
    const confirmFn = vi.fn().mockReturnValue(true)
    const out = await postGatedRestart('/api/marveen/restart', { fetchFn, confirmFn, tFn })
    expect(confirmFn).toHaveBeenCalledWith('agents.confirm.restart_force_busy')
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toEqual({ force: true })
    expect(out.res.ok).toBe(true)
    expect(out.cancelled).toBe(false)
  })

  it('no_pane: the second confirm is worded for the unreadable pane', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(reply(409, { error: 'conflict', reason: 'no_pane' }))
      .mockResolvedValueOnce(reply(200, { ok: true }))
    const confirmFn = vi.fn().mockReturnValue(true)
    await postGatedRestart('/api/marveen/restart', { fetchFn, confirmFn, tFn })
    expect(confirmFn).toHaveBeenCalledWith('agents.confirm.restart_force_no_pane')
  })

  it('a declined second confirm starts nothing: one request, cancelled', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply(409, { error: 'conflict', reason: 'busy' }))
    const out = await postGatedRestart('/api/marveen/restart', { fetchFn, confirmFn: () => false, tFn })
    expect(out.cancelled).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('other failures are returned as they are and never forced', async () => {
    for (const r of [reply(500, { error: 'internal_error' }), reply(409, { error: 'conflict', reason: 'expired' }), reply(403, { error: 'forbidden' })]) {
      const fetchFn = vi.fn().mockResolvedValue(r)
      const confirmFn = vi.fn()
      const out = await postGatedRestart('/api/marveen/restart', { fetchFn, confirmFn, tFn })
      expect(out.res.ok).toBe(false)
      expect(out.cancelled).toBe(false)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(confirmFn).not.toHaveBeenCalled()
    }
  })

  it('a failed forced attempt is returned, not retried', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(reply(409, { error: 'conflict', reason: 'busy' }))
      .mockResolvedValueOnce(reply(500, { error: 'internal_error' }))
    const out = await postGatedRestart('/api/marveen/restart', { fetchFn, confirmFn: () => true, tFn })
    expect(out.res.status).toBe(500)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('plainBody is sent on the first attempt (the Federation page posts {}), and still gated', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply(409, { error: 'conflict', reason: 'busy' }))
    await postGatedRestart('/api/federation/apply', { fetchFn, confirmFn: () => false, tFn, plainBody: '{}' })
    expect(fetchFn.mock.calls[0][1].body).toBe('{}')
  })
})
