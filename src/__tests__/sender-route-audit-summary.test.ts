// The counting behind GET /api/admin/sender-route-audit: pure rows in, summary out. The route test (against a real
// database and the real audit writer) covers the window, the role gate and the row limit; this file pins how a unit
// is counted in each of the two stage blocks. Neutral fixtures only (agent-a, agent-b, main-a).

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
const ZERO = { total: 0, would_deny: 0, denied: 0, by_reason: {}, by_mode: {} }

describe('summarizeSenderRouteChecks: the shape', () => {
  it('an empty window is two zero blocks and nothing else; there is no top-level total', () => {
    const s = summarizeSenderRouteChecks([])
    expect(s).toEqual({ by_stage: { route: ZERO, delivery: ZERO }, unreadable: 0, pairs: [], pairs_truncated: false })
    expect(s).not.toHaveProperty('total')
    expect(s).not.toHaveProperty('would_deny')
    expect(s).not.toHaveProperty('denied')
    expect(s).not.toHaveProperty('by_reason')
    expect(s).not.toHaveProperty('by_mode')
  })
})

describe('summarizeSenderRouteChecks: the route block', () => {
  it('a route row is one unit each, even with the same pair (it has no message id)', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'route', mode: 'audit', ok: true }), row({ stage: 'route', mode: 'audit', ok: true })])
    expect(s.by_stage.route.total).toBe(2)
    expect(s.pairs).toHaveLength(1)
    expect(s.pairs[0]).toMatchObject({ stage: 'route', count: 2 })
  })

  it('route rows are never merged by an entity id, whatever it holds', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'route', mode: 'audit', ok: true }, '5'), row({ stage: 'route', mode: 'audit', ok: true }, '5')])
    expect(s.by_stage.route.total).toBe(2)
  })

  it('audit mode: a not-ok verdict is a would_deny and never a denied', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'route', mode: 'audit', ok: false })])
    expect(s.by_stage.route).toEqual({ total: 1, would_deny: 1, denied: 0, by_reason: { not_trusted_peer: 1 }, by_mode: { audit: { total: 1, would_deny: 1, denied: 0 } } })
  })

  it('enforce mode: a refusal is both a would_deny and a denied', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'route', mode: 'enforce', ok: false, denied: true })])
    expect(s.by_stage.route).toMatchObject({ total: 1, would_deny: 1, denied: 1 })
    expect(s.by_stage.route.by_mode.enforce).toEqual({ total: 1, would_deny: 1, denied: 1 })
  })

  it('an ok verdict counts in total only and puts nothing in by_reason', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'route', mode: 'enforce', ok: true })])
    expect(s.by_stage.route).toMatchObject({ total: 1, would_deny: 0, denied: 0, by_reason: {} })
  })

  it('the messages an agent sent to itself are readable from the route pairs, counted once', () => {
    const s = summarizeSenderRouteChecks([
      row({ stage: 'route', mode: 'audit', ok: true, from: 'agent-a', to: 'agent-a' }),
      row({ stage: 'route', mode: 'audit', ok: true, from: 'agent-a', to: 'agent-a' }),
      row({ stage: 'route', mode: 'audit', ok: true, from: 'agent-a', to: 'agent-b' }),
    ])
    const self = s.pairs.filter((p) => p.stage === 'route' && p.from === p.to)
    expect(self.reduce((n, p) => n + p.count, 0)).toBe(2)
  })
})

describe('summarizeSenderRouteChecks: the delivery block', () => {
  it('several delivery rows of one message id and mode are ONE unit (a restart forgets the once-per-message memory)', () => {
    const rows = [1, 2, 3].map(() => row({ stage: 'delivery', mode: 'audit', ok: false }, '77'))
    const s = summarizeSenderRouteChecks(rows)
    expect(s.by_stage.delivery.total).toBe(1)
    expect(s.by_stage.delivery.would_deny).toBe(1)
    expect(s.pairs[0].count).toBe(1)
  })

  it('different message ids are different units', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'delivery', mode: 'audit', ok: false }, '1'), row({ stage: 'delivery', mode: 'audit', ok: false }, '2')])
    expect(s.by_stage.delivery).toMatchObject({ total: 2, would_deny: 2 })
  })

  it('the same id in two modes is two units, one per mode (a switch writes a second row by design)', () => {
    const s = summarizeSenderRouteChecks([
      row({ stage: 'delivery', mode: 'enforce', ok: false, denied: true }, '9'),
      row({ stage: 'delivery', mode: 'audit', ok: false, denied: false }, '9'),
    ])
    expect(s.by_stage.delivery.total).toBe(2)
    expect(s.by_stage.delivery.by_mode).toEqual({
      enforce: { total: 1, would_deny: 1, denied: 1 },
      audit: { total: 1, would_deny: 1, denied: 0 },
    })
    expect(s.pairs.map((p) => `${p.mode}:${p.count}`).sort()).toEqual(['audit:1', 'enforce:1'])
  })

  it('of the rows of one message and mode, the newest verdict is the unit', () => {
    const s = summarizeSenderRouteChecks([
      row({ stage: 'delivery', mode: 'audit', ok: true }, '4'),      // newest
      row({ stage: 'delivery', mode: 'audit', ok: false }, '4'),
    ])
    expect(s.by_stage.delivery).toMatchObject({ total: 1, would_deny: 0 })
  })

  it('a delivery row with no message id is its own unit, like a route row', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'delivery', mode: 'audit', ok: false }, null), row({ stage: 'delivery', mode: 'audit', ok: false }, null)])
    expect(s.by_stage.delivery.total).toBe(2)
  })
})

describe('summarizeSenderRouteChecks: the two blocks do not meet', () => {
  it('the same not-ok message in a route row and a delivery row is one unit in EACH block and is added nowhere', () => {
    const s = summarizeSenderRouteChecks([
      row({ stage: 'delivery', mode: 'audit', ok: false }, '5'),
      row({ stage: 'route', mode: 'audit', ok: false }),
    ])
    expect(s.by_stage.route).toMatchObject({ total: 1, would_deny: 1 })
    expect(s.by_stage.delivery).toMatchObject({ total: 1, would_deny: 1 })
    expect(s).not.toHaveProperty('total')
    expect(s.pairs.map((p) => `${p.stage}:${p.count}`).sort()).toEqual(['delivery:1', 'route:1'])
  })

  it('by_reason and by_mode are per stage', () => {
    const s = summarizeSenderRouteChecks([
      row({ stage: 'route', mode: 'audit', ok: false, reason: 'not_trusted_peer' }),
      row({ stage: 'route', mode: 'audit', ok: false, reason: 'not_trusted_peer' }),
      row({ stage: 'delivery', mode: 'enforce', ok: false, reason: 'target_not_owner_main_agent', denied: true }, '3'),
    ])
    expect(s.by_stage.route.by_reason).toEqual({ not_trusted_peer: 2 })
    expect(s.by_stage.delivery.by_reason).toEqual({ target_not_owner_main_agent: 1 })
    expect(Object.keys(s.by_stage.route.by_mode)).toEqual(['audit'])
    expect(Object.keys(s.by_stage.delivery.by_mode)).toEqual(['enforce'])
  })

  it('a pair of the same shape in both stages stays two pairs, the count is inside its stage', () => {
    const s = summarizeSenderRouteChecks([
      row({ stage: 'route', mode: 'audit', ok: false }),
      row({ stage: 'route', mode: 'audit', ok: false }),
      row({ stage: 'delivery', mode: 'audit', ok: false }, '8'),
    ])
    const by = Object.fromEntries(s.pairs.map((p) => [p.stage, p.count]))
    expect(by).toEqual({ route: 2, delivery: 1 })
  })
})

describe('summarizeSenderRouteChecks: pairs, bad rows, odd keys', () => {
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

  it('the pair list is cut at the cap and says so; the block totals still count every unit', () => {
    const rows = Array.from({ length: SENDER_ROUTE_AUDIT_MAX_PAIRS + 3 }, (_, i) => row({ stage: 'route', mode: 'audit', ok: true, from: `agent-${i}` }))
    const s = summarizeSenderRouteChecks(rows)
    expect(s.pairs).toHaveLength(SENDER_ROUTE_AUDIT_MAX_PAIRS)
    expect(s.pairs_truncated).toBe(true)
    expect(s.by_stage.route.total).toBe(SENDER_ROUTE_AUDIT_MAX_PAIRS + 3)
    expect(summarizeSenderRouteChecks(rows.slice(0, SENDER_ROUTE_AUDIT_MAX_PAIRS)).pairs_truncated).toBe(false)
  })

  it('a row whose detail cannot be read, or names another stage, is counted as unreadable and nowhere else', () => {
    const ok = { mode: 'audit', lane: 'routed', senderClass: 'fleet_agent', from: 'a', to: 'b', ok: true, denied: false }
    const bad: SenderRouteCheckRow[] = [
      { id: 900, entity_id: null, created_at: 1, detail: null },
      { id: 901, entity_id: null, created_at: 1, detail: 'not json' },
      { id: 902, entity_id: null, created_at: 1, detail: '[1,2]' },
      { id: 903, entity_id: null, created_at: 1, detail: JSON.stringify({ stage: 'route', mode: 'audit' }) },
      { id: 904, entity_id: null, created_at: 1, detail: JSON.stringify({ ...ok, stage: 'route', ok: 'yes' }) },
      { id: 905, entity_id: null, created_at: 1, detail: JSON.stringify({ ...ok, stage: 'elsewhere' }) },
    ]
    const s = summarizeSenderRouteChecks([...bad, row({ stage: 'route', mode: 'audit', ok: true })])
    expect(s.unreadable).toBe(6)
    expect(s.by_stage.route.total).toBe(1)
    expect(s.by_stage.delivery.total).toBe(0)
  })

  it('a reason or mode named like an object property stays a plain key and does not touch the prototype', () => {
    const s = summarizeSenderRouteChecks([row({ stage: 'route', mode: '__proto__', ok: false, reason: '__proto__' })])
    expect(Object.keys(s.by_stage.route.by_reason)).toEqual(['__proto__'])
    expect(Object.getOwnPropertyDescriptor(s.by_stage.route.by_reason, '__proto__')?.value).toBe(1)
    expect(Object.keys(s.by_stage.route.by_mode)).toEqual(['__proto__'])
    expect(({} as Record<string, unknown>).total).toBeUndefined()
  })

  it('a not-ok verdict with no reason is counted under "unspecified", not dropped', () => {
    const r = row({ stage: 'route', mode: 'audit', ok: false })
    const parsed = JSON.parse(r.detail as string)
    parsed.reason = null
    const s = summarizeSenderRouteChecks([{ ...r, detail: JSON.stringify(parsed) }])
    expect(s.by_stage.route.by_reason).toEqual({ unspecified: 1 })
  })
})
