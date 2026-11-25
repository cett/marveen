// The radial layout of one tenant's org chart (web/modules/org-radial-layout.js): pure geometry, so every rule is a cell.
//
//   - ring 1 is symmetric (360/n apart, the first node on the top, clockwise); a branch is a wedge of its parent's slice and
//     never crosses another one; a single child sits on its parent's angle;
//   - one radius per ring, the smallest the geometry rule of the plan (section 11) allows, grown in 5 % steps until no two
//     label boxes overlap; no fixed radii;
//   - determinism, a missing centre, a cycle, too many rings, malformed input.
//
// Privacy: neutral fixtures only.
import { describe, it, expect } from 'vitest'
import { layoutRadial, DEFAULT_LAYOUT_OPTIONS } from '../../web/modules/org-radial-layout.js'

type View = Parameters<typeof layoutRadial>[0]
const view = (rootId: string | null, edges: [string, string][], extra: string[] = []): View => {
  const ids = new Set<string>(extra)
  if (rootId) ids.add(rootId)
  for (const [a, b] of edges) { ids.add(a); ids.add(b) }
  return { rootId, nodes: [...ids].map((id) => ({ id })), edges: edges.map(([from, to]) => ({ from, to })) }
}
// the shape of a live tenant: a centre, seven on ring 1, three under one of them, two under another, one on ring 3
const live = (): View => view('c', [
  ['c', 'n1'], ['c', 'n2'], ['c', 'n3'], ['c', 'n4'], ['c', 'n5'], ['c', 'n6'], ['c', 'n7'],
  ['n2', 'k1'], ['n2', 'k2'], ['n2', 'k3'], ['n3', 'j1'], ['n3', 'j2'], ['k1', 'g1'],
])
const at = (l: ReturnType<typeof layoutRadial>, id: string) => {
  const n = l.nodes.find((x) => x.id === id)
  if (!n) throw new Error('no node ' + id)
  return n
}
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

describe('ring 1 is symmetric', () => {
  it('n nodes are 360/n degrees apart, the first on the top, then clockwise, in the order given', () => {
    const l = layoutRadial(live())
    const ring1 = l.nodes.filter((n) => n.ring === 1)
    expect(ring1.map((n) => n.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'])
    ring1.forEach((n, i) => expect(n.angle).toBeCloseTo((i * 360) / 7, 1))
    expect(at(l, 'n1').x).toBeCloseTo(0, 1)
    expect(at(l, 'n1').y).toBeLessThan(0)
    expect(at(l, 'n2').x).toBeGreaterThan(0) // clockwise from the top goes to the right first
  })

  it('all of ring 1 sits on one circle around the centre at 0,0', () => {
    const l = layoutRadial(live())
    for (const n of l.nodes.filter((x) => x.ring === 1)) expect(Math.hypot(n.x, n.y)).toBeCloseTo(l.radii[0] as number, 1)
    expect(at(l, 'c')).toMatchObject({ x: 0, y: 0, ring: 0, isRoot: true })
  })

  it('one subordinate sits on the top', () => {
    const l = layoutRadial(view('c', [['c', 'a']]))
    expect(at(l, 'a')).toMatchObject({ x: 0, ring: 1 })
    expect(at(l, 'a').y).toBe(-DEFAULT_LAYOUT_OPTIONS.ringGap) // the first ring is a ring gap away from the centre
  })

  it('no subordinates: only the centre, no rings', () => {
    const l = layoutRadial(view('c', []))
    expect(l.nodes.map((n) => n.id)).toEqual(['c'])
    expect(l.radii).toEqual([])
    expect(l.spokes).toEqual([])
  })
})

describe('the radii', () => {
  it('are the smallest that keep the rules, not constants: a small ring 1 is one ring gap out, a bigger tree is wider', () => {
    const small = layoutRadial(view('c', [['c', 'a'], ['c', 'b'], ['c', 'd'], ['c', 'e']]))
    expect(small.radii).toEqual([DEFAULT_LAYOUT_OPTIONS.ringGap])
    const big = layoutRadial(live())
    expect(big.radii).toHaveLength(3)
    expect(big.radii[0]).toBeGreaterThan(small.radii[0] as number)
    for (let k = 1; k < big.radii.length; k++) expect((big.radii[k] as number) - (big.radii[k - 1] as number)).toBeGreaterThanOrEqual(DEFAULT_LAYOUT_OPTIONS.ringGap - 0.01)
  })

  it('no two label boxes overlap, and when the chord rule alone leaves an overlap the radii grow in 5 % steps until it is gone', () => {
    // eight nodes on ring 1 keep the chord at 150 px but their boxes (150 x 130) still overlap on the diagonals
    const edges: [string, string][] = Array.from({ length: 8 }, (_, i) => ['c', `n${i}`])
    const l = layoutRadial(view('c', edges))
    const chordOnly = DEFAULT_LAYOUT_OPTIONS.minChord / (2 * Math.sin(Math.PI / 8))
    expect(l.radii[0]).toBeGreaterThan(chordOnly)
    // grown from the minimum by whole 5 % steps
    const steps = Math.log((l.radii[0] as number) / Math.max(chordOnly, DEFAULT_LAYOUT_OPTIONS.ringGap)) / Math.log(DEFAULT_LAYOUT_OPTIONS.growStep)
    expect(Math.abs(steps - Math.round(steps))).toBeLessThan(0.01)
    for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) {
      const a = l.nodes[i]!, b = l.nodes[j]!
      expect(Math.abs(a.x - b.x) >= DEFAULT_LAYOUT_OPTIONS.boxW || Math.abs(a.y - b.y) >= DEFAULT_LAYOUT_OPTIONS.boxH, `${a.id} ${b.id}`).toBe(true)
    }
  })

  it('the live-shaped tree has no overlapping boxes either', () => {
    const l = layoutRadial(live())
    for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) {
      const a = l.nodes[i]!, b = l.nodes[j]!
      expect(Math.abs(a.x - b.x) >= DEFAULT_LAYOUT_OPTIONS.boxW || Math.abs(a.y - b.y) >= DEFAULT_LAYOUT_OPTIONS.boxH, `${a.id} ${b.id}`).toBe(true)
    }
  })

  it('a crowded ring grows its radius until its neighbours are a chord apart, and is flagged', () => {
    const edges: [string, string][] = Array.from({ length: 30 }, (_, i) => ['c', `n${i}`])
    const l = layoutRadial(view('c', edges))
    expect(l.radii[0]).toBeGreaterThanOrEqual((30 * DEFAULT_LAYOUT_OPTIONS.minChord) / (2 * Math.PI) - 1)
    expect(l.crowdedRings).toEqual([1])
    const ring = l.nodes.filter((n) => n.ring === 1)
    for (let i = 0; i < ring.length; i++) expect(dist(ring[i]!, ring[(i + 1) % ring.length]!)).toBeGreaterThanOrEqual(DEFAULT_LAYOUT_OPTIONS.minChord - 1)
  })

  it('the ring gap option is honoured', () => {
    const l = layoutRadial(live(), { ringGap: 300 })
    expect(l.radii[0]).toBeGreaterThanOrEqual(300)
    for (let k = 1; k < l.radii.length; k++) expect((l.radii[k] as number) - (l.radii[k - 1] as number)).toBeGreaterThanOrEqual(299.99)
  })

  it('borderChord governs where two branches meet, minChord inside a branch (the box test switched off to see the rule alone)', () => {
    const l = layoutRadial(live(), { borderChord: 400, minChord: 100, boxW: 1, boxH: 1, ringGap: 1 })
    expect(dist(at(l, 'k3'), at(l, 'j1'))).toBeGreaterThanOrEqual(399)
    const k = layoutRadial(live(), { borderChord: 1, minChord: 400, boxW: 1, boxH: 1, ringGap: 1 })
    expect(dist(at(k, 'k1'), at(k, 'k2'))).toBeGreaterThanOrEqual(399)
  })

  it('across the border of two branches the least distance is borderChord (148), within a branch minChord (150)', () => {
    const l = layoutRadial(live())
    const d = (a: string, b: string) => dist(at(l, a), at(l, b))
    expect(d('k1', 'k2')).toBeGreaterThanOrEqual(DEFAULT_LAYOUT_OPTIONS.minChord - 0.5) // same parent
    expect(d('k3', 'j1')).toBeGreaterThanOrEqual(DEFAULT_LAYOUT_OPTIONS.borderChord - 0.5) // two branches meet
  })
})

describe('a branch is a wedge', () => {
  it('the children of a node are centred on it and share its slice; a single child sits on its parent\'s angle', () => {
    const l = layoutRadial(live())
    const a = at(l, 'n2').angle
    const kids = ['k1', 'k2', 'k3'].map((id) => at(l, id).angle)
    expect(kids[1]).toBeCloseTo(a, 1)
    expect(kids[0]).toBeCloseTo(a - 360 / 7 / 3, 1)
    expect(kids[2]).toBeCloseTo(a + 360 / 7 / 3, 1)
    expect(at(l, 'g1').angle).toBeCloseTo(at(l, 'k1').angle, 1)
    expect(at(l, 'g1').ring).toBe(3)
  })

  it('no descendant leaves the slice of its ring-1 ancestor (branches never cross)', () => {
    const l = layoutRadial(live())
    const slice = 360 / 7
    for (const [top, below] of [['n2', ['k1', 'k2', 'k3', 'g1']], ['n3', ['j1', 'j2']]] as const) {
      for (const id of below) {
        const delta = Math.abs(((at(l, id).angle - at(l, top).angle + 540) % 360) - 180)
        expect(delta).toBeLessThanOrEqual(slice / 2 + 1e-6)
      }
    }
  })

  it('every angle is reported in [0, 360), also for a wedge that starts left of the top', () => {
    // the first node of ring 1 is on the top, so the wedge of its children starts at a negative angle
    const l = layoutRadial(view('c', [['c', 'a'], ['c', 'b'], ['a', 'a1'], ['a', 'a2']]))
    for (const n of l.nodes) { expect(n.angle).toBeGreaterThanOrEqual(0); expect(n.angle).toBeLessThan(360) }
    expect(at(l, 'a1').angle).toBeGreaterThan(300)
    expect(at(l, 'a1').x).toBeLessThan(0) // left of the top
  })

  it('children share their parent\'s slice by LEAF COUNT: a heavier branch gets more, a lighter one less (plan section 11, rule 6)', () => {
    // under n: a has three leaves, b has one: a's wedge is three times b's
    const l = layoutRadial(view('c', [['c', 'n'], ['n', 'a'], ['n', 'b'], ['a', 'a1'], ['a', 'a2'], ['a', 'a3']]))
    // n is the only node on ring 1 (angle 0), its slice is the whole circle from -180: a's wedge is 270 degrees (centre -45,
    // that is 315), b's 90 degrees (centre 135)
    expect(at(l, 'a').angle).toBeCloseTo(315, 1)
    expect(at(l, 'b').angle).toBeCloseTo(135, 1)
  })

  it('there is no weighting switch any more: an old `slices` option changes nothing', () => {
    const edges: [string, string][] = [['c', 'n'], ['n', 'a'], ['n', 'b'], ['a', 'a1'], ['a', 'a2'], ['a', 'a3']]
    const withOption = layoutRadial(view('c', edges), { slices: 'equal' } as never)
    expect(withOption).toEqual(layoutRadial(view('c', edges)))
    expect('slices' in DEFAULT_LAYOUT_OPTIONS).toBe(false)
  })
})

describe('no overlap', () => {
  it('on every ring neighbours are at least a chord apart, across branch borders too', () => {
    const l = layoutRadial(live())
    for (let k = 1; k <= l.radii.length; k++) {
      const ring = l.nodes.filter((n) => n.ring === k)
      for (let i = 0; i < ring.length; i++) for (let j = i + 1; j < ring.length; j++) {
        expect(dist(ring[i]!, ring[j]!), `${ring[i]!.id} ${ring[j]!.id}`).toBeGreaterThanOrEqual(DEFAULT_LAYOUT_OPTIONS.minChord - 1)
      }
    }
  })

  it('no two nodes of any ring are closer than the avatar footprint', () => {
    const l = layoutRadial(live())
    for (let i = 0; i < l.nodes.length; i++) for (let j = i + 1; j < l.nodes.length; j++) {
      expect(dist(l.nodes[i]!, l.nodes[j]!)).toBeGreaterThan(92)
    }
  })

  it('the bounding box holds every label box of the placed nodes, with the pad around them', () => {
    const l = layoutRadial(live())
    const { boxW, boxH, pad } = DEFAULT_LAYOUT_OPTIONS
    for (const n of l.nodes) {
      expect(n.x - boxW / 2).toBeGreaterThanOrEqual(l.bounds.minX + pad - 0.01)
      expect(n.x + boxW / 2).toBeLessThanOrEqual(l.bounds.maxX - pad + 0.01)
      expect(n.y - boxH / 2).toBeGreaterThanOrEqual(l.bounds.minY + pad - 0.01)
      expect(n.y + boxH / 2).toBeLessThanOrEqual(l.bounds.maxY - pad + 0.01)
    }
    expect(l.bounds.width).toBeCloseTo(l.bounds.maxX - l.bounds.minX, 1)
    expect(l.bounds.height).toBeCloseTo(l.bounds.maxY - l.bounds.minY, 1)
  })

  it('the bounding box is TIGHT: a tree that fills one side only does not get the empty side of the outer rings', () => {
    // one long branch up: more room above the centre than below it, and as wide as the widest node plus its box and pad
    const l = layoutRadial(view('c', [['c', 'a'], ['a', 'b'], ['b', 'd']]))
    expect(l.bounds.minY).toBeLessThan(-l.bounds.maxY)
    const widest = Math.max(...l.nodes.map((n) => Math.abs(n.x)))
    expect(l.bounds.maxX).toBeCloseTo(widest + DEFAULT_LAYOUT_OPTIONS.boxW / 2 + DEFAULT_LAYOUT_OPTIONS.pad, 1)
  })

  it('a lone centre and an empty view still get a drawable box, never a zero-size one', () => {
    for (const l of [layoutRadial(view('c', [])), layoutRadial({ rootId: null, nodes: [], edges: [] })]) {
      expect(l.bounds.width).toBeGreaterThan(0)
      expect(l.bounds.height).toBeGreaterThan(0)
      expect(Number.isFinite(l.bounds.minX + l.bounds.maxY)).toBe(true)
    }
  })
})

describe('determinism and the order of the answer', () => {
  it('the same input gives the same picture, byte for byte', () => {
    expect(JSON.stringify(layoutRadial(live()))).toBe(JSON.stringify(layoutRadial(live())))
  })

  it('the answer lists the centre first, then the nodes in the order they were given', () => {
    const input = live()
    const l = layoutRadial(input)
    expect(l.nodes.map((n) => n.id)).toEqual(['c', ...input.nodes.map((n) => n.id).filter((id) => id !== 'c')])
  })

  it('every edge of the tree is a spoke from the parent to the child, the centre\'s from 0,0', () => {
    const l = layoutRadial(live())
    expect(l.spokes).toHaveLength(13)
    expect(l.spokes.find((s) => s.from === 'c' && s.to === 'n1')).toMatchObject({ x1: 0, y1: 0 })
    const s = l.spokes.find((x) => x.from === 'k1' && x.to === 'g1')!
    expect([s.x1, s.y1]).toEqual([at(l, 'k1').x, at(l, 'k1').y])
    expect([s.x2, s.y2]).toEqual([at(l, 'g1').x, at(l, 'g1').y])
  })
})

describe('a missing centre, odd shapes and malformed input', () => {
  it('without a centre the parentless nodes are ring 1 around an empty middle (no node at 0,0, no spoke from it)', () => {
    const l = layoutRadial(view(null, [['a', 'a1']], ['b', 'd']))
    expect(l.centre).toBeNull()
    expect(l.nodes.some((n) => n.x === 0 && n.y === 0)).toBe(false)
    // in the order given (b and d were listed before a)
    expect(l.nodes.filter((n) => n.ring === 1).map((n) => n.id)).toEqual(['b', 'd', 'a'])
    expect(at(l, 'a1').ring).toBe(2)
    expect(l.spokes).toHaveLength(1)
  })

  it('a rootId that is not among the nodes is treated as no centre', () => {
    const l = layoutRadial({ rootId: 'ghost', nodes: [{ id: 'a' }, { id: 'b' }], edges: [] })
    expect(l.centre).toBeNull()
    expect(l.nodes.map((n) => n.ring)).toEqual([1, 1])
  })

  it('nodes deeper than maxRings are not placed; the outermost drawn node carries how many are folded behind it', () => {
    const chain = view('c', [['c', 'r1'], ['r1', 'r2'], ['r2', 'r3'], ['r3', 'r4'], ['r4', 'r5'], ['r5', 'r6']])
    const l = layoutRadial(chain)
    expect(l.nodes.map((n) => n.id)).toEqual(['c', 'r1', 'r2', 'r3', 'r4'])
    expect(at(l, 'r4').hiddenCount).toBe(2)
    expect(at(l, 'r3').hiddenCount).toBeUndefined()
  })

  it('a node that cannot be reached from the centre (a cycle) goes on a trailing ring, flagged orphan, and nothing hangs', () => {
    const l = layoutRadial({ rootId: 'c', nodes: [{ id: 'c' }, { id: 'a' }, { id: 'x' }, { id: 'y' }], edges: [{ from: 'c', to: 'a' }, { from: 'x', to: 'y' }, { from: 'y', to: 'x' }] })
    expect(at(l, 'a').ring).toBe(1)
    expect(at(l, 'x')).toMatchObject({ ring: 2, orphan: true })
    expect(at(l, 'y')).toMatchObject({ ring: 2, orphan: true })
    expect(at(l, 'a').orphan).toBeUndefined()
  })

  it('a node with two parents hangs under the first edge; self-edges, unknown ids and duplicates are ignored', () => {
    const l = layoutRadial({
      rootId: 'c', nodes: [{ id: 'c' }, { id: 'a' }, { id: 'b' }, { id: 'a' }],
      edges: [{ from: 'c', to: 'a' }, { from: 'c', to: 'b' }, { from: 'a', to: 'b' }, { from: 'a', to: 'a' }, { from: 'nope', to: 'a' }, { from: 'a', to: 'nope' }],
    })
    expect(l.nodes.map((n) => n.id)).toEqual(['c', 'a', 'b'])
    expect(at(l, 'b').ring).toBe(1)
  })

  it('empty or malformed input never throws and gives an empty picture', () => {
    for (const bad of [undefined, null, {}, { nodes: 'x', edges: 5 }, { rootId: 3, nodes: [null, { id: 4 }], edges: [null] }] as unknown as View[]) {
      const l = layoutRadial(bad)
      expect(l.nodes).toEqual([])
      expect(l.spokes).toEqual([])
    }
  })
})

// Plan section 11 (the geometry rule): lower bounds of the DEFAULT tenant, 7 on ring 1, one of them with 3 children in a
// 17.14 degree slice each, one node on ring 3. The box test can only raise them.
describe('the geometry rule of the plan, section 11', () => {
  const boxesOverlap = (nodes: { x: number; y: number }[]) => {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      if (Math.abs(nodes[i]!.x - nodes[j]!.x) < DEFAULT_LAYOUT_OPTIONS.boxW && Math.abs(nodes[i]!.y - nodes[j]!.y) < DEFAULT_LAYOUT_OPTIONS.boxH) return true
    }
    return false
  }

  it('the DEFAULT tenant honours the lower bounds: r1 >= 173, r2 >= 503, r3 >= 679, and ends clean', () => {
    const l = layoutRadial(live())
    expect(l.clean).toBe(true)
    expect(l.radii[0]).toBeGreaterThanOrEqual(150 / (2 * Math.sin(Math.PI / 7)) - 0.01) // 173
    expect(l.radii[1]).toBeGreaterThanOrEqual(150 / (2 * Math.sin((17.142857 / 2) * (Math.PI / 180))) - 0.01) // 503
    expect(l.radii[2]).toBeGreaterThanOrEqual((l.radii[1] as number) + DEFAULT_LAYOUT_OPTIONS.ringGap - 0.01) // 679
    expect(l.radii[0]).toBeGreaterThanOrEqual(173)
    expect(l.radii[1]).toBeGreaterThanOrEqual(503)
    expect(l.radii[2]).toBeGreaterThanOrEqual(679)
  })

  it('the numbers of the rule are the defaults: a 150 x 130 box, 150 / 148 / 176 apart, a 5 % step', () => {
    expect(DEFAULT_LAYOUT_OPTIONS).toMatchObject({ boxW: 150, boxH: 130, minChord: 150, borderChord: 148, ringGap: 176, growStep: 1.05 })
  })

  it('the fixed radii 150 / 300 / 410 of the retired section 10 are a RED cell: with them the boxes overlap', () => {
    const l = layoutRadial(live())
    const fixed = [150, 300, 410]
    const nodes = l.nodes.filter((n) => !n.isRoot).map((n) => ({
      x: fixed[n.ring - 1]! * Math.sin((n.angle * Math.PI) / 180),
      y: -fixed[n.ring - 1]! * Math.cos((n.angle * Math.PI) / 180),
    }))
    expect(boxesOverlap(nodes)).toBe(true) // the detector rejects them ...
    expect(l.radii[0]).not.toBe(150) // ... and the layout does not use them
    expect(l.radii[1]).not.toBe(300)
    expect(l.radii[2]).not.toBe(410)
  })

  it('a 1.6x scale of the fixed set (240 / 480 / 656) is not an input: only the result of the rule may be that big', () => {
    const l = layoutRadial(live())
    expect(l.radii).not.toEqual([240, 480, 656])
  })

  it('when the grow cap runs out with boxes still overlapping the answer says so (clean: false), it is never silently drawn', () => {
    const edges: [string, string][] = Array.from({ length: 8 }, (_, i) => ['c', `n${i}`])
    const capped = layoutRadial(view('c', edges), { maxGrowSteps: 0, ringGap: 1, minChord: 1, borderChord: 1 })
    expect(capped.clean).toBe(false)
    expect(layoutRadial(view('c', edges)).clean).toBe(true)
  })

  it('an empty and a one-node picture are clean', () => {
    expect(layoutRadial({ rootId: null, nodes: [], edges: [] }).clean).toBe(true)
    expect(layoutRadial(view('c', [['c', 'a']])).clean).toBe(true)
  })
})
