// The counting behind GET /api/admin/sender-route-audit: pure rows in, summary out. The route test (against a real
// database and the real audit writer) covers the window, the role gate and the row limit; this file pins how a
// message is counted. Neutral fixtures only (agent-a, agent-b, main-a).

import { describe, it, expect } from 'vitest'
import {
  SENDER_ROUTE_AUDIT_MAX_PAIRS, summarizeSenderRouteChecks,
} from '../web/sender-route-audit.js'
import type { SenderRouteCheckRow } from '../db/audit.js'

type D = { stage: string; mode: string; lane?: string; senderClass?: string; from?: string; to?: string; ok: boolean; reason?: string | null; denied?: boolean }
let nextId = 1
/** A stored row; rows are listed newest first, so a test lists them in that order. */
const row = (d: D, entityId: string | null = null): SenderRouteCheckRow => ({
  id: nextId++,
  entity_id: entityId,
  created_at: 1000,
  detail: JSON.stringify({
    lane: 'routed', senderClass: 'fleet_agent', from: 'agent-a', to: 'agent-b', reason: d.ok ? null : 'not_trusted_peer', denied: false, ...d,
  }),
})

describe('summarizeSenderRouteChecks', () => {
  it('an empty window is zeros and empty maps, nothing undefined', () => {
    expect(summarizeSenderRouteChecks([])).toEqual({
      total: 0, would_deny: 0, denied: 0, by_reason: {}, by_mode: {}, by_stage: {}, unreadable: 0, pairs: [], pairs_truncated: false,
    })
  })

  it('a route row is one message each, even with the same pair (it has no message id)', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'route', mode: 'audit', ok: true }), row({ stage: 'route', mode: 'audit', ok: true })])
    expect(s.total).toBe(2)
    expect(s.pairs).toHaveLength(1)
    expect(s.pairs[0].count).toBe(2)
  })

  it('several delivery rows of one message id are ONE message (a restart forgets the once-per-message memory)', () => {
    const rows = [1, 2, 3].map(() => row({ stage: 'delivery', mode: 'audit', ok: false }, '77'))
    const s = summarizeSenderRouteChecks(rows)
    expect(s.total).toBe(1)
    expect(s.would_deny).toBe(1)
    expect(s.pairs[0].count).toBe(1)
  })

  it('different message ids are different messages', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'delivery', mode: 'audit', ok: false }, '1'), row({ stage: 'delivery', mode: 'audit', ok: false }, '2')])
    expect(s.total).toBe(2)
    expect(s.would_deny).toBe(2)
  })

  it('a message judged in both modes counts once in total and shows under each mode, its newest verdict decides the rest', () => {
    const s = summarizeSenderRouteChecks([
      row({ stage: 'delivery', mode: 'enforce', ok: false, denied: true }, '9'), // newest
      row({ stage: 'delivery', mode: 'audit', ok: false, denied: false }, '9'),
    ])
    expect(s.total).toBe(1)
    expect(s.would_deny).toBe(1)
    expect(s.denied).toBe(1)
    expect(s.by_mode).toEqual({
      enforce: { total: 1, would_deny: 1, denied: 1 },
      audit: { total: 1, would_deny: 1, denied: 0 },
    })
    expect(s.pairs).toHaveLength(1)
    expect(s.pairs[0]).toMatchObject({ mode: 'enforce', denied: true, count: 1 })
  })

  it('audit mode: a verdict that is not ok is a would_deny and never a denied', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'route', mode: 'audit', ok: false })])
    expect(s).toMatchObject({ total: 1, would_deny: 1, denied: 0 })
    expect(s.by_mode.audit).toEqual({ total: 1, would_deny: 1, denied: 0 })
  })

  it('enforce mode: a refusal is both a would_deny and a denied', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'route', mode: 'enforce', ok: false, denied: true })])
    expect(s).toMatchObject({ total: 1, would_deny: 1, denied: 1 })
  })

  it('an ok verdict counts in total only, and puts nothing in by_reason', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'route', mode: 'enforce', ok: true })])
    expect(s).toMatchObject({ total: 1, would_deny: 0, denied: 0, by_reason: {} })
  })

  it('by_reason counts messages per reason', () => {
    const s = summarizeSenderRouteChecks([
      row({ stage: 'route', mode: 'audit', ok: false, reason: 'not_trusted_peer' }),
      row({ stage: 'route', mode: 'audit', ok: false, reason: 'not_trusted_peer' }),
      row({ stage: 'route', mode: 'audit', ok: false, reason: 'unknown_sender_class' }),
    ])
    expect(s.by_reason).toEqual({ not_trusted_peer: 2, unknown_sender_class: 1 })
  })

  it('by_stage separates a route verdict from a delivery verdict of the same pair (no id joins them)', () => {
    const s = summarizeSenderRouteChecks([
      row({ stage: 'delivery', mode: 'audit', ok: false }, '5'),
      row({ stage: 'route', mode: 'audit', ok: false }),
    ])
    expect(s.total).toBe(2)
    expect(s.by_stage.route).toEqual({ total: 1, would_deny: 1, denied: 0 })
    expect(s.by_stage.delivery).toEqual({ total: 1, would_deny: 1, denied: 0 })
    expect(s.pairs.map((p) => p.stage).sort()).toEqual(['delivery', 'route'])
  })

  it('a delivery row with no message id is its own unit, like a route row', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'delivery', mode: 'audit', ok: false }, null), row({ stage: 'delivery', mode: 'audit', ok: false }, null)])
    expect(s.total).toBe(2)
  })

  it('pairs carry the documented fields and no message id, content or principal', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'delivery', mode: 'enforce', lane: 'routed', senderClass: 'owner', from: 'owner-a', to: 'agent-b', ok: false, reason: 'target_not_owner_main_agent', denied: true }, '41')])
    expect(Object.keys(s.pairs[0]).sort()).toEqual(['count', 'denied', 'from', 'lane', 'mode', 'ok', 'reason', 'senderClass', 'stage', 'to'])
    expect(JSON.stringify(s)).not.toContain('41')
  })

  it('pairs are sorted by count, then by name, so two reads of the same rows give the same list', () => {
    const rows = [
      row({ stage: 'route', mode: 'audit', ok: true, from: 'agent-b', to: 'main-a' }),
      row({ stage: 'route', mode: 'audit', ok: true, from: 'agent-a', to: 'main-a' }),
      row({ stage: 'route', mode: 'audit', ok: true, from: 'agent-c', to: 'main-a' }),
      row({ stage: 'route', mode: 'audit', ok: true, from: 'agent-c', to: 'main-a' }),
    ]
    expect(summarizeSenderRouteChecks(rows).pairs.map((p) => `${p.from}:${p.count}`)).toEqual(['agent-c:2', 'agent-a:1', 'agent-b:1'])
    expect(summarizeSenderRouteChecks([...rows].reverse()).pairs.map((p) => `${p.from}:${p.count}`)).toEqual(['agent-c:2', 'agent-a:1', 'agent-b:1'])
  })

  it('the pair list is cut at the cap and says so', () => {
    const rows = Array.from({ length: SENDER_ROUTE_AUDIT_MAX_PAIRS + 3 }, (_, i) => row({ stage: 'route', mode: 'audit', ok: true, from: `agent-${i}` }))
    const s = summarizeSenderRouteChecks(rows)
    expect(s.pairs).toHaveLength(SENDER_ROUTE_AUDIT_MAX_PAIRS)
    expect(s.pairs_truncated).toBe(true)
    expect(s.total).toBe(SENDER_ROUTE_AUDIT_MAX_PAIRS + 3) // the totals still count every message
    expect(summarizeSenderRouteChecks(rows.slice(0, SENDER_ROUTE_AUDIT_MAX_PAIRS)).pairs_truncated).toBe(false)
  })

  it('a row whose detail cannot be read is counted as unreadable and nowhere else', () => {
    const bad: SenderRouteCheckRow[] = [
      { id: 900, entity_id: null, created_at: 1, detail: null },
      { id: 901, entity_id: null, created_at: 1, detail: 'not json' },
      { id: 902, entity_id: null, created_at: 1, detail: '[1,2]' },
      { id: 903, entity_id: null, created_at: 1, detail: JSON.stringify({ stage: 'route', mode: 'audit' }) },
      { id: 904, entity_id: null, created_at: 1, detail: JSON.stringify({ stage: 'route', mode: 'audit', lane: 'routed', senderClass: 'fleet_agent', from: 'a', to: 'b', ok: 'yes', denied: false }) },
    ]
    const s = summarizeSenderRouteChecks([...bad, row({ stage: 'route', mode: 'audit', ok: true })])
    expect(s.unreadable).toBe(5)
    expect(s.total).toBe(1)
  })

  it('a reason or mode named like an object property stays a plain key and does not touch the prototype', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'route', mode: '__proto__', ok: false, reason: '__proto__' })])
    expect(Object.keys(s.by_reason)).toEqual(['__proto__'])
    expect(Object.getOwnPropertyDescriptor(s.by_reason, '__proto__')?.value).toBe(1)
    expect(Object.keys(s.by_mode)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).total).toBeUndefined()
  })

  it('a not-ok verdict with no reason is counted under "unspecified", not dropped', () => {
    const r = row({ stage: 'route', mode: 'audit', ok: false })
    const parsed = JSON.parse(r.detail as string)
    parsed.reason = null
    const s = summarizeSenderRouteChecks([{ ...r, detail: JSON.stringify(parsed) }])
    expect(s.by_reason).toEqual({ unspecified: 1 })
  })
})
