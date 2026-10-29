// Two overlapping refreshes of the RBAC mode. A slow read that started BEFORE a tightening must not put the
// older, looser mode back after it: only the newest-started read may write the cache (the ticket in refreshRbacMode).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  row: { value: 'shadow' } as { value: string } | undefined,
  journal: 'shadow' as unknown,
  gate: null as null | Promise<void>,
  uncached: vi.fn(),
  last: vi.fn(),
}))

vi.mock('../db.js', () => ({
  getSystemConfigUncached: (...a: unknown[]) => h.uncached(...a),
  insertSystemConfigIfAbsent: vi.fn(() => Promise.resolve(false)),
  getLastConfigChangeValue: (...a: unknown[]) => h.last(...a),
  logConfigChange: vi.fn(() => Promise.resolve()),
  writeAdminAuditLog: vi.fn(() => Promise.resolve()),
  createAgentMessage: vi.fn(() => Promise.resolve(undefined)),
}))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { refreshRbacMode, getRbacMode } from '../web/rbac-mode.js'

beforeEach(() => {
  h.row = { value: 'shadow' }
  h.journal = 'shadow'
  h.uncached.mockImplementation(() => Promise.resolve(h.row))
  h.last.mockImplementation(() => Promise.resolve(h.journal))
})

describe('overlapping RBAC mode refreshes', () => {
  it('an older read that started before the tightening cannot put shadow back', async () => {
    // refresh 1 reads the row (shadow) and then waits on the slow journal lookup
    let release: () => void = () => undefined
    const slow = new Promise<void>((r) => { release = r })
    h.last.mockImplementationOnce(async () => { await slow; return 'shadow' })
    const first = refreshRbacMode(undefined)
    await Promise.resolve()
    // the operator tightens: the row says enforce, refresh 2 runs to the end
    h.row = { value: 'enforce' }
    expect(await refreshRbacMode(undefined)).toBe('enforce')
    expect(getRbacMode()).toBe('enforce')
    // the old read finishes now, with the old (shadow) answer: it must be dropped
    release()
    await first
    expect(getRbacMode()).toBe('enforce')
  })

  it('the newest read wins also when it is the loosening one and the older read is the slow tightening', async () => {
    h.row = { value: 'enforce' }
    let release: () => void = () => undefined
    const slow = new Promise<void>((r) => { release = r })
    h.uncached.mockImplementationOnce(async () => { await slow; return { value: 'enforce' } })
    const first = refreshRbacMode(undefined)
    await Promise.resolve()
    h.row = { value: 'shadow' }
    expect(await refreshRbacMode(undefined)).toBe('shadow')
    release()
    await first
    // the later-started read decides: shadow stays (this is the documented ordering rule)
    expect(getRbacMode()).toBe('shadow')
  })
})
