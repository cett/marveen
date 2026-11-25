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
    ` role="group" aria-label="${escapeHtml(opts.ariaLabel ?? tenant?.name ?? '')}" data-tenant="${escapeHtml(tenant?.id ?? '')}">`,
  )

  // faint concentric guide circles, one per ring
  out.push('<g class="org-guides" aria-hidden="true">')
  for (const r of layout.radii) out.push(`<circle class="org-guide" cx="0" cy="0" r="${num(r)}"/>`)
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
    const nameY = ringR + 20
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
