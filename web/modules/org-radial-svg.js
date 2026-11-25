// SVG markup of one tenant's radial org chart. Pure: no DOM, no fetch, no i18n import, so every rule is a unit-test cell.
// The caller (agents-org-chart.js) does the fetching, the translated strings and the events; this module turns a layout
// (org-radial-layout.js) plus the tenant view of GET /api/team/graph?view=tenants into a string.
//
// Rules (plan orgchart-radial, sections 3.3 and 3.4, and the mockup tokens of the design doc):
//   - node = a circle-clipped avatar, a state ring around it (running: solid 4 px, green; not running: dashed 3 px, grey, so
//     the state is told by the stroke AND the colour), the name and the one-word title under it; the centre is larger, has a
//     halo ring and no title. No "running" / "member" text on the picture.
//   - every colour is a CSS custom property (--org-*), so light and dark come from the theme, not from this module.
//   - every text and attribute value that came from the server is escaped.
//   - a node is a keyboard button (tabindex 0, Enter / Space is wired by the caller) with ONE accessible name, "Name, title,
//     running|not running" (aria-label); the visible texts are aria-hidden, so a reader does not say them twice.
//   - a long label is cut at LABEL_MAX characters and the full text sits in the <title> tooltip; a crowded ring shows the
//     monogram only; `hiddenCount` of the outermost drawn node is a "+N" badge.
import { escapeHtml } from './util.js'

/** avatar diameter of a normal node and of the centre (the 150 x 130 label box of the layout holds both) */
export const AVATAR_SIZE = Object.freeze({ normal: 80, centre: 112 })
/** a state ring sits this far outside the avatar edge */
export const RING_OFFSET = 6
/** a visible label longer than this is cut with an ellipsis (the tooltip keeps the whole text) */
export const LABEL_MAX = 14
/** a small tenant is not blown up to the page width: the picture is drawn at most this much larger than its own units */
export const MAX_SCALE = 1.25

/** Cut `text` to `max` characters (code points) with an ellipsis; a shorter text is returned as it is. */
export function shortLabel(text, max = LABEL_MAX) {
  const chars = [...String(text ?? '')]
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('')
}

/** The initials of a label for a crowded ring: the first two letters of the first word, upper case. */
export function monogram(text) {
  const first = String(text ?? '').trim().split(/\s+/)[0] ?? ''
  return [...first].slice(0, 2).join('').toUpperCase()
}

function num(n) { return Math.round(n * 100) / 100 }

/** how far (px, along the ring) a guide arc reaches past the outermost nodes it serves */
const GUIDE_OVERRUN = 60
/** an arc that would cover this many degrees or more is drawn as the whole circle */
const GUIDE_FULL_DEG = 340

/**
 * The faint guide of one ring. The bounding box of the layout is tight around the nodes, so a full circle of an outer ring
 * would be cut by the edge of the picture, which looks like the chart spilling out of its box. Instead the guide is the arc
 * that covers the nodes of the ring (everything except the largest empty gap) and runs GUIDE_OVERRUN px past the outermost
 * ones, which stays inside the box; a ring that is nearly all around is a full circle.
 */
export function guideShape(r, angles) {
  if (!angles.length) return `<circle class="org-guide" cx="0" cy="0" r="${num(r)}"/>`
  const sorted = [...angles].sort((a, b) => a - b)
  // the largest gap between neighbours on the circle; the arc starts after it and ends before it
  let gap = -1
  let startIdx = 0
  for (let i = 0; i < sorted.length; i++) {
    const next = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 360
    if (next - sorted[i] > gap) { gap = next - sorted[i]; startIdx = (i + 1) % sorted.length }
  }
  const over = ((GUIDE_OVERRUN / r) * 180) / Math.PI
  const span = 360 - gap
  if (span + 2 * over >= GUIDE_FULL_DEG) return `<circle class="org-guide" cx="0" cy="0" r="${num(r)}"/>`
  const from = sorted[startIdx] - over
  const to = sorted[startIdx] + span + over
  const pt = (deg) => `${num(r * Math.sin((deg * Math.PI) / 180))} ${num(-r * Math.cos((deg * Math.PI) / 180))}`
  return `<path class="org-guide" d="M ${pt(from)} A ${num(r)} ${num(r)} 0 ${to - from > 180 ? 1 : 0} 1 ${pt(to)}"/>`
}

/**
 * @param tenant   {id, name, rootId, nodes:[{id,label,title,running}], edges}  one entry of the tenant view
 * @param layout   the answer of layoutRadial() for that tenant (it must be `clean`, the caller decides what to do if not)
 * @param opts     {
 *   index:          position of the tenant on the page (makes the clip-path ids unique across several SVGs),
 *   avatarUrl(id):  the avatar URL of an agent,
 *   a11yLabel({label,title,running}): the accessible name of a node,
 *   hiddenLabel(n): the tooltip of the "+N" badge,
 *   ariaLabel:      the accessible name of the whole picture,
 * }
 */
export function renderRadialSvg(tenant, layout, opts) {
  const info = new Map((tenant?.nodes ?? []).map((n) => [n.id, n]))
  const b = layout.bounds
  const crowded = new Set(layout.crowdedRings ?? [])
  const idx = Number.isInteger(opts.index) ? opts.index : 0
  const out = []
  out.push(
    `<svg class="org-radial-svg" xmlns="http://www.w3.org/2000/svg" viewBox="${num(b.minX)} ${num(b.minY)} ${num(b.width)} ${num(b.height)}"` +
    ` style="max-width:${Math.round(b.width * MAX_SCALE)}px"` +
    ` role="group" aria-label="${escapeHtml(opts.ariaLabel ?? tenant?.name ?? '')}" data-tenant="${escapeHtml(tenant?.id ?? '')}">`,
  )

  // faint concentric guide circles, one per ring
  out.push('<g class="org-guides" aria-hidden="true">')
  layout.radii.forEach((r, i) => out.push(guideShape(r, layout.nodes.filter((n) => n.ring === i + 1).map((n) => n.angle))))
  out.push('</g>')

  // spokes (parent to child), under the nodes
  out.push('<g class="org-spokes" aria-hidden="true">')
  for (const s of layout.spokes) out.push(`<line class="org-spoke" x1="${num(s.x1)}" y1="${num(s.y1)}" x2="${num(s.x2)}" y2="${num(s.y2)}"/>`)
  out.push('</g>')

  out.push('<g class="org-nodes">')
  layout.nodes.forEach((p, i) => {
    const n = info.get(p.id) ?? { id: p.id, label: p.id, title: null, running: false }
    const label = n.label || n.id
    const title = p.isRoot ? null : (n.title || null)
    const running = !!n.running
    const size = p.isRoot ? AVATAR_SIZE.centre : AVATAR_SIZE.normal
    const half = size / 2
    const ringR = half + RING_OFFSET
    const clip = `org-clip-${idx}-${i}`
    const name = escapeHtml(opts.a11yLabel({ label, title, running }))
    const mono = !p.isRoot && crowded.has(p.ring)
    const cls = ['org-node', p.isRoot ? 'org-node-centre' : '', running ? 'org-running' : 'org-stopped'].filter(Boolean).join(' ')
    // the centre is not a button (the main agent has no detail page here, as in the tree view); everything else is
    const attrs = p.isRoot
      ? 'role="img"'
      : 'role="button" tabindex="0"'
    out.push(`<g class="${cls}" data-agent="${escapeHtml(p.id)}" ${attrs} aria-label="${name}" transform="translate(${num(p.x)} ${num(p.y)})">`)
    out.push(`<title>${name}</title>`)
    if (p.isRoot) out.push(`<circle class="org-centre-halo" r="${ringR + 8}"/>`)
    out.push(`<circle class="org-state-ring" r="${ringR}"${running ? '' : ' stroke-dasharray="7 6"'}/>`)
    out.push(`<clipPath id="${clip}"><circle r="${half}"/></clipPath>`)
    out.push(
      `<image class="org-avatar" href="${escapeHtml(opts.avatarUrl(p.id))}" x="${-half}" y="${-half}" width="${size}" height="${size}"` +
      ` clip-path="url(#${clip})" preserveAspectRatio="xMidYMid slice"/>`,
    )
    // the focus ring is drawn by CSS around the state ring (a stroke only, no fill)
    out.push(`<circle class="org-focus-ring" r="${ringR + 4}"/>`)
    const nameY = ringR + (p.isRoot ? 28 : 20) // the centre's halo ring sits 8 px further out
    out.push(`<text class="org-name" y="${nameY}" text-anchor="middle" aria-hidden="true">${escapeHtml(mono ? monogram(label) : shortLabel(label))}</text>`)
    if (title && !mono) out.push(`<text class="org-title" y="${nameY + 17}" text-anchor="middle" aria-hidden="true">${escapeHtml(shortLabel(title))}</text>`)
    if (p.hiddenCount) {
      const bx = half * 0.72
      const by = -half * 0.72
      out.push(
        `<g class="org-hidden-badge"><title>${escapeHtml(opts.hiddenLabel(p.hiddenCount))}</title>` +
        `<circle cx="${num(bx)}" cy="${num(by)}" r="14"/><text x="${num(bx)}" y="${num(by + 4)}" text-anchor="middle">+${p.hiddenCount}</text></g>`,
      )
    }
    out.push('</g>')
  })
  out.push('</g></svg>')
  return out.join('')
}
