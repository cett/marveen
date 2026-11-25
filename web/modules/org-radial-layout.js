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
//     proportional to its leaf count (plan section 11, rule 6: the picture follows the real tree, no balancing, no
//     weighting switch), centred on the sub-wedge.
//     A branch therefore never crosses another one, and a single child sits on the angle of its parent (a radial spoke).
//   - one radius PER RING (concentric circles, not per branch), NO fixed values: the smallest radii that keep (1) neighbours
//     of a ring at least `minChord` apart (a label box wide), `borderChord` across the border of two branches, (2) two rings
//     at least `ringGap` apart (a label box high plus a gap); then every pair of label boxes is tested and all radii grow by
//     `growStep` (5 %) until no two boxes overlap. The layout follows the REAL tree, it is not balanced.
//   - no centre (rootId null: a tenant role has no global main node): the parentless nodes form ring 1 around an empty centre.
//   - a node deeper than `maxRings` is not placed: its ring-`maxRings` ancestor carries `hiddenCount` (the renderer shows "+N").
//   - a node that cannot be reached from the centre (a reporting cycle the server should have refused) goes on a trailing
//     ring, evenly spaced, flagged `orphan`.

export const DEFAULT_LAYOUT_OPTIONS = Object.freeze({
  /** least distance between two neighbouring nodes of one ring and one branch (the width of a label box, 80 px avatar) */
  minChord: 150,
  /** least distance between two neighbours of one ring across the border of two branches */
  borderChord: 148,
  /** the label box of a node, for the overlap test (the avatar size is a theme token of the renderer, not derived from it) */
  boxW: 150,
  boxH: 130,
  /** least gap between two rings: the box height plus a gap */
  ringGap: 176,
  /** every radius grows by this factor (5 %) while two boxes overlap, at most maxGrowSteps times */
  growStep: 1.05,
  maxGrowSteps: 40,
  /** rings that are drawn; deeper nodes are folded into `hiddenCount` of the outermost drawn one */
  maxRings: 4,
  /** more nodes than this on one ring: the renderer shortens the labels to the initials (see `crowdedRings`) */
  crowdedLimit: 24,
  /** room around the label box of the outermost nodes (their ring, the centre halo, a stroke), added to the bounding box */
  pad: 32,
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
  const parentOf = new Map()
  for (const e of edges) {
    if (!byId.has(e?.from) || !byId.has(e?.to) || e.from === e.to || hasParent.has(e.to)) continue
    children.get(e.from).push(e.to)
    hasParent.add(e.to)
    parentOf.set(e.to, e.from)
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

  // The SMALLEST radii that keep the rules (no fixed values), then a box test that grows them until nothing overlaps:
  //   1. neighbours of a ring are at least `minChord` apart (the width of a label box), and at least `borderChord` apart
  //      across the border of two branches (different parents);
  //   2. two rings are at least `ringGap` apart (the height of a label box plus a gap), the first one from the centre too.
  const baseRadii = [0]
  for (let k = 1; k <= lastRing; k++) {
    const ids = [...(ringIds[k] ?? [])].sort((a, b) => angle.get(a) - angle.get(b))
    let need = 0
    if (ids.length > 1) {
      for (let i = 0; i < ids.length; i++) {
        const a = ids[i]
        const b = ids[(i + 1) % ids.length]
        const d = angularDistance(angle.get(a), angle.get(b))
        if (d <= 1e-9) continue
        need = Math.max(need, radiusForChord(parentOf.get(a) === parentOf.get(b) ? o.minChord : o.borderChord, d))
      }
    }
    baseRadii[k] = Math.max(need, baseRadii[k - 1] + o.ringGap)
  }

  const build = (scale) => {
    const radii = baseRadii.map((r) => r * scale)
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
    return { radii, placed, pos }
  }
  // the box test: every pair of label boxes (boxW x boxH around the node) is checked, and every radius grows by `growStep`
  // until no two boxes overlap (a bounded number of steps, so a degenerate input cannot loop)
  const overlaps = (placed) => {
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      if (Math.abs(placed[i].x - placed[j].x) < o.boxW && Math.abs(placed[i].y - placed[j].y) < o.boxH) return true
    }
    return false
  }
  let scale = 1
  let built = build(scale)
  for (let step = 0; step < o.maxGrowSteps && overlaps(built.placed); step++) { scale *= o.growStep; built = build(scale) }
  const { radii, placed, pos } = built
  // `clean` is false when the step cap ran out with boxes still overlapping: the caller (and the unit test) must not draw that
  const clean = !overlaps(placed)
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

  // the bounding box is TIGHT around the label boxes of the placed nodes (a lopsided tree leaves the empty side of the
  // outer rings out, so the picture can be drawn larger); an empty picture is a pad-sized square around the centre
  const xs = placed.map((n) => n.x)
  const ys = placed.map((n) => n.y)
  const minX = Math.min(0, ...xs) - o.boxW / 2 - o.pad
  const maxX = Math.max(0, ...xs) + o.boxW / 2 + o.pad
  const minY = Math.min(0, ...ys) - o.boxH / 2 - o.pad
  const maxY = Math.max(0, ...ys) + o.boxH / 2 + o.pad
  return {
    centre: rootId,
    nodes: placed,
    clean,
    spokes,
    radii: radii.slice(1),
    crowdedRings,
    bounds: { minX: round(minX), minY: round(minY), maxX: round(maxX), maxY: round(maxY), width: round(maxX - minX), height: round(maxY - minY) },
  }
}

function round(n) { return Math.round(n * 100) / 100 }
