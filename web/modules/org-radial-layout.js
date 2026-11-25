// Radial layout of one tenant's org chart. Pure functions: no DOM, no fetch, no clock, no randomness, so the same
// input always gives the same picture (stable for screenshots and for tests).
//
// Input: the per-tenant view of GET /api/team/graph?view=tenants, `{ rootId, nodes: [{ id }], edges: [{ from, to }] }`.
// Output: a position (x, y, relative to the centre at 0,0, y pointing DOWN) per node, the radius of each ring, the spokes
// and the bounding box. Angles are in degrees, 0 = straight up, clockwise.
//
// Rules (plan orgchart-radial, section 3.2, and the mockup of the design doc):
//   - ring index = depth: the centre is ring 0, its direct reports ring 1, their reports ring 2, and so on.
//   - ring 1 is SYMMETRIC: n nodes 360/n degrees apart, the first one at the top, then clockwise, in the order given.
//   - below ring 1 a branch is a WEDGE: the children of a node share the wedge of that node, each child a sub-wedge
//     proportional to its leaf count (a heavier branch gets more room), centred on the sub-wedge. A branch therefore never
//     crosses another one, and a single child sits on the angle of its parent (a radial spoke).
//   - one radius PER RING (concentric circles, not per branch). The radius is the larger of a base value (taken from the
//     mockup) and what the no-overlap rule needs: two neighbours on a ring are at least `minChord` pixels apart (the node
//     plus its label), so the radius grows when a ring is crowded. The layout follows the REAL tree, it is not balanced.
//   - no centre (rootId null: a tenant role has no global main node): the parentless nodes form ring 1 around an empty centre.
//   - a node deeper than `maxRings` is not placed: its ring-`maxRings` ancestor carries `hiddenCount` (the renderer shows "+N").
//   - a node that cannot be reached from the centre (a reporting cycle the server should have refused) goes on a trailing
//     ring, evenly spaced, flagged `orphan`.

export const DEFAULT_LAYOUT_OPTIONS = Object.freeze({
  /** base radius of ring 1 .. ring 3 (px), from the mockup (avatar 80 px); further rings add `ringStep` each */
  ringBase: Object.freeze([240, 520, 700]),
  /** base radius of ring 1 when it has `smallRing1Limit` nodes or fewer (a small tenant graph) */
  smallRing1: 200,
  smallRing1Limit: 4,
  ringStep: 180,
  /** least distance between two neighbouring nodes of one ring (node, its ring and the label width) */
  minChord: 150,
  /** least gap between two rings */
  minRingGap: 140,
  /** rings that are drawn; deeper nodes are folded into `hiddenCount` of the outermost drawn one */
  maxRings: 4,
  /** more nodes than this on one ring: the renderer shortens the labels to the initials (see `crowdedRings`) */
  crowdedLimit: 24,
  /** room around the outermost node for its ring and label, added to the bounding box */
  pad: 100,
})

const TAU_DEG = 360

function rad(deg) { return (deg * Math.PI) / 180 }

/** Smallest positive angular distance (degrees) between two angles on a circle. */
function angularDistance(a, b) {
  const d = Math.abs(a - b) % TAU_DEG
  return d > 180 ? TAU_DEG - d : d
}

/** Radius at which two nodes `deltaDeg` apart are `chord` pixels apart. */
function radiusForChord(chord, deltaDeg) {
  const half = Math.sin(rad(Math.min(deltaDeg, 180)) / 2)
  return half > 1e-9 ? chord / (2 * half) : Infinity
}

export function layoutRadial(view, options = {}) {
  const o = { ...DEFAULT_LAYOUT_OPTIONS, ...options }
  const nodes = Array.isArray(view?.nodes) ? view.nodes : []
  const edges = Array.isArray(view?.edges) ? view.edges : []
  const byId = new Map()
  for (const n of nodes) if (n && typeof n.id === 'string' && !byId.has(n.id)) byId.set(n.id, n)
  const order = [...byId.keys()]
  const index = new Map(order.map((id, i) => [id, i]))

  // children in the order of the nodes given, one parent per node (the first edge wins)
  const children = new Map(order.map((id) => [id, []]))
  const hasParent = new Set()
  for (const e of edges) {
    if (!byId.has(e?.from) || !byId.has(e?.to) || e.from === e.to || hasParent.has(e.to)) continue
    children.get(e.from).push(e.to)
    hasParent.add(e.to)
  }
  for (const list of children.values()) list.sort((a, b) => index.get(a) - index.get(b))

  const rootId = typeof view?.rootId === 'string' && byId.has(view.rootId) ? view.rootId : null
  // top-level nodes: the centre's reports, or (no centre) every parentless node
  const top = rootId
    ? [...children.get(rootId)]
    : order.filter((id) => !hasParent.has(id))

  // depth by a walk from the top; the visited set also stops a cycle
  const depth = new Map()
  const placedOrder = []
  const visit = (id, d) => {
    if (depth.has(id) || id === rootId) return
    depth.set(id, d)
    placedOrder.push(id)
    for (const c of children.get(id)) visit(c, d + 1)
  }
  for (const id of top) visit(id, 1)
  const orphans = order.filter((id) => id !== rootId && !depth.has(id))

  // leaf counts for the wedge weights (a node with no placed child counts as one)
  const leaves = new Map()
  const countLeaves = (id) => {
    if (leaves.has(id)) return leaves.get(id)
    const kids = children.get(id).filter((c) => depth.get(c) === depth.get(id) + 1)
    const n = kids.length === 0 ? 1 : kids.reduce((s, c) => s + countLeaves(c), 0)
    leaves.set(id, n)
    return n
  }

  const angle = new Map()
  const assign = (ids, from, width) => {
    const total = ids.reduce((s, id) => s + countLeaves(id), 0)
    let cursor = from
    for (const id of ids) {
      const w = (width * countLeaves(id)) / total
      angle.set(id, cursor + w / 2)
      const kids = children.get(id).filter((c) => depth.get(c) === depth.get(id) + 1)
      if (kids.length) assign(kids, cursor, w)
      cursor += w
    }
  }
  // ring 1: equal slices (symmetry), the first node on the top; the slices are centred on their node
  if (top.length) {
    const slice = TAU_DEG / top.length
    top.forEach((id, i) => {
      const a = i * slice
      angle.set(id, a)
      const kids = children.get(id).filter((c) => depth.get(c) === 2)
      if (kids.length) assign(kids, a - slice / 2, slice)
    })
  }

  for (const [id, a] of angle) angle.set(id, ((a % TAU_DEG) + TAU_DEG) % TAU_DEG) // a wedge left of the top has a negative angle
  const maxDepth = Math.max(0, ...depth.values())
  const drawnDepth = Math.min(maxDepth, o.maxRings)
  // a trailing ring for the unreachable nodes
  const orphanRing = orphans.length ? drawnDepth + 1 : 0
  orphans.forEach((id, i) => { depth.set(id, orphanRing); angle.set(id, (i * TAU_DEG) / orphans.length) })

  // hidden descendants of the outermost drawn ring
  const hiddenCount = new Map()
  const countBelow = (id) => children.get(id).reduce((s, c) => s + 1 + countBelow(c), 0)
  for (const id of placedOrder) if (depth.get(id) === o.maxRings) {
    const n = countBelow(id)
    if (n > 0) hiddenCount.set(id, n)
  }

  const ringIds = []
  for (const [id, d] of depth) {
    if (d > o.maxRings && d !== orphanRing) continue
    if (!ringIds[d]) ringIds[d] = []
    ringIds[d].push(id)
  }
  const lastRing = Math.max(0, ringIds.length - 1)

  // one radius per ring: base value, or what the chord rule needs for the two closest neighbours of the ring
  const radii = [0]
  for (let k = 1; k <= lastRing; k++) {
    const ids = ringIds[k] ?? []
    const base = k === 1 && ids.length <= o.smallRing1Limit
      ? o.smallRing1
      : (o.ringBase[k - 1] ?? o.ringBase[o.ringBase.length - 1] + (k - o.ringBase.length) * o.ringStep)
    let need = 0
    const angles = ids.map((id) => angle.get(id)).sort((a, b) => a - b)
    if (angles.length > 1) {
      let min = Infinity
      for (let i = 0; i < angles.length; i++) {
        const d = angularDistance(angles[i], angles[(i + 1) % angles.length])
        if (d > 1e-9 && d < min) min = d
      }
      need = Number.isFinite(min) ? radiusForChord(o.minChord, min) : 0
    }
    radii[k] = Math.max(base, need, (radii[k - 1] ?? 0) + (k === 1 ? 0 : o.minRingGap))
  }

  const placed = []
  const pos = new Map()
  if (rootId) { placed.push({ id: rootId, ring: 0, angle: 0, x: 0, y: 0, isRoot: true }); pos.set(rootId, { x: 0, y: 0 }) }
  for (let k = 1; k <= lastRing; k++) {
    for (const id of ringIds[k] ?? []) {
      const a = angle.get(id)
      const x = round(radii[k] * Math.sin(rad(a)))
      const y = round(-radii[k] * Math.cos(rad(a)))
      pos.set(id, { x, y })
      placed.push({
        id, ring: k, angle: round(a), x, y, isRoot: false,
        ...(depth.get(id) === orphanRing && orphans.includes(id) ? { orphan: true } : {}),
        ...(hiddenCount.has(id) ? { hiddenCount: hiddenCount.get(id) } : {}),
      })
    }
  }
  // the order of the output is the order of the input (centre first), not the order of the rings
  placed.sort((a, b) => (a.isRoot ? -1 : b.isRoot ? 1 : index.get(a.id) - index.get(b.id)))

  // spokes between two placed nodes; with a centre its own spokes start at 0,0, without one the top-level nodes have none
  const spokes = []
  for (const [parent, kids] of children) {
    for (const c of kids) {
      const from = pos.get(parent)
      const to = pos.get(c)
      if (from && to) spokes.push({ from: parent, to: c, x1: from.x, y1: from.y, x2: to.x, y2: to.y })
    }
  }

  const crowdedRings = []
  for (let k = 1; k <= lastRing; k++) if ((ringIds[k] ?? []).length > o.crowdedLimit) crowdedRings.push(k)

  const reach = Math.max(0, ...radii) + o.pad
  return {
    centre: rootId,
    nodes: placed,
    spokes,
    radii: radii.slice(1),
    crowdedRings,
    bounds: { minX: -reach, minY: -reach, maxX: reach, maxY: reach, width: 2 * reach, height: 2 * reach },
  }
}

function round(n) { return Math.round(n * 100) / 100 }
